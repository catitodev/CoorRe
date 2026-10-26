import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  ContractExecuteTransaction,
  ContractFunctionParameters,
  ContractId,
  KeyList,
  PrivateKey,
  TopicCreateTransaction,
  TopicDeleteTransaction,
  TopicMessageSubmitTransaction,
  TopicUpdateTransaction,
} from "@hiero-ledger/sdk";
import { BUILD_ROOT } from "./compile.mjs";
import {
  accountEvmAddress,
  call,
  clientFor,
  deploy,
  evmHex,
  execute,
  loadAccounts,
  mirror,
  mirrorTransactionId,
  msgValueUnit,
  recordOf,
  revertSelector,
  rpc,
  settings,
  submit,
  timestampSeconds,
} from "../lib/network.mjs";
import { HEDERA_ROOT } from "../scripts/wata-lock.mjs";

const PERIOD_STATES = ["None", "PendingApproval", "Approved", "Released", "Rejected", "InReview", "ClosedNoPay"];
const HYBRID = 1;

async function observe(config, client, probeId, hbar) {
  const executed = await execute(client, probeId, "observe", null, { hbar, gas: 100_000 });
  if (executed.status !== "SUCCESS") throw new Error(`observe returned ${executed.status}`);
  const result = executed.functionResult;
  const contractTimestamp = BigInt(result.getUint256(3).toString());
  const consensus = executed.record.consensusTimestamp;
  const detail = await mirror(config, `/api/v1/contracts/results/${mirrorTransactionId(executed.transactionId)}`, (body) => body.block_number != null);
  const block = await mirror(config, `/api/v1/blocks/${detail.block_number}`);
  return {
    transactionId: executed.transactionId,
    sender: evmHex(result.getAddress(0)),
    origin: evmHex(result.getAddress(1)),
    value: result.getUint256(2).toString(),
    contractTimestamp: contractTimestamp.toString(),
    contractBlockNumber: result.getUint256(4).toString(),
    recordConsensusTimestamp: `${consensus.seconds.toString()}.${String(consensus.nanos.toString()).padStart(9, "0")}`,
    mirrorBlockNumber: detail.block_number,
    mirrorBlockTimestampFrom: block.timestamp?.from ?? null,
    mirrorBlockTimestampTo: block.timestamp?.to ?? null,
    equalsBlockFrom: block.timestamp?.from ? contractTimestamp === timestampSeconds(block.timestamp.from) : null,
    equalsTransactionSecond: contractTimestamp === BigInt(consensus.seconds.toString()),
  };
}

async function probeAddressesAndTime(config, ctx) {
  const operatorObservations = [];
  for (let i = 0; i < 3; i += 1) operatorObservations.push(await observe(config, ctx.operatorClient, ctx.probeId, 1));
  const ecdsaObservation = await observe(config, ctx.ecdsaClients[2], ctx.probeId, 0);
  const operatorMirror = await accountEvmAddress(config, ctx.accounts.operator.id);
  const ecdsaMirror = await accountEvmAddress(config, ctx.accounts.ecdsa[2].id);
  const operatorLongZero = evmHex(ctx.accounts.operator.id.toEvmAddress());
  const ecdsaAlias = evmHex(ctx.accounts.ecdsa[2].key.publicKey.toEvmAddress());
  const unit = msgValueUnit(operatorObservations[0].value, 1);
  ctx.operatorSender = operatorObservations[0].sender;
  return [
    {
      id: "P7",
      question: "Which msg.sender does a contract see for an ED25519 account and for an ECDSA account calling through ContractExecuteTransaction?",
      status: "verified",
      result: {
        ed25519: { account: ctx.accounts.operator.id.toString(), sender: operatorObservations[0].sender, longZero: operatorLongZero, mirrorEvmAddress: operatorMirror.evmAddress, mirrorKeyType: operatorMirror.keyType, senderIsLongZero: operatorObservations[0].sender === operatorLongZero },
        ecdsa: { account: ctx.accounts.ecdsa[2].id.toString(), sender: ecdsaObservation.sender, alias: ecdsaAlias, mirrorEvmAddress: ecdsaMirror.evmAddress, mirrorKeyType: ecdsaMirror.keyType, senderIsAlias: ecdsaObservation.sender === ecdsaAlias },
        originEqualsSender: operatorObservations[0].origin === operatorObservations[0].sender,
      },
    },
    {
      id: "P5-sdk",
      question: "Which unit does msg.value carry when 1 HBAR is sent with ContractExecuteTransaction.setPayableAmount?",
      status: unit === "unknown" ? "failed" : "verified",
      result: { sentHbar: 1, observed: operatorObservations[0].value, unit },
    },
    {
      id: "P2",
      question: "Does block.timestamp equal the consensus timestamp of the first transaction of the block (HIP-415), and how far is it from the calling transaction?",
      status: "verified",
      result: { observations: [...operatorObservations, ecdsaObservation] },
    },
  ];
}

