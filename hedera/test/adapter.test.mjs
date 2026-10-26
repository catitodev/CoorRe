import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { DECIDE_SELECTOR, DECIDE_SIGNATURE, PROFILE, prepareDecision, readInput } from "../adapter/wata.mjs";
import { caseId, jcsHash } from "../lib/canonical.mjs";
import { GATE_ARTIFACT, loadGate } from "../lib/gate.mjs";

const AUDIT = "60e923175e060c671d4191c337ba6a6936e3c6120aa9a304e5918c51f33cdd8b";
const INPUT = { hostId: "wata", decisionPoint: "approve-or-reject-period", agreementId: "0", periodId: "1", auditHash: `0x${AUDIT}`, score: 80, scoreVersion: 1 };
const ESCROW = "0x00000000000000000000000000000000000003FF";
const GATE = "0x0000000000000000000000000000000000000401";
const DELEGATE = "0x0000000000000000000000000000000000000403";
const MANDATE = "3a7eb0df33c0f1724ebd4e6769c980b6a80245a8a341d271db3205e78969a77b";
const CONTEXT = { network: "solo", escrow: ESCROW, gate: GATE, mandateId: MANDATE, delegate: DELEGATE, verdict: "approve", mode: "A" };

function words(callData) {
  const hex = callData.slice(10);
  return Array.from({ length: hex.length / 64 }, (_, index) => hex.slice(index * 64, index * 64 + 64));
}

test("path A calls the gate's decide with the decision's evidence hash", () => {
  const out = prepareDecision(INPUT, CONTEXT);
  assert.equal(out.call.to, GATE);
  assert.equal(out.call.function, DECIDE_SIGNATURE);
  assert.equal(out.call.callData.slice(0, 10), DECIDE_SELECTOR);
  const w = words(out.call.callData);
  assert.equal(w.length, 6);
  assert.equal(w[0], MANDATE);
  assert.equal(BigInt(`0x${w[1]}`), 0n);
  assert.equal(BigInt(`0x${w[2]}`), 1n);
  assert.equal(w[3], AUDIT);
  assert.equal(BigInt(`0x${w[4]}`), 1n);
  assert.equal(w[5], out.evidenceHash);
  assert.equal(out.evidenceHash, jcsHash(out.decisionDocument));
  assert.equal(out.call.value, "0");
});

test("path B calls the escrow with the host's own selectors from the profile", () => {
  const approve = prepareDecision(INPUT, { ...CONTEXT, mode: "B" });
  const reject = prepareDecision(INPUT, { ...CONTEXT, mode: "B", verdict: "reject" });
  const actions = Object.fromEntries(PROFILE.decisionPoints[0].actions.map((action) => [action.verdict, action.selector]));
  assert.equal(approve.call.to, ESCROW.toLowerCase());
  assert.equal(approve.call.callData.slice(0, 10), actions.approve);
  assert.equal(reject.call.callData.slice(0, 10), actions.reject);
  assert.deepEqual(words(approve.call.callData).map((word) => BigInt(`0x${word}`)), [0n, 1n]);
});

test("the decision names the case, the batch and the mandate, and the log message stays small", () => {
  const out = prepareDecision(INPUT, CONTEXT);
  assert.equal(out.case_ref, `urn:coorre:case:wata:298:${ESCROW.toLowerCase()}:0:1`);
  assert.equal(out.case_id, caseId(out.case_ref));
  assert.equal(out.decisionDocument.auditHash, AUDIT);
  assert.equal(out.decisionDocument.mandateId, MANDATE);
  assert.ok(Buffer.byteLength(out.logMessage, "utf8") <= 1024);
  assert.equal(JSON.parse(out.logMessage).evidenceHash, out.evidenceHash);
});

test("the output carries only strings, numbers and plain objects", () => {
  const out = prepareDecision(INPUT, CONTEXT);
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
});

test("inputs are checked against the profile's types", () => {
  assert.throws(() => readInput({ ...INPUT, hostId: "other" }), /hostId/);
  assert.throws(() => readInput({ ...INPUT, decisionPoint: "pay" }), /unknown decision point/);
  assert.throws(() => readInput({ ...INPUT, auditHash: "0x1234" }), /auditHash/);
  assert.throws(() => readInput({ ...INPUT, score: 256 }), /uint8/);
  assert.throws(() => readInput({ ...INPUT, score: 101 }), /at most 100/);
  assert.throws(() => readInput({ ...INPUT, scoreVersion: 70000 }), /uint16/);
  assert.throws(() => readInput({ ...INPUT, periodId: "-1" }), /non-negative/);
  const { periodId, ...missing } = INPUT;
  assert.throws(() => readInput(missing), /missing input periodId/);
});

test("context errors are refused", () => {
  assert.throws(() => prepareDecision(INPUT, { ...CONTEXT, verdict: "pay" }), /verdict must be one of/);
  assert.throws(() => prepareDecision(INPUT, { ...CONTEXT, mode: "C" }), /mode must be A or B/);
  assert.throws(() => prepareDecision(INPUT, { ...CONTEXT, network: "mainnet" }), /no target/);
  assert.throws(() => prepareDecision(INPUT, { ...CONTEXT, gate: "0x1" }), /gate/);
});

test("the decide selector matches the compiled gate when a build is present", async (t) => {
  if (!existsSync(GATE_ARTIFACT)) {
    t.skip("no Hardhat build; run npm run build:contracts");
    return;
  }
  const gate = await loadGate();
  assert.equal(`0x${gate.identifiers[DECIDE_SIGNATURE]}`, DECIDE_SELECTOR);
});
