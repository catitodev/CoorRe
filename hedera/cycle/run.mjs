import { mkdir, writeFile } from "node:fs/promises";
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
import { loadArtifact } from "../lib/artifacts.mjs";
import { caseId, caseRef, jcs, jcsHash, mandateId } from "../lib/canonical.mjs";
import { REGISTER_SIGNATURE, VERDICT, hexToBytes32, loadGate, registerMandateCallData } from "../lib/gate.mjs";
import { accountEvmAddress, call, clientFor, deploy, evmHex, execute, loadAccounts, mirror, recordOf, settings, submit } from "../lib/network.mjs";
import { HEDERA_ROOT } from "../lib/paths.mjs";

const PERIOD_STATES = ["None", "PendingApproval", "Approved", "Released", "Rejected", "InReview", "ClosedNoPay"];
const HYBRID = 1;
const PERIOD_AMOUNT = 100_000_000;
const MAX_MESSAGE_BYTES = 1024;

export function logMessage(entry) {
  const text = jcs(entry);
  const size = Buffer.byteLength(text, "utf8");
  if (size > MAX_MESSAGE_BYTES) throw new Error(`log message of ${size} bytes exceeds ${MAX_MESSAGE_BYTES}`);
  return text;
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

async function publish(client, topicId, submitKey, entry) {
  const text = logMessage(entry);
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
  const gateId = await deploy(admin, gateBuild, new ContractFunctionParameters().addAddress(escrowEvm), 3_000_000);
  const gateEvm = evmHex(gateId.toEvmAddress());
  check("admin points the financial manager to the gate", (await execute(admin, escrowId, "setFinancialManager", new ContractFunctionParameters().addAddress(gateEvm))).status === "SUCCESS");
  const financialManager = evmHex((await call(admin, escrowId, "financialManager")).getAddress(0));
  check("escrow financial manager is the gate", financialManager === gateEvm, financialManager);

  check("HYBRID agreement created", (await execute(admin, escrowId, "createAgreement", new ContractFunctionParameters().addAddress(producerEvm).addUint256(PERIOD_AMOUNT).addUint8(50).addUint8(HYBRID))).status === "SUCCESS");

  const auditDocument = { type: "coorre-cycle-synthetic-audit", agreement: 0, period: 1, measurements: [{ parameter: "turbidity", value: "3.1", unit: "NTU" }], score: 80 };
  const auditHash = jcsHash(auditDocument);
  const submitted = await execute(oracle, escrowId, "submitBatch", new ContractFunctionParameters().addUint256(0).addUint256(1).addBytes32(hexToBytes32(auditHash)).addUint8(80).addUint16(1));
  check("oracle submitted the period", submitted.status === "SUCCESS");
  check("period waits for approval", periodState(await call(admin, escrowId, "getPeriod", new ContractFunctionParameters().addUint256(0).addUint256(1))) === "PendingApproval");

  const logKey = PrivateKey.generateED25519();
  const topic = await submit(admin, new TopicCreateTransaction().setTopicMemo("coorre-log").setSubmitKey(logKey.publicKey));
  const topicId = topic.receipt.topicId;

  const delegateKey = PrivateKey.generateED25519();
  const delegateAccount = await submit(admin, new AccountCreateTransaction().setKeyWithoutAlias(delegateKey.publicKey).setInitialBalance(new Hbar(5)));
  const delegateId = delegateAccount.receipt.accountId;
  const delegateEvm = evmHex(delegateId.toEvmAddress());
  const delegate = clientFor(config, delegateId, delegateKey);

  const now = Math.floor(Date.now() / 1000);
  const mandateDocument = {
    format: "coorre-mandate/1",
    hostId: "example-host",
    chainId: 298,
    escrow: escrowEvm,
    gate: gateEvm,
    issuer: adminEvm,
    delegates: [{ account: delegateId.toString(), address: delegateEvm, kind: "human", publicKey: delegateKey.publicKey.toStringRaw() }],
    quorum: 1,
    scope: { agreements: "all", modes: ["HYBRID"], verdicts: ["approve", "reject", "review"] },
    validFrom: now - 600,
    validUntil: now + 7 * 24 * 3600,
    autonomyLimit: null,
    evidenceRule: "the decision names the audit document whose SHA-256 is the period auditHash",
  };
  const id = mandateId(mandateDocument);
  const registered = await submit(
    admin,
    new ContractExecuteTransaction()
      .setContractId(gateId)
      .setGas(600_000)
      .setFunctionParameters(
        registerMandateCallData(gateBuild.identifiers[REGISTER_SIGNATURE], {
          id,
          terms: {
            validFrom: mandateDocument.validFrom,
            validUntil: mandateDocument.validUntil,
            quorum: 1,
            allAgreements: true,
            allowApprove: true,
            allowReject: true,
            hasAutonomyLimit: false,
            autonomyLimit: 0,
          },
          delegates: [{ address: delegateEvm, kind: "human" }],
          agreementIds: [],
        }),
      ),
  );
  check("issuer registered the mandate", registered.status === "SUCCESS", registered.status);
  const mandateMessage = await publish(admin, topicId, logKey, { kind: "mandate", hostId: "example-host", mandateId: id, gate: gateEvm, transactionId: registered.transactionId });

  const decideParameters = (verdict, evidenceHash) =>
    new ContractFunctionParameters().addBytes32(hexToBytes32(id)).addUint256(0).addUint256(1).addBytes32(hexToBytes32(auditHash)).addUint8(verdict).addBytes32(hexToBytes32(evidenceHash));
  const strangerTry = await execute(stranger, gateId, "decide", decideParameters(VERDICT.approve, jcsHash({ attempt: "stranger" })));
  check("a non-delegate cannot decide", strangerTry.status === "CONTRACT_REVERT_EXECUTED", strangerTry.status);
  const directTry = await execute(admin, escrowId, "approve", new ContractFunctionParameters().addUint256(0).addUint256(1));
  check("the admin cannot approve around the gate", directTry.status === "CONTRACT_REVERT_EXECUTED", directTry.status);

  const ref = caseRef("example-host", 298, escrowEvm, 0, 1);
  const decisionDocument = { format: "coorre-decision/1", case_ref: ref, case_id: caseId(ref), mandateId: id, verdict: "approve", auditHash, agreementId: "0", periodId: "1", delegate: delegateId.toString() };
  const evidenceHash = jcsHash(decisionDocument);
  const decided = await execute(delegate, gateId, "decide", decideParameters(VERDICT.approve, evidenceHash));
  check("the delegate's decision executed on the escrow", decided.status === "SUCCESS", decided.status);
  const anchoredLog = decided.functionResult?.logs?.find((log) => Buffer.from(log.contractId.toEvmAddress(), "hex").equals(Buffer.from(gateEvm.slice(2), "hex")));
  const anchored = anchoredLog ? decisionEventFields(anchoredLog.data) : null;
  check("DecisionAnchored carries the evidence hash", anchored?.evidenceHash === evidenceHash, anchored?.evidenceHash);
  check("DecisionAnchored names the delegate", anchored?.delegate === delegateEvm, anchored?.delegate);
  check("period approved", periodState(await call(admin, escrowId, "getPeriod", new ContractFunctionParameters().addUint256(0).addUint256(1))) === "Approved");
  const replay = await execute(delegate, gateId, "decide", decideParameters(VERDICT.approve, evidenceHash));
  check("the same decision cannot run twice", replay.status === "CONTRACT_REVERT_EXECUTED", replay.status);

  const decisionMessage = await publish(admin, topicId, logKey, {
    kind: "decision",
    case_ref: ref,
    mandateId: id,
    evidenceHash,
    transactionId: decided.transactionId,
    blockTimestamp: anchored?.blockTimestamp ?? null,
  });

  const messages = await mirror(config, `/api/v1/topics/${topicId}/messages?order=asc`, (body) => (body.messages ?? []).length >= 2);
  const decisionOnMirror = messages.messages.find((message) => message.sequence_number === decisionMessage.sequence);
  check("decision message on the Mirror Node is byte-identical", Buffer.from(decisionOnMirror.message, "base64").toString("utf8") === decisionMessage.text);
  const record = await recordOf(admin, decided.transactionId);
  const decisionSecond = Number(record.consensusTimestamp.seconds.toString());
  const clockGap = anchored ? decisionSecond - anchored.blockTimestamp : null;
  check("block timestamp is at most one block before the consensus second", clockGap !== null && clockGap >= 0 && clockGap <= 2, { blockTimestamp: anchored?.blockTimestamp, consensusSecond: decisionSecond });
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
