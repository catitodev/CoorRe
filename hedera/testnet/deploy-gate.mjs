#!/usr/bin/env node
import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ContractFunctionParameters, PrivateKey, Status, TopicCreateTransaction } from "@hiero-ledger/sdk";
import { DEFAULT_MAX_VALIDITY_SECONDS, GATE_ARTIFACT, loadGate } from "../lib/gate.mjs";
import { CONTRACT_CREATE_MAX_FEE_HBAR, deployDetailed, hasNoExternalAdmin } from "../lib/network.mjs";
import { sha256Hex } from "../lib/canonical.mjs";
import { ARTIFACTS_ROOT, REPO_ROOT, isInside } from "../lib/paths.mjs";
import { MAX_FEE_HBAR, REQUEST_TIMEOUT_MS, TESTNET, loadOperator, mirrorCall, mirrorGet, testnetClient } from "./operator.mjs";

const GATE_GAS = 3_000_000;
const ESCROW_VIEWS = { admin: "0xf851a440", financialManager: "0x4eef3f31", approvalWindow: "0x737b68dd" };
const EVM = /^0x[0-9a-fA-F]{40}$/;
const ACCOUNT = /^0\.0\.\d+$/;
const MIN_VALIDITY_SECONDS = 3600;
const MAX_VALIDITY_SECONDS = 365 * 24 * 3600;

export function parseArgs(argv) {
  const args = { hostConfig: null, confirmSpend: false, supersede: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--host-config") args.hostConfig = argv[++i];
    else if (argv[i] === "--confirm-spend") args.confirmSpend = true;
    else if (argv[i] === "--supersede") args.supersede = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!args.hostConfig) throw new Error("--host-config must name the private host configuration file");
  args.hostConfig = resolve(args.hostConfig);
  if (isInside(REPO_ROOT, args.hostConfig)) throw new Error("the host configuration must live outside the repository");
  return args;
}

export function hostAccountIds(config) {
  const named = ["admin", "financialManager", "oracle"].map((role) => config[role]?.id).filter(Boolean);
  return [...new Set([...named, ...(config.otherHostAccounts ?? [])])];
}

export function validateHostConfig(config) {
  if (config.network !== "testnet" || config.chainId !== TESTNET.chainId) throw new Error("the host configuration is not for testnet (chain 296)");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(config.hostId ?? "")) throw new Error("hostId must be lowercase letters, digits and dashes");
  if (!EVM.test(config.escrow?.evm ?? "")) throw new Error("escrow.evm must be an EVM address");
  if (!/^[0-9a-f]{64}$/.test(config.escrow?.runtimeSha256 ?? "")) throw new Error("escrow.runtimeSha256 must be 32 bytes of lowercase hex");
  if (typeof config.recordDir !== "string" || config.recordDir.length === 0) throw new Error("recordDir must name a private directory");
  if (isInside(REPO_ROOT, resolve(config.recordDir))) throw new Error("recordDir must live outside the repository");
  const accounts = hostAccountIds(config);
  if (accounts.length === 0) throw new Error("the host configuration must list the host's accounts");
  for (const id of accounts) if (!ACCOUNT.test(id)) throw new Error(`bad host account id ${id}`);
  const maxMandateValiditySeconds = config.maxMandateValiditySeconds ?? DEFAULT_MAX_VALIDITY_SECONDS;
  if (!Number.isInteger(maxMandateValiditySeconds) || maxMandateValiditySeconds < MIN_VALIDITY_SECONDS || maxMandateValiditySeconds > MAX_VALIDITY_SECONDS) {
    throw new Error(`maxMandateValiditySeconds must be an integer between ${MIN_VALIDITY_SECONDS} and ${MAX_VALIDITY_SECONDS}`);
  }
  return { ...config, maxMandateValiditySeconds, escrow: { ...config.escrow, evm: config.escrow.evm.toLowerCase() }, recordDir: resolve(config.recordDir) };
}

export function assertSeparateOperator(operatorId, config) {
  if (hostAccountIds(config).includes(String(operatorId))) {
    throw new Error(`the CoorRe operator ${operatorId} is also a host account; use an account that belongs to CoorRe only`);
  }
}

export function wordAddress(result) {
  const hex = String(result).replace(/^0x/, "");
  if (hex.length !== 64) throw new Error("expected one 32-byte word");
  return `0x${hex.slice(24)}`;
}