async function probeEscrow(config, ctx) {
  const build = ctx.build.contracts;
  const oracle = ctx.accounts.ecdsa[0];
  const producer = ctx.accounts.ecdsa[1];
  const oracleEvm = (await accountEvmAddress(config, oracle.id)).evmAddress ?? evmHex(oracle.key.publicKey.toEvmAddress());
  const producerEvm = (await accountEvmAddress(config, producer.id)).evmAddress ?? evmHex(producer.key.publicKey.toEvmAddress());
  const oracleManagerId = await deploy(ctx.operatorClient, build.OracleManager, null, 1_000_000);
  const probeEvm = evmHex(ctx.probeId.toEvmAddress());
  const escrowId = await deploy(
    ctx.operatorClient,
    build.PESEscrowV3,
    new ContractFunctionParameters()
      .addAddress(evmHex(oracleManagerId.toEvmAddress()))
      .addAddress(ctx.operatorSender)
      .addAddress(probeEvm)
      .addUint256(3600),
    3_000_000,
  );
  const steps = {};
  steps.authorizeOracle = (await execute(ctx.operatorClient, oracleManagerId, "authorizeOracle", new ContractFunctionParameters().addAddress(oracleEvm))).status;
  steps.createAgreement = (await execute(ctx.operatorClient, escrowId, "createAgreement", new ContractFunctionParameters().addAddress(producerEvm).addUint256(100_000_000).addUint8(50).addUint8(HYBRID))).status;
  steps.deposit = (await execute(ctx.operatorClient, escrowId, "deposit", new ContractFunctionParameters().addUint256(0), { hbar: 2 })).status;
  const agreement = await call(ctx.operatorClient, escrowId, "getAgreement", new ContractFunctionParameters().addUint256(0));
  const deposited = agreement.getUint256(6).toString();
  const oracleClient = ctx.ecdsaClients[0];
  const submitPeriod = async (periodId) =>
    (await execute(oracleClient, escrowId, "submitBatch", new ContractFunctionParameters().addUint256(0).addUint256(periodId).addBytes32(randomBytes(32)).addUint8(80).addUint16(1))).status;
  steps.submitPeriod1 = await submitPeriod(1);
  steps.submitPeriod2 = await submitPeriod(2);
  const selectors = await call(ctx.operatorClient, ctx.probeId, "errorSelectors");
  const notFinancialManager = `0x${Buffer.from(selectors.getBytes32(0)).subarray(0, 4).toString("hex")}`;
  const direct = await execute(ctx.operatorClient, escrowId, "approve", new ContractFunctionParameters().addUint256(0).addUint256(1));
  const directSelector = revertSelector(direct.functionResult?.errorMessage);
  const viaProbe = await execute(ctx.operatorClient, ctx.probeId, "approveOn", new ContractFunctionParameters().addAddress(evmHex(escrowId.toEvmAddress())).addUint256(0).addUint256(1));
  const approvedLog = viaProbe.functionResult?.logs?.find((log) => log.topics.length === 4);
  const approver = approvedLog ? evmHex(Buffer.from(approvedLog.topics[3]).subarray(12).toString("hex")) : null;
  const rejectViaProbe = await execute(ctx.operatorClient, ctx.probeId, "rejectOn", new ContractFunctionParameters().addAddress(evmHex(escrowId.toEvmAddress())).addUint256(0).addUint256(2));
  const period1 = await call(ctx.operatorClient, escrowId, "getPeriod", new ContractFunctionParameters().addUint256(0).addUint256(1));
  const period2 = await call(ctx.operatorClient, escrowId, "getPeriod", new ContractFunctionParameters().addUint256(0).addUint256(2));
  const escrowMirror = await mirror(config, `/api/v1/contracts/${escrowId}`);
  const probeMirror = await mirror(config, `/api/v1/contracts/${ctx.probeId}`);
  const p1State = PERIOD_STATES[period1.getUint8(0)];
  const p2State = PERIOD_STATES[period2.getUint8(0)];
  const p1 = direct.status === "CONTRACT_REVERT_EXECUTED" && directSelector === notFinancialManager && viaProbe.status === "SUCCESS" && p1State === "Approved" && approver === probeEvm && rejectViaProbe.status === "SUCCESS" && p2State === "Rejected";
  const unit = msgValueUnit(deposited, 2);
  return [
    {
      id: "P1",
      question: "When a contract set as financialManager calls PESEscrowV3.approve or reject, is msg.sender that contract?",
      status: p1 ? "verified" : "failed",
      result: {
        escrow: { id: escrowId.toString(), longZero: evmHex(escrowId.toEvmAddress()), mirrorEvmAddress: escrowMirror.evm_address ?? null },
        probe: { id: ctx.probeId.toString(), longZero: probeEvm, mirrorEvmAddress: probeMirror.evm_address ?? null },
        steps,
        directApprove: { status: direct.status, selector: directSelector, expectedNotFinancialManager: notFinancialManager },
        approveViaProbe: { status: viaProbe.status, periodState: p1State, approverInEvent: approver },
        rejectViaProbe: { status: rejectViaProbe.status, periodState: p2State },
      },
    },
    {
      id: "P5-deposit",
      question: "Which unit does PESEscrowV3.deposit record when 2 HBAR are sent through the SDK?",
      status: unit === "unknown" ? "failed" : "verified",
      result: { sentHbar: 2, deposited, unit },
    },
    {
      id: "P6",
      question: "Do PESEscrowV3 and OracleManager compiled with solc 0.8.28, viaIR, optimizer 200 and evmVersion paris deploy and run on this network?",
      status: steps.createAgreement === "SUCCESS" && steps.deposit === "SUCCESS" && steps.submitPeriod1 === "SUCCESS" ? "verified" : "failed",
      result: { steps, bytecodeSha256: { PESEscrowV3: build.PESEscrowV3.bytecodeSha256, OracleManager: build.OracleManager.bytecodeSha256 } },
    },
  ];
}

