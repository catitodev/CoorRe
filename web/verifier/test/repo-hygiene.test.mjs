import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
const KEYPAIR = /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/g;

function keypairArrays(text) {
  return [...text.matchAll(KEYPAIR)].map((m) => m[0]).filter((match) => match.match(/\d+/g).every((n) => Number(n) <= 255));
}

test("the keypair detector finds a Solana keypair array and nothing shorter", () => {
  const keypair = JSON.stringify(Array.from({ length: 64 }, (_, i) => (i * 37) % 256));
  assert.equal(keypairArrays(`{"k": ${keypair}}`).length, 1);
  assert.equal(keypairArrays(keypair.replace(/,/g, ",\n  ")).length, 1);
  assert.equal(keypairArrays(JSON.stringify(Array.from({ length: 32 }, () => 7))).length, 0);
  assert.equal(keypairArrays(JSON.stringify(Array.from({ length: 64 }, () => 300))).length, 0);
});

test("no tracked file holds a Solana keypair", () => {
  const files = git("ls-files", "-z").split("\0").filter(Boolean);
  assert.ok(files.length > 50, String(files.length));
  const found = [];
  for (const file of files) {
    const bytes = readFileSync(path.join(repo, file));
    if (bytes.includes(0)) continue;
    if (keypairArrays(bytes.toString("utf8")).length) found.push(file);
  }
  assert.deepEqual(found, []);
});

test("the ignore rules keep environment files and keypairs out of git anywhere in the tree", () => {
  const rules = readFileSync(path.join(repo, ".gitignore"), "utf8").split("\n");
  for (const rule of [".local/", ".env*", "*keypair*.json"]) assert.ok(rules.includes(rule), `.gitignore lost ${rule}`);
  for (const probe of [".env", ".env.local", "bridge/.env.production", "demo-keypair.json", "hedera/keys/payer-keypair.json", ".local/guard"]) {
    const result = spawnSync("git", ["-C", repo, "check-ignore", "-q", "--no-index", "--", probe]);
    assert.equal(result.status, 0, `${probe} is not ignored`);
  }
  assert.equal(git("ls-files", "-i", "-c", "--exclude-standard"), "");
});