export function verificationInput(buildInfo, sourceName) {
  const keep = [sourceName, sourceName.replace(/CoorReMandateGate\.sol$/, "IPeriodEscrow.sol")];
  const sources = Object.fromEntries(keep.map((name) => {
    if (!buildInfo.input.sources[name]) throw new Error(`${name} is not in the build`);
    return [name, buildInfo.input.sources[name]];
  }));
  return { language: buildInfo.input.language, sources, settings: buildInfo.input.settings };
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export const RECORD_STAGES = ["gate-deployed", "topic-created", "complete"];

export function recordStage(record) {
  if (record === null) return null;
  const stage = record.stage ?? "complete";
  if (!RECORD_STAGES.includes(stage)) throw new Error(`the recorded deploy has an unknown stage ${stage}`);
  return stage;
}

export async function pollUntil(get, { attempts = 30, intervalMs = 2_000 } = {}) {
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await get();
    } catch (error) {
      last = error;
    }
    if (attempt < attempts) await new Promise((done) => setTimeout(done, intervalMs));
  }
  throw new Error(`gave up after ${attempts} attempts: ${last?.message}`, { cause: last });
}

export async function writeRecord(recordFile, record) {
  const partial = `${recordFile}.writing`;
  await writeFile(partial, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await chmod(partial, 0o600);
  await rename(partial, recordFile);
}

export async function writeLogKeyFile(logKeyFile, privateKeyRaw) {
  const body = `${JSON.stringify({ network: "testnet", purpose: "CoorRe log topic submit key", keyType: "ED25519", privateKey: privateKeyRaw })}\n`;
  await writeFile(logKeyFile, body, { mode: 0o600, flag: "wx" });
  await chmod(logKeyFile, 0o600);
}

export async function verifySafely(verify, gateEvm) {
  try {
    return await verify(gateEvm);
  } catch (error) {
    return { status: "error", error: `${error.name}: ${error.message}` };
  }
}

export function planLines({ config, previous, stage }) {
  const lines = [];
  if (stage !== null && stage !== "complete") lines.push(`resume    the recorded deploy of gate ${previous.gate.id} stopped at stage ${stage}; it is resumed, the gate is not deployed again`);
  if (stage === null || stage === "complete") lines.push(`plan      1. deploy CoorReMandateGate(escrow, mandate validity cap ${config.maxMandateValiditySeconds} s), gas limit ${GATE_GAS}`);
  if (stage === "complete") lines.push(`          2. keep the existing log topic ${previous.topic.id} (the previous record is archived, not deleted)`);
  else if (stage !== "topic-created") lines.push("          2. create the CoorRe log topic: new ED25519 submit key kept in the private record directory, no admin key");
  lines.push("          3. verify the gate on Sourcify (chain 296) with the CoorRe sources only");
  lines.push("          4. write the deploy record to the private record directory after each step");
  lines.push(`fees      at most ${MAX_FEE_HBAR} HBAR per transaction, and at most ${CONTRACT_CREATE_MAX_FEE_HBAR} HBAR for the gate's ContractCreate`);
  return lines;
}

export async function runDeploy({ args, recordFile, logKeyFile, previous, base }, steps, log = console.log) {
  const stage = recordStage(previous);
  if (stage !== null && stage !== "complete" && args.supersede) throw new Error(`the recorded deploy stopped at stage ${stage}; finish it before superseding it`);
  if (stage === "complete" && !args.supersede) throw new Error("a gate is already recorded for this host; use --supersede to archive that record, keep its log topic and deploy a new gate");
  let record;
  if (stage === null || stage === "complete") {
    const gate = await steps.deployGate();
    log(`gate      ${gate.id} (${gate.transactionId}), bytecode sent in ${gate.chunks} blocks of at most 1000 characters`);
    record = { ...base, createdAt: new Date().toISOString(), supersedes: stage === "complete" ? previous.gate.id : null, gate };
    if (stage === "complete") {
      await rename(recordFile, `${recordFile.replace(/\.json$/, "")}-superseded-${previous.createdAt.replace(/[^0-9]/g, "")}.json`);
      record = { ...record, stage: "topic-created", topic: { ...previous.topic, reused: true } };
      log(`topic     ${record.topic.id} reused`);
    } else {
      record = { ...record, stage: "gate-deployed" };
    }
    await writeRecord(recordFile, record);
  } else {
    record = previous;
  }
  await steps.confirmNoAdmin(record.gate);
  log("admin     the gate has no external admin key: its admin key is the contract itself");
  if (record.stage === "gate-deployed") {
    if (await exists(logKeyFile)) {
      throw new Error("a log key file exists but no topic is recorded; look for a TopicCreate by the operator on the Mirror Node, record it or move the key file away, then rerun");
    }
    const logKey = steps.generateLogKey();
    await writeLogKeyFile(logKeyFile, logKey.toStringRaw());
    const topic = await steps.createTopic(logKey.publicKey);
    record = { ...record, stage: "topic-created", topic: { ...topic, submitKey: logKey.publicKey.toStringRaw(), adminKey: null } };
    await writeRecord(recordFile, record);
    log(`topic     ${record.topic.id} (${record.topic.transactionId})`);
  }
  const verification = await verifySafely(steps.verify, record.gate.evm);
  log(`sourcify  ${verification.status}${verification.match ? ` (${verification.match})` : ""}${verification.error ? `: ${verification.error}` : ""}`);
  record = { ...record, stage: "complete", gate: { ...record.gate, verification } };
  await writeRecord(recordFile, record);
  log("record    written to the private record directory");
  return record;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = validateHostConfig(JSON.parse(await readFile(args.hostConfig, "utf8")));
  const operator = await loadOperator();
  assertSeparateOperator(operator.id, config);
  const gateBuild = await loadGate();
  const escrow = await checkEscrow(config);
  const recordFile = join(config.recordDir, "testnet-gate.json");
  const logKeyFile = join(config.recordDir, "testnet-log-key.json");
  const previous = (await exists(recordFile)) ? JSON.parse(await readFile(recordFile, "utf8")) : null;
  const stage = recordStage(previous);
  if (stage === "complete" && !args.supersede) throw new Error("a gate is already recorded for this host; use --supersede to archive that record, keep its log topic and deploy a new gate");
  if (stage !== null && stage !== "complete" && args.supersede) throw new Error(`the recorded deploy stopped at stage ${stage}; finish it before superseding it`);
  console.log(`operator  ${operator.id} (${operator.keyType}), balance ${(operator.balanceTinybar / 1e8).toFixed(8)} HBAR, separate from the host's accounts`);
  console.log(`escrow    ${escrow.id}: expected runtime (sha256 ${escrow.runtimeSha256}), approvalWindow ${escrow.approvalWindow} s`);
  for (const line of planLines({ config, previous, stage })) console.log(line);
  if (!args.confirmSpend) {
    console.log("dry run   nothing sent; rerun with --confirm-spend to execute");
    return;
  }

  await mkdir(config.recordDir, { recursive: true, mode: 0o700 });
  const client = testnetClient(operator);
  try {
    await runDeploy(
      {
        args,
        recordFile,
        logKeyFile,
        previous,
        base: { network: "testnet", chainId: TESTNET.chainId, hostId: config.hostId, operator: operator.id.toString(), escrow },
      },
      {
        deployGate: async () => {
          const deployed = await deployDetailed(client, gateBuild, new ContractFunctionParameters().addAddress(escrow.evm).addUint64(config.maxMandateValiditySeconds), GATE_GAS);
          const gateId = deployed.contractId;
          return {
            id: gateId.toString(),
            evm: `0x${gateId.toEvmAddress()}`.toLowerCase(),
            transactionId: deployed.transactionId,
            uploadTransactions: deployed.uploads,
            chunks: deployed.chunks,
            bytecodeFile: deployed.bytecodeFile,
            bytecodeSha256: sha256Hex(Buffer.from(gateBuild.bytecode, "hex")),
            maxMandateValiditySeconds: config.maxMandateValiditySeconds,
            adminKey: "the contract itself, so there is no external administrator",
            hashscan: `${TESTNET.hashscan}/contract/${gateId}`,
          };
        },
        confirmNoAdmin: async (gate) => {
          const gateInfo = await pollUntil(() => mirrorGet(`/api/v1/contracts/${gate.id}`));
          if (!hasNoExternalAdmin(gateInfo)) throw new Error(`the gate ${gate.id} is deployed but has an external admin key; do not use it`);
        },
        generateLogKey: () => PrivateKey.generateED25519(),
        createTopic: async (publicKey) => {
          const response = await new TopicCreateTransaction().setTopicMemo("coorre-log").setSubmitKey(publicKey).execute(client);
          const receipt = await response.getReceipt(client);
          if (receipt.status !== Status.Success) throw new Error(`topic create returned ${receipt.status}`);
          return { id: receipt.topicId.toString(), transactionId: response.transactionId.toString(), hashscan: `${TESTNET.hashscan}/topic/${receipt.topicId}` };
        },
        verify: verifyOnSourcify,
      },
    );
  } finally {
    client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`deploy-gate: ${error.message}`);
    process.exit(1);
  });
}
