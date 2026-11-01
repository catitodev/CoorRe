import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GATE_ARTIFACT } from "../lib/gate.mjs";
import { FROZEN_SOURCES, assertFrozenSources, comparableRuntime } from "../lib/frozen.mjs";
import { sha256Hex } from "../lib/canonical.mjs";
import { HEDERA_ROOT } from "../lib/paths.mjs";

const GATE_RUNTIME_SHA256 = "cb176b34474fd2cb4d4cce9740062a3bb67b21f5ed3a760425651a383f7e30c1";

test("the deployed sources keep the bytes verified on Sourcify", () => {
  assert.deepEqual(FROZEN_SOURCES, {
    "contracts/CoorReMandateGate.sol": "32b2f9b6629c69b23aff376420f4459078d555320b3a60571da4bc1e7669e55b",
    "contracts/IPeriodEscrow.sol": "4534963902b0db12dfc4514c5ab0f670791b9914ca976fa7c7edde23e23002e3",
  });
  for (const [path, expected] of Object.entries(FROZEN_SOURCES)) assert.equal(sha256Hex(readFileSync(join(HEDERA_ROOT, path))), expected, path);
});

test("a changed deployed source is reported with its path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coorre-frozen-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "contracts"));
  for (const path of Object.keys(FROZEN_SOURCES)) await writeFile(join(root, path), readFileSync(join(HEDERA_ROOT, path)));
  await assertFrozenSources(root);
  await writeFile(join(root, "contracts", "CoorReMandateGate.sol"), `${readFileSync(join(HEDERA_ROOT, "contracts", "CoorReMandateGate.sol"), "utf8")}\n`);
  await assert.rejects(assertFrozenSources(root), /contracts\/CoorReMandateGate\.sol has sha256/);
});

test("the comparable runtime drops the metadata trailer and zeroes the immutables", () => {
  const code = "6001600255";
  const immutable = "11".repeat(4);
  const trailer = "a1" + "00".repeat(3);
  const runtime = `${code}${immutable}${trailer}0004`;
  assert.equal(comparableRuntime(runtime, { 1: [{ start: 5, length: 4 }] }).toString("hex"), `${code}${"00".repeat(4)}`);
  assert.throws(() => comparableRuntime(`${code}0004`, {}), /CBOR metadata/);
  assert.throws(() => comparableRuntime(runtime, { 1: [{ start: 8, length: 4 }] }), /outside the runtime/);
  assert.throws(() => comparableRuntime("0x60", {}), /too short/);
});

test("the compiled gate runtime keeps its pinned digest once immutables and metadata are set aside", (t) => {
  if (!existsSync(GATE_ARTIFACT)) {
    t.skip("no Hardhat build; run npm run build:contracts");
    return;
  }
  const artifact = JSON.parse(readFileSync(GATE_ARTIFACT, "utf8"));
  assert.equal(sha256Hex(comparableRuntime(artifact.deployedBytecode, artifact.immutableReferences)), GATE_RUNTIME_SHA256);
});
