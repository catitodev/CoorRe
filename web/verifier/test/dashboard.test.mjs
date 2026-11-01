import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { base58, decodeCaseRecord, decodeUpgradeAuthority, readAccounts, CASE_RECORD_SIZE } from "../live.js";

const read = (p) => readFileSync(new URL(p, import.meta.url));
const data = JSON.parse(read("../site-data.json").toString("utf8"));

test("site-data.json is generated from the committed bundles and rules", () => {
  const script = new URL("../../../scripts/build-site-data", import.meta.url).pathname;
  const out = execFileSync(process.execPath, [script, "--check"], { encoding: "utf8" });
  assert.match(out, /up to date/);
});

test("the dashboard data matches the recorded devnet runs", () => {
  assert.equal(data.cases.length, 10);
  assert.deepEqual(
    data.rules.map((r) => `${r.id} v${r.version}`),
    ["supplier-docs v1", "agent-purchase v1", "agent-purchase v2", "ecosystem-services-payment v1", "milestone-payment v1", "milestone-payment v2", "service-delivery v1", "service-delivery v2"]
  );
  for (const rule of data.rules) {
    const citing = data.cases.filter((c) => c.rule.id === rule.id && c.rule.version === rule.version);
    assert.deepEqual(rule.cases, citing.map((c) => c.id), `${rule.id} v${rule.version}`);
    for (const c of citing) assert.equal(c.rule.hash, rule.hash, c.id);
  }
  for (const v2 of data.rules.filter((r) => r.version === "2")) assert.deepEqual(v2.cases, [], v2.id);
  for (const run of data.runs) assert.equal(run.spent, run.recorded_spent, run.date);
  assert.deepEqual(data.cases.filter((c) => c.blocked_attempt).map((c) => c.id), ["SUP-002", "AGT-002", "PES-002"]);
  const outcomes = Object.groupBy(data.cases, (c) => c.outcome);
  assert.equal(outcomes.auto.length, 5);
  assert.equal(outcomes.approved.length, 3);
  assert.equal(outcomes.rejected.length, 2);
  for (const c of data.cases) assert.ok(c.rule.hash.startsWith("sha256:"), c.id);
});

test("base58 encodes like the Solana addresses in the bundles", () => {
  assert.equal(base58(new Uint8Array(32)), "11111111111111111111111111111111");
  assert.equal(base58(new Uint8Array([0, 0, 1])), "112");
});

test("case records and program data decode from recorded devnet bytes", () => {
  const recorded = JSON.parse(read("./fixtures/SUP-002-rpc.json").toString("utf8"));
  const bytes = Uint8Array.from(Buffer.from(recorded.response.result.value[0].data[0], "base64"));
  assert.equal(bytes.length, CASE_RECORD_SIZE);
  const record = decodeCaseRecord(bytes);
  assert.deepEqual(record, { amount: 200000000, autonomyLimit: 100000000, state: "APPROVED", transitions: 4 });
  assert.throws(() => decodeCaseRecord(bytes.slice(1)));
  const programData = new Uint8Array(45);
  programData[0] = 3;
  programData[12] = 1;
  programData.fill(0, 13, 45);
  assert.equal(decodeUpgradeAuthority(programData), "11111111111111111111111111111111");
  assert.throws(() => decodeUpgradeAuthority(new Uint8Array(10)));
});

test("live reads send one getMultipleAccounts with public addresses only", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ result: { context: { slot: 7 }, value: [{ owner: "o", lamports: 5, executable: true, data: ["AQI=", "base64"] }, null] } }) };
  };
  const result = await readAccounts("https://rpc.example", ["A", "B"], fetchImpl);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.method, "getMultipleAccounts");
  assert.deepEqual(calls[0].body.params[0], ["A", "B"]);
  assert.deepEqual([...result.accounts.A.data], [1, 2]);
  assert.equal(result.accounts.B, null);
  await assert.rejects(readAccounts("x", ["A"], async () => ({ ok: false, status: 500 })), /HTTP 500/);
});

test("dashboard modules never build HTML from data", () => {
  for (const file of ["../views.js", "../charts.js", "../live.js", "../app.js", "../i18n.js"]) {
    const source = read(file).toString("utf8");
    for (const forbidden of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"]) {
      assert.ok(!source.includes(forbidden), `${file}: ${forbidden}`);
    }
  }
});

test("every case reads as a complete story with no missing value", async () => {
  const { caseSteps, stepStory } = await import("../views.js");
  for (const c of data.cases) {
    const rows = caseSteps(c);
    assert.equal(rows.length, c.steps.length + 1 + (c.blocked_attempt ? 1 : 0), c.id);
    assert.equal(rows[0].step.to, "OPEN", c.id);
    const blocked = rows.findIndex((r) => r.kind === "blocked");
    if (c.blocked_attempt) assert.equal(rows[blocked + 1].step.to, "ESCALATED", c.id);
    for (const row of rows.filter((r) => r.kind === "step")) {
      const story = stepStory(c, row.step);
      for (const text of [story.title, story.body, story.quote ?? ""]) assert.ok(!/\b(undefined|null|NaN)\b/.test(text), `${c.id} ${row.step.to}: ${text}`);
      if (row.step.role === "approver") assert.ok(story.quote, `${c.id}: the approver's justification is quoted`);
    }
  }
});

