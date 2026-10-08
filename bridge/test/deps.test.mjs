import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Connection } from "@solana/web3.js";

const require = createRequire(import.meta.url);

test("the RPC client path never loads stream-json", async () => {
  await new Connection("http://127.0.0.1:9", "confirmed").getGenesisHash().catch(() => {});
  const loaded = Object.keys(require.cache).filter((file) => file.includes(`${path.sep}stream-json${path.sep}`));
  assert.deepEqual(loaded, []);
  const jayson = Object.keys(require.cache).filter((file) => file.includes(`${path.sep}jayson${path.sep}`));
  assert.ok(jayson.length > 0, "the jayson client should be loaded by this check");
  assert.ok(jayson.every((file) => !file.endsWith(`${path.sep}utils.js`)), "jayson utils.js pulls in stream-json");
});

test("jayson resolves the patched uuid", () => {
  const jaysonDir = path.dirname(require.resolve("jayson/package.json"));
  const uuidPackage = createRequire(path.join(jaysonDir, "index.js")).resolve("uuid/package.json");
  const { version } = JSON.parse(readFileSync(uuidPackage, "utf8"));
  assert.equal(version, "11.1.1");
});
