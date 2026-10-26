import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../lib/paths.mjs";
import { PROTECTIONS } from "../scripts/protection-check.mjs";

const threatModel = readFileSync(join(REPO_ROOT, "docs", "hedera", "THREAT_MODEL.md"), "utf8");
const solidityTests = readFileSync(join(REPO_ROOT, "hedera", "contracts", "test", "CoorReMandateGate.t.sol"), "utf8");
const security = readFileSync(join(REPO_ROOT, "docs", "SECURITY.md"), "utf8");

test("every Solidity test the threat model cites exists", () => {
  const cited = [...new Set([...threatModel.matchAll(/`(test[A-Za-z0-9]+)`/g)].map((match) => match[1]))];
  assert.ok(cited.length > 20, `only ${cited.length} tests cited`);
  const missing = cited.filter((name) => !new RegExp(`function ${name}\\(`).test(solidityTests));
  assert.deepEqual(missing, []);
});

test("every threat row names at least one proof or says where it is proved", () => {
  const rows = threatModel.split("\n").filter((line) => /^\| T\d+ \|/.test(line));
  assert.ok(rows.length >= 25);
  for (const row of rows) {
    const proof = row.split("|").filter(Boolean).at(-1).trim();
    assert.ok(proof.length > 0, row);
  }
});

test("the security notes state the number of protections the check exercises", () => {
  const stated = Number(/one entry per guard, (\d+) today/.exec(security)?.[1]);
  assert.equal(stated, PROTECTIONS.length);
});
