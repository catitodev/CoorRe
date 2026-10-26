import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { artifactPath, loadArtifact } from "../lib/artifacts.mjs";
import { HEDERA_ROOT, REPO_ROOT } from "../lib/paths.mjs";

const schema = JSON.parse(readFileSync(join(HEDERA_ROOT, "spec", "host-profile.schema.json"), "utf8"));
const profile = JSON.parse(readFileSync(join(HEDERA_ROOT, "host-profiles", "example.json"), "utf8"));
const UNFILLED = /A PREENCHER|TO BE FILLED|\bTBD\b|\bTODO\b/i;

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function typeMatches(expected, value) {
  const actual = typeOf(value);
  return actual === expected || (expected === "number" && actual === "integer");
}

export function validate(node, value, path = "$", root = node) {
  if (node.$ref) {
    const name = /^#\/\$defs\/(.+)$/.exec(node.$ref)?.[1];
    if (!name || !root.$defs?.[name]) return [`${path}: unknown $ref ${node.$ref}`];
    return validate(root.$defs[name], value, path, root);
  }
  const errors = [];
  if ("const" in node && JSON.stringify(node.const) !== JSON.stringify(value)) errors.push(`${path}: expected ${JSON.stringify(node.const)}`);
  if (node.enum && !node.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) errors.push(`${path}: not one of ${JSON.stringify(node.enum)}`);
  if (node.type) {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (!types.some((type) => typeMatches(type, value))) return [...errors, `${path}: expected ${types.join(" or ")}, got ${typeOf(value)}`];
  }
  if (typeof value === "string") {
    if (node.minLength !== undefined && value.length < node.minLength) errors.push(`${path}: shorter than ${node.minLength}`);
    if (node.pattern && !new RegExp(node.pattern, "u").test(value)) errors.push(`${path}: does not match ${node.pattern}`);
  }
  if (typeof value === "number") {
    if (node.minimum !== undefined && value < node.minimum) errors.push(`${path}: below ${node.minimum}`);
    if (node.maximum !== undefined && value > node.maximum) errors.push(`${path}: above ${node.maximum}`);
  }
  if (Array.isArray(value)) {
    if (node.minItems !== undefined && value.length < node.minItems) errors.push(`${path}: fewer than ${node.minItems} items`);
    if (node.items) value.forEach((item, index) => errors.push(...validate(node.items, item, `${path}[${index}]`, root)));
  }
  if (typeOf(value) === "object") {
    for (const key of node.required ?? []) if (!(key in value)) errors.push(`${path}: missing ${key}`);
    for (const [key, child] of Object.entries(value)) {
      if (node.properties?.[key]) errors.push(...validate(node.properties[key], child, `${path}.${key}`, root));
      else if (node.additionalProperties === false) errors.push(`${path}: unexpected ${key}`);
    }
  }
  return errors;
}

function walk(value, visit, path = "$") {
  visit(value, path);
  if (Array.isArray(value)) value.forEach((item, index) => walk(item, visit, `${path}[${index}]`));
  else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) walk(child, visit, `${path}.${key}`);
}

function sources(value) {
  const found = [];
  walk(value, (node, path) => {
    if (node && typeof node === "object" && !Array.isArray(node) && typeof node.kind === "string" && typeof node.ref === "string") found.push({ path, ...node });
  });
  return found;
}

function selectors(value) {
  const found = [];
  walk(value, (node) => {
    if (node && typeof node === "object" && typeof node.signature === "string" && typeof node.selector === "string") found.push(node);
  });
  return found;
}

function slug(heading) {
  return heading.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/ +/g, "-");
}

test("the schema uses only the keywords the validator implements", () => {
  const known = new Set(["$schema", "$id", "title", "description", "type", "additionalProperties", "required", "properties", "$defs", "$ref", "const", "enum", "pattern", "minLength", "minimum", "maximum", "minItems", "items", "default"]);
  const unknown = [];
  walk(schema, (node, path) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    if (/\.(properties|\$defs)$/.test(path)) return;
    for (const key of Object.keys(node)) if (!known.has(key)) unknown.push(`${path}.${key}`);
  });
  assert.deepEqual(unknown, []);
});

