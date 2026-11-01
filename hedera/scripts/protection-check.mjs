#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { cp, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertFrozenSources } from "../lib/frozen.mjs";
import { HEDERA_ROOT, isInside } from "../lib/paths.mjs";

const CONTRACT = join(HEDERA_ROOT, "contracts", "CoorReMandateGate.sol");
const WORK_CONFIG = `import { defineConfig } from "hardhat/config";

export default defineConfig({
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "paris" },
  },
  paths: { sources: "contracts", cache: ".cache/hardhat", artifacts: ".cache/artifacts" },
});
`;

const line = (text) => `        ${text}\n`;

export const PROTECTIONS = [
  { name: "the constructor refuses a zero escrow", find: line("if (escrow_ == address(0)) revert ZeroAddress();"), replace: "" },
  { name: "the constructor refuses a zero validity cap", find: line("if (maxValidity_ == 0) revert InvalidTerms();"), replace: "" },
  {
    name: "only the escrow admin registers",
    find: line("if (msg.sender != escrow.admin()) revert NotIssuer();") + line("if (mandates[mandateId].registered) revert MandateExists();"),
    replace: line("if (mandates[mandateId].registered) revert MandateExists();"),
  },
  { name: "only the admin or the issuer revokes", find: line("if (msg.sender != escrow.admin() && msg.sender != m.issuer) revert NotIssuer();"), replace: "" },
  {
    name: "the original issuer can revoke",
    find: "if (msg.sender != escrow.admin() && msg.sender != m.issuer) revert NotIssuer();",
    replace: "if (msg.sender != escrow.admin()) revert NotIssuer();",
  },
  { name: "a mandate is revoked once", find: line("if (m.revoked) revert MandateNotActive();"), replace: "" },
  { name: "a mandate id is registered once", find: line("if (mandates[mandateId].registered) revert MandateExists();"), replace: "" },
  { name: "a mandate id is not zero", find: line("if (mandateId == bytes32(0)) revert InvalidTerms();"), replace: "" },
  { name: "a mandate names delegates and one kind per delegate", find: line("if (delegates.length == 0 || delegates.length != kinds.length) revert InvalidTerms();"), replace: "" },
  { name: "all agreements or a list, never both nor neither", find: line("if (terms.allAgreements == (agreementIds.length > 0)) revert InvalidTerms();"), replace: "" },
  { name: "no autonomy limit value without a limit", find: line("if (!terms.hasAutonomyLimit && terms.autonomyLimit != 0) revert InvalidTerms();"), replace: "" },
  { name: "no zero delegate", find: line("if (delegates[i] == address(0)) revert ZeroAddress();"), replace: "" },
  { name: "a delegate kind is known", find: line("if (kinds[i] != KIND_HUMAN && kinds[i] != KIND_AGENT) revert InvalidTerms();"), replace: "" },
  {
    name: "only a registered mandate is revoked",
    find: line("if (!m.registered) revert UnknownMandate();") + line("if (msg.sender != escrow.admin() && msg.sender != m.issuer) revert NotIssuer();"),
    replace: line("if (msg.sender != escrow.admin() && msg.sender != m.issuer) revert NotIssuer();"),
  },
  {
    name: "only a registered mandate decides",
    find: line("m = mandates[mandateId];") + line("if (!m.registered) revert UnknownMandate();"),
    replace: line("m = mandates[mandateId];"),
  },
  { name: "a mandate must allow some verdict", find: line("if (!terms.allowApprove && !terms.allowReject && !terms.allowReview) revert InvalidTerms();"), replace: "" },
  { name: "a mandate does not start after it ends", find: line("if (terms.validFrom >= terms.validUntil) revert InvalidTerms();"), replace: "" },
  { name: "a mandate is not registered already expired", find: line("if (terms.validUntil <= block.timestamp) revert InvalidTerms();"), replace: "" },
  { name: "a mandate is not backdated far", find: line("if (uint256(terms.validFrom) + MAX_BACKDATE < block.timestamp) revert InvalidTerms();"), replace: "" },
  { name: "validity cap", find: line("if (terms.validUntil - terms.validFrom > maxValidity) revert InvalidTerms();"), replace: "" },
  { name: "delegate list limit", find: line("if (delegates.length > MAX_DELEGATES) revert InvalidTerms();"), replace: "" },
  { name: "agreement list limit", find: line("if (agreementIds.length > MAX_AGREEMENTS) revert InvalidTerms();"), replace: "" },
  { name: "quorum within the delegates", find: line("if (terms.quorum == 0 || terms.quorum > delegates.length) revert InvalidTerms();"), replace: "" },
  { name: "no duplicate delegate", find: line("if (delegateKind[mandateId][delegates[i]] != 0) revert InvalidTerms();").replace(/^ {4}/, "    "), replace: "" },
  {
    name: "validity window",
    find: "if (m.revoked || block.timestamp < m.terms.validFrom || block.timestamp > m.terms.validUntil) revert MandateNotActive();",
    replace: "if (m.revoked) revert MandateNotActive();",
  },
  { name: "revocation", find: "if (m.revoked || block.timestamp < m.terms.validFrom", replace: "if (block.timestamp < m.terms.validFrom" },
  { name: "the mandate stays bound to the escrow admin", find: line("if (m.issuer != escrow.admin()) revert IssuerNotAdmin();"), replace: "" },
  { name: "only delegates decide", find: line("if (kind == 0) revert UnauthorizedActor();"), replace: "" },
  { name: "an agent cannot reject", find: line("if (kind == KIND_AGENT && verdict != VERDICT_APPROVE) revert UnauthorizedActor();"), replace: "" },
  { name: "a decision verdict is known", find: line("if (verdict != VERDICT_APPROVE && verdict != VERDICT_REJECT) revert InvalidVerdict();"), replace: "" },
  { name: "approval in scope", find: line("if (verdict == VERDICT_APPROVE && !m.terms.allowApprove) revert OutOfScope();"), replace: "" },
  { name: "verdict in scope", find: line("if (verdict == VERDICT_REJECT && !m.terms.allowReject) revert OutOfScope();"), replace: "" },
  {
    name: "agreement in scope for a decision",
    find: line("if (verdict == VERDICT_REJECT && !m.terms.allowReject) revert OutOfScope();") + line("if (!m.terms.allAgreements && !agreementInScope[mandateId][agreementId]) revert OutOfScope();"),
    replace: line("if (verdict == VERDICT_REJECT && !m.terms.allowReject) revert OutOfScope();"),
  },
  {
    name: "HYBRID mode only for a decision",
    find: line("if (agreement.mode != MODE_HYBRID) revert OutOfScope();") + "\n" + line("IPeriodEscrow.Period memory period = escrow.getPeriod(agreementId, periodId);") + line("if (period.state != PERIOD_PENDING_APPROVAL) revert PeriodNotPending();"),
    replace: line("IPeriodEscrow.Period memory period = escrow.getPeriod(agreementId, periodId);") + line("if (period.state != PERIOD_PENDING_APPROVAL) revert PeriodNotPending();"),
  },
  { name: "period pending", find: line("if (period.state != PERIOD_PENDING_APPROVAL) revert PeriodNotPending();"), replace: "" },
  {
    name: "audit hash binding for a decision",
    find: line("if (period.auditHash != auditHash) revert AuditHashMismatch();") + line("if (block.timestamp > period.approvalDeadline) revert DeadlinePassed();"),
    replace: line("if (block.timestamp > period.approvalDeadline) revert DeadlinePassed();"),
  },
  { name: "decision deadline", find: line("if (block.timestamp > period.approvalDeadline) revert DeadlinePassed();"), replace: "" },
  {
    name: "submitter cannot decide",
    find: line("if (block.timestamp > period.approvalDeadline) revert DeadlinePassed();") + line("if (period.submitter == msg.sender) revert SubmitterCannotDecide();"),
    replace: line("if (block.timestamp > period.approvalDeadline) revert DeadlinePassed();"),
  },
  {
    name: "autonomy limit",
    find: line("if (kind == KIND_AGENT && (!m.terms.hasAutonomyLimit || agreement.periodAmount > m.terms.autonomyLimit)) {") + "            revert MandateExceeded();\n        }\n",
    replace: "",
  },
  { name: "review needs the permission", find: line("if (!m.terms.allowReview) revert OutOfScope();"), replace: "" },
  { name: "only human delegates record a review", find: line("if (delegateKind[mandateId][msg.sender] != KIND_HUMAN) revert UnauthorizedActor();"), replace: "" },
  { name: "a review outcome is known", find: line("if (outcome != REVIEW_RESUBMIT && outcome != REVIEW_CLOSE_NO_PAY) revert InvalidVerdict();") + line("if (!m.terms.allAgreements && !agreementInScope[mandateId][agreementId]) revert OutOfScope();"), replace: line("if (!m.terms.allAgreements && !agreementInScope[mandateId][agreementId]) revert OutOfScope();") },
  {
    name: "agreement in scope for a review",
    find: line("if (outcome != REVIEW_RESUBMIT && outcome != REVIEW_CLOSE_NO_PAY) revert InvalidVerdict();") + line("if (!m.terms.allAgreements && !agreementInScope[mandateId][agreementId]) revert OutOfScope();"),
    replace: line("if (outcome != REVIEW_RESUBMIT && outcome != REVIEW_CLOSE_NO_PAY) revert InvalidVerdict();"),
  },
  {
    name: "HYBRID mode only for a review",
    find: line("if (agreement.mode != MODE_HYBRID) revert OutOfScope();") + "\n" + line("IPeriodEscrow.Period memory period = escrow.getPeriod(agreementId, periodId);") + line("if (period.state != PERIOD_IN_REVIEW) revert PeriodNotInReview();"),
    replace: line("IPeriodEscrow.Period memory period = escrow.getPeriod(agreementId, periodId);") + line("if (period.state != PERIOD_IN_REVIEW) revert PeriodNotInReview();"),
  },
  { name: "a review only for a period in review", find: line("if (period.state != PERIOD_IN_REVIEW) revert PeriodNotInReview();"), replace: "" },
  {
    name: "audit hash binding for a review",
    find: line("if (period.state != PERIOD_IN_REVIEW) revert PeriodNotInReview();") + line("if (period.auditHash != auditHash) revert AuditHashMismatch();"),
    replace: line("if (period.state != PERIOD_IN_REVIEW) revert PeriodNotInReview();"),
  },
  {
    name: "submitter cannot record a review",
    find: line("if (period.auditHash != auditHash) revert AuditHashMismatch();") + line("if (period.submitter == msg.sender) revert SubmitterCannotDecide();") + "\n        concluded =",
    replace: line("if (period.auditHash != auditHash) revert AuditHashMismatch();") + "\n        concluded =",
  },
  {
    name: "one vote per delegate",
    find: "if (hasDecided[ballotKey][msg.sender] || executed[periodKey]) revert AlreadyDecided();",
    replace: "if (executed[periodKey]) revert AlreadyDecided();",
  },
  {
    name: "a concluded ballot is closed before the escrow call",
    find: "if (hasDecided[ballotKey][msg.sender] || executed[periodKey]) revert AlreadyDecided();",
    replace: "if (hasDecided[ballotKey][msg.sender]) revert AlreadyDecided();",
  },
  { name: "quorum", find: line("reached = count >= quorum;"), replace: line("reached = true;") },
];

