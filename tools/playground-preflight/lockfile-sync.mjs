#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function installedPackages(text) {
  const lock = JSON.parse(text);
  const packages = { ...(lock.packages ?? {}) };
  delete packages[""];
  return { lockfileVersion: lock.lockfileVersion, packages };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  }
  return value;
}

export function lockfilesMatch(lockText, hiddenText) {
  if (typeof hiddenText !== "string") return false;
  let wanted;
  let installed;
  try {
    wanted = installedPackages(lockText);
    installed = installedPackages(hiddenText);
  } catch (err) {
    if (err instanceof SyntaxError) return false;
    throw err;
  }
  return JSON.stringify(canonical(wanted)) === JSON.stringify(canonical(installed));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.argv[2] ?? path.dirname(fileURLToPath(import.meta.url)));
  const hidden = path.join(dir, "node_modules", ".package-lock.json");
  const lockText = readFileSync(path.join(dir, "package-lock.json"), "utf8");
  const inSync = existsSync(hidden) && lockfilesMatch(lockText, readFileSync(hidden, "utf8"));
  process.exitCode = inSync ? 0 : 1;
}
