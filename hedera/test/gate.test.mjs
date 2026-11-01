import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DECIDE_SIGNATURE, GATE_ARTIFACT, REGISTER_SIGNATURE, REVIEW_SIGNATURE, hexToBytes32, loadGate, registerMandateCallData, termsFromMandate } from "../lib/gate.mjs";
import { cycleDecision, cycleMandate, decisionEventFields, reviewEventFields } from "../cycle/run.mjs";
import { prepareDecision } from "../adapter/period-escrow.mjs";
import { HEDERA_ROOT } from "../lib/paths.mjs";

const ID = "ab".repeat(32);
const TERMS = { validFrom: 10, validUntil: 20, quorum: 1, allAgreements: true, allowApprove: true, allowReject: false, allowReview: true, hasAutonomyLimit: true, autonomyLimit: 7 };
const DELEGATE = "0x00000000000000000000000000000000000003ea";

function word(data, index) {
  return Buffer.from(data.subarray(4 + index * 32, 4 + index * 32 + 32));
}

test("registerMandate call data lays the static terms inline and the arrays after a 13-word head", () => {
  const data = registerMandateCallData("4d404266", { id: ID, terms: TERMS, delegates: [{ address: DELEGATE, kind: "agent" }], agreementIds: [] });
  assert.equal(Buffer.from(data.subarray(0, 4)).toString("hex"), "4d404266");
  assert.equal(data.length, 4 + 13 * 32 + 64 + 64 + 32);
  assert.equal(word(data, 0).toString("hex"), ID);
  assert.equal(word(data, 1).readBigUInt64BE(24), 10n);
  assert.equal(word(data, 2).readBigUInt64BE(24), 20n);
  assert.equal(word(data, 3).readUInt8(31), 1);
  assert.deepEqual([4, 5, 6, 7, 8].map((index) => word(data, index).readUInt8(31)), [1, 1, 0, 1, 1]);
  assert.equal(word(data, 9).readBigUInt64BE(24), 7n);
  assert.deepEqual([10, 11, 12].map((index) => Number(word(data, index).readBigUInt64BE(24))), [416, 480, 544]);
  assert.equal(Number(word(data, 13).readBigUInt64BE(24)), 1);
  assert.equal(`0x${word(data, 14).subarray(12).toString("hex")}`, DELEGATE);
  assert.equal(Number(word(data, 15).readBigUInt64BE(24)), 1);
  assert.equal(word(data, 16).readUInt8(31), 2);
  assert.equal(Number(word(data, 17).readBigUInt64BE(24)), 0);
});

test("registerMandate call data refuses a bad selector, no delegate and an unknown kind", () => {
  const mandate = { id: ID, terms: TERMS, delegates: [{ address: DELEGATE, kind: "human" }], agreementIds: [] };
  assert.throws(() => registerMandateCallData("4d40426", mandate), /selector/);
  assert.throws(() => registerMandateCallData("4d404266", { ...mandate, delegates: [] }), /at least one delegate/);
  assert.throws(() => registerMandateCallData("4d404266", { ...mandate, delegates: [{ address: DELEGATE, kind: "robot" }] }), /unknown delegate kind/);
});

test("hexToBytes32 accepts 32 bytes with or without 0x and nothing else", () => {
  assert.equal(hexToBytes32(`0x${ID}`).length, 32);
  assert.throws(() => hexToBytes32("ab"), /32 bytes/);
});

test("the compiled gate exposes the register signature the encoder targets", async (t) => {
  if (!existsSync(GATE_ARTIFACT)) {
    t.skip("no Hardhat build; run npm run build:contracts");
    return;
  }
  const gate = await loadGate();
  assert.equal(gate.identifiers[REGISTER_SIGNATURE], "4d404266");
  assert.equal(gate.identifiers[REVIEW_SIGNATURE], "7749304e");
  assert.equal(gate.identifiers[DECIDE_SIGNATURE], "cd2d478a");
});

