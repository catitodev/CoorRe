import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../lib/paths.mjs";

function scalar(text) {
  const value = text.trim();
  if (value === "") return null;
  if (/^".*"$/.test(value) || /^'.*'$/.test(value)) return value.slice(1, -1);
  return value;
}

export function parseWorkflow(source) {
  const lines = source.split("\n").map((raw) => ({ raw, indent: raw.search(/\S/), text: raw.trim() })).filter((line) => line.indent >= 0);
  let index = 0;

  function block(indent) {
    if (index >= lines.length || lines[index].indent < indent) return null;
    return lines[index].text.startsWith("- ") || lines[index].text === "-" ? sequence(lines[index].indent) : mapping(lines[index].indent);
  }

  function literal(parentIndent) {
    const body = [];
    let base = null;
    while (index < lines.length && lines[index].indent > parentIndent) {
      base ??= lines[index].indent;
      body.push(lines[index].raw.slice(base));
      index += 1;
    }
    return `${body.join("\n")}\n`;
  }

  function entry(text, indent, target) {
    const match = /^([^:]+?):(?:\s+(.*))?$/.exec(text);
    if (!match) throw new Error(`unreadable line: ${text}`);
    const [, key, rest = ""] = match;
    if (rest === "|") target[key] = literal(indent);
    else if (rest === "") target[key] = block(indent + 1);
    else target[key] = scalar(rest);
  }

  function mapping(indent) {
    const result = {};
    while (index < lines.length && lines[index].indent === indent && !lines[index].text.startsWith("- ")) {
      const line = lines[index];
      index += 1;
      entry(line.text, indent, result);
    }
    return result;
  }

  function sequence(indent) {
    const result = [];
    while (index < lines.length && lines[index].indent === indent && lines[index].text.startsWith("- ")) {
      const line = lines[index];
      const inner = line.text.slice(2);
      const innerIndent = indent + 2;
      if (/^[^:"']+:(\s|$)/.test(inner)) {
        lines[index] = { raw: `${" ".repeat(innerIndent)}${inner}`, indent: innerIndent, text: inner };
        result.push(mapping(innerIndent));
      } else {
        index += 1;
        result.push(scalar(inner));
      }
    }
    return result;
  }

  const document = mapping(0);
  if (index !== lines.length) throw new Error(`unparsed line ${index + 1}: ${lines[index].raw}`);
  return document;
}

const ci = parseWorkflow(readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8"));
const solo = parseWorkflow(readFileSync(join(REPO_ROOT, ".github", "workflows", "hedera-solo.yml"), "utf8"));
const PINNED_ACTIONS = {
  "actions/checkout": "3d3c42e5aac5ba805825da76410c181273ba90b1",
  "actions/setup-node": "820762786026740c76f36085b0efc47a31fe5020",
};

test("the workflow reader understands mappings, sequences and literal blocks", () => {
  const parsed = parseWorkflow('on:\n  push:\n    branches:\n      - main\njobs:\n  a:\n    steps:\n      - name: one\n        run: |\n          echo 1\n          echo 2\n      - uses: x/y@abc\n        with:\n          node-version: "24"\n');
  assert.deepEqual(parsed, {
    on: { push: { branches: ["main"] } },
    jobs: { a: { steps: [{ name: "one", run: "echo 1\necho 2\n" }, { uses: "x/y@abc", with: { "node-version": "24" } }] } },
  });
});

test("CI runs the hedera job on every push and pull request", () => {
  assert.ok(Object.hasOwn(ci.on, "push") && ci.on.push === null, "push without filters");
  assert.ok(Object.hasOwn(ci.on, "pull_request") && ci.on.pull_request === null, "pull_request without filters");
  assert.deepEqual(ci.permissions, { contents: "read" });
  const job = ci.jobs.hedera;
  assert.ok(job, "ci.yml has a hedera job");
  assert.equal(job.defaults.run["working-directory"], "hedera");
  assert.equal(job.env.HARDHAT_DISABLE_TELEMETRY, "true");
  const runs = job.steps.filter((step) => step.run).map((step) => step.run.trim());
  for (const command of ["npm ci --no-fund", "npm audit --omit=dev --audit-level=high", "npm run build:contracts", "npm test", "npm run test:contracts", "npm run check:protections"]) {
    assert.ok(runs.includes(command), `the hedera job runs ${command}`);
  }
  assert.ok(runs.indexOf("npm run build:contracts") < runs.indexOf("npm test"), "the build comes before npm test");
});

test("every action in the hedera workflows is pinned to the commit already used, without persisted credentials", () => {
  for (const job of [ci.jobs.hedera, solo.jobs.probes]) {
    for (const step of job.steps.filter((entry) => entry.uses)) {
      const [action, ref] = step.uses.split("@");
      if (PINNED_ACTIONS[action]) assert.equal(ref, PINNED_ACTIONS[action], step.uses);
      else assert.match(ref, /^[0-9a-f]{40}$/, step.uses);
      if (action === "actions/checkout") assert.equal(step.with["persist-credentials"], "false");
    }
  }
});

test("the Solo workflow runs on main, on pull requests that touch hedera and by hand", () => {
  assert.ok(Object.hasOwn(solo.on, "workflow_dispatch"));
  assert.deepEqual(solo.on.push.branches, ["main"]);
  for (const trigger of [solo.on.push, solo.on.pull_request]) {
    assert.ok(trigger.paths.includes("hedera/**"));
    assert.ok(trigger.paths.includes(".github/workflows/hedera-solo.yml"));
  }
  assert.ok(!JSON.stringify(solo.on).includes("hedera-engine"));
  assert.deepEqual(solo.permissions, { contents: "read" });
});

test("the Solo workflow gives the token only to the step that needs it and swallows no error", () => {
  const job = solo.jobs.probes;
  assert.ok(!Object.hasOwn(job.env, "GITHUB_TOKEN"), "no token for the whole job");
  const withToken = job.steps.filter((step) => step.env && Object.hasOwn(step.env, "GITHUB_TOKEN"));
  assert.deepEqual(withToken.map((step) => step.run.trim()), ["solo one-shot single deploy"]);
  assert.match(job.env.SOLO_VERSION, /^\d+\.\d+\.\d+$/);
  assert.match(job.env.SOLO_TARBALL_SHA512, /^[0-9a-f]{128}$/);
  const install = job.steps.find((step) => /npm install -g/.test(step.run ?? ""));
  assert.match(install.run, /sha512sum -c -/);
  for (const step of job.steps.filter((entry) => entry.run)) assert.ok(!/\|\|\s*true\b/.test(step.run), `${step.name} swallows an error`);
});

test("every node --test call names test files, not a directory, so it runs on every supported Node", () => {
  const sources = readdirSync(join(REPO_ROOT, ".github", "workflows"))
    .filter((name) => name.endsWith(".yml"))
    .map((name) => [name, readFileSync(join(REPO_ROOT, ".github", "workflows", name), "utf8")]);
  for (const dir of ["bridge", "hedera", "web/verifier", "tools/playground-preflight"]) {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, dir, "package.json"), "utf8"));
    sources.push([`${dir}/package.json`, Object.values(manifest.scripts ?? {}).join("\n")]);
  }
  let calls = 0;
  for (const [name, source] of sources) {
    for (const match of source.matchAll(/node --test((?:[ \t]+[^\s&|;]+)+)/g)) {
      calls += 1;
      for (const arg of match[1].trim().split(/\s+/).filter((part) => !part.startsWith("-"))) {
        assert.match(arg.replace(/^["']|["']$/g, ""), /\.m?js$/, `${name}: node --test ${arg} must name test files`);
      }
    }
  }
  assert.ok(calls >= 5, `only ${calls} node --test calls found`);
});
