import { test } from "node:test";
import assert from "node:assert/strict";
import { callDataBytes, indexedAddress } from "../integration/run.mjs";

test("callDataBytes accepts only lowercase 0x-prefixed whole bytes", () => {
  assert.deepEqual([...callDataBytes("0x5d35a3d9")], [0x5d, 0x35, 0xa3, 0xd9]);
  assert.throws(() => callDataBytes("5d35a3d9"), /0x-prefixed/);
  assert.throws(() => callDataBytes("0x5D35"), /lowercase/);
  assert.throws(() => callDataBytes("0x5d3"), /hex/);
});

test("indexedAddress reads the last 20 bytes of a 32-byte topic", () => {
  const topic = Buffer.alloc(32);
  Buffer.from("00000000000000000000000000000000000003f9", "hex").copy(topic, 12);
  assert.equal(indexedAddress(topic), "0x00000000000000000000000000000000000003f9");
  assert.throws(() => indexedAddress(Buffer.alloc(20)), /32 bytes/);
});