async function probeTopics(config, ctx) {
  const client = ctx.operatorClient;
  const adminKeys = [PrivateKey.generateED25519(), PrivateKey.generateED25519(), PrivateKey.generateED25519()];
  const threshold = new KeyList(adminKeys.map((key) => key.publicKey), 2);
  const submitKey = PrivateKey.generateED25519();
  const created = await submit(client, new TopicCreateTransaction().setTopicMemo("coorre-probe").setAdminKey(threshold).setSubmitKey(submitKey.publicKey), adminKeys.slice(0, 2));
  if (created.status !== "SUCCESS") throw new Error(`topic create returned ${created.status}`);
  const topicId = created.receipt.topicId;
  const message = Buffer.from(JSON.stringify({ probe: "coorre", nonce: randomBytes(8).toString("hex") }));
  const withoutSubmitKey = await submit(client, new TopicMessageSubmitTransaction().setTopicId(topicId).setMessage(message));
  const withSubmitKey = await submit(client, new TopicMessageSubmitTransaction().setTopicId(topicId).setMessage(message), [submitKey]);
  const submitRecord = withSubmitKey.transactionId ? await recordOf(client, withSubmitKey.transactionId) : null;
  const sequence = withSubmitKey.receipt?.topicSequenceNumber?.toString() ?? null;
  const mirrorMessage = await mirror(config, `/api/v1/topics/${topicId}/messages/${sequence}`);
  const receiptRunningHash = withSubmitKey.receipt?.topicRunningHash ? Buffer.from(withSubmitKey.receipt.topicRunningHash).toString("base64") : null;
  const mirrorTopic = await mirror(config, `/api/v1/topics/${topicId}`);
  const updateOne = await submit(client, new TopicUpdateTransaction().setTopicId(topicId).setTopicMemo("coorre-probe-1"), adminKeys.slice(0, 1));
  const updateTwo = await submit(client, new TopicUpdateTransaction().setTopicId(topicId).setTopicMemo("coorre-probe-2"), adminKeys.slice(0, 2));
  const immutable = await submit(client, new TopicCreateTransaction().setTopicMemo("coorre-probe-immutable").setSubmitKey(submitKey.publicKey));
  const immutableId = immutable.receipt.topicId;
  const immutableUpdate = await submit(client, new TopicUpdateTransaction().setTopicId(immutableId).setTopicMemo("changed"));
  const immutableDelete = await submit(client, new TopicDeleteTransaction().setTopicId(immutableId));
  const atLimit = await submit(client, new TopicMessageSubmitTransaction().setTopicId(topicId).setMessage(randomBytes(1024)).setMaxChunks(1), [submitKey]);
  let overLimit;
  try {
    overLimit = await submit(client, new TopicMessageSubmitTransaction().setTopicId(topicId).setMessage(randomBytes(1025)).setChunkSize(2048).setMaxChunks(1), [submitKey]);
  } catch (error) {
    overLimit = { status: `client error: ${error.message}` };
  }
  const recordTimestamp = submitRecord ? `${submitRecord.consensusTimestamp.seconds.toString()}.${String(submitRecord.consensusTimestamp.nanos.toString()).padStart(9, "0")}` : null;
  const p3 = mirrorMessage.sequence_number === Number(sequence) && mirrorMessage.running_hash === receiptRunningHash && mirrorMessage.consensus_timestamp === recordTimestamp;
  const p4 = withoutSubmitKey.status === "INVALID_SIGNATURE" && withSubmitKey.status === "SUCCESS" && updateOne.status === "INVALID_SIGNATURE" && updateTwo.status === "SUCCESS" && immutableUpdate.status === "UNAUTHORIZED" && immutableDelete.status === "UNAUTHORIZED";
  return [
    {
      id: "P3",
      question: "Which fields does the Mirror Node return for an HCS message, and do they match the receipt and the record?",
      status: p3 ? "verified" : "failed",
      result: {
        topicId: topicId.toString(),
        mirror: { sequence_number: mirrorMessage.sequence_number, running_hash: mirrorMessage.running_hash, running_hash_version: mirrorMessage.running_hash_version, consensus_timestamp: mirrorMessage.consensus_timestamp, payer_account_id: mirrorMessage.payer_account_id, chunk_info: mirrorMessage.chunk_info ?? null, messageMatches: mirrorMessage.message === message.toString("base64") },
        receipt: { sequence, runningHash: receiptRunningHash, runningHashVersion: withSubmitKey.receipt?.topicRunningHashVersion?.toString() ?? null },
        recordConsensusTimestamp: recordTimestamp,
        messageAtLimit1024: atLimit.status,
        messageOver1024: overLimit.status,
      },
    },
    {
      id: "P4",
      question: "Are submitKey and a 2-of-3 threshold adminKey enforced, and is a topic without adminKey immutable?",
      status: p4 ? "verified" : "failed",
      result: {
        submitWithoutSubmitKey: withoutSubmitKey.status,
        submitWithSubmitKey: withSubmitKey.status,
        updateWithOneOfThree: updateOne.status,
        updateWithTwoOfThree: updateTwo.status,
        immutableTopic: { id: immutableId.toString(), update: immutableUpdate.status, delete: immutableDelete.status },
        mirrorTopicKeys: { admin_key: mirrorTopic.admin_key ?? null, submit_key: mirrorTopic.submit_key ?? null },
      },
    },
  ];
}

