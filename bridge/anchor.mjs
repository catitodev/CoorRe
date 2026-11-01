#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Connection, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import * as lib from "./lib.mjs";

const USAGE =
  "usage: node bridge/anchor.mjs <open-case|anchor-transition|fetch-account> --input <file.json>";
const POLL_MS = 1000;
const CONFIRMED = new Set(["confirmed", "finalized"]);
const sentSignatures = [];

const COMMANDS = {
  "open-case": openCase,
  "anchor-transition": anchorTransition,
  "fetch-account": fetchAccount,
};

function loadConfig(env) {
  if (!env.COORRE_PROGRAM_ID) {
    throw new lib.BridgeError("MissingConfig", "COORRE_PROGRAM_ID is not set");
  }
  const rpcUrls = [lib.parseRpcUrl(env.COORRE_RPC_URL || lib.DEFAULT_RPC_URL, "COORRE_RPC_URL")];
  if (env.COORRE_RPC_FALLBACK_URL) rpcUrls.push(lib.parseRpcUrl(env.COORRE_RPC_FALLBACK_URL, "COORRE_RPC_FALLBACK_URL"));
  return {
    rpcUrls,
    programId: lib.parsePubkey(env.COORRE_PROGRAM_ID, "COORRE_PROGRAM_ID"),
    keysDir: path.resolve(env.COORRE_KEYS_DIR || lib.DEFAULT_KEYS_DIR),
  };
}

async function connect(config) {
  const attempts = [];
  for (const url of config.rpcUrls) {
    const connection = new Connection(url, "confirmed");
    let genesis;
    try {
      genesis = await connection.getGenesisHash();
    } catch (err) {
      attempts.push({ rpc: lib.rpcOrigin(url), reason: String(err?.message ?? err), ...causeCode(err) });
      continue;
    }
    if (genesis !== lib.DEVNET_GENESIS_HASH) {
      throw new lib.BridgeError("WrongNetwork", `RPC ${lib.rpcOrigin(url)} is not Solana devnet`, { genesis_hash: genesis });
    }
    return connection;
  }
  throw new lib.BridgeError("RpcUnavailable", "no RPC endpoint reachable", { attempts });
}

function causeCode(err) {
  const code = err?.code ?? err?.cause?.code;
  return code === undefined ? {} : { cause_code: String(code) };
}

async function loadKeypair(keysDir, role) {
  const file = path.join(keysDir, `${role}.json`);
  let info;
  try {
    info = await stat(file);
  } catch (err) {
    if (err?.code === "ENOENT") {
      throw new lib.BridgeError("MissingKey", `key file for ${role} not found in ${keysDir}`, causeCode(err));
    }
    throw new lib.BridgeError("UnreadableKey", `key file for ${role} cannot be inspected`, causeCode(err));
  }
  if (!info.isFile()) throw new lib.BridgeError("InvalidKey", `key file for ${role} is not a regular file`);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new lib.BridgeError("InsecureKeyFile", `key file for ${role} must not be readable by group or others (chmod 600)`);
  }
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    throw new lib.BridgeError("UnreadableKey", `key file for ${role} cannot be read`, causeCode(err));
  }
  let bytes;
  try {
    bytes = JSON.parse(text);
  } catch (err) {
    throw new lib.BridgeError("InvalidKey", `key file for ${role} is not valid JSON`, { reason: err?.name ?? "parse error" });
  }
  const valid = Array.isArray(bytes) && bytes.length === 64 && bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255);
  if (!valid) throw new lib.BridgeError("InvalidKey", `key file for ${role} must hold 64 bytes`);
  try {
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  } catch (err) {
    throw new lib.BridgeError("InvalidKey", `key file for ${role} has a public key that does not match its seed`, {
      reason: err?.name ?? "invalid secret key",
    });
  }
}

async function failureFrom(err, connection) {
  let logs = Array.isArray(err?.logs) ? err.logs : undefined;
  let logsError;
  if (!logs && typeof err?.getLogs === "function" && err.signature) {
    try {
      logs = await err.getLogs(connection);
    } catch (logErr) {
      logsError = String(logErr?.message ?? logErr);
    }
  }
  const parsed = lib.parseProgramError(logs ?? [], String(err?.message ?? err));
  return new lib.BridgeError(parsed?.name ?? "TransactionFailed", String(err?.message ?? err), {
    ...(parsed?.code !== undefined ? { code: parsed.code } : {}),
    logs: logs ?? [],
    ...(logsError ? { logs_error: logsError } : {}),
  });
}