test("registerMandate call data refuses a delegate kind inherited from the object prototype", () => {
  const mandate = { id: ID, terms: TERMS, delegates: [{ address: DELEGATE, kind: "constructor" }], agreementIds: [] };
  assert.throws(() => registerMandateCallData("4d404266", mandate), /unknown delegate kind constructor/);
  assert.throws(() => registerMandateCallData("4d404266", { ...mandate, delegates: [{ address: DELEGATE, kind: "toString" }] }), /unknown delegate kind/);
});

const MANDATE_DOCUMENT = {
  format: "coorre-mandate/1",
  hostId: "example-host",
  delegates: [{ account: "0.0.1002", address: "0x00000000000000000000000000000000000003EA", kind: "human" }],
  quorum: 1,
  scope: { agreements: "all", modes: ["HYBRID"], verdicts: ["approve", "reject", "review"] },
  validFrom: 1_800_000_000,
  validUntil: 1_800_604_800,
  autonomyLimit: null,
};

function registeredWords(document) {
  const data = registerMandateCallData("4d404266", { id: ID, ...termsFromMandate(document) });
  return [4, 5, 6, 7, 8].map((index) => word(data, index).readUInt8(31));
}

test("the registered terms are read from the mandate document, verdict by verdict", () => {
  const out = termsFromMandate(MANDATE_DOCUMENT);
  assert.deepEqual(out.terms, { validFrom: 1_800_000_000, validUntil: 1_800_604_800, quorum: 1, allAgreements: true, allowApprove: true, allowReject: true, allowReview: true, hasAutonomyLimit: false, autonomyLimit: 0 });
  assert.deepEqual(out.delegates, [{ address: "0x00000000000000000000000000000000000003ea", kind: "human" }]);
  assert.deepEqual(out.agreementIds, []);
  assert.deepEqual(registeredWords(MANDATE_DOCUMENT), [1, 1, 1, 1, 0]);
  assert.deepEqual(registeredWords({ ...MANDATE_DOCUMENT, scope: { ...MANDATE_DOCUMENT.scope, verdicts: ["approve"] } }), [1, 1, 0, 0, 0]);
  const listed = termsFromMandate({ ...MANDATE_DOCUMENT, scope: { ...MANDATE_DOCUMENT.scope, agreements: [3, "7"] }, autonomyLimit: 500 });
  assert.equal(listed.terms.allAgreements, false);
  assert.deepEqual(listed.agreementIds, ["3", "7"]);
  assert.equal(listed.terms.hasAutonomyLimit, true);
  assert.equal(listed.terms.autonomyLimit, "500");
});

test("a mandate document the gate cannot represent is refused", () => {
  const scope = MANDATE_DOCUMENT.scope;
  assert.throws(() => termsFromMandate({ ...MANDATE_DOCUMENT, scope: { ...scope, verdicts: ["approve", "pay"] } }), /unknown verdict pay/);
  assert.throws(() => termsFromMandate({ ...MANDATE_DOCUMENT, scope: { ...scope, verdicts: [] } }), /names no verdict/);
  assert.throws(() => termsFromMandate({ ...MANDATE_DOCUMENT, scope: { ...scope, modes: ["AUTO"] } }), /HYBRID/);
  assert.throws(() => termsFromMandate({ ...MANDATE_DOCUMENT, scope: { ...scope, agreements: [] } }), /scope.agreements/);
  assert.throws(() => termsFromMandate({ ...MANDATE_DOCUMENT, scope: { ...scope, agreements: [1, 1] } }), /repeats an agreement/);
  assert.throws(() => termsFromMandate({ ...MANDATE_DOCUMENT, quorum: 2 }), /quorum/);
  assert.throws(() => termsFromMandate({ ...MANDATE_DOCUMENT, autonomyLimit: -1 }), /autonomyLimit/);
  assert.throws(() => termsFromMandate({ ...MANDATE_DOCUMENT, delegates: [{ address: "0x1", kind: "human" }] }), /EVM address/);
  assert.throws(() => termsFromMandate({ ...MANDATE_DOCUMENT, delegates: [{ ...MANDATE_DOCUMENT.delegates[0], kind: "constructor" }] }), /unknown delegate kind/);
  assert.throws(() => termsFromMandate({ ...MANDATE_DOCUMENT, validFrom: "1800000000" }), /validFrom/);
});

