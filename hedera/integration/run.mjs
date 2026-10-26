import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ContractExecuteTransaction, ContractFunctionParameters, PrivateKey, TopicCreateTransaction, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";
import { JsonRpcProvider, Wallet } from "ethers";
import { prepareDecision } from "../adapter/wata.mjs";
import { decisionEventFields } from "../cycle/run.mjs";
import { BUILD_ROOT } from "../probes/compile.mjs";
import { jcs, jcsHash, mandateId } from "../lib/canonical.mjs";
import { REGISTER_SIGNATURE, loadGate, registerMandateCallData } from "../lib/gate.mjs";
import { accountEvmAddress, call, clientFor, deploy, evmHex, execute, loadAccounts, mirror, recordOf, settings, submit } from "../lib/network.mjs";
import { HEDERA_ROOT } from "../scripts/wata-lock.mjs";

const PERIOD_STATES = ["None", "PendingApproval", "Approved", "Released", "Rejected", "InReview", "ClosedNoPay"];
const HYBRID = 1;
const SHORT_WINDOW = 5;

export function callDataBytes(callData) {
  if (!/^0x([0-9a-f]{2})+$/.test(callData)) throw new Error("call data must be lowercase 0x-prefixed hex");
  return Buffer.from(callData.slice(2), "hex");
}

export function indexedAddress(topic) {
  const bytes = Buffer.from(topic);
  if (bytes.length !== 32) throw new Error("an indexed address topic has 32 bytes");
  return `0x${bytes.subarray(12).toString("hex")}`;
}

