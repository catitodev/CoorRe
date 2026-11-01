import { test } from "node:test";
import assert from "node:assert/strict";
import { callDataBytes, mirror, requireSuccess, rpc, settleUpload } from "../lib/network.mjs";
import { escrowProbeAfter, probeExitCode } from "../probes/run.mjs";

const CONFIG = { mirrorRest: "http://mirror.invalid", relay: "http://relay.invalid" };
const FAST = { totalMs: 200, intervalMs: 10, requestMs: 50 };

function withFetch(t, implementation) {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = implementation;
}

test("requireSuccess passes a SUCCESS result and names the step otherwise", () => {
  const ok = { status: "SUCCESS", receipt: {} };
  assert.equal(requireSuccess(ok, "deposit"), ok);
  assert.throws(() => requireSuccess({ status: "CONTRACT_REVERT_EXECUTED" }, "deposit"), /deposit returned CONTRACT_REVERT_EXECUTED/);
  assert.throws(() => requireSuccess(undefined, "topic create"), /topic create returned no status/);
});

test("callDataBytes accepts only lowercase 0x-prefixed whole bytes", () => {
  assert.deepEqual([...callDataBytes("0x5d35a3d9")], [0x5d, 0x35, 0xa3, 0xd9]);
  assert.throws(() => callDataBytes("0x5D35"), /lowercase/);
});

test("the mirror poll retries failed and hanging requests and reports the last reason", async (t) => {
  let calls = 0;
  withFetch(t, async (url, options) => {
    calls += 1;
    assert.ok(options.signal instanceof AbortSignal, "every request has a timeout");
    if (calls === 1) throw new TypeError("fetch failed");
    if (calls === 2) return new Response("busy", { status: 503 });
    return new Response(JSON.stringify({ ready: calls >= 4 }), { status: 200 });
  });
  assert.deepEqual(await mirror(CONFIG, "/api/v1/x", (body) => body.ready, FAST), { ready: true });
  assert.equal(calls, 4);
  withFetch(t, async () => new Response("down", { status: 500 }));
  await assert.rejects(mirror(CONFIG, "/api/v1/x", undefined, FAST), /mirror node after \d+ attempt\(s\): HTTP 500 for \/api\/v1\/x/);
  withFetch(t, (url, options) => new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason))));
  await assert.rejects(mirror(CONFIG, "/api/v1/x", undefined, FAST), /TimeoutError/);
});

test("the relay call fails on an HTTP error, a JSON-RPC error and an answer without a result", async (t) => {
  withFetch(t, async (url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    return new Response("<html>bad gateway</html>", { status: 502 });
  });
  await assert.rejects(rpc(CONFIG, "eth_chainId"), /eth_chainId: relay returned HTTP 502/);
  withFetch(t, async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "nope" } }), { status: 200 }));
  await assert.rejects(rpc(CONFIG, "eth_chainId"), /nope/);
  withFetch(t, async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1 }), { status: 200 }));
  await assert.rejects(rpc(CONFIG, "eth_chainId"), /without a result/);
  withFetch(t, async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x12a" }), { status: 200 }));
  assert.equal(await rpc(CONFIG, "eth_chainId"), "0x12a");
});

test("a bytecode file that is not deleted is reported, never dropped", () => {
  const kept = { fileId: "0.0.5", deleted: false, error: "Error: BUSY" };
  const deployed = settleUpload({ contractId: "0.0.6" }, null, kept);
  assert.deepEqual(deployed.bytecodeFile, kept);
  const failure = new Error("contract create returned INSUFFICIENT_GAS");
  assert.throws(() => settleUpload(null, failure, kept), (error) => /INSUFFICIENT_GAS; the bytecode file 0\.0\.5 was not deleted: Error: BUSY/.test(error.message) && error.cause === failure);
  assert.throws(() => settleUpload(null, failure, { fileId: "0.0.5", deleted: true }), (error) => error.message === failure.message && error.cause === failure);
});

test("the escrow probe is reported as an error when its prerequisite is missing, and the run fails", async () => {
  const skipped = await escrowProbeAfter({ operatorSender: null }, async () => [{ id: "escrow", status: "verified" }]);
  assert.equal(skipped[0].status, "error");
  assert.match(skipped[0].error, /operator's EVM sender/);
  assert.deepEqual(await escrowProbeAfter({ operatorSender: "0x01" }, async () => [{ id: "escrow", status: "verified" }]), [{ id: "escrow", status: "verified" }]);
  assert.equal(probeExitCode([{ id: "relay", status: "verified" }, ...skipped]), 1);
  assert.equal(probeExitCode([{ id: "relay", status: "verified" }]), 0);
  assert.equal(probeExitCode([]), 1);
});
