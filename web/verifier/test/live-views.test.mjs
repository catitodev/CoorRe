import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installFakeDom } from "./fake-dom.mjs";

const { byId } = installFakeDom();
const { renderCaseDetail, renderOnchain, renderOverview, liveState } = await import("../views.js");
const { timeOfDay } = await import("../i18n.js");

const data = JSON.parse(readFileSync(new URL("../site-data.json", import.meta.url), "utf8"));
const settle = () => new Promise((resolve) => setImmediate(resolve));
const calls = [];

function answerWith(account) {
  globalThis.fetch = async (url, init) => {
    calls.push(url);
    const addresses = JSON.parse(init.body).params[0];
    return { ok: true, json: async () => ({ result: { context: { slot: 9 }, value: addresses.map(account) } }) };
  };
}

const shortCaseRecord = (address) =>
  address === data.program.id ? { owner: "BPFLoaderUpgradeab1e11111111111111111111111", executable: true, data: ["", "base64"] } : { owner: data.program.id, lamports: 1, data: ["AQI=", "base64"] };

test("a case record of the wrong size shows an error in the case view instead of failing silently", async () => {
  answerWith(shortCaseRecord);
  renderCaseDetail(data, "SUP-002", "https://w2-case.example");
  await settle();
  assert.match(byId("case-detail").textContent, /not a case record/);
  assert.doesNotMatch(byId("case-detail").textContent, /reading devnet/);
});

test("a case record of the wrong size shows an error on the overview cards", async () => {
  answerWith(shortCaseRecord);
  renderOverview(data, "https://w2-overview.example");
  await settle();
  for (const id of ["now-card", "status-card"]) assert.match(byId(id).textContent, /Could not read devnet: .*not a (program data account|case record)/, id);
  assert.equal(byId("now-time").textContent, "not read");
});

test("program data that does not decode shows an error in the on-chain view", async () => {
  answerWith(shortCaseRecord);
  renderOnchain(data, "https://w2-onchain.example");
  await settle();
  assert.match(byId("program-facts").textContent, /Could not read devnet: .*not a program data account/);
});

test("the live read keeps the time it was made and a new RPC address reads again", async () => {
  answerWith(() => null);
  calls.length = 0;
  mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 10, 3, 0) });
  try {
    const readAt = new Date();
    renderOverview(data, "https://w5-a.example");
    await settle();
    assert.equal(byId("now-time").textContent, timeOfDay(readAt));
    mock.timers.tick(2 * 60 * 60 * 1000);
    renderOverview(data, "https://w5-a.example");
    await settle();
    assert.equal(byId("now-time").textContent, timeOfDay(readAt));
    assert.deepEqual(calls, ["https://w5-a.example"]);
    const again = await liveState(data, "https://w5-b.example");
    assert.deepEqual(calls, ["https://w5-a.example", "https://w5-b.example"]);
    assert.equal(again.readAt.getTime(), readAt.getTime() + 2 * 60 * 60 * 1000);
  } finally {
    mock.timers.reset();
  }
});

test("the read-live status card shows only values read from the chain", async () => {
  answerWith(() => null);
  renderOverview(data, "https://w4.example");
  await settle();
  const text = byId("status-card").textContent;
  assert.match(text, /Case records match bundles/);
  assert.doesNotMatch(text, /Rules shipped|Run costs/);
});

test("each recorded run says in words whether its cost matches DEPLOYMENTS.md", async () => {
  answerWith(() => null);
  renderOverview(data, "https://w11.example");
  await settle();
  const dots = byId("runs-list").byClass("dot-status");
  assert.equal(dots.length, data.runs.length);
  for (const dot of dots) {
    assert.equal(dot.getAttribute("role"), "img");
    assert.equal(dot.getAttribute("aria-label"), "Cost matches DEPLOYMENTS.md");
  }
});
