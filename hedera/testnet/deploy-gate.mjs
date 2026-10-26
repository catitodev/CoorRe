#!/usr/bin/env node
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ContractCreateFlow, ContractFunctionParameters, PrivateKey, Status, TopicCreateTransaction } from "@hiero-ledger/sdk";
import { GATE_ARTIFACT, loadGate } from "../lib/gate.mjs";
import { hexBytecode } from "../lib/network.mjs";
import { sha256Hex } from "../lib/canonical.mjs";
import { ARTIFACTS_ROOT, REPO_ROOT, isInside } from "../lib/paths.mjs";
import { TESTNET, loadOperator, mirrorCall, mirrorGet, testnetClient } from "./operator.mjs";

const GATE_GAS = 3_000_000;
const ESCROW_VIEWS = { admin: "0xf851a440", financialManager: "0x4eef3f31", approvalWindow: "0x737b68dd" };
const EVM = /^0x[0-9a-fA-F]{40}$/;
const ACCOUNT = /^0\.0\.\d+$/;

export function parseArgs(argv) {
  const args = { hostConfig: null, confirmSpend: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--host-config") args.hostConfig = argv[++i];
    else if (argv[i] === "--confirm-spend") args.confirmSpend = true;
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
  return { ...config, escrow: { ...config.escrow, evm: config.escrow.evm.toLowerCase() }, recordDir: resolve(config.recordDir) };
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
  const logKeyFile = join(config.recordDir, "testnet-log-key.json");
  console.log(`operator  ${operator.id} (${operator.keyType}), balance ${(operator.balanceTinybar / 1e8).toFixed(8)} HBAR, separate from the host's accounts`);
  console.log(`escrow    ${escrow.id}: expected runtime (sha256 ${escrow.runtimeSha256}), approvalWindow ${escrow.approvalWindow} s`);
  console.log("plan      1. deploy CoorReMandateGate(escrow), gas limit " + GATE_GAS);
  console.log("          2. create the CoorRe log topic: new ED25519 submit key kept in the private record directory, no admin key");
  console.log("          3. verify the gate on Sourcify (chain 296) with the CoorRe sources only");
  console.log("          4. write the deploy record to the private record directory");
  if (!args.confirmSpend) {
    console.log("dry run   nothing sent; rerun with --confirm-spend to execute");
    return;
  }
  if (await exists(recordFile)) throw new Error("a gate is already recorded for this host");

  await mkdir(config.recordDir, { recursive: true, mode: 0o700 });
  const client = testnetClient(operator);
  const created = await new ContractCreateFlow()
    .setBytecode(hexBytecode(gateBuild.bytecode))
    .setGas(GATE_GAS)
    .setConstructorParameters(new ContractFunctionParameters().addAddress(escrow.evm))
    .execute(client);
  const gateReceipt = await created.getReceipt(client);
  if (gateReceipt.status !== Status.Success) throw new Error(`gate deploy returned ${gateReceipt.status}`);
  const gateId = gateReceipt.contractId;
  const gateEvm = `0x${gateId.toEvmAddress()}`.toLowerCase();
  console.log(`gate      ${gateId} (${created.transactionId})`);

  let logKey;
  if (await exists(logKeyFile)) {
    logKey = PrivateKey.fromStringED25519(JSON.parse(await readFile(logKeyFile, "utf8")).privateKey);
  } else {
    logKey = PrivateKey.generateED25519();
    await writeFile(logKeyFile, `${JSON.stringify({ network: "testnet", purpose: "CoorRe log topic submit key", keyType: "ED25519", privateKey: logKey.toStringRaw() })}\n`, { mode: 0o600 });
    await chmod(logKeyFile, 0o600);
  }
  const topicResponse = await new TopicCreateTransaction().setTopicMemo("coorre-log").setSubmitKey(logKey.publicKey).execute(client);
  const topicReceipt = await topicResponse.getReceipt(client);
  if (topicReceipt.status !== Status.Success) throw new Error(`topic create returned ${topicReceipt.status}`);
  console.log(`topic     ${topicReceipt.topicId} (${topicResponse.transactionId})`);

  const verification = await verifyOnSourcify(gateEvm);
  console.log(`sourcify  ${verification.status}${verification.match ? ` (${verification.match})` : ""}`);

  const record = {
    network: "testnet",
    chainId: TESTNET.chainId,
    hostId: config.hostId,
    createdAt: new Date().toISOString(),
    operator: operator.id.toString(),
    escrow,
    gate: {
      id: gateId.toString(),
      evm: gateEvm,
      transactionId: created.transactionId.toString(),
      bytecodeSha256: sha256Hex(Buffer.from(gateBuild.bytecode, "hex")),
      hashscan: `${TESTNET.hashscan}/contract/${gateId}`,
      verification,
    },
    topic: {
      id: topicReceipt.topicId.toString(),
      submitKey: logKey.publicKey.toStringRaw(),
      adminKey: null,
      transactionId: topicResponse.transactionId.toString(),
      hashscan: `${TESTNET.hashscan}/topic/${topicReceipt.topicId}`,
    },
  };
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