const PROFILE = JSON.parse(readFileSync(join(HEDERA_ROOT, "host-profiles", "example.json"), "utf8"));
const CYCLE = {
  hostId: "example-host",
  chainId: 298,
  escrow: "0x00000000000000000000000000000000000003ff",
  gate: "0x0000000000000000000000000000000000000401",
  issuer: "0x0000000000000000000000000000000000000002",
  delegate: { account: "0.0.1027", address: "0x0000000000000000000000000000000000000403", publicKey: "ab".repeat(32) },
  now: 1_800_000_000,
};

test("the cycle registers exactly the terms its mandate document declares", () => {
  const { id, document, registration } = cycleMandate(CYCLE);
  assert.equal(registration.id, id);
  assert.deepEqual(registration, { id, ...termsFromMandate(document) });
  assert.equal(registration.terms.allowReview, document.scope.verdicts.includes("review"));
  assert.equal(registration.terms.allowApprove, document.scope.verdicts.includes("approve"));
  assert.equal(registration.terms.allowReject, document.scope.verdicts.includes("reject"));
  assert.deepEqual(registeredWords(document), [1, 1, 1, 1, 0]);
});

test("the cycle's decision is the adapter's decision, with the same document and evidence hash", () => {
  const auditHash = "60e923175e060c671d4191c337ba6a6936e3c6120aa9a304e5918c51f33cdd8b";
  const context = { escrow: CYCLE.escrow, gate: CYCLE.gate, mandateId: cycleMandate(CYCLE).id, delegate: CYCLE.delegate.address, auditHash };
  const ours = cycleDecision(PROFILE, context);
  const adapter = prepareDecision(
    PROFILE,
    { hostId: "example-host", decisionPoint: "approve-or-reject-period", agreementId: "0", periodId: "1", auditHash, score: 80, scoreVersion: 1 },
    { network: "solo", escrow: CYCLE.escrow, gate: CYCLE.gate, mandateId: context.mandateId, delegate: CYCLE.delegate.address, verdict: "approve", mode: "A" },
  );
  assert.deepEqual(ours, adapter);
  assert.equal(ours.decisionDocument.format, "coorre-decision/1");
  assert.equal(ours.decisionDocument.delegate, CYCLE.delegate.address);
});

test("DecisionAnchored data decodes into its seven fields", () => {
  const words = [
    Buffer.from("11".repeat(32), "hex"),
    Buffer.alloc(32),
    Buffer.alloc(32),
    Buffer.alloc(32),
    Buffer.from("22".repeat(32), "hex"),
    Buffer.alloc(32),
    Buffer.alloc(32),
  ];
  words[1][31] = 1;
  Buffer.from(DELEGATE.slice(2), "hex").copy(words[2], 12);
  words[3][31] = 1;
  words[5].writeBigUInt64BE(1_800_000_000n, 24);
  words[6][31] = 1;
  assert.deepEqual(decisionEventFields(Buffer.concat(words)), {
    auditHash: "11".repeat(32),
    verdict: 1,
    delegate: DELEGATE,
    kind: 1,
    evidenceHash: "22".repeat(32),
    blockTimestamp: 1_800_000_000,
    executedOnEscrow: true,
  });
  assert.throws(() => decisionEventFields(Buffer.alloc(32)), /expected 224/);
});

test("ReviewRecorded data decodes into its six fields", () => {
  const words = [Buffer.from("33".repeat(32), "hex"), Buffer.alloc(32), Buffer.alloc(32), Buffer.from("44".repeat(32), "hex"), Buffer.alloc(32), Buffer.alloc(32)];
  words[1][31] = 2;
  Buffer.from(DELEGATE.slice(2), "hex").copy(words[2], 12);
  words[4].writeBigUInt64BE(1_800_000_000n, 24);
  words[5][31] = 1;
  assert.deepEqual(reviewEventFields(Buffer.concat(words)), {
    auditHash: "33".repeat(32),
    outcome: 2,
    delegate: DELEGATE,
    evidenceHash: "44".repeat(32),
    blockTimestamp: 1_800_000_000,
    concluded: true,
  });
  assert.throws(() => reviewEventFields(Buffer.alloc(32)), /expected 192/);
});
