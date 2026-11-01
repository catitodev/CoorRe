import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const HEDERA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = resolve(HEDERA_ROOT, "..");
export const ARTIFACTS_ROOT = join(HEDERA_ROOT, ".cache", "artifacts");

function present(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function real(path) {
  try {
    return realpathSync(path);
  } catch (error) {
    throw new Error(`${path} cannot be resolved (${error.code ?? error.message}); a dangling link is refused`, { cause: error });
  }
}

export function realPathOf(path) {
  const text = String(path);
  const absolute = isAbsolute(text) ? text : `${process.cwd()}${sep}${text}`;
  const segments = absolute.split(sep).filter((segment) => segment.length > 0);
  let current = real(sep);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === ".") continue;
    if (segment === "..") {
      current = dirname(current);
      continue;
    }
    const candidate = join(current, segment);
    if (!present(candidate)) return resolve(candidate, ...segments.slice(index + 1));
    current = real(candidate);
  }
  return current;
}

export function isInside(parent, child) {
  const base = realPathOf(parent);
  const target = realPathOf(child);
  return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}
