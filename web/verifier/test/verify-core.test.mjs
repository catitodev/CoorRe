import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as wasm from "../pkg/coorre_verify.js";
import { verifyBundle, fetchAccounts, fetchOk, explorerUrl, base64ToBytes, accountsFromSnapshot, isAccountSnapshot, readSnapshotFile, verdictTone } from "../verify-core.js";

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

for (const [id, rule, reasons] of [
  ["AGT-002", "agent-purchase", ["supplier registration expired", "amount exceeds autonomy limit"]],
  ["PES-002", "ecosystem-services-payment", ["verified area below committed area", "amount exceeds autonomy limit"]],
]) {
  test(`${id} sample verifies 7/7 under ${rule} and fails checks 1 and 7 when a byte changes`, async () => {
    const { report } = await check(id);
    assert.deepEqual(failing(report), []);
    assert.equal(report.summary.final_state, "APPROVED");
    assert.deepEqual(report.timeline.map((t) => t.to_state), ["SUBMITTED", "AGENT_REVIEWED", "ESCALATED", "APPROVED"]);
    assert.deepEqual(report.timeline[2].payload.reasons, reasons);
    assert.equal(JSON.parse(read(`../samples/${id}/bundle.json`).toString("utf8")).rules[0].id, rule);
    const tampered = await check(id, { tamper: true });
    assert.ok(tampered.tamperedName);
    assert.deepEqual(failing(tampered.report), [1, 7]);
  });
}

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

const offline = async () => {
  throw new Error("no network request is allowed in offline verification");
};

function snapshot() {
  return JSON.parse(read("../samples/devnet-snapshot.json").toString("utf8"));
}

test("the published snapshot is the recorded devnet evidence, byte for byte", () => {
  assert.deepEqual(read("../samples/devnet-snapshot.json"), read("../../../docs/evidence/devnet-snapshot/accounts.json"));
  assert.ok(isAccountSnapshot(snapshot()));
});

for (const id of ["SUP-001", "SUP-002", "AGT-002", "PES-002"]) {
  test(`${id} verifies 7/7 from the recorded snapshot with no network request`, async () => {
    const s = sample(id);
    const result = await verifyBundle({ wasm, bundleText: s.bundleText, files: s.files, rpcUrl: RPC, programId: PROGRAM, networkId: NETWORK, snapshot: snapshot(), snapshotRecorded: true, fetchImpl: offline });
    assert.equal(result.source, "recorded-snapshot");
    assert.equal(result.tone, "pass");
    assert.equal(result.slot, 509686323);
    assert.deepEqual(failing(result.report), []);
  });
}

test("an anchor missing from the snapshot fails checks 4 and 6", async () => {
  const s = sample("SUP-001");
  const recorded = snapshot();
  const anchor = JSON.parse(s.bundleText).evidence[1].anchor_account;
  recorded.response.result.value[recorded.addresses.indexOf(anchor)] = null;
  const result = await verifyBundle({ wasm, bundleText: s.bundleText, files: s.files, rpcUrl: RPC, programId: PROGRAM, networkId: NETWORK, snapshot: recorded, fetchImpl: offline });
  assert.deepEqual(failing(result.report), [4, 6]);
});

const EXPECTED = { programId: PROGRAM, networkId: NETWORK };
const shaped = (value) => ({ format: "coorre-devnet-snapshot/1", network_id: NETWORK, program_id: PROGRAM, addresses: ["A"], response: { result: { value } } });

test("only well-formed snapshots are read", () => {
  assert.ok(!isAccountSnapshot({ format: "coorre-audit-bundle/1" }));
  assert.ok(!isAccountSnapshot(null));
  assert.throws(() => accountsFromSnapshot(shaped([]), ["A"], EXPECTED), /more addresses/);
  assert.throws(() => accountsFromSnapshot(shaped([{ owner: "P", data: ["AQ==", "base58"] }]), ["A"], EXPECTED), /base64/);
  assert.throws(() => accountsFromSnapshot(shaped([{ data: ["AQ==", "base64"] }]), ["A"], EXPECTED), /no owner/);
  const { accounts } = accountsFromSnapshot(shaped([{ owner: "P", data: ["AQI=", "base64"] }]), ["A", "B"], EXPECTED);
  assert.deepEqual(accounts[0].data, new Uint8Array([1, 2]));
  assert.equal(accounts[1], null);
});