test("each step of the hero chain opens the matching step of a real case", async () => {
  const { caseSteps } = await import("../views.js");
  const source = read("../views.js").toString("utf8");
  const targets = [...source.matchAll(/key: "([a-z ]+)"[^\n]*go\("#cases\/(SUP-002)\/step-(\d+)"\)/g)].map((m) => [m[1], m[2], Number(m[3])]);
  const expected = { escrow: "OPEN", evidence: "SUBMITTED", "agent advice": "AGENT_REVIEWED", "rule decision": "blocked", "human signature": "APPROVED" };
  assert.deepEqual(targets.map((t) => t[0]), Object.keys(expected));
  for (const [label, id, n] of targets) {
    const row = caseSteps(data.cases.find((c) => c.id === id))[n];
    assert.equal(row.kind === "blocked" ? "blocked" : row.step.to, expected[label], label);
  }
  assert.match(source, /key: "anchored"[^\n]*go\("#onchain"\)/);
});

function spentInDeployments(markdown, run) {
  const sections = markdown.split(/^#{2,3} /m);
  const section = sections.find((s) => s.split("\n")[0].includes(`(${run.date} ${run.utc} UTC)`));
  assert.ok(section, `DEPLOYMENTS.md has no section for the run of ${run.date} ${run.utc} UTC`);
  const prose = section.replace(/\s+/g, " ");
  const sol = /the creator spent (\d+)\.(\d{1,9}) SOL/.exec(prose);
  if (sol) return Number(sol[1]) * 1e9 + Number(sol[2].padEnd(9, "0"));
  const lamports = /\(([\d,]+) spent:/.exec(prose);
  assert.ok(lamports, `the section of ${run.date} states no amount spent by the creator`);
  return Number(lamports[1].replace(/,/g, ""));
}

test("the recorded cost of each run is the amount DEPLOYMENTS.md states", () => {
  const markdown = read("../../../onchain/DEPLOYMENTS.md").toString("utf8");
  assert.equal(data.runs.length, 2);
  for (const run of data.runs) assert.equal(run.recorded_spent, spentInDeployments(markdown, run), run.date);
});

test("the site data only produces outcomes the dashboard can draw", async () => {
  const { OUTCOMES } = await import("../views.js");
  const require = createRequire(import.meta.url);
  const { OUTCOME_BY_FINAL_STATE, outcomeOf } = require(new URL("../../../scripts/build-site-data", import.meta.url).pathname);
  assert.deepEqual(Object.values(OUTCOME_BY_FINAL_STATE).sort(), Object.keys(OUTCOMES).sort());
  for (const state of ["OPEN", "SUBMITTED", "AGENT_REVIEWED", "ESCALATED"]) assert.throws(() => outcomeOf(state, "X-001"), new RegExp(`X-001: final state ${state} has no dashboard outcome`));
  assert.equal(outcomeOf("APPROVED", "X-001"), "approved");
  for (const c of data.cases) assert.ok(OUTCOMES[c.outcome], c.id);
});

test("the page hashes every rule as the engine does (JCS, then SHA-256)", () => {
  const { canonical, ruleHash } = createRequire(import.meta.url)("../../../scripts/build-site-data");
  assert.equal(canonical({ b: [1, "x"], a: { d: null, c: true } }), '{"a":{"c":true,"d":null},"b":[1,"x"]}');
  const pinned = {
    "supplier-docs v1": "7320d1d698663198cb21f5f5cce3e6d0064b8300a1042ebf13fc8934fbdabd2f",
    "agent-purchase v1": "3d77e718e5ee0b6a66448c960024fe1dadff3950364eed67e2401d23eecc91b2",
    "agent-purchase v2": "707c224f3ff8d0d0257dd23e075ac2cc8321752a09a9c390fee5a38149148f35",
    "ecosystem-services-payment v1": "eb9e053a54cf94256949e7bb134390e68efb86fa4be4434f1b0c24d34d4307c9",
    "milestone-payment v1": "bb7edb9e6d965c6c508d1f3abcb56000811e7dbd4fe558145dddc874bc37ed85",
    "milestone-payment v2": "f7d08860c8e3d5bdcfd03bad0d7386e51824ee0c84887de61dca282e1d94e0c7",
    "service-delivery v1": "c8ef062c4eb22745086f9ff84b143c5549b06aef0079aa3e52327a0a9928e21c",
    "service-delivery v2": "9716660e20d2a88aee467e81020bd9630a2f2f9767d260964b9869dae67d05ab",
  };
  for (const rule of data.rules) {
    const file = new URL(`../../../offchain/crates/coorre-engine/rules/${rule.id}-v${rule.version}.json`, import.meta.url);
    assert.equal(ruleHash(JSON.parse(readFileSync(file, "utf8"))), rule.hash, rule.id);
    assert.equal(rule.hash, `sha256:${pinned[`${rule.id} v${rule.version}`]}`, `${rule.id} v${rule.version}`);
  }
});