async function main() {
  const config = settings(join(HEDERA_ROOT, ".cache", "integration", "report.json"));
  const accounts = await loadAccounts(config.accounts);
  const build = JSON.parse(await readFile(join(BUILD_ROOT, "contracts.json"), "utf8"));
  const gateBuild = await loadGate();
  const admin = clientFor(config, accounts.operator.id, accounts.operator.key);
  const [oracleAccount, producerAccount, walletAccount] = accounts.ecdsa;
  const oracle = clientFor(config, oracleAccount.id, oracleAccount.key);
  const wallet = clientFor(config, walletAccount.id, walletAccount.key);
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
  const steps = [];

  const adminEvm = evmHex(accounts.operator.id.toEvmAddress());
  const oracleEvm = (await accountEvmAddress(config, oracleAccount.id)).evmAddress;
  const producerEvm = (await accountEvmAddress(config, producerAccount.id)).evmAddress;
  const walletEvm = (await accountEvmAddress(config, walletAccount.id)).evmAddress;

  const oracleManagerId = await deploy(admin, build.contracts.OracleManager, null, 1_000_000);
  await execute(admin, oracleManagerId, "authorizeOracle", new ContractFunctionParameters().addAddress(oracleEvm));
  const escrowId = await deploy(
    admin,
    build.contracts.PESEscrowV3,
    new ContractFunctionParameters().addAddress(evmHex(oracleManagerId.toEvmAddress())).addAddress(adminEvm).addAddress(walletEvm).addUint256(3600),
    3_000_000,
  );
  const escrowEvm = evmHex(escrowId.toEvmAddress());
  await execute(admin, escrowId, "createAgreement", new ContractFunctionParameters().addAddress(producerEvm).addUint256(100_000_000).addUint8(50).addUint8(HYBRID));
  await execute(admin, escrowId, "deposit", new ContractFunctionParameters().addUint256(0), { hbar: 6 });

  const logKey = PrivateKey.generateED25519();
  const topicId = (await submit(admin, new TopicCreateTransaction().setTopicMemo("coorre-log").setSubmitKey(logKey.publicKey))).receipt.topicId;
  const published = [];
  const publish = async (text) => {
    const sent = await submit(admin, new TopicMessageSubmitTransaction().setTopicId(topicId).setMessage(text).setMaxChunks(1), [logKey]);
    if (sent.status !== "SUCCESS") throw new Error(`topic message returned ${sent.status}`);
    published.push({ sequence: Number(sent.receipt.topicSequenceNumber.toString()), text });
    return sent;
  };

  const auditOf = (periodId) => jcsHash({ type: "coorre-integration-synthetic-audit", agreement: 0, period: periodId, score: 80 });
  const submitPeriod = async (periodId, auditHash) =>
    (await execute(oracle, escrowId, "submitBatch", new ContractFunctionParameters().addUint256(0).addUint256(periodId).addBytes32(Buffer.from(auditHash, "hex")).addUint8(80).addUint16(1))).status;
  const stateOf = async (periodId) => PERIOD_STATES[(await call(admin, escrowId, "getPeriod", new ContractFunctionParameters().addUint256(0).addUint256(periodId))).getUint8(0)];
  const hostInput = async (periodId) => {
    const period = await call(admin, escrowId, "getPeriod", new ContractFunctionParameters().addUint256(0).addUint256(periodId));
    return {
      hostId: "wata",
      decisionPoint: "approve-or-reject-period",
      agreementId: "0",
      periodId: String(periodId),
      auditHash: Buffer.from(period.getBytes32(1)).toString("hex"),
      score: Number(period.getUint8(2)),
      scoreVersion: Number(period.getUint16(3)),
    };
  };
  const gateIdRef = { id: null };
  const send = async (client, prepared) =>
    submit(client, new ContractExecuteTransaction().setContractId(prepared.call.to === escrowEvm ? escrowId : gateIdRef.id).setGas(600_000).setFunctionParameters(callDataBytes(prepared.call.callData)));

  const now = Math.floor(Date.now() / 1000);
  const mandateDocument = {
    format: "coorre-mandate/1",
    hostId: "wata",
    chainId: 298,
    escrow: escrowEvm,
    issuer: adminEvm,
    delegates: [{ account: walletAccount.id.toString(), address: walletEvm, kind: "human" }],
    quorum: 1,
    scope: { agreements: "all", modes: ["HYBRID"], verdicts: ["approve", "reject", "review"] },
    validFrom: now - 600,
    validUntil: now + 7 * 24 * 3600,
    autonomyLimit: null,
    evidenceRule: "the decision names the audit document whose SHA-256 is the period auditHash",
  };
  const id = mandateId(mandateDocument);
  await publish(jcs({ kind: "mandate", path: "B", hostId: "wata", mandateId: id, escrow: escrowEvm }));

  const audit1 = auditOf(1);
  check("B: oracle submitted period 1", (await submitPeriod(1, audit1)) === "SUCCESS");
  const decisionB = prepareDecision(await hostInput(1), { network: "solo", escrow: escrowEvm, mandateId: id, delegate: walletEvm, verdict: "approve", mode: "B" });
  const sentB = await send(wallet, decisionB);
  check("B: the financial manager's wallet approves with the adapter's call data", sentB.status === "SUCCESS", sentB.status);
  check("B: period 1 approved", (await stateOf(1)) === "Approved");
  const recordB = await recordOf(admin, sentB.transactionId);
  const approvedB = recordB.contractFunctionResult.logs.find((log) => log.topics.length === 4);
  check("B: the on-chain approver is the delegate named in the decision", approvedB && indexedAddress(approvedB.topics[3]) === decisionB.decisionDocument.delegate);
  await publish(jcs({ ...JSON.parse(decisionB.logMessage), transactionId: sentB.transactionId }));
  steps.push({ path: "B", periodId: 1, transactionId: sentB.transactionId, evidenceHash: decisionB.evidenceHash });

  const gateId = await deploy(admin, { bytecode: gateBuild.bytecode }, new ContractFunctionParameters().addAddress(escrowEvm), 3_000_000);
  gateIdRef.id = gateId;
  const gateEvm = evmHex(gateId.toEvmAddress());
  const switched = await execute(admin, escrowId, "setFinancialManager", new ContractFunctionParameters().addAddress(gateEvm));
  check("switch: the admin points the financial manager to the gate", switched.status === "SUCCESS");
  const changed = switched.functionResult.logs.find((log) => log.topics.length === 3);
  check("switch: FinancialManagerChanged names the wallet and the gate", changed && indexedAddress(changed.topics[1]) === walletEvm && indexedAddress(changed.topics[2]) === gateEvm);
  await publish(jcs({ kind: "admin", action: "setFinancialManager(address)", escrow: escrowEvm, from: walletEvm, to: gateEvm, transactionId: switched.transactionId }));

  const registered = await submit(
    admin,
    new ContractExecuteTransaction()
      .setContractId(gateId)
      .setGas(600_000)
      .setFunctionParameters(
        registerMandateCallData(gateBuild.identifiers[REGISTER_SIGNATURE], {
          id,
          terms: { validFrom: mandateDocument.validFrom, validUntil: mandateDocument.validUntil, quorum: 1, allAgreements: true, allowApprove: true, allowReject: true, hasAutonomyLimit: false, autonomyLimit: 0 },
          delegates: [{ address: walletEvm, kind: "human" }],
          agreementIds: [],
        }),
      ),
  );
  check("A: the issuer registers the same mandate in the gate", registered.status === "SUCCESS", registered.status);
  await publish(jcs({ kind: "mandate", path: "A", hostId: "wata", mandateId: id, gate: gateEvm, transactionId: registered.transactionId }));

  const audit2 = auditOf(2);
  check("A: oracle submitted period 2", (await submitPeriod(2, audit2)) === "SUCCESS");
  const oldPath = prepareDecision(await hostInput(2), { network: "solo", escrow: escrowEvm, mandateId: id, delegate: walletEvm, verdict: "approve", mode: "B" });
  const oldSent = await send(wallet, oldPath);
  check("A: the wallet can no longer approve around the gate", oldSent.status === "CONTRACT_REVERT_EXECUTED", oldSent.status);
  const decisionA = prepareDecision(await hostInput(2), { network: "solo", escrow: escrowEvm, gate: gateEvm, mandateId: id, delegate: walletEvm, verdict: "approve", mode: "A" });
  const sentA = await send(wallet, decisionA);
  check("A: the delegate approves through the gate with the adapter's call data", sentA.status === "SUCCESS", sentA.status);
  check("A: period 2 approved", (await stateOf(2)) === "Approved");
  const recordA = await recordOf(admin, sentA.transactionId);
  const approvedA = recordA.contractFunctionResult.logs.find((log) => log.topics.length === 4 && indexedAddress(log.topics[3]) === gateEvm);
  check("A: the on-chain approver is the gate", Boolean(approvedA));
  await publish(jcs({ ...JSON.parse(decisionA.logMessage), transactionId: sentA.transactionId }));
  steps.push({ path: "A", periodId: 2, transactionId: sentA.transactionId, evidenceHash: decisionA.evidenceHash });

  const audit3 = auditOf(3);
  await submitPeriod(3, audit3);
  const rejectA = prepareDecision(await hostInput(3), { network: "solo", escrow: escrowEvm, gate: gateEvm, mandateId: id, delegate: walletEvm, verdict: "reject", mode: "A" });
  const sentReject = await send(wallet, rejectA);
  check("A: the delegate rejects period 3 through the gate", sentReject.status === "SUCCESS" && (await stateOf(3)) === "Rejected", sentReject.status);
  await publish(jcs({ ...JSON.parse(rejectA.logMessage), transactionId: sentReject.transactionId }));

  const provider = new JsonRpcProvider(config.relay, 298, { staticNetwork: true });
  const rpcWallet = new Wallet(`0x${walletAccount.key.toStringRaw()}`, provider);
  check("JSON-RPC: the wallet key controls the delegate's address", rpcWallet.address.toLowerCase() === walletEvm, rpcWallet.address);
  await submitPeriod(5, auditOf(5));
  const viaRelay = prepareDecision(await hostInput(5), { network: "solo", escrow: escrowEvm, gate: gateEvm, mandateId: id, delegate: walletEvm, verdict: "approve", mode: "A" });
  const relayGasPrice = BigInt(await provider.send("eth_gasPrice", []));
  const relayTx = await rpcWallet.sendTransaction({ type: 0, to: viaRelay.call.to, data: viaRelay.call.callData, value: 0n, gasLimit: 600_000n, gasPrice: relayGasPrice });
  let relayReceipt = null;
  for (let attempt = 0; attempt < 60 && relayReceipt === null; attempt += 1) {
    relayReceipt = await provider.getTransactionReceipt(relayTx.hash);
    if (relayReceipt === null) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  check("JSON-RPC: a wallet signs the adapter's call data and the relay accepts it", relayReceipt?.status === 1 && relayReceipt.hash === relayTx.hash, relayReceipt?.status);
  check("JSON-RPC: period 5 approved", (await stateOf(5)) === "Approved");
  const relayAnchored = (relayReceipt?.logs ?? []).find((log) => log.address.toLowerCase() === gateEvm && log.topics.length === 4);
  check("JSON-RPC: the gate saw the wallet as the delegate", relayAnchored && decisionEventFields(Buffer.from(relayAnchored.data.slice(2), "hex")).delegate === walletEvm);
  await publish(jcs({ ...JSON.parse(viaRelay.logMessage), transactionHash: relayTx.hash }));
  steps.push({ path: "A", via: "json-rpc", periodId: 5, transactionHash: relayTx.hash, gasPriceWeibar: relayGasPrice.toString(), evidenceHash: viaRelay.evidenceHash });
  provider.destroy();

  const shortened = await execute(admin, escrowId, "setApprovalWindow", new ContractFunctionParameters().addUint256(SHORT_WINDOW));
  await publish(jcs({ kind: "admin", action: "setApprovalWindow(uint256)", escrow: escrowEvm, value: SHORT_WINDOW, transactionId: shortened.transactionId }));
  const audit4 = auditOf(4);
  await submitPeriod(4, audit4);
  const deadline = Number((await call(admin, escrowId, "getPeriod", new ContractFunctionParameters().addUint256(0).addUint256(4))).getUint64(5).toString());
  let expired = null;
  for (let attempt = 0; attempt < 30 && expired?.status !== "SUCCESS"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expired = await execute(wallet, escrowId, "expire", new ContractFunctionParameters().addUint256(0).addUint256(4));
  }
  check("review: period 4 expires into InReview after its deadline", expired?.status === "SUCCESS" && (await stateOf(4)) === "InReview", { deadline, status: expired?.status });
  const late = prepareDecision({ ...(await hostInput(4)) }, { network: "solo", escrow: escrowEvm, gate: gateEvm, mandateId: id, delegate: walletEvm, verdict: "approve", mode: "A" });
  const lateSent = await send(wallet, late);
  check("review: the gate refuses a decision on a period in review", lateSent.status === "CONTRACT_REVERT_EXECUTED", lateSent.status);
  const review = { kind: "review", verdict: "resubmit", case_ref: late.case_ref, mandateId: id, delegate: walletEvm, auditHash: audit4, reason: "new measurements for the same period" };
  const reviewEvidence = jcsHash(review);
  await publish(jcs({ ...review, evidenceHash: reviewEvidence }));
  const audit4b = auditOf(41);
  check("review: the oracle resubmits with a new audit hash", (await submitPeriod(4, audit4b)) === "SUCCESS" && (await stateOf(4)) === "PendingApproval");
  const restored = await execute(admin, escrowId, "setApprovalWindow", new ContractFunctionParameters().addUint256(3600));
  await publish(jcs({ kind: "admin", action: "setApprovalWindow(uint256)", escrow: escrowEvm, value: 3600, transactionId: restored.transactionId }));

  const messages = await mirror(config, `/api/v1/topics/${topicId}/messages?order=asc&limit=100`, (body) => (body.messages ?? []).length >= published.length);
  const onMirror = new Map(messages.messages.map((message) => [message.sequence_number, Buffer.from(message.message, "base64").toString("utf8")]));
  check("log: every published message is on the Mirror Node byte-identical and in order", published.every((entry) => onMirror.get(entry.sequence) === entry.text), published.length);

  const report = {
    createdAt: new Date().toISOString(),
    network: "solo",
    contracts: { escrow: { id: escrowId.toString(), evm: escrowEvm }, gate: { id: gateId.toString(), evm: gateEvm } },
    wallet: { account: walletAccount.id.toString(), evm: walletEvm },
    topic: { id: topicId.toString(), messages: published.length },
    mandateId: id,
    steps,
    checks,
  };
  await mkdir(dirname(config.report), { recursive: true });
  await writeFile(config.report, `${JSON.stringify(report, null, 2)}\n`);
  for (const entry of checks) console.log(`${entry.ok ? "PASS" : "FAIL"}  ${entry.name}${entry.ok || entry.detail === undefined ? "" : ` (${JSON.stringify(entry.detail)})`}`);
  console.log(`report: ${config.report}`);
  for (const client of [admin, oracle, wallet]) client.close();
  if (checks.some((entry) => !entry.ok)) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`integration: ${error.stack ?? error.message}`);
    process.exit(2);
  });
}