test("a snapshot without its format, network or program is refused", () => {
  const recorded = snapshot();
  for (const key of ["format", "network_id", "program_id"]) {
    const copy = structuredClone(recorded);
    delete copy[key];
    assert.ok(!isAccountSnapshot(copy), key);
    assert.throws(() => accountsFromSnapshot(copy, recorded.addresses, EXPECTED), /not a coorre-devnet-snapshot\/1 snapshot/, key);
  }
  const { format, ...unformatted } = recorded;
  assert.equal(format, "coorre-devnet-snapshot/1");
  assert.throws(() => readSnapshotFile("accounts.json", new TextEncoder().encode(JSON.stringify(unformatted)), read("../samples/devnet-snapshot.json")), /accounts\.json is not a coorre-devnet-snapshot\/1 snapshot/);
});

test("a snapshot of another program or network is refused before any check runs", async () => {
  const s = sample("SUP-001");
  const other = { ...snapshot(), program_id: "11111111111111111111111111111111" };
  await assert.rejects(
    verifyBundle({ wasm, bundleText: s.bundleText, files: s.files, rpcUrl: RPC, programId: PROGRAM, networkId: NETWORK, snapshot: other, fetchImpl: offline }),
    /names program 11111111111111111111111111111111, not the expected program/
  );
  await assert.rejects(
    verifyBundle({ wasm, bundleText: s.bundleText, files: s.files, rpcUrl: RPC, programId: PROGRAM, networkId: NETWORK, snapshot: { ...snapshot(), network_id: "solana:mainnet" }, fetchImpl: offline }),
    /taken on solana:mainnet, not on the expected network/
  );
});

test("a valid snapshot that is not the published file is labelled as provided, never as recorded", async () => {
  const published = new Uint8Array(read("../samples/devnet-snapshot.json"));
  assert.equal(readSnapshotFile("accounts.json", published, published).recorded, true);
  const reformatted = new TextEncoder().encode(JSON.stringify(snapshot()));
  const provided = readSnapshotFile("accounts.json", reformatted, published);
  assert.equal(provided.recorded, false);
  const s = sample("SUP-001");
  const result = await verifyBundle({ wasm, bundleText: s.bundleText, files: s.files, rpcUrl: RPC, programId: PROGRAM, networkId: NETWORK, snapshot: provided.value, snapshotRecorded: provided.recorded, fetchImpl: offline });
  assert.deepEqual(failing(result.report), []);
  assert.equal(result.source, "provided-snapshot");
  assert.equal(result.tone, "caveat");
  assert.equal(verdictTone(result.report, "rpc"), "pass");
  assert.equal(verdictTone({ checks: [{ status: "FAIL" }] }, "provided-snapshot"), "fail");
});

test("the page labels the recorded snapshot only for the published file", () => {
  const app = read("../app.js").toString("utf8");
  assert.match(app, /result\.source === "recorded-snapshot" \? ` · \$\{t\("accounts from the recorded devnet snapshot/);
  assert.match(app, /verdict\.className = `verdict \$\{tone\}`/);
  assert.match(app, /run\(bundleText, files, snapshot, useSnapshot\)/);
  assert.match(app, /snapshot\?\.recorded \?\? false/);
});

test("fetchOk turns an HTTP error into a clear message with the status and the address", async () => {
  await assert.rejects(fetchOk("samples/SUP-001/bundle.json", undefined, async () => ({ ok: false, status: 404 })), { message: "HTTP 404 samples/SUP-001/bundle.json" });
  const response = { ok: true, status: 200 };
  assert.equal(await fetchOk("site-data.json", undefined, async () => response), response);
  const app = read("../app.js").toString("utf8");
  assert.ok(!/(?<![A-Za-z])fetch\(/.test(app), "app.js calls fetch without fetchOk");
});

test("an RPC account that is not base64-encoded or has no owner is refused", async () => {
  const answer = (value) => async () => ({ ok: true, json: async () => ({ result: { context: { slot: 1 }, value: [value] } }) });
  await assert.rejects(fetchAccounts(RPC, ["A"], answer({ owner: "P", data: ["x", "base58"] })), { message: "A: account is not base64-encoded" });
  await assert.rejects(fetchAccounts(RPC, ["A"], answer({ owner: "P", data: ["***", "base64"] })), { message: "A: account is not base64-encoded" });
  await assert.rejects(fetchAccounts(RPC, ["A"], answer({ data: ["AQI=", "base64"] })), { message: "A: account has no owner" });
});
