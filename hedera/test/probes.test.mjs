import { test } from "node:test";
import assert from "node:assert/strict";
import { evmHex, hexBytecode, mirrorTransactionId, msgValueUnit, revertSelector, timestampSeconds } from "../lib/network.mjs";

test("mirrorTransactionId converts the SDK form and pads the nanoseconds", () => {
  assert.equal(mirrorTransactionId("0.0.2@1700000000.000000123"), "0.0.2-1700000000-000000123");
  assert.equal(mirrorTransactionId("0.0.1002@1700000000.5"), "0.0.1002-1700000000-000000005");
  assert.throws(() => mirrorTransactionId("0.0.2-1700000000-000000123"), /unexpected/);
});

test("timestampSeconds keeps the whole seconds of a consensus timestamp", () => {
  assert.equal(timestampSeconds("1700000000.999999999"), 1700000000n);
  assert.throws(() => timestampSeconds("1700000000"), /unexpected/);
});

test("msgValueUnit tells tinybar from weibar", () => {
  assert.equal(msgValueUnit("100000000", 1), "tinybar");
  assert.equal(msgValueUnit("200000000", 2), "tinybar");
  assert.equal(msgValueUnit((10n ** 18n).toString(), 1), "weibar");
  assert.equal(msgValueUnit("1", 1), "unknown");
});

test("revertSelector reads the first four bytes of revert data", () => {
  assert.equal(revertSelector("0x3d7d3fc8"), "0x3d7d3fc8");
  assert.equal(revertSelector("3D7D3FC80000"), "0x3d7d3fc8");
  assert.equal(revertSelector("CONTRACT_REVERT_EXECUTED"), null);
  assert.equal(revertSelector(undefined), null);
});

test("evmHex normalizes addresses", () => {
  assert.equal(evmHex("00000000000000000000000000000000000003E9"), "0x00000000000000000000000000000000000003e9");
  assert.equal(evmHex("0xABC"), "0xabc");
});

test("bytecode goes to the SDK as hex text, never as raw bytes", () => {
  assert.equal(hexBytecode("6080"), "6080");
  assert.throws(() => hexBytecode(Buffer.from("6080", "hex")), /not raw bytes/);
  assert.throws(() => hexBytecode(new Uint8Array([0x60, 0x80])), /not raw bytes/);
  assert.throws(() => hexBytecode("0x6080"), /without 0x/);
  assert.throws(() => hexBytecode("608"), /whole bytes/);
  assert.throws(() => hexBytecode("60GG"), /hex/);
});
