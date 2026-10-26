#!/usr/bin/env node
import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ContractFunctionParameters, PrivateKey, Status, TopicCreateTransaction } from "@hiero-ledger/sdk";
import { DEFAULT_MAX_VALIDITY_SECONDS, GATE_ARTIFACT, loadGate } from "../lib/gate.mjs";
import { deployDetailed, hasNoExternalAdmin } from "../lib/network.mjs";
import { sha256Hex } from "../lib/canonical.mjs";
import { ARTIFACTS_ROOT, REPO_ROOT, isInside } from "../lib/paths.mjs";
import { TESTNET, loadOperator, mirrorCall, mirrorGet, testnetClient } from "./operator.mjs";

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
  } catch {
    return false;
  }
}

async function checkEscrow(config) {
  const contract = await mirrorGet(`/api/v1/contracts/${config.escrow.evm}`);
  const observed = sha256Hex(Buffer.from(String(contract.runtime_bytecode).replace(/^0x/, ""), "hex"));
  if (observed !== config.escrow.runtimeSha256) throw new Error(`the contract at ${config.escrow.evm} does not hold the expected runtime (sha256 ${observed})`);
  return {
    id: contract.contract_id,
    evm: config.escrow.evm,
    runtimeSha256: observed,
    admin: wordAddress(await mirrorCall(config.escrow.evm, ESCROW_VIEWS.admin)),
    financialManager: wordAddress(await mirrorCall(config.escrow.evm, ESCROW_VIEWS.financialManager)),
    approvalWindow: BigInt(await mirrorCall(config.escrow.evm, ESCROW_VIEWS.approvalWindow)).toString(),
  };
}