test("the example profile validates against the schema", () => {
  assert.deepEqual(validate(schema, profile), []);
});

test("no field of the profile is left unfilled", () => {
  const unfilled = [];
  walk(profile, (node, path) => {
    if (typeof node === "string" && UNFILLED.test(node)) unfilled.push(path);
  });
  assert.deepEqual(unfilled, []);
});

test("the validator refuses an unfilled value, a missing field and an unexpected field", () => {
  const unfilled = structuredClone(profile);
  unfilled.mandate.quorum.default = "A PREENCHER";
  assert.ok(validate(schema, unfilled).some((error) => error.includes("$.mandate.quorum.default")));
  const missing = structuredClone(profile);
  delete missing.mandate.validity;
  assert.ok(validate(schema, missing).some((error) => error.includes("missing validity")));
  const extra = structuredClone(profile);
  extra.decisionPoints[0].threshold = 70;
  assert.ok(validate(schema, extra).some((error) => error.includes("unexpected threshold")));
  const write = structuredClone(profile);
  write.hostRef = { repository: "example/host", commit: "a".repeat(40), access: "write" };
  assert.ok(validate(schema, write).some((error) => error.includes("$.hostRef.access")));
});

test("the profile does not set host business values", () => {
  const forbidden = ["scoreThreshold", "periodAmount", "approvalWindow", "threshold", "amount"];
  const keys = [];
  walk(profile, (node) => {
    if (node && typeof node === "object" && !Array.isArray(node)) keys.push(...Object.keys(node));
  });
  assert.deepEqual(keys.filter((key) => forbidden.includes(key)), []);
  assert.equal(profile.mandate.autonomyLimit.value, null);
  assert.equal(profile.mandate.validity.default, null);
});

test("every host-code source names a file of this repository and a line range inside it", () => {
  const problems = [];
  for (const source of sources(profile).filter((entry) => entry.kind === "host-code")) {
    const match = /^(.+):(\d+)(?:-(\d+))?$/.exec(source.ref);
    if (!match) {
      problems.push(`${source.path}: ${source.ref} is not path:line or path:start-end`);
      continue;
    }
    const [, file, start, end = start] = match;
    const path = join(REPO_ROOT, file);
    if (!existsSync(path)) {
      problems.push(`${source.path}: ${file} does not exist`);
      continue;
    }
    if (Number(start) > Number(end)) problems.push(`${source.path}: range ${start}-${end} is reversed`);
    const lines = readFileSync(path, "utf8").split("\n").length;
    if (Number(end) > lines) problems.push(`${source.path}: ${file} has ${lines} lines, ref ends at ${end}`);
  }
  assert.deepEqual(problems, []);
});

test("every coorre-proposal source points to a heading of the Hedera specification", () => {
  const spec = readFileSync(join(REPO_ROOT, "docs", "hedera", "SPEC.md"), "utf8");
  const anchors = new Set([...spec.matchAll(/^#{1,6} (.+)$/gm)].map((match) => slug(match[1])));
  const problems = [];
  for (const source of sources(profile).filter((entry) => entry.kind === "coorre-proposal")) {
    const [file, anchor] = source.ref.split("#");
    if (file !== "docs/hedera/SPEC.md") problems.push(`${source.path}: ${source.ref} is outside docs/hedera/SPEC.md`);
    else if (!anchors.has(anchor)) problems.push(`${source.path}: no heading #${anchor}`);
  }
  assert.deepEqual(problems, []);
});

test("selectors match the compiled reference escrow when a build is present", async (t) => {
  if (!existsSync(artifactPath("reference/ReferencePeriodEscrow.sol", "ReferencePeriodEscrow"))) {
    t.skip("no Hardhat build; run npm run build:contracts");
    return;
  }
  const { identifiers } = await loadArtifact("reference/ReferencePeriodEscrow.sol", "ReferencePeriodEscrow");
  const problems = selectors(profile)
    .filter((entry) => `0x${identifiers[entry.signature]}` !== entry.selector)
    .map((entry) => `${entry.signature}: profile ${entry.selector}, compiled 0x${identifiers[entry.signature]}`);
  assert.deepEqual(problems, []);
});
