import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROTECTIONS, applyProtectionRemoval, selectProtections } from "../scripts/protection-check.mjs";
import { HEDERA_ROOT } from "../lib/paths.mjs";

const source = readFileSync(join(HEDERA_ROOT, "contracts", "CoorReMandateGate.sol"), "utf8");

test("every listed protection is present exactly once in the contract", () => {
  for (const protection of PROTECTIONS) {
    const removed = applyProtectionRemoval(source, protection);
    assert.notEqual(removed, source, protection.name);
  }
});

test("protection names are unique", () => {
  const names = PROTECTIONS.map((protection) => protection.name);
  assert.equal(new Set(names).size, names.length);
});

test("a protection that is missing from the source is reported", () => {
  assert.throws(() => applyProtectionRemoval("contract X {}", PROTECTIONS[0]), /expected the protected code once, found 0/);
});

test("--only selects exactly one protection by its name and refuses anything else", () => {
  assert.equal(selectProtections([]).length, PROTECTIONS.length);
  assert.deepEqual(selectProtections(["--only", PROTECTIONS[0].name]), [PROTECTIONS[0]]);
  assert.throws(() => selectProtections(["--only", "no such protection"]), /exact name/);
  assert.throws(() => selectProtections(["--only"]), /exact name/);
});
