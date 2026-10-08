import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as wasm from "../pkg/coorre_verify.js";
import { verifyBundle, fetchAccounts, explorerUrl, base64ToBytes } from "../verify-core.js";

wasm.initSync({ module: readFileSync(new URL("../pkg/coorre_verify_bg.wasm", import.meta.url)) });

const PROGRAM = "9esN1A8K1SASLg17ob81dbSdB4VX8ozc6tBLmJ247Wv";
const NETWORK = "solana:devnet";
const RPC = "https://api.devnet.solana.com";
const read = (path) => readFileSync(new URL(path, import.meta.url));

function sample(id) {
  const bundleText = read(`../samples/${id}/bundle.json`).toString("utf8");
  const files = JSON.parse(bundleText).artifacts.map((a) => ({
    name: a.name,
    bytes: new Uint8Array(read(`../samples/${id}/artifacts/${a.name}`)),
  }));
  const recorded = JSON.parse(read(`./fixtures/${id}-rpc.json`).toString("utf8"));
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => recorded.response };
  };
  return { bundleText, files, recorded, requests, fetchImpl };
}

async function check(id, options = {}) {
  const s = sample(id);
  const result = await verifyBundle({
    wasm,
    bundleText: s.bundleText,
    files: options.files ?? s.files,
    rpcUrl: RPC,
    programId: options.programId ?? PROGRAM,
    networkId: NETWORK,
    tamper: options.tamper ?? false,
    fetchImpl: s.fetchImpl,
  });
  return { ...result, sample: s };
}

const failing = (report) => report.checks.filter((c) => c.status === "FAIL").map((c) => c.id);

test("SUP-001 sample verifies 7/7 in WebAssembly", async () => {
  const { report } = await check("SUP-001");
  assert.deepEqual(failing(report), []);
  assert.equal(report.checks.length, 7);
  assert.equal(report.summary.final_state, "AUTO_APPROVED");
  assert.equal(report.timeline.length, 3);
});

test("SUP-002 sample verifies 7/7 and carries the approver's justification", async () => {
  const { report } = await check("SUP-002");
  assert.deepEqual(failing(report), []);
  assert.equal(report.summary.final_state, "APPROVED");
  assert.deepEqual(report.timeline.map((t) => t.to_state), ["SUBMITTED", "AGENT_REVIEWED", "ESCALATED", "APPROVED"]);
  assert.match(report.timeline[2].payload.reasons.join(" "), /environmental license expired/);
  assert.equal(typeof report.timeline[3].payload.justification, "string");
});

test("one changed byte fails check 1 and the decision is no longer reproducible", async () => {
  const { report, tamperedName } = await check("SUP-002", { tamper: true });
  assert.ok(tamperedName);
  assert.deepEqual(failing(report), [1, 7]);
});

test("another expected program fails check 6", async () => {
  const { report } = await check("SUP-001", { programId: "11111111111111111111111111111111" });
  assert.ok(failing(report).includes(6));
});

test("a missing artifact is reported and fails checks 1 and 7", async () => {
  const s = sample("SUP-001");
  const { report, missing } = await check("SUP-001", { files: s.files.slice(1) });
  assert.deepEqual(missing, [s.files[0].name]);
  assert.deepEqual(failing(report), [1, 7]);
});

test("only the public account addresses are sent, in one getMultipleAccounts call", async () => {
  const { sample: s } = await check("SUP-002");
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].url, RPC);
  assert.equal(s.requests[0].body.method, "getMultipleAccounts");
  assert.deepEqual(s.requests[0].body.params[0], s.recorded.addresses);
  const sent = JSON.stringify(s.requests[0].body);
  for (const file of s.files) assert.ok(!sent.includes(file.name));
});

test("RPC failures are reported, not silently ignored", async () => {
  await assert.rejects(
    fetchAccounts(RPC, ["A"], async () => ({ ok: false, status: 429 })),
    /HTTP 429/
  );
  await assert.rejects(
    fetchAccounts(RPC, ["A"], async () => ({ ok: true, json: async () => ({ error: { message: "boom" } }) })),
    /boom/
  );
  await assert.rejects(
    fetchAccounts(RPC, ["A", "B"], async () => ({ ok: true, json: async () => ({ result: { value: [null] } }) })),
    /unexpected/
  );
});

test("explorer links only for devnet and well-formed base58", () => {
  assert.equal(explorerUrl("address", PROGRAM, NETWORK), `https://explorer.solana.com/address/${PROGRAM}?cluster=devnet`);
  assert.equal(explorerUrl("address", PROGRAM, "memory:simulated"), null);
  assert.equal(explorerUrl("tx", "javascript:alert(1)", NETWORK), null);
  assert.equal(explorerUrl("tx", "0OIl", NETWORK), null);
  assert.equal(explorerUrl("address", undefined, NETWORK), null);
});

test("base64 decoding matches Node's decoder", () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  assert.deepEqual(base64ToBytes(Buffer.from(bytes).toString("base64")), bytes);
});

test("the page never builds HTML from data and ships a strict CSP", () => {
  const app = read("../app.js").toString("utf8");
  const core = read("../verify-core.js").toString("utf8");
  for (const source of [app, core]) {
    for (const forbidden of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"]) {
      assert.ok(!source.includes(forbidden), forbidden);
    }
  }
  const html = read("../index.html").toString("utf8");
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; script-src 'self' 'wasm-unsafe-eval'/);
  assert.ok(!/<script(?![^>]*src=)/.test(html), "no inline scripts");
});