async function probeRelay(config) {
  const chainId = await rpc(config, "eth_chainId");
  const blockNumber = await rpc(config, "eth_blockNumber");
  return [
    {
      id: "P0-relay",
      question: "Does the JSON-RPC relay answer with chain id 298?",
      status: chainId === "0x12a" ? "verified" : "failed",
      result: { chainId, blockNumber },
    },
    {
      id: "P5-jsonrpc",
      question: "Which unit does msg.value carry for a value sent through eth_sendRawTransaction?",
      status: "out-of-scope",
      result: { reason: "CoorRe never sends value: approve and reject carry none, and deposits belong to the host" },
    },
  ];
}

async function guarded(id, run) {
  try {
    return await run();
  } catch (error) {
    return [{ id, status: "error", error: error.stack ?? String(error) }];
  }
}

async function main() {
  const config = settings(join(HEDERA_ROOT, ".cache", "probes", "report.json"));
  const accounts = await loadAccounts(config.accounts);
  const build = JSON.parse(await readFile(join(BUILD_ROOT, "contracts.json"), "utf8"));
  const operatorClient = clientFor(config, accounts.operator.id, accounts.operator.key);
  const ecdsaClients = accounts.ecdsa.map((account) => clientFor(config, account.id, account.key));
  const probeId = await deploy(operatorClient, build.contracts.CallerProbe, null, 600_000);
  const ctx = { accounts, build, operatorClient, ecdsaClients, probeId: ContractId.fromString(probeId.toString()), operatorSender: null };
  const results = [];
  results.push(...(await guarded("relay", () => probeRelay(config))));
  results.push(...(await guarded("addresses-and-time", () => probeAddressesAndTime(config, ctx))));
  if (ctx.operatorSender) results.push(...(await guarded("escrow", () => probeEscrow(config, ctx))));
  results.push(...(await guarded("topics", () => probeTopics(config, ctx))));
  const report = { createdAt: new Date().toISOString(), solc: build.solc, wataCommit: build.wataCommit, endpoints: { consensus: config.consensus, mirrorRest: config.mirrorRest, relay: config.relay }, results };
  await mkdir(dirname(config.report), { recursive: true });
  await writeFile(config.report, `${JSON.stringify(report, null, 2)}\n`);
  for (const entry of results) console.log(`${entry.status.padEnd(12)} ${entry.id}${entry.error ? `: ${entry.error.split("\n")[0]}` : ""}`);
  console.log(`report: ${config.report}`);
  operatorClient.close();
  for (const client of ecdsaClients) client.close();
  if (results.some((entry) => entry.status === "error" || entry.status === "failed")) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`probes: ${error.stack ?? error.message}`);
    process.exit(2);
  });
}
