import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { PROTECTIONS, applyProtectionRemoval, classifyRun, prepareWorkDir, selectProtections } from "../scripts/protection-check.mjs";
import { HEDERA_ROOT, REPO_ROOT, isInside } from "../lib/paths.mjs";

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

test("every guard of the contract has a protection entry", () => {
  const finds = PROTECTIONS.map((protection) => protection.find);
  const uncovered = source
    .split("\n")
    .map((text, index) => ({ line: index + 1, text: text.trim() }))
    .filter(({ text }) => /\brevert\b/.test(text) || /\breached = /.test(text))
    .filter(({ text }) => !finds.some((find) => find.includes(text)));
  assert.deepEqual(uncovered, []);
});

const PASSED = "Compiled 2 Solidity files with solc 0.8.28 (evm target: paris)\n\nRunning Solidity tests\n\n  82 passing\n";
const CAUGHT = "Running Solidity tests\n    1) testUnknownVerdictIsRefused()\n\n  81 passing\n  1 failing\n\n  1) CoorReMandateGateTest#testUnknownVerdictIsRefused()\n    Error: next call did not revert as expected\n";
const COMPILE_ERROR = "ParserError: Expected ';' but got 'if'\n  --> ./contracts/CoorReMandateGate.sol:96:9:\n   |\nError HHE910: Compilation failed\n";

test("a run counts as caught only when a test fails and the compiler did not stop it", () => {
  assert.deepEqual(classifyRun({ status: 0, output: PASSED }), { verdict: "passed", failing: [], passing: 82 });
  assert.deepEqual(classifyRun({ status: 1, output: CAUGHT }), { verdict: "caught", failing: ["testUnknownVerdictIsRefused"], passing: 81 });
  assert.equal(classifyRun({ status: 1, output: COMPILE_ERROR }).verdict, "inconclusive");
  assert.match(classifyRun({ status: 1, output: COMPILE_ERROR }).reason, /compiler/);
  assert.equal(classifyRun({ status: 1, output: "Error HHE1: unexpected\n" }).verdict, "inconclusive");
  assert.equal(classifyRun({ status: 137, output: "" }).verdict, "inconclusive");
  assert.equal(classifyRun({ status: null, output: "  3 passing\n" }).verdict, "inconclusive");
  assert.equal(classifyRun({ status: 0, output: "Running Solidity tests\n" }).verdict, "inconclusive");
  assert.equal(classifyRun({ status: 1, output: `${CAUGHT}${COMPILE_ERROR}` }).verdict, "inconclusive");
});

test("mutants are written in a copy outside the repository, never in the deployed contract", async (t) => {
  const workDir = await prepareWorkDir();
  t.after(() => rm(workDir, { recursive: true, force: true }));
  assert.equal(isInside(REPO_ROOT, workDir), false);
  assert.ok(existsSync(join(workDir, "contracts", "CoorReMandateGate.sol")));
  assert.ok(existsSync(join(workDir, "hardhat.config.mjs")));
  assert.ok(lstatSync(join(workDir, "node_modules")).isSymbolicLink());
  const script = readFileSync(join(HEDERA_ROOT, "scripts", "protection-check.mjs"), "utf8");
  assert.ok(!/writeFile\(CONTRACT\b/.test(script));
  assert.match(script, /writeFile\(mutant, applyProtectionRemoval/);
  assert.match(script, /await assertFrozenSources\(\);\n  const original/);
});
