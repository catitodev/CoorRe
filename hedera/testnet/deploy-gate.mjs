#!/usr/bin/env node
import { access, readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ContractCreateFlow, ContractFunctionParameters, PrivateKey, Status, TopicCreateTransaction } from "@hiero-ledger/sdk";
import { BUILD_ROOT } from "../probes/compile.mjs";
import { GATE_ARTIFACT, loadGate } from "../lib/gate.mjs";
import { sha256Hex } from "../lib/canonical.mjs";
import { HEDERA_ROOT } from "../scripts/wata-lock.mjs";
import { LOCAL_DIR, TESTNET, loadOperator, mirrorCall, mirrorGet, testnetClient } from "./operator.mjs";

export const DEPLOYMENT_FILE = join(HEDERA_ROOT, "deployments", "testnet.json");
export const LOG_KEY_FILE = join(LOCAL_DIR, "hedera-testnet-log-key.json");
const GATE_GAS = 3_000_000;
const ESCROW_VIEWS = { admin: "0xf851a440", financialManager: "0x4eef3f31", approvalWindow: "0x737b68dd" };

export function parseArgs(argv) {
  const args = { escrow: null, confirmSpend: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--escrow") args.escrow = argv[++i];
    else if (argv[i] === "--confirm-spend") args.confirmSpend = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(args.escrow ?? "")) throw new Error("--escrow must be the EVM address of the host's PESEscrowV3 on testnet");
  args.escrow = args.escrow.toLowerCase();
  return args;
}

export function wordAddress(result) {
  const hex = String(result).replace(/^0x/, "");
  if (hex.length !== 64) throw new Error("expected one 32-byte word");
  return `0x${hex.slice(24)}`;
}

export function verificationInput(buildInfo, sourceName) {
  const keep = [sourceName, sourceName.replace(/CoorReMandateGate\.sol$/, "IPESEscrowV3.sol")];
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

async function checkEscrow(escrow) {
  const contract = await mirrorGet(`/api/v1/contracts/${escrow}`);
  const runtime = Buffer.from(String(contract.runtime_bytecode).replace(/^0x/, ""), "hex");
  const build = JSON.parse(await readFile(join(BUILD_ROOT, "contracts.json"), "utf8"));
  const pinned = build.contracts.PESEscrowV3.deployedBytecodeSha256;
  const observed = sha256Hex(runtime);
  if (observed !== pinned) throw new Error(`the contract at ${escrow} is not the pinned PESEscrowV3 (runtime sha256 ${observed}, pinned ${pinned})`);
  const admin = wordAddress(await mirrorCall(escrow, ESCROW_VIEWS.admin));
  const financialManager = wordAddress(await mirrorCall(escrow, ESCROW_VIEWS.financialManager));
  const approvalWindow = BigInt(await mirrorCall(escrow, ESCROW_VIEWS.approvalWindow)).toString();
  return { id: contract.contract_id, evm: escrow, runtimeSha256: observed, admin, financialManager, approvalWindow };
}

async function verifyOnSourcify(gateEvm, gateBuild) {
  const artifact = JSON.parse(await readFile(GATE_ARTIFACT, "utf8"));
  const buildInfo = JSON.parse(await readFile(join(GATE_ARTIFACT, "..", "..", "..", "build-info", `${artifact.buildInfoId}.json`), "utf8"));
  const body = {
    stdJsonInput: verificationInput(buildInfo, artifact.inputSourceName),
    compilerVersion: buildInfo.solcLongVersion,
    contractIdentifier: `${artifact.inputSourceName}:${artifact.contractName}`,
  };
  const submitted = await fetch(`${TESTNET.sourcify}/v2/verify/${TESTNET.chainId}/${gateEvm}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const job = await submitted.json();
  if (!job.verificationId) return { status: "not-submitted", response: job };
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const state = await (await fetch(`${TESTNET.sourcify}/v2/verify/${job.verificationId}`)).json();
    if (state.isJobCompleted) return { status: state.error ? "failed" : "completed", verificationId: job.verificationId, match: state.contract?.match ?? null, error: state.error ?? null };
  }
  return { status: "pending", verificationId: job.verificationId };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const operator = await loadOperator();
  const gateBuild = await loadGate();
  const escrow = await checkEscrow(args.escrow);
  console.log(`operator  ${operator.id} (${operator.keyType}), balance ${(operator.balanceTinybar / 1e8).toFixed(8)} HBAR`);
  console.log(`escrow    ${escrow.id} ${escrow.evm}: pinned PESEscrowV3 runtime (sha256 ${escrow.runtimeSha256})`);
  console.log(`          admin ${escrow.admin}, financialManager ${escrow.financialManager}, approvalWindow ${escrow.approvalWindow} s`);
  console.log("plan      1. deploy CoorReMandateGate(escrow), gas limit " + GATE_GAS);
  console.log("          2. create the CoorRe log topic: submit key = a new ED25519 log key kept in .local/, no admin key");
  console.log("          3. verify the gate on Sourcify (chain 296) and write hedera/deployments/testnet.json");
  if (!args.confirmSpend) {
    console.log("dry run   nothing sent; rerun with --confirm-spend to execute");
    return;
  }
  if (await exists(DEPLOYMENT_FILE)) throw new Error(`${DEPLOYMENT_FILE} exists: a gate is already deployed`);

  const client = testnetClient(operator);
  const created = await new ContractCreateFlow()
    .setBytecode(gateBuild.bytecode)
    .setGas(GATE_GAS)
    .setConstructorParameters(new ContractFunctionParameters().addAddress(escrow.evm))
    .execute(client);
  const gateReceipt = await created.getReceipt(client);
  if (gateReceipt.status !== Status.Success) throw new Error(`gate deploy returned ${gateReceipt.status}`);
  const gateId = gateReceipt.contractId;
  const gateEvm = `0x${gateId.toEvmAddress()}`.toLowerCase();
  console.log(`gate      ${gateId} ${gateEvm} (${created.transactionId})`);

  let logKey;
  if (await exists(LOG_KEY_FILE)) {
    logKey = PrivateKey.fromStringED25519(JSON.parse(await readFile(LOG_KEY_FILE, "utf8")).privateKey);
  } else {
    logKey = PrivateKey.generateED25519();
    await writeFile(LOG_KEY_FILE, `${JSON.stringify({ network: "testnet", purpose: "CoorRe log topic submit key", keyType: "ED25519", privateKey: logKey.toStringRaw() })}\n`, { mode: 0o600 });
    await chmod(LOG_KEY_FILE, 0o600);
  }
  const topicResponse = await new TopicCreateTransaction().setTopicMemo("coorre-log").setSubmitKey(logKey.publicKey).execute(client);
  const topicReceipt = await topicResponse.getReceipt(client);
  if (topicReceipt.status !== Status.Success) throw new Error(`topic create returned ${topicReceipt.status}`);
  console.log(`topic     ${topicReceipt.topicId} (${topicResponse.transactionId})`);

  const verification = await verifyOnSourcify(gateEvm, gateBuild);
  console.log(`sourcify  ${verification.status}${verification.match ? ` (${verification.match})` : ""}`);

  const record = {
    network: "testnet",
    chainId: TESTNET.chainId,
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
  await mkdir(join(HEDERA_ROOT, "deployments"), { recursive: true });
  await writeFile(DEPLOYMENT_FILE, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`record    ${DEPLOYMENT_FILE}`);
  client.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`deploy-gate: ${error.message}`);
    process.exit(1);
  });
}