async function landedFailure(connection, signature, txError) {
  let logs = [];
  let logsError;
  try {
    const landed = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    logs = landed?.meta?.logMessages ?? [];
  } catch (err) {
    logsError = String(err?.message ?? err);
  }
  const message = JSON.stringify(txError);
  const parsed = lib.parseProgramError(logs, message);
  return new lib.BridgeError(parsed?.name ?? "TransactionFailed", message, {
    ...(parsed?.code !== undefined ? { code: parsed.code } : {}),
    logs,
    ...(logsError ? { logs_error: logsError } : {}),
    tx_signature: signature,
  });
}

async function statusOf(connection, signature) {
  const { value } = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
  if (!value) return { status: "unknown" };
  if (value.err) return { status: "failed", err: value.err };
  if (CONFIRMED.has(value.confirmationStatus)) return { status: "confirmed" };
  return { status: "processed" };
}

async function confirm(connection, signature, lastValidBlockHeight) {
  for (;;) {
    const current = await statusOf(connection, signature);
    if (current.status === "confirmed" || current.status === "failed") return current;
    if (current.status === "unknown" && (await connection.getBlockHeight("confirmed")) > lastValidBlockHeight) {
      const last = await statusOf(connection, signature);
      if (last.status === "unknown") return { status: "expired" };
      if (last.status !== "processed") return last;
    }
    await sleep(POLL_MS);
  }
}

async function earlierLanded(connection, signatures) {
  for (const signature of signatures) {
    if ((await statusOf(connection, signature)).status === "confirmed") return signature;
  }
  return null;
}

async function send(connection, instruction, signers) {
  const attempts = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: signers[0].publicKey, blockhash, lastValidBlockHeight }).add(instruction);
    tx.sign(...signers);

    let failure;
    let signature;
    try {
      signature = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
    } catch (err) {
      failure = await failureFrom(err, connection);
    }
    if (signature) {
      attempts.push(signature);
      sentSignatures.push(signature);
      const outcome = await confirm(connection, signature, lastValidBlockHeight);
      if (outcome.status === "confirmed") return signature;
      if (outcome.status === "failed") failure = await landedFailure(connection, signature, outcome.err);
    }
    if (failure) {
      const earlier = attempts.filter((s) => s !== signature);
      if (failure.name === "AccountAlreadyInUse" && earlier.length) {
        const landed = await earlierLanded(connection, earlier);
        if (landed) return landed;
      }
      throw failure;
    }
  }
  throw new lib.BridgeError("TransactionExpired", "transaction expired twice", { tx_signatures: attempts });
}

function receipt(config, account, signature) {
  return {
    network_id: lib.NETWORK_ID,
    program_id: config.programId.toBase58(),
    account: account.toBase58(),
    tx_signature: signature,
  };
}

async function openCase(input, config) {
  lib.requireMembers(input, [
    "case_id",
    "submitter",
    "agent",
    "rule_engine",
    "approver",
    "amount_lamports",
    "autonomy_limit_lamports",
  ]);
  const args = {
    caseId: lib.parseHex32(input.case_id, "case_id"),
    submitter: lib.parseWalletKey(input.submitter, "submitter", config.programId),
    agent: lib.parseWalletKey(input.agent, "agent", config.programId),
    ruleEngine: lib.parseWalletKey(input.rule_engine, "rule_engine", config.programId),
    approver: lib.parseWalletKey(input.approver, "approver", config.programId),
    amount: lib.parseU64(input.amount_lamports, "amount_lamports"),
    autonomyLimit: lib.parseU64(input.autonomy_limit_lamports, "autonomy_limit_lamports"),
  };
  const connection = await connect(config);
  const creator = await loadKeypair(config.keysDir, "creator");
  const payee = await connection.getAccountInfo(args.submitter, "confirmed");
  if (payee && (payee.executable || !payee.owner.equals(SystemProgram.programId))) {
    throw new lib.BridgeError(
      "InvalidInput",
      "submitter (the payee) must be a system account; an executable or program-owned account would block every transition of the case",
      { owner: payee.owner.toBase58(), executable: payee.executable }
    );
  }
  const caseRecord = lib.caseRecordAddress(config.programId, creator.publicKey, args.caseId);
  const instruction = lib.openCaseInstruction(config.programId, {
    caseRecord,
    creator: creator.publicKey,
    data: lib.encodeOpenCase(args),
  });
  const signature = await send(connection, instruction, [creator]);
  return receipt(config, caseRecord, signature);
}

