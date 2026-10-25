import { test } from "node:test";
import assert from "node:assert/strict";
import { compareFiles, fetchBytes, fetchPinned, hasDrift, rawUrl, readLock, safeRelativePath, sha256Hex, validateLock } from "../scripts/wata-lock.mjs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const COMMIT = "1462dfeb3d492893331dc5c0b0eae15d91ec807c";
const HASH = "a".repeat(64);

function lockWith(files) {
  return { repository: "vivipolli/wata", commit: COMMIT, access: "read-only", files };
}

test("sha256Hex matches the FIPS 180-2 abc vector", () => {
  assert.equal(sha256Hex(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("the committed lock is valid and read-only", async () => {
  const lock = await readLock();
  assert.equal(lock.access, "read-only");
  assert.equal(lock.commit, COMMIT);
  assert.ok(lock.files.some((file) => file.use === "compile" && file.contract === "PESEscrowV3"));
});

test("validateLock rejects a lock that is not read-only", () => {
  assert.throws(() => validateLock({ ...lockWith([{ path: "a.sol", sha256: HASH, use: "watch" }]), access: "write" }), /read-only/);
});

test("validateLock rejects a short commit", () => {
  assert.throws(() => validateLock({ ...lockWith([{ path: "a.sol", sha256: HASH, use: "watch" }]), commit: "1462dfeb" }), /40-character/);
});

test("validateLock rejects a compile file without an expected bytecode hash", () => {
  assert.throws(() => validateLock(lockWith([{ path: "a.sol", sha256: HASH, use: "compile", contract: "A" }])), /bytecodeSha256/);
});

test("validateLock rejects duplicate paths", () => {
  const file = { path: "a.sol", sha256: HASH, use: "watch" };
  assert.throws(() => validateLock(lockWith([file, file])), /duplicate/);
});

test("safeRelativePath refuses absolute and escaping paths", () => {
  assert.throws(() => safeRelativePath("/etc/passwd"), /relative/);
  assert.throws(() => safeRelativePath("../secret"), /normalized/);
  assert.throws(() => safeRelativePath("a/../../b"), /normalized/);
  assert.throws(() => safeRelativePath("a\\b"), /relative/);
  assert.equal(safeRelativePath("contracts/contracts/PESEscrowV3.sol"), "contracts/contracts/PESEscrowV3.sol");
});

test("rawUrl pins the commit in the URL", () => {
  assert.equal(rawUrl("vivipolli/wata", COMMIT, "contracts/deployment.json"), `https://raw.githubusercontent.com/vivipolli/wata/${COMMIT}/contracts/deployment.json`);
});

test("compareFiles reports same, changed and missing", () => {
  const files = [
    { path: "a", sha256: HASH, use: "compile" },
    { path: "b", sha256: HASH, use: "watch" },
    { path: "c", sha256: HASH, use: "watch" },
  ];
  const observed = new Map([["a", HASH], ["b", "b".repeat(64)]]);
  const comparison = compareFiles(files, observed);
  assert.deepEqual(comparison.map((entry) => entry.status), ["same", "changed", "missing"]);
  assert.equal(hasDrift(comparison), true);
  assert.equal(hasDrift(comparison.slice(0, 1)), false);
});

function fakeFetch(table) {
  return async (url) => {
    const body = table.get(url);
    if (body === undefined) return new Response(null, { status: 404 });
    return new Response(body, { status: 200 });
  };
}

test("fetchBytes returns null on 404 and throws on other errors", async () => {
  assert.equal(await fetchBytes("https://x/missing", fakeFetch(new Map())), null);
  await assert.rejects(fetchBytes("https://x/err", async () => new Response(null, { status: 500 })), /500/);
});

test("fetchPinned writes files whose hash matches and refuses a tampered file", async () => {
  const root = await mkdtemp(join(tmpdir(), "coorre-wata-"));
  try {
    const content = Buffer.from("contract A {}\n");
    const lock = lockWith([{ path: "contracts/A.sol", sha256: sha256Hex(content), use: "watch" }]);
    const url = rawUrl(lock.repository, lock.commit, "contracts/A.sol");
    const { files } = await fetchPinned(lock, root, fakeFetch(new Map([[url, content]])));
    assert.deepEqual(await readFile(files[0].target), content);
    await assert.rejects(fetchPinned(lock, root, fakeFetch(new Map([[url, Buffer.from("contract B {}\n")]]))), /does not match the pinned/);
    await assert.rejects(fetchPinned(lock, root, fakeFetch(new Map())), /missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