export function applyProtectionRemoval(source, protection) {
  const occurrences = source.split(protection.find).length - 1;
  if (occurrences !== 1) throw new Error(`"${protection.name}": expected the protected code once, found ${occurrences}`);
  return source.replace(protection.find, protection.replace);
}

export function classifyRun({ status, output }) {
  const failing = [...new Set([...output.matchAll(/^\s+\d+\) \S+#(\w+)/gm)].map((match) => match[1]))];
  const passing = Number(/^\s*(\d+) passing/m.exec(output)?.[1] ?? 0);
  const failingCount = Number(/^\s*(\d+) failing/m.exec(output)?.[1] ?? 0);
  const hardhatError = /^Error HHE\d+/m.test(output) || /^\w*Error: .*\n\s+--> /m.test(output);
  if (status === 0 && !hardhatError && failingCount === 0 && passing > 0) return { verdict: "passed", failing, passing };
  if (status !== 0 && !hardhatError && failingCount > 0 && failing.length > 0) return { verdict: "caught", failing, passing };
  const reason = hardhatError ? "Hardhat or the compiler stopped before the tests ran" : status === 0 ? "the run reported no passing test" : "the run failed without a failing test";
  return { verdict: "inconclusive", failing, passing, reason };
}

function runSuite(workDir) {
  const result = spawnSync(join(HEDERA_ROOT, "node_modules", ".bin", "hardhat"), ["--config", join(workDir, "hardhat.config.mjs"), "test", "solidity"], {
    cwd: workDir,
    env: { ...process.env, HARDHAT_DISABLE_TELEMETRY: "true" },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const output = `${result.stdout}\n${result.stderr}`;
  return { status: result.status, output, ...classifyRun({ status: result.status, output }) };
}

export async function prepareWorkDir(parent = tmpdir()) {
  const workDir = await mkdtemp(join(parent, "coorre-protection-check-"));
  if (isInside(HEDERA_ROOT, workDir)) throw new Error("the mutation work directory must be outside the repository");
  await cp(join(HEDERA_ROOT, "contracts"), join(workDir, "contracts"), { recursive: true });
  await symlink(join(HEDERA_ROOT, "node_modules"), join(workDir, "node_modules"), "dir");
  await writeFile(join(workDir, "package.json"), '{ "type": "module", "private": true }\n');
  await writeFile(join(workDir, "hardhat.config.mjs"), WORK_CONFIG);
  return workDir;
}

export function selectProtections(argv) {
  const index = argv.indexOf("--only");
  if (index < 0) return PROTECTIONS;
  const name = argv[index + 1];
  const chosen = PROTECTIONS.filter((protection) => protection.name === name);
  if (chosen.length !== 1) throw new Error(`--only needs the exact name of one protection, got ${JSON.stringify(name)}`);
  return chosen;
}

async function main() {
  const selected = selectProtections(process.argv.slice(2));
  await assertFrozenSources();
  const original = await readFile(CONTRACT, "utf8");
  const workDir = await prepareWorkDir();
  const cleanUp = () => rmSync(workDir, { recursive: true, force: true });
  const stop = (signal) => {
    cleanUp();
    process.kill(process.pid, signal);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const mutant = join(workDir, "contracts", "CoorReMandateGate.sol");
  const survivors = [];
  const inconclusive = [];
  try {
    const baseline = runSuite(workDir);
    if (baseline.verdict !== "passed") {
      process.stdout.write(baseline.output);
      throw new Error(`the suite does not pass before any protection is removed (${baseline.reason ?? baseline.verdict})`);
    }
    console.log(`baseline: ${baseline.passing} tests pass on a copy in ${workDir}`);
    for (const protection of selected) {
      await writeFile(mutant, applyProtectionRemoval(original, protection));
      const run = runSuite(workDir);
      if (run.verdict === "passed") survivors.push(protection.name);
      if (run.verdict === "inconclusive") {
        inconclusive.push(protection.name);
        process.stdout.write(run.output);
      }
      const label = { passed: "SURVIVED", caught: "caught  ", inconclusive: "INCONCLUSIVE" }[run.verdict];
      console.log(`${label} ${protection.name}${run.failing.length ? `: ${run.failing.join(", ")}` : ""}${run.reason ? ` (${run.reason})` : ""}`);
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    cleanUp();
  }
  await assertFrozenSources();
  if (survivors.length > 0 || inconclusive.length > 0) {
    console.log(`FAIL: ${survivors.length} protection(s) can be removed without a failing test, ${inconclusive.length} run(s) were inconclusive`);
    process.exit(1);
  }
  console.log(`PASS: removing any of the ${selected.length} protection(s) fails at least one test`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`protection-check: ${error.message}`);
    process.exit(2);
  });
}