async function anchorTransition(input, config) {
  lib.requireMembers(input, ["case_record", "evidence_hash", "prev_hash", "to_state", "rule_hash", "actor_role"]);
  const caseRecord = lib.parsePubkey(input.case_record, "case_record");
  const args = {
    evidenceHash: lib.parseHex32(input.evidence_hash, "evidence_hash"),
    prevHash: lib.parseHex32(input.prev_hash, "prev_hash"),
    toState: lib.parseStateCode(input.to_state, "to_state"),
    ruleHash: lib.parseHex32(input.rule_hash, "rule_hash"),
  };
  const actorRole = lib.parseActorRole(input.actor_role, "actor_role");

  const connection = await connect(config);
  const payer = await loadKeypair(config.keysDir, "creator");
  const actor = await loadKeypair(config.keysDir, actorRole);
  const account = await connection.getAccountInfo(caseRecord, "confirmed");
  if (!account) throw new lib.BridgeError("AccountNotFound", "case record not found");
  if (!account.owner.equals(config.programId)) {
    throw new lib.BridgeError("InvalidAccount", "case record is not owned by the program");
  }
  const record = lib.decodeCaseRecord(account.data);

  const evidenceAnchor = lib.evidenceAnchorAddress(config.programId, caseRecord, args.evidenceHash);
  const instruction = lib.anchorTransitionInstruction(config.programId, {
    caseRecord,
    evidenceAnchor,
    actor: actor.publicKey,
    payer: payer.publicKey,
    submitter: record.submitter,
    creator: record.creator,
    data: lib.encodeAnchorTransition(args),
  });
  const signature = await send(connection, instruction, [payer, actor]);
  return receipt(config, evidenceAnchor, signature);
}

async function fetchAccount(input, config) {
  lib.requireMembers(input, ["address"]);
  const address = lib.parsePubkey(input.address, "address");
  const connection = await connect(config);
  const { context, value } = await connection.getAccountInfoAndContext(address, "confirmed");
  if (!value) return { address: address.toBase58(), exists: false, slot: context.slot };
  return {
    address: address.toBase58(),
    exists: true,
    owner: value.owner.toBase58(),
    lamports: value.lamports,
    executable: value.executable,
    data_hex: value.data.toString("hex"),
    slot: context.slot,
  };
}

async function main(argv, env) {
  const [command, flag, inputPath, ...rest] = argv;
  if (!Object.hasOwn(COMMANDS, command ?? "") || flag !== "--input" || !inputPath || rest.length > 0) {
    throw new lib.BridgeError("Usage", USAGE);
  }
  let text;
  try {
    text = await readFile(inputPath, "utf8");
  } catch (err) {
    throw new lib.BridgeError("InvalidInput", `cannot read input file ${inputPath}`, causeCode(err));
  }
  let input;
  try {
    input = JSON.parse(text);
  } catch (err) {
    throw new lib.BridgeError("InvalidInput", `input file ${inputPath} is not valid JSON`, { reason: String(err?.message ?? err) });
  }
  const config = loadConfig(env);
  return COMMANDS[command](input, config);
}

function errorObject(err) {
  if (err instanceof lib.BridgeError) return { name: err.name, message: err.message, ...err.details };
  return { name: "UnexpectedError", message: String(err?.message ?? err), ...causeCode(err) };
}

function finish(value, exitCode) {
  const text = lib.redactRpcUrls(JSON.stringify(value), [process.env.COORRE_RPC_URL, process.env.COORRE_RPC_FALLBACK_URL]);
  process.stdout.write(`${text}\n`, () => process.exit(exitCode));
}

let timeoutMs;
try {
  timeoutMs = lib.parseTimeoutMs(process.env.COORRE_BRIDGE_TIMEOUT_MS);
} catch (err) {
  finish({ error: errorObject(err) }, 1);
}

if (timeoutMs !== undefined) {
  const deadline = setTimeout(() => {
    finish(
      {
        error: {
          name: "Timeout",
          message: `the bridge did not finish within ${timeoutMs} ms`,
          timeout_ms: timeoutMs,
          ...(sentSignatures.length ? { tx_signatures: [...sentSignatures] } : {}),
        },
      },
      1
    );
  }, timeoutMs);
  main(process.argv.slice(2), process.env).then(
    (result) => {
      clearTimeout(deadline);
      finish(result, 0);
    },
    (err) => {
      clearTimeout(deadline);
      finish({ error: errorObject(err) }, 1);
    }
  );
}
