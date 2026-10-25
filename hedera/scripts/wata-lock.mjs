import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const HEDERA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const LOCK_PATH = join(HEDERA_ROOT, "reference", "wata.lock.json");
export const CACHE_ROOT = join(HEDERA_ROOT, ".cache", "wata");

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const USES = new Set(["compile", "watch"]);

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateLock(lock) {
  if (!lock || typeof lock !== "object") throw new Error("lock must be an object");
  if (!REPOSITORY_PATTERN.test(lock.repository ?? "")) throw new Error("lock.repository must be owner/name");
  if (!COMMIT_PATTERN.test(lock.commit ?? "")) throw new Error("lock.commit must be a full 40-character sha");
  if (lock.access !== "read-only") throw new Error("lock.access must be read-only");
  if (!Array.isArray(lock.files) || lock.files.length === 0) throw new Error("lock.files must be a non-empty array");
  const seen = new Set();
  for (const file of lock.files) {
    safeRelativePath(file.path);
    if (seen.has(file.path)) throw new Error(`duplicate path ${file.path}`);
    seen.add(file.path);
    if (!SHA256_PATTERN.test(file.sha256 ?? "")) throw new Error(`bad sha256 for ${file.path}`);
    if (!USES.has(file.use)) throw new Error(`bad use for ${file.path}`);
    if (file.use === "compile") {
      if (typeof file.contract !== "string" || file.contract.length === 0) throw new Error(`missing contract for ${file.path}`);
      if (!SHA256_PATTERN.test(file.bytecodeSha256 ?? "")) throw new Error(`bad bytecodeSha256 for ${file.path}`);
    }
  }
  return lock;
}

export function safeRelativePath(path) {
  if (typeof path !== "string" || path.length === 0) throw new Error("path must be a non-empty string");
  if (path.startsWith("/") || path.includes("\\")) throw new Error(`path must be relative: ${path}`);
  const normalized = normalize(path);
  if (normalized !== path || normalized.split(sep).includes("..")) throw new Error(`path must be normalized: ${path}`);
  return path;
}

export function rawUrl(repository, ref, path) {
  return `https://raw.githubusercontent.com/${repository}/${ref}/${safeRelativePath(path)}`;
}

export function compareFiles(lockFiles, observed) {
  return lockFiles.map((file) => {
    const sha256 = observed.get(file.path) ?? null;
    const status = sha256 === null ? "missing" : sha256 === file.sha256 ? "same" : "changed";
    return { path: file.path, use: file.use, pinned: file.sha256, observed: sha256, status };
  });
}

export function hasDrift(comparison) {
  return comparison.some((entry) => entry.status !== "same");
}

export async function readLock(path = LOCK_PATH) {
  return validateLock(JSON.parse(await readFile(path, "utf8")));
}

export async function fetchBytes(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, { headers: { "user-agent": "coorre-hedera" } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GET ${url} returned ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function fetchHeadCommit(repository, fetchImpl = fetch) {
  const headers = { accept: "application/vnd.github+json", "user-agent": "coorre-hedera" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/commits/HEAD`, { headers });
  if (!response.ok) throw new Error(`GitHub API returned ${response.status} for ${repository} HEAD`);
  const body = await response.json();
  if (!COMMIT_PATTERN.test(body.sha ?? "")) throw new Error("GitHub API returned no commit sha");
  return { sha: body.sha, date: body.commit?.committer?.date ?? null };
}

export async function fetchPinned(lock, cacheRoot = CACHE_ROOT, fetchImpl = fetch) {
  const root = join(cacheRoot, lock.commit);
  const results = [];
  for (const file of lock.files) {
    const bytes = await fetchBytes(rawUrl(lock.repository, lock.commit, file.path), fetchImpl);
    if (bytes === null) throw new Error(`${file.path} is missing at ${lock.commit}`);
    const sha256 = sha256Hex(bytes);
    if (sha256 !== file.sha256) throw new Error(`${file.path}: sha256 ${sha256} does not match the pinned ${file.sha256}`);
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    results.push({ path: file.path, sha256, target });
  }
  return { root, files: results };
}
