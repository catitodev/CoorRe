import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../lib/paths.mjs";
import { PROTECTIONS } from "../scripts/protection-check.mjs";
import { CONTRACT_CREATE_MAX_FEE_HBAR } from "../lib/network.mjs";
import { MAX_FEE_HBAR } from "../testnet/operator.mjs";

const threatModel = readFileSync(join(REPO_ROOT, "docs", "hedera", "THREAT_MODEL.md"), "utf8");
const solidityTests = readFileSync(join(REPO_ROOT, "hedera", "contracts", "test", "CoorReMandateGate.t.sol"), "utf8");
const security = readFileSync(join(REPO_ROOT, "docs", "SECURITY.md"), "utf8");
const spec = readFileSync(join(REPO_ROOT, "docs", "hedera", "SPEC.md"), "utf8");
const phase0 = readFileSync(join(REPO_ROOT, "docs", "hedera", "PHASE0.md"), "utf8");
const gateSource = readFileSync(join(REPO_ROOT, "hedera", "contracts", "CoorReMandateGate.sol"), "utf8");

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

test("the testnet notes state the fee caps the scripts use", () => {
  assert.match(phase0, new RegExp(`cap fees at ${MAX_FEE_HBAR} HBAR per transaction`));
  assert.match(phase0, new RegExp(`ContractCreate at ${CONTRACT_CREATE_MAX_FEE_HBAR} HBAR`));
});

test("the specification names every error the gate declares", () => {
  const declared = [...gateSource.matchAll(/^\s*error (\w+)\(\);$/gm)].map((match) => match[1]);
  assert.ok(declared.length >= 17);
  const sentence = /Its errors are ([^.]+)\./.exec(spec)?.[1] ?? "";
  assert.deepEqual(declared.filter((name) => !sentence.includes(`\`${name}\``)), []);
});

test("the specification states the host requirement the gate's vote key relies on", () => {
  assert.match(spec, /evidence\.auditHashUnique/);
  assert.match(spec, /`testAHostThatAcceptsARepeatedAuditHashLetsAnEarlierRoundVoteCount`/);
  assert.match(solidityTests, /function testAHostThatAcceptsARepeatedAuditHashLetsAnEarlierRoundVoteCount\(/);
});

test("the Hedera documents present the signed decision credential only as a next step", () => {
  const files = ["SPEC.md", "DIVERGENCES.md", "PHASE0.md", "THREAT_MODEL.md"].map((name) => [name, readFileSync(join(REPO_ROOT, "docs", "hedera", name), "utf8")]);
  files.push(["example.json", readFileSync(join(REPO_ROOT, "hedera", "host-profiles", "example.json"), "utf8")]);
  const claims = [];
  for (const [name, text] of files) {
    for (const line of text.split("\n")) {
      if (/eddsa-jcs-2022|Verifiable Credential|w3c-vc-di-eddsa|decision credential/i.test(line) && !/next step/i.test(line)) claims.push(`${name}: ${line.trim().slice(0, 120)}`);
    }
  }
  assert.deepEqual(claims, []);
});
