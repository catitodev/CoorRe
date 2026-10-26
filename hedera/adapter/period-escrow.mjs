import { ContractFunctionParameters } from "@hiero-ledger/sdk";
import { caseId, caseRef, jcs, jcsHash } from "../lib/canonical.mjs";

export const DECIDE_SIGNATURE = "decide(bytes32,uint256,uint256,bytes32,uint8,bytes32)";
export const DECIDE_SELECTOR = "0xcd2d478a";
export const DECIDE_ABI = {
  type: "function",
  name: "decide",
  stateMutability: "nonpayable",
  inputs: [
    { name: "mandateId", type: "bytes32" },
    { name: "agreementId", type: "uint256" },
    { name: "periodId", type: "uint256" },
    { name: "auditHash", type: "bytes32" },
    { name: "verdict", type: "uint8" },
    { name: "evidenceHash", type: "bytes32" },
  ],
  outputs: [{ name: "executedOnEscrow", type: "bool" }],
};
export const REVIEW_SIGNATURE = "recordReview(bytes32,uint256,uint256,bytes32,uint8,bytes32)";
export const REVIEW_SELECTOR = "0x7749304e";
export const REVIEW_ABI = {
  type: "function",
  name: "recordReview",
  stateMutability: "nonpayable",
  inputs: [
    { name: "mandateId", type: "bytes32" },
    { name: "agreementId", type: "uint256" },
    { name: "periodId", type: "uint256" },
    { name: "auditHash", type: "bytes32" },
    { name: "outcome", type: "uint8" },
    { name: "evidenceHash", type: "bytes32" },
  ],
  outputs: [{ name: "concluded", type: "bool" }],
};
const VERDICT_CODES = { approve: 1, reject: 2 };
const REVIEW_OUTCOMES = { resubmit: 1, "close-no-pay": 2 };
const MAX_REASON_CHARS = 500;
const UINT_LIMITS = { uint8: 2n ** 8n, uint16: 2n ** 16n, uint64: 2n ** 64n, uint256: 2n ** 256n };

function decisionPoint(profile, name) {
  const point = profile.decisionPoints.find((entry) => entry.name === name);
  if (!point) throw new Error(`unknown decision point ${name}`);
  return point;
}

function hex32(value, field) {
  const clean = String(value).replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) throw new Error(`${field} must be 32 bytes of hex`);
  return clean;
}

function address(value, field) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(value))) throw new Error(`${field} must be an EVM address`);
  return String(value).toLowerCase();
}

function uint(value, type, field) {
  const text = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new Error(`${field} must be a non-negative integer`);
  const number = BigInt(text);
  if (number >= UINT_LIMITS[type]) throw new Error(`${field} does not fit in ${type}`);
  return text;
}

export function readInput(profile, input) {
  if (input.hostId !== profile.hostId) throw new Error(`hostId must be ${profile.hostId}`);
  const point = decisionPoint(profile, input.decisionPoint);
  const read = {};
  for (const field of point.inputs) {
    if (!(field.name in input)) throw new Error(`missing input ${field.name}`);
    const value = input[field.name];
    read[field.name] = field.type === "bytes32" ? hex32(value, field.name) : field.type === "address" ? address(value, field.name) : uint(value, field.type, field.name);
  }
  if (Number(read.score) > 100) throw new Error("score must be at most 100");
  return { hostId: profile.hostId, decisionPoint: point.name, ...read };
}

function verdictAction(point, verdict) {
  const action = point.actions.find((entry) => entry.verdict === verdict);
  if (!action) throw new Error(`verdict must be one of ${point.actions.map((entry) => entry.verdict).join(", ")}`);
  return action;
}

