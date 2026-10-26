import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { GATE_ARTIFACT, REGISTER_SIGNATURE, hexToBytes32, loadGate, registerMandateCallData } from "../lib/gate.mjs";
import { decisionEventFields, logMessage } from "../cycle/run.mjs";

const ID = "ab".repeat(32);
const TERMS = { validFrom: 10, validUntil: 20, quorum: 1, allAgreements: true, allowApprove: true, allowReject: false, hasAutonomyLimit: true, autonomyLimit: 7 };
const DELEGATE = "0x00000000000000000000000000000000000003ea";

function word(data, index) {
  return Buffer.from(data.subarray(4 + index * 32, 4 + index * 32 + 32));
}

test("registerMandate call data lays the static terms inline and the arrays after a 12-word head", () => {
  const data = registerMandateCallData("07171427", { id: ID, terms: TERMS, delegates: [{ address: DELEGATE, kind: "agent" }], agreementIds: [] });
  assert.equal(Buffer.from(data.subarray(0, 4)).toString("hex"), "07171427");
  assert.equal(data.length, 4 + 12 * 32 + 64 + 64 + 32);
  assert.equal(word(data, 0).toString("hex"), ID);
  assert.equal(word(data, 1).readBigUInt64BE(24), 10n);
  assert.equal(word(data, 2).readBigUInt64BE(24), 20n);
  assert.equal(word(data, 3).readUInt8(31), 1);
  assert.deepEqual([4, 5, 6, 7].map((index) => word(data, index).readUInt8(31)), [1, 1, 0, 1]);
  assert.equal(word(data, 8).readBigUInt64BE(24), 7n);
  assert.deepEqual([9, 10, 11].map((index) => Number(word(data, index).readBigUInt64BE(24))), [384, 448, 512]);
  assert.equal(Number(word(data, 12).readBigUInt64BE(24)), 1);
  assert.equal(`0x${word(data, 13).subarray(12).toString("hex")}`, DELEGATE);
  assert.equal(word(data, 15).readUInt8(31), 2);
  assert.equal(Number(word(data, 16).readBigUInt64BE(24)), 0);
});

test("registerMandate call data refuses a bad selector, no delegate and an unknown kind", () => {
  const mandate = { id: ID, terms: TERMS, delegates: [{ address: DELEGATE, kind: "human" }], agreementIds: [] };
  assert.throws(() => registerMandateCallData("0717142", mandate), /selector/);
  assert.throws(() => registerMandateCallData("07171427", { ...mandate, delegates: [] }), /at least one delegate/);
  assert.throws(() => registerMandateCallData("07171427", { ...mandate, delegates: [{ address: DELEGATE, kind: "robot" }] }), /unknown delegate kind/);
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
  assert.equal(gate.identifiers[REGISTER_SIGNATURE], "07171427");
});

test("log messages are JCS and stay within 1024 bytes", () => {
  assert.equal(logMessage({ b: 1, a: "x" }), '{"a":"x","b":1}');
  assert.throws(() => logMessage({ pad: "x".repeat(1100) }), /exceeds 1024/);
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
