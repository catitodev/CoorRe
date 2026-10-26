#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { HEDERA_ROOT } from "../lib/paths.mjs";

const CONTRACT = join(HEDERA_ROOT, "contracts", "CoorReMandateGate.sol");

export const PROTECTIONS = [
  {
    name: "only the escrow admin registers",
    find: "        if (msg.sender != escrow.admin()) revert NotIssuer();\n        if (mandates[mandateId].registered) revert MandateExists();",
    replace: "        if (mandates[mandateId].registered) revert MandateExists();",
  },
  {
    name: "only the escrow admin revokes",
    find: "        if (!m.registered) revert UnknownMandate();\n        if (msg.sender != escrow.admin()) revert NotIssuer();",
    replace: "        if (!m.registered) revert UnknownMandate();",
  },
  { name: "a mandate id is registered once", find: "        if (mandates[mandateId].registered) revert MandateExists();\n", replace: "" },
  { name: "quorum within the delegates", find: "        if (terms.quorum == 0 || terms.quorum > delegates.length) revert InvalidTerms();\n", replace: "" },
  { name: "no duplicate delegate", find: "            if (delegateKind[mandateId][delegates[i]] != 0) revert InvalidTerms();\n", replace: "" },
  {
    name: "validity window",
    find: "if (m.revoked || block.timestamp < m.terms.validFrom || block.timestamp > m.terms.validUntil) revert MandateNotActive();",
    replace: "if (m.revoked) revert MandateNotActive();",
  },
  {
    name: "revocation",
    find: "if (m.revoked || block.timestamp < m.terms.validFrom",
    replace: "if (block.timestamp < m.terms.validFrom",
  },
  { name: "only delegates decide", find: "        if (kind == 0) revert UnauthorizedActor();\n", replace: "" },
  { name: "an agent cannot reject", find: "        if (kind == KIND_AGENT && verdict != VERDICT_APPROVE) revert UnauthorizedActor();\n", replace: "" },
  { name: "verdict in scope", find: "        if (verdict == VERDICT_REJECT && !m.terms.allowReject) revert OutOfScope();\n", replace: "" },
  { name: "agreement in scope", find: "        if (!m.terms.allAgreements && !agreementInScope[mandateId][agreementId]) revert OutOfScope();\n", replace: "" },
  { name: "HYBRID mode only", find: "        if (agreement.mode != MODE_HYBRID) revert OutOfScope();\n", replace: "" },
  { name: "period pending", find: "        if (period.state != PERIOD_PENDING_APPROVAL) revert PeriodNotPending();\n", replace: "" },
  { name: "audit hash binding", find: "        if (period.auditHash != auditHash) revert AuditHashMismatch();\n", replace: "" },
  { name: "submitter cannot decide", find: "        if (period.submitter == msg.sender) revert SubmitterCannotDecide();\n", replace: "" },
  {
    name: "autonomy limit",
    find: "        if (kind == KIND_AGENT && (!m.terms.hasAutonomyLimit || agreement.periodAmount > m.terms.autonomyLimit)) {\n            revert MandateExceeded();\n        }\n",
    replace: "",
  },
  {
    name: "one decision per delegate",
    find: "if (hasDecided[ballotKey][msg.sender] || executed[periodKey]) revert AlreadyDecided();",
    replace: "if (executed[periodKey]) revert AlreadyDecided();",
  },
  {
    name: "state before the escrow call",
    find: "if (hasDecided[ballotKey][msg.sender] || executed[periodKey]) revert AlreadyDecided();",
    replace: "if (hasDecided[ballotKey][msg.sender]) revert AlreadyDecided();",
  },
  { name: "quorum", find: "        executedOnEscrow = count >= m.terms.quorum;\n", replace: "        executedOnEscrow = true;\n" },
];

export function applyProtectionRemoval(source, protection) {
  const occurrences = source.split(protection.find).length - 1;
  if (occurrences !== 1) throw new Error(`"${protection.name}": expected the protected code once, found ${occurrences}`);
  return source.replace(protection.find, protection.replace);
}

function runSuite() {
  const result = spawnSync("npx", ["hardhat", "test", "solidity"], {
    cwd: HEDERA_ROOT,
    env: { ...process.env, HARDHAT_DISABLE_TELEMETRY: "true" },
    encoding: "utf8",
  });
  const output = `${result.stdout}\n${result.stderr}`;
  const failing = [...output.matchAll(/^\s+\d+\) \S+#(\w+)/gm)].map((match) => match[1]);
  return { status: result.status, failing: [...new Set(failing)], output };
}

async function main() {
  const original = await readFile(CONTRACT, "utf8");
  const baseline = runSuite();
  if (baseline.status !== 0) {
    process.stdout.write(baseline.output);
    throw new Error("the suite fails before any protection is removed");
  }
  console.log("baseline: all tests pass");
  const survivors = [];
  try {
    for (const protection of PROTECTIONS) {
      await writeFile(CONTRACT, applyProtectionRemoval(original, protection));
      const run = runSuite();
      if (run.status === 0) survivors.push(protection.name);
      console.log(`${run.status === 0 ? "SURVIVED" : "caught  "} ${protection.name}${run.failing.length ? `: ${run.failing.join(", ")}` : ""}`);
    }
  } finally {
    await writeFile(CONTRACT, original);
  }
  if (survivors.length > 0) {
    console.log(`FAIL: ${survivors.length} protection(s) can be removed without a failing test`);
    process.exit(1);
  }
  console.log(`PASS: removing any of the ${PROTECTIONS.length} protections fails at least one test`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`protection-check: ${error.message}`);
    process.exit(2);
  });
}