function hexOf(bytes) {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

export function prepareDecision(profile, input, context) {
  const read = readInput(profile, input);
  const point = decisionPoint(profile, read.decisionPoint);
  const action = verdictAction(point, context.verdict);
  const target = profile.targets.find((entry) => entry.network === context.network);
  if (!target) throw new Error(`no target for network ${context.network}`);
  const escrow = address(context.escrow, "escrow");
  if (context.mode !== "A" && context.mode !== "B") throw new Error("mode must be A or B");
  const mandateId = hex32(context.mandateId, "mandateId");
  const delegate = address(context.delegate, "delegate");
  const ref = caseRef(profile.hostId, target.chainId, escrow, read.agreementId, read.periodId);

  const decisionDocument = {
    format: "coorre-decision/1",
    hostId: profile.hostId,
    decisionPoint: read.decisionPoint,
    case_ref: ref,
    case_id: caseId(ref),
    chainId: target.chainId,
    escrow,
    agreementId: read.agreementId,
    periodId: read.periodId,
    auditHash: read.auditHash,
    score: read.score,
    scoreVersion: read.scoreVersion,
    verdict: context.verdict,
    mandateId,
    delegate,
    path: context.mode,
  };
  const evidenceHash = jcsHash(decisionDocument);

  let call;
  if (context.mode === "A") {
    const gate = address(context.gate, "gate");
    const data = new ContractFunctionParameters()
      .addBytes32(Buffer.from(mandateId, "hex"))
      .addUint256(read.agreementId)
      .addUint256(read.periodId)
      .addBytes32(Buffer.from(read.auditHash, "hex"))
      .addUint8(VERDICT_CODES[context.verdict])
      .addBytes32(Buffer.from(evidenceHash, "hex"))
      ._build("decide");
    call = { to: gate, function: DECIDE_SIGNATURE, selector: DECIDE_SELECTOR, abi: [DECIDE_ABI], callData: hexOf(data), value: "0" };
  } else {
    const data = new ContractFunctionParameters().addUint256(read.agreementId).addUint256(read.periodId)._build(action.signature.split("(")[0]);
    call = {
      to: escrow,
      function: action.signature,
      selector: action.selector,
      abi: [{ type: "function", name: action.signature.split("(")[0], stateMutability: "nonpayable", inputs: [{ name: "agreementId", type: "uint256" }, { name: "periodId", type: "uint256" }], outputs: [] }],
      callData: hexOf(data),
      value: "0",
    };
  }
  if (!call.callData.startsWith(call.selector)) throw new Error(`call data does not start with ${call.selector}`);

  const logEntry = { kind: "decision", path: context.mode, case_ref: ref, mandateId, evidenceHash, auditHash: read.auditHash, verdict: context.verdict, delegate };
  const logMessage = jcs(logEntry);
  const maxLogBytes = profile.log.maxMessageBytes;
  if (Buffer.byteLength(logMessage, "utf8") > maxLogBytes) throw new Error(`log message exceeds ${maxLogBytes} bytes`);

  return { case_ref: ref, case_id: caseId(ref), decisionDocument, evidenceHash, call, logMessage };
}

export function prepareReview(profile, input, context) {
  const read = readInput(profile, input);
  const declared = profile.review.verdicts.map((entry) => entry.verdict);
  if (!declared.includes(context.outcome)) throw new Error(`outcome must be one of ${declared.join(", ")}`);
  const outcome = REVIEW_OUTCOMES[context.outcome];
  if (!outcome) throw new Error(`outcome ${context.outcome} is not one the gate records`);
  const target = profile.targets.find((entry) => entry.network === context.network);
  if (!target) throw new Error(`no target for network ${context.network}`);
  const escrow = address(context.escrow, "escrow");
  const gate = address(context.gate, "gate");
  const mandateId = hex32(context.mandateId, "mandateId");
  const delegate = address(context.delegate, "delegate");
  const reason = String(context.reason ?? "").trim();
  if (reason.length === 0 || reason.length > MAX_REASON_CHARS) throw new Error(`reason must have between 1 and ${MAX_REASON_CHARS} characters`);
  const ref = caseRef(profile.hostId, target.chainId, escrow, read.agreementId, read.periodId);

  const reviewDocument = {
    format: "coorre-review/1",
    hostId: profile.hostId,
    decisionPoint: read.decisionPoint,
    case_ref: ref,
    case_id: caseId(ref),
    chainId: target.chainId,
    escrow,
    agreementId: read.agreementId,
    periodId: read.periodId,
    auditHash: read.auditHash,
    outcome: context.outcome,
    reason,
    mandateId,
    delegate,
  };
  const evidenceHash = jcsHash(reviewDocument);
  const data = new ContractFunctionParameters()
    .addBytes32(Buffer.from(mandateId, "hex"))
    .addUint256(read.agreementId)
    .addUint256(read.periodId)
    .addBytes32(Buffer.from(read.auditHash, "hex"))
    .addUint8(outcome)
    .addBytes32(Buffer.from(evidenceHash, "hex"))
    ._build("recordReview");
  const call = { to: gate, function: REVIEW_SIGNATURE, selector: REVIEW_SELECTOR, abi: [REVIEW_ABI], callData: hexOf(data), value: "0" };
  if (!call.callData.startsWith(call.selector)) throw new Error(`call data does not start with ${call.selector}`);

  const logEntry = { kind: "review", case_ref: ref, mandateId, evidenceHash, auditHash: read.auditHash, outcome: context.outcome, delegate };
  const logMessage = jcs(logEntry);
  const maxLogBytes = profile.log.maxMessageBytes;
  if (Buffer.byteLength(logMessage, "utf8") > maxLogBytes) throw new Error(`log message exceeds ${maxLogBytes} bytes`);

  return { case_ref: ref, case_id: caseId(ref), reviewDocument, evidenceHash, call, logMessage };
}
