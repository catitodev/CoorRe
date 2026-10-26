import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const HEDERA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = resolve(HEDERA_ROOT, "..");
export const ARTIFACTS_ROOT = join(HEDERA_ROOT, ".cache", "artifacts");

export function isInside(parent, child) {
  const base = resolve(parent);
  const target = resolve(child);
  return target === base || target.startsWith(`${base}${sep}`);
}
