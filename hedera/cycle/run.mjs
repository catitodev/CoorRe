import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AccountCreateTransaction,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  Hbar,
  PrivateKey,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
} from "@hiero-ledger/sdk";
import { prepareDecision } from "../adapter/period-escrow.mjs";
import { loadArtifact } from "../lib/artifacts.mjs";
import { jcsHash, mandateId } from "../lib/canonical.mjs";
import { DEFAULT_MAX_VALIDITY_SECONDS, REGISTER_SIGNATURE, VERDICT, hexToBytes32, loadGate, registerMandateCallData, termsFromMandate } from "../lib/gate.mjs";
import { logMessage } from "../lib/log.mjs";
import { accountEvmAddress, call, callDataBytes, clientFor, deploy, evmHex, execute, hasNoExternalAdmin, loadAccounts, mirror, recordOf, requireSuccess, settings, submit } from "../lib/network.mjs";
import { HEDERA_ROOT } from "../lib/paths.mjs";

const PERIOD_STATES = ["None", "PendingApproval", "Approved", "Released", "Rejected", "InReview", "ClosedNoPay"];
const HYBRID = 1;
const PERIOD_AMOUNT = 100_000_000;
const AGREEMENT_ID = "0";
const PERIOD_ID = "1";
const SCORE = 80;
const SCORE_VERSION = 1;

export function cycleMandate({ hostId, chainId, escrow, gate, issuer, delegate, now }) {
  const document = {
    format: "coorre-mandate/1",
    hostId,
    chainId,
    escrow,
    gate,
    issuer,
    delegates: [{ account: delegate.account, address: delegate.address, kind: "human", publicKey: delegate.publicKey }],
    quorum: 1,
    scope: { agreements: "all", modes: ["HYBRID"], verdicts: ["approve", "reject", "review"] },
    validFrom: now - 600,
    validUntil: now + 7 * 24 * 3600,
    autonomyLimit: null,
    evidenceRule: "the decision names the audit document whose SHA-256 is the period auditHash",
  };
  const id = mandateId(document);
  return { id, document, registration: { id, ...termsFromMandate(document) } };
}

export function cycleDecision(profile, { escrow, gate, mandateId: id, delegate, auditHash }) {
  const input = { hostId: profile.hostId, decisionPoint: profile.decisionPoints[0].name, agreementId: AGREEMENT_ID, periodId: PERIOD_ID, auditHash, score: SCORE, scoreVersion: SCORE_VERSION };
  return prepareDecision(profile, input, { network: "solo", escrow, gate, mandateId: id, delegate, verdict: "approve", mode: "A" });
}

export function reviewEventFields(data) {
  const bytes = Buffer.from(data);
  if (bytes.length !== 6 * 32) throw new Error(`ReviewRecorded data has ${bytes.length} bytes, expected 192`);
  const word = (index) => bytes.subarray(index * 32, index * 32 + 32);
  return {
    auditHash: word(0).toString("hex"),
    outcome: word(1).readUInt8(31),
    delegate: `0x${word(2).subarray(12).toString("hex")}`,
    evidenceHash: word(3).toString("hex"),
    blockTimestamp: Number(word(4).readBigUInt64BE(24)),
    concluded: word(5).readUInt8(31) === 1,
  };
}

export function decisionEventFields(data) {
  const bytes = Buffer.from(data);
  if (bytes.length !== 7 * 32) throw new Error(`DecisionAnchored data has ${bytes.length} bytes, expected 224`);
  const word = (index) => bytes.subarray(index * 32, index * 32 + 32);
  return {
    auditHash: word(0).toString("hex"),
    verdict: word(1).readUInt8(31),
    delegate: `0x${word(2).subarray(12).toString("hex")}`,
    kind: word(3).readUInt8(31),
    evidenceHash: word(4).toString("hex"),
    blockTimestamp: Number(word(5).readBigUInt64BE(24)),
    executedOnEscrow: word(6).readUInt8(31) === 1,
  };
}

async function publish(client, topicId, submitKey, entry, maxBytes) {
  const text = logMessage(entry, maxBytes);
  const sent = await submit(client, new TopicMessageSubmitTransaction().setTopicId(topicId).setMessage(text).setMaxChunks(1), [submitKey]);
  if (sent.status !== "SUCCESS") throw new Error(`topic message returned ${sent.status}`);
  return { sequence: Number(sent.receipt.topicSequenceNumber.toString()), transactionId: sent.transactionId, text };
}

function periodState(result) {
  return PERIOD_STATES[result.getUint8(0)];
}