async function verifyOnSourcify(gateEvm) {
  const artifact = JSON.parse(await readFile(GATE_ARTIFACT, "utf8"));
  const buildInfo = JSON.parse(await readFile(join(ARTIFACTS_ROOT, "build-info", `${artifact.buildInfoId}.json`), "utf8"));
  const body = {
    stdJsonInput: verificationInput(buildInfo, artifact.inputSourceName),
    compilerVersion: buildInfo.solcLongVersion,
    contractIdentifier: `${artifact.inputSourceName}:${artifact.contractName}`,
  };
  const submitted = await fetch(`${TESTNET.sourcify}/v2/verify/${TESTNET.chainId}/${gateEvm}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const job = await submitted.json();
  if (!job.verificationId) return { status: "not-submitted", response: job };
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((done) => setTimeout(done, 5_000));
    const state = await (await fetch(`${TESTNET.sourcify}/v2/verify/${job.verificationId}`)).json();
    if (state.isJobCompleted) return { status: state.error ? "failed" : "completed", verificationId: job.verificationId, match: state.contract?.match ?? null, error: state.error ?? null };
  }
  return { status: "pending", verificationId: job.verificationId };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = validateHostConfig(JSON.parse(await readFile(args.hostConfig, "utf8")));
  const operator = await loadOperator();
  assertSeparateOperator(operator.id, config);
  const gateBuild = await loadGate();
  const escrow = await checkEscrow(config);
  const recordFile = join(config.recordDir, "testnet-gate.json");
  const previous = (await exists(recordFile)) ? JSON.parse(await readFile(recordFile, "utf8")) : null;
  if (previous && !args.supersede) throw new Error("a gate is already recorded for this host; use --supersede to archive that record, keep its log topic and deploy a new gate");
  const logKeyFile = join(config.recordDir, "testnet-log-key.json");
  console.log(`operator  ${operator.id} (${operator.keyType}), balance ${(operator.balanceTinybar / 1e8).toFixed(8)} HBAR, separate from the host's accounts`);
  console.log(`escrow    ${escrow.id}: expected runtime (sha256 ${escrow.runtimeSha256}), approvalWindow ${escrow.approvalWindow} s`);
  console.log(`plan      1. deploy CoorReMandateGate(escrow, mandate validity cap ${config.maxMandateValiditySeconds} s), gas limit ${GATE_GAS}`);
  console.log(previous ? `          2. keep the existing log topic ${previous.topic.id} (the previous record is archived, not deleted)` : "          2. create the CoorRe log topic: new ED25519 submit key kept in the private record directory, no admin key");
  console.log("          3. verify the gate on Sourcify (chain 296) with the CoorRe sources only");
  console.log("          4. write the deploy record to the private record directory");
  if (!args.confirmSpend) {
    console.log("dry run   nothing sent; rerun with --confirm-spend to execute");
    return;
  }

  await mkdir(config.recordDir, { recursive: true, mode: 0o700 });
  const client = testnetClient(operator);
  const deployed = await deployDetailed(
    client,
    gateBuild,
    new ContractFunctionParameters().addAddress(escrow.evm).addUint64(config.maxMandateValiditySeconds),
    GATE_GAS,
  );
  const gateId = deployed.contractId;
  const gateEvm = `0x${gateId.toEvmAddress()}`.toLowerCase();
  console.log(`gate      ${gateId} (${deployed.transactionId}), bytecode sent in ${deployed.chunks} blocks of at most 1000 characters`);
  let gateInfo = null;
  for (let attempt = 0; attempt < 30 && gateInfo === null; attempt += 1) {
    try {
      gateInfo = await mirrorGet(`/api/v1/contracts/${gateId}`);
    } catch {
      await new Promise((done) => setTimeout(done, 2_000));
    }
  }
  if (!gateInfo || !hasNoExternalAdmin(gateInfo)) throw new Error(`the gate ${gateId} is deployed but could not be confirmed to have no external admin key; do not use it`);
  console.log("admin     the gate has no external admin key: its admin key is the contract itself");

  let topic;
  if (previous) {
    topic = { ...previous.topic, reused: true };
    console.log(`topic     ${topic.id} reused`);
  } else {
    const logKey = PrivateKey.generateED25519();
    await writeFile(logKeyFile, `${JSON.stringify({ network: "testnet", purpose: "CoorRe log topic submit key", keyType: "ED25519", privateKey: logKey.toStringRaw() })}\n`, { mode: 0o600 });
    await chmod(logKeyFile, 0o600);
    const topicResponse = await new TopicCreateTransaction().setTopicMemo("coorre-log").setSubmitKey(logKey.publicKey).execute(client);
    const topicReceipt = await topicResponse.getReceipt(client);
    if (topicReceipt.status !== Status.Success) throw new Error(`topic create returned ${topicReceipt.status}`);
    topic = {
      id: topicReceipt.topicId.toString(),
      submitKey: logKey.publicKey.toStringRaw(),
      adminKey: null,
      transactionId: topicResponse.transactionId.toString(),
      hashscan: `${TESTNET.hashscan}/topic/${topicReceipt.topicId}`,
    };
    console.log(`topic     ${topic.id} (${topic.transactionId})`);
  }

  const verification = await verifyOnSourcify(gateEvm);
  console.log(`sourcify  ${verification.status}${verification.match ? ` (${verification.match})` : ""}`);

  const record = {
    network: "testnet",
    chainId: TESTNET.chainId,
    hostId: config.hostId,
    createdAt: new Date().toISOString(),
    supersedes: previous ? previous.gate.id : null,
    operator: operator.id.toString(),
    escrow,
    gate: {
      id: gateId.toString(),
      evm: gateEvm,
      transactionId: deployed.transactionId,
      uploadTransactions: deployed.uploads,
      bytecodeSha256: sha256Hex(Buffer.from(gateBuild.bytecode, "hex")),
      maxMandateValiditySeconds: config.maxMandateValiditySeconds,
      adminKey: "the contract itself, so there is no external administrator",
      hashscan: `${TESTNET.hashscan}/contract/${gateId}`,
      verification,
    },
    topic,
  };
  if (previous) await rename(recordFile, join(config.recordDir, `testnet-gate-superseded-${previous.createdAt.replace(/[^0-9]/g, "")}.json`));
  await writeFile(recordFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  console.log("record    written to the private record directory");
  client.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`deploy-gate: ${error.message}`);
    process.exit(1);
  });
}
