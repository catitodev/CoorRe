import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  assert.deepEqual(data.rules.map((r) => r.id), ["supplier-docs", "agent-purchase", "ecosystem-services-payment", "milestone-payment", "service-delivery"]);
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
  for (const file of ["../views.js", "../charts.js", "../live.js", "../app.js"]) {
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
