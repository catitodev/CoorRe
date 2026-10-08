#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  Connection,
  Keypair,
  Transaction,
  TransactionExpiredBlockheightExceededError,
} from "@solana/web3.js";
import * as lib from "./lib.mjs";

const USAGE =
  "usage: node bridge/anchor.mjs <open-case|anchor-transition|fetch-account> --input <file.json>";

const COMMANDS = {
  "open-case": openCase,
  "anchor-transition": anchorTransition,
  "fetch-account": fetchAccount,
};

function loadConfig(env) {
  if (!env.COORRE_PROGRAM_ID) {
    throw new lib.BridgeError("MissingConfig", "COORRE_PROGRAM_ID is not set");
  }
  return {
    rpcUrls: [env.COORRE_RPC_URL || lib.DEFAULT_RPC_URL, env.COORRE_RPC_FALLBACK_URL].filter(Boolean),
    programId: lib.parsePubkey(env.COORRE_PROGRAM_ID, "COORRE_PROGRAM_ID"),
    keysDir: path.resolve(env.COORRE_KEYS_DIR || lib.DEFAULT_KEYS_DIR),
  };
}

async function connect(config) {
  let lastError;
  for (const url of config.rpcUrls) {
    const connection = new Connection(url, "confirmed");
    let genesis;
    try {
      genesis = await connection.getGenesisHash();
    } catch (err) {
      lastError = err;
      continue;
    }
    if (genesis !== lib.DEVNET_GENESIS_HASH) {
      throw new lib.BridgeError("WrongNetwork", `RPC ${url} is not Solana devnet`);
    }
    return connection;
  }
  throw new lib.BridgeError("RpcUnavailable", `no RPC endpoint reachable: ${lastError?.message ?? "none configured"}`);
}

async function loadKeypair(keysDir, role) {
  const file = path.join(keysDir, `${role}.json`);
  let info;
  try {
    info = await stat(file);
  } catch {
    throw new lib.BridgeError("MissingKey", `key file for ${role} not found in ${keysDir}`);
  }
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new lib.BridgeError("InsecureKeyFile", `key file for ${role} must not be readable by group or others (chmod 600)`);
  }
  let bytes;
  try {
    bytes = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new lib.BridgeError("InvalidKey", `key file for ${role} is not valid JSON`);
  }
  const valid = Array.isArray(bytes) && bytes.length === 64 && bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255);
  if (!valid) throw new lib.BridgeError("InvalidKey", `key file for ${role} must hold 64 bytes`);
  try {
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  } catch {
    throw new lib.BridgeError("InvalidKey", `key file for ${role} has a public key that does not match its seed`);
  }
}

async function failureFrom(err, connection) {
  let logs = Array.isArray(err?.logs) ? err.logs : undefined;
  if (!logs && typeof err?.getLogs === "function") {
    logs = await err.getLogs(connection).catch(() => undefined);
  }
  const parsed = lib.parseProgramError(logs ?? [], String(err?.message ?? err));
  return new lib.BridgeError(parsed?.name ?? "TransactionFailed", String(err?.message ?? err), {
    ...(parsed?.code !== undefined ? { code: parsed.code } : {}),
    logs: logs ?? [],
  });
}

async function send(connection, instruction, signers) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: signers[0].publicKey, blockhash, lastValidBlockHeight }).add(instruction);
    tx.sign(...signers);

    let signature;
    try {
      signature = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
    } catch (err) {
      throw await failureFrom(err, connection);
    }
    try {
      const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
      if (result.value.err) {
        const landed = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        const logs = landed?.meta?.logMessages ?? [];
        const parsed = lib.parseProgramError(logs, JSON.stringify(result.value.err));
        throw new lib.BridgeError(parsed?.name ?? "TransactionFailed", JSON.stringify(result.value.err), {
          ...(parsed?.code !== undefined ? { code: parsed.code } : {}),
          logs,
          tx_signature: signature,
        });
      }
      return signature;
    } catch (err) {
      if (!(err instanceof TransactionExpiredBlockheightExceededError) || attempt > 0) throw err;
      const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
      const value = status?.value;
      if (value && !value.err && (value.confirmationStatus === "confirmed" || value.confirmationStatus === "finalized")) {
        return signature;
      }
    }
  }
  throw new lib.BridgeError("TransactionExpired", "transaction expired twice");
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
    submitter: lib.parsePubkey(input.submitter, "submitter"),
    agent: lib.parsePubkey(input.agent, "agent"),
    ruleEngine: lib.parsePubkey(input.rule_engine, "rule_engine"),
    approver: lib.parsePubkey(input.approver, "approver"),
    amount: lib.parseU64(input.amount_lamports, "amount_lamports"),
    autonomyLimit: lib.parseU64(input.autonomy_limit_lamports, "autonomy_limit_lamports"),
  };
  const connection = await connect(config);
  const creator = await loadKeypair(config.keysDir, "creator");
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

async function main(argv) {
  const [command, flag, inputPath, ...rest] = argv;
  if (!Object.hasOwn(COMMANDS, command ?? "") || flag !== "--input" || !inputPath || rest.length > 0) {
    throw new lib.BridgeError("Usage", USAGE);
  }
  let input;
  try {
    input = JSON.parse(await readFile(inputPath, "utf8"));
  } catch {
    throw new lib.BridgeError("InvalidInput", `cannot read JSON input from ${inputPath}`);
  }
  const config = loadConfig(process.env);
  return COMMANDS[command](input, config);
}

main(process.argv.slice(2)).then(
  (result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  },
  (err) => {
    const error =
      err instanceof lib.BridgeError
        ? { name: err.name, message: err.message, ...err.details }
        : { name: "UnexpectedError", message: String(err?.message ?? err) };
    process.stdout.write(`${JSON.stringify({ error })}\n`);
    process.exitCode = 1;
  }
);