async function main() {
  const config = settings(join(HEDERA_ROOT, ".cache", "cycle", "report.json"));
  const accounts = await loadAccounts(config.accounts);
  const escrowArtifact = await loadArtifact("reference/ReferencePeriodEscrow.sol", "ReferencePeriodEscrow");
  const profile = JSON.parse(await readFile(join(HEDERA_ROOT, "host-profiles", "example.json"), "utf8"));
  const target = profile.targets.find((entry) => entry.network === "solo");
  const gateBuild = await loadGate();
  const admin = clientFor(config, accounts.operator.id, accounts.operator.key);
  const [oracleAccount, producerAccount, strangerAccount] = accounts.ecdsa;
  const oracle = clientFor(config, oracleAccount.id, oracleAccount.key);
  const stranger = clientFor(config, strangerAccount.id, strangerAccount.key);
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

  const adminEvm = evmHex(accounts.operator.id.toEvmAddress());
  const oracleEvm = (await accountEvmAddress(config, oracleAccount.id)).evmAddress;
  const producerEvm = (await accountEvmAddress(config, producerAccount.id)).evmAddress;

  const escrowId = await deploy(admin, escrowArtifact, new ContractFunctionParameters().addAddress(adminEvm).addAddress(adminEvm).addUint256(3600), 3_000_000);
  const escrowEvm = evmHex(escrowId.toEvmAddress());
  check("oracle authorized", (await execute(admin, escrowId, "authorizeOracle", new ContractFunctionParameters().addAddress(oracleEvm))).status === "SUCCESS");
  const gateId = await deploy(admin, gateBuild, new ContractFunctionParameters().addAddress(escrowEvm).addUint64(DEFAULT_MAX_VALIDITY_SECONDS), 3_000_000);
  const gateEvm = evmHex(gateId.toEvmAddress());
  const gateInfo = await mirror(config, `/api/v1/contracts/${gateId}`);
  check("the gate has no external admin key: its admin key is the contract itself", hasNoExternalAdmin(gateInfo), gateInfo.admin_key);
  check("admin points the financial manager to the gate", (await execute(admin, escrowId, "setFinancialManager", new ContractFunctionParameters().addAddress(gateEvm))).status === "SUCCESS");
  const financialManager = evmHex((await call(admin, escrowId, "financialManager")).getAddress(0));
  check("escrow financial manager is the gate", financialManager === gateEvm, financialManager);

  check("HYBRID agreement created", (await execute(admin, escrowId, "createAgreement", new ContractFunctionParameters().addAddress(producerEvm).addUint256(PERIOD_AMOUNT).addUint8(50).addUint8(HYBRID))).status === "SUCCESS");
  check("agreement funded with 6 HBAR", (await execute(admin, escrowId, "deposit", new ContractFunctionParameters().addUint256(0), { hbar: 6 })).status === "SUCCESS");

  const auditDocument = { type: "coorre-cycle-synthetic-audit", agreement: 0, period: 1, measurements: [{ parameter: "turbidity", value: "3.1", unit: "NTU" }], score: 80 };
  const auditHash = jcsHash(auditDocument);
  const submitted = await execute(oracle, escrowId, "submitBatch", new ContractFunctionParameters().addUint256(AGREEMENT_ID).addUint256(PERIOD_ID).addBytes32(hexToBytes32(auditHash)).addUint8(SCORE).addUint16(SCORE_VERSION));
  check("oracle submitted the period", submitted.status === "SUCCESS");
  check("period waits for approval", periodState(await call(admin, escrowId, "getPeriod", new ContractFunctionParameters().addUint256(0).addUint256(1))) === "PendingApproval");

  const logKey = PrivateKey.generateED25519();
  const topic = requireSuccess(await submit(admin, new TopicCreateTransaction().setTopicMemo("coorre-log").setSubmitKey(logKey.publicKey)), "topic create");
  const topicId = topic.receipt.topicId;

  const delegateKey = PrivateKey.generateED25519();
  const delegateAccount = requireSuccess(await submit(admin, new AccountCreateTransaction().setKeyWithoutAlias(delegateKey.publicKey).setInitialBalance(new Hbar(5))), "delegate account create");
  const delegateId = delegateAccount.receipt.accountId;
  const delegateEvm = evmHex(delegateId.toEvmAddress());
  const delegate = clientFor(config, delegateId, delegateKey);

  const mandate = cycleMandate({
    hostId: profile.hostId,
    chainId: target.chainId,
    escrow: escrowEvm,
    gate: gateEvm,
    issuer: adminEvm,
    delegate: { account: delegateId.toString(), address: delegateEvm, publicKey: delegateKey.publicKey.toStringRaw() },
    now: Math.floor(Date.now() / 1000),
  });
  const { id, document: mandateDocument } = mandate;
  const registered = await submit(admin, new ContractExecuteTransaction().setContractId(gateId).setGas(600_000).setFunctionParameters(registerMandateCallData(gateBuild.identifiers[REGISTER_SIGNATURE], mandate.registration)));
  check("issuer registered the mandate", registered.status === "SUCCESS", registered.status);
  const mandateMessage = await publish(admin, topicId, logKey, { kind: "mandate", hostId: profile.hostId, path: "A", mandateId: id, gate: gateEvm, transactionId: registered.transactionId }, profile.log.maxMessageBytes);

  const decideParameters = (verdict, evidenceHash) =>
    new ContractFunctionParameters().addBytes32(hexToBytes32(id)).addUint256(0).addUint256(1).addBytes32(hexToBytes32(auditHash)).addUint8(verdict).addBytes32(hexToBytes32(evidenceHash));
  const strangerTry = await execute(stranger, gateId, "decide", decideParameters(VERDICT.approve, jcsHash({ attempt: "stranger" })));
  check("a non-delegate cannot decide", strangerTry.status === "CONTRACT_REVERT_EXECUTED", strangerTry.status);
  const directTry = await execute(admin, escrowId, "approve", new ContractFunctionParameters().addUint256(0).addUint256(1));
  check("the admin cannot approve around the gate", directTry.status === "CONTRACT_REVERT_EXECUTED", directTry.status);

  const decision = cycleDecision(profile, { escrow: escrowEvm, gate: gateEvm, mandateId: id, delegate: delegateEvm, auditHash });
  const { case_ref: ref, decisionDocument, evidenceHash } = decision;
  const sendDecision = () => submit(delegate, new ContractExecuteTransaction().setContractId(gateId).setGas(600_000).setFunctionParameters(callDataBytes(decision.call.callData)));
  const decided = await sendDecision();
  check("the delegate's decision executed on the escrow", decided.status === "SUCCESS", decided.status);
  const decidedRecord = decided.status === "SUCCESS" ? await recordOf(admin, decided.transactionId) : null;
  const anchoredLog = decidedRecord?.contractFunctionResult?.logs?.find((log) => Buffer.from(log.contractId.toEvmAddress(), "hex").equals(Buffer.from(gateEvm.slice(2), "hex")));
  const anchored = anchoredLog ? decisionEventFields(anchoredLog.data) : null;
  check("DecisionAnchored carries the evidence hash", anchored?.evidenceHash === evidenceHash, anchored?.evidenceHash);
  check("DecisionAnchored names the delegate", anchored?.delegate === delegateEvm, anchored?.delegate);
  check("period approved", periodState(await call(admin, escrowId, "getPeriod", new ContractFunctionParameters().addUint256(0).addUint256(1))) === "Approved");
  const replay = await sendDecision();
  check("the same decision cannot run twice", replay.status === "CONTRACT_REVERT_EXECUTED", replay.status);

  if (!anchored) throw new Error("the decision transaction carries no DecisionAnchored event from the gate");
  const decisionMessage = await publish(admin, topicId, logKey, { ...decision.logFields, transactionId: decided.transactionId, blockTimestamp: anchored.blockTimestamp }, profile.log.maxMessageBytes);

  const messages = await mirror(config, `/api/v1/topics/${topicId}/messages?order=asc`, (body) => (body.messages ?? []).length >= 2);
  const decisionOnMirror = messages.messages.find((message) => message.sequence_number === decisionMessage.sequence);
  check("decision message on the Mirror Node is byte-identical", Buffer.from(decisionOnMirror.message, "base64").toString("utf8") === decisionMessage.text);
  const decisionSecond = Number(decidedRecord.consensusTimestamp.seconds.toString());
  const clockGap = decisionSecond - anchored.blockTimestamp;
  check("block timestamp is at most one block before the consensus second", clockGap >= 0 && clockGap <= 2, { blockTimestamp: anchored.blockTimestamp, consensusSecond: decisionSecond });
  const topicInfo = await mirror(config, `/api/v1/topics/${topicId}`);
  check("log topic has a submit key and no admin key", topicInfo.submit_key !== null && topicInfo.admin_key === null);

  const report = {
    createdAt: new Date().toISOString(),
    network: "solo",
    contracts: { escrow: { id: escrowId.toString(), evm: escrowEvm }, gate: { id: gateId.toString(), evm: gateEvm } },
    topic: { id: topicId.toString(), messages: [mandateMessage.sequence, decisionMessage.sequence] },
    mandate: { id, document: mandateDocument, transactionId: registered.transactionId },
    decision: { case_ref: ref, evidenceHash, document: decisionDocument, transactionId: decided.transactionId, event: anchored, hcsConsensusTimestamp: decisionOnMirror.consensus_timestamp },
    checks,
  };
  await mkdir(dirname(config.report), { recursive: true });
  await writeFile(config.report, `${JSON.stringify(report, null, 2)}\n`);
  for (const entry of checks) console.log(`${entry.ok ? "PASS" : "FAIL"}  ${entry.name}${entry.ok || entry.detail === undefined ? "" : ` (${JSON.stringify(entry.detail)})`}`);
  console.log(`report: ${config.report}`);
  for (const client of [admin, oracle, stranger, delegate]) client.close();
  if (checks.some((entry) => !entry.ok)) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`cycle: ${error.stack ?? error.message}`);
    process.exit(2);
  });
}
