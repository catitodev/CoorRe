import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkTypescriptVersion, verdict } from "../preflight.mjs";
import { lockfilesMatch } from "../lockfile-sync.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.resolve(HERE, "..");

test("skipped checks are not reported as safe to paste", () => {
  const run = spawnSync(process.execPath, [path.join(TOOL, "preflight.mjs"), "--offline", "--skip-programs"], { encoding: "utf8", timeout: 120_000 });
  const lines = run.stdout.trim().split("\n");
  assert.notEqual(run.status, 0, run.stdout + run.stderr);
  assert.equal(lines.at(-1), "2 check(s) skipped: not cleared for Playground.");
  assert.ok(!run.stdout.includes("safe to paste"), run.stdout);
});

test("verdict: failures first, then skips, and only a clean run is cleared", () => {
  assert.deepEqual(verdict([{ status: "PASS" }, { status: "PASS" }]), { code: 0, line: "All checks passed: safe to paste into Playground." });
  assert.deepEqual(verdict([{ status: "PASS" }, { status: "WARN" }]), { code: 1, line: "1 check(s) skipped: not cleared for Playground." });
  assert.deepEqual(verdict([{ status: "FAIL" }, { status: "WARN" }]), { code: 1, line: "1 check(s) failed: do not paste into Playground yet." });
  assert.equal(verdict([]).code, 1, "no checks at all is not a pass");
});

test("the installed TypeScript must be the version Playground uses", () => {
  assert.equal(checkTypescriptVersion("5.0.4", { typescriptVersion: "5.0.4" }).status, "PASS");
  const wrong = checkTypescriptVersion("5.9.3", { typescriptVersion: "5.0.4" });
  assert.equal(wrong.status, "FAIL");
  assert.match(wrong.detail, /5\.9\.3/);
  assert.match(wrong.detail, /npm ci/);
  assert.equal(checkTypescriptVersion("5.0.4", {}).status, "FAIL");
});

test("lockfilesMatch compares the installed tree with package-lock.json", () => {
  const lock = { name: "x", lockfileVersion: 3, packages: { "": { name: "x" }, "node_modules/typescript": { version: "5.0.4", integrity: "a" } } };
  const hidden = { name: "x", lockfileVersion: 3, packages: { "node_modules/typescript": { version: "5.0.4", integrity: "a" } } };
  assert.equal(lockfilesMatch(JSON.stringify(lock), JSON.stringify(hidden)), true);
  const stale = structuredClone(hidden);
  stale.packages["node_modules/typescript"].version = "5.9.3";
  assert.equal(lockfilesMatch(JSON.stringify(lock), JSON.stringify(stale)), false);
  const extra = structuredClone(hidden);
  extra.packages["node_modules/left-pad"] = { version: "1.0.0" };
  assert.equal(lockfilesMatch(JSON.stringify(lock), JSON.stringify(extra)), false);
  assert.equal(lockfilesMatch(JSON.stringify(lock), undefined), false);
  assert.equal(lockfilesMatch(JSON.stringify(lock), "{not json"), false);
});

test("lockfile-sync exits 0 only when node_modules matches the lockfile", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "coorre-lock-"));
  try {
    const lock = { lockfileVersion: 3, packages: { "": {}, "node_modules/typescript": { version: "5.0.4" } } };
    writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify(lock));
    const sync = () => spawnSync(process.execPath, [path.join(TOOL, "lockfile-sync.mjs"), dir], { encoding: "utf8" }).status;
    assert.equal(sync(), 1, "no node_modules");
    mkdirSync(path.join(dir, "node_modules"));
    writeFileSync(path.join(dir, "node_modules", ".package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/typescript": { version: "5.9.3" } } }));
    assert.equal(sync(), 1, "stale node_modules");
    writeFileSync(path.join(dir, "node_modules", ".package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/typescript": { version: "5.0.4" } } }));
    assert.equal(sync(), 0, "in sync");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
