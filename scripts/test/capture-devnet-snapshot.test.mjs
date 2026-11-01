import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "capture-devnet-snapshot");
const RECORDED = path.join(ROOT, "docs", "evidence", "devnet-snapshot");
const FILES = ["accounts.json", "signatures.json"];
const PROGRAM_ID = "9esN1A8K1SASLg17ob81dbSdB4VX8ozc6tBLmJ247Wv";
const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

let dir;
const servers = [];

const goodAccount = () => ({ data: ["", "base64"], executable: false, lamports: 1, owner: PROGRAM_ID, rentEpoch: 0, space: 0 });
const finalized = () => ({ slot: 9, confirmations: null, err: null, confirmationStatus: "finalized" });

function fakeRpc({ account = goodAccount, signature = finalized, hang = false } = {}) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (hang) return;
        const { id, method, params } = JSON.parse(body);
        const results = {
          getGenesisHash: () => DEVNET_GENESIS_HASH,
          getMultipleAccounts: () => ({ context: { slot: 9 }, value: params[0].map((a, i) => account(a, i)) }),
          getSignatureStatuses: () => ({ context: { slot: 9 }, value: params[0].map((s, i) => signature(s, i)) }),
        };
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: results[method]() }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      servers.push(server);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function capture(outDir, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, "--out", outDir], { env: { PATH: process.env.PATH, ...env }, timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

async function recordedCopy() {
  const out = await mkdtemp(path.join(dir, "out-"));
  for (const f of FILES) await copyFile(path.join(RECORDED, f), path.join(out, f));
  return out;
}

async function contents(out) {
  return Promise.all(FILES.map((f) => readFile(path.join(out, f))));
}

async function assertUntouched(out, result) {
  assert.notEqual(result.code, 0, result.stdout + result.stderr);
  const recorded = await contents(RECORDED);
  const now = await contents(out);
  for (const [i, f] of FILES.entries()) assert.ok(now[i].equals(recorded[i]), `${f} changed`);
  assert.deepEqual((await readdir(out)).sort(), [...FILES].sort(), "no temporary files left");
}

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "coorre-capture-"));
});

after(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
  await rm(dir, { recursive: true, force: true });
});

test("a missing account keeps the recorded snapshot byte for byte and exits non-zero", async () => {
  const out = await recordedCopy();
  const url = await fakeRpc({ account: (a, i) => (i === 0 ? null : goodAccount()) });
  const result = await capture(out, { COORRE_RPC_URL: url });
  await assertUntouched(out, result);
  assert.match(result.stdout + result.stderr, /missing accounts: 1/);
});

test("an account owned by another program keeps the recorded snapshot", async () => {
  const out = await recordedCopy();
  const url = await fakeRpc({ account: (a, i) => (i === 1 ? { ...goodAccount(), owner: "11111111111111111111111111111111" } : goodAccount()) });
  await assertUntouched(out, await capture(out, { COORRE_RPC_URL: url }));
});

test("a transaction that is not finalized keeps the recorded snapshot", async () => {
  const out = await recordedCopy();
  const url = await fakeRpc({ signature: (s, i) => (i === 0 ? { ...finalized(), confirmationStatus: "confirmed" } : finalized()) });
  await assertUntouched(out, await capture(out, { COORRE_RPC_URL: url }));
});

test("a response of the wrong length keeps the recorded snapshot", async () => {
  const out = await recordedCopy();
  const url = await fakeRpc();
  const short = await new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const { id, method, params } = JSON.parse(body);
        const result =
          method === "getGenesisHash"
            ? DEVNET_GENESIS_HASH
            : { context: { slot: 9 }, value: params[0].slice(1).map(() => (method === "getMultipleAccounts" ? goodAccount() : finalized())) };
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      servers.push(server);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
  assert.ok(url);
  await assertUntouched(out, await capture(out, { COORRE_RPC_URL: short }));
});

test("an RPC that never answers is abandoned after the timeout and keeps the recorded snapshot", async () => {
  const out = await recordedCopy();
  const url = await fakeRpc({ hang: true });
  const started = Date.now();
  const result = await capture(out, { COORRE_RPC_URL: url, COORRE_RPC_TIMEOUT_MS: "500" });
  assert.ok(Date.now() - started < 15_000);
  await assertUntouched(out, result);
  assert.match(result.stderr, /timeout|aborted/i);
});

test("plain http to a host other than loopback is refused", async () => {
  const out = await recordedCopy();
  await assertUntouched(out, await capture(out, { COORRE_RPC_URL: "http://api.devnet.solana.com" }));
});

test("a clean capture writes both files and records only the RPC origin", async () => {
  const out = await recordedCopy();
  const url = `${await fakeRpc()}/v1/SEGREDO?api-key=SEGREDO`;
  const result = await capture(out, { COORRE_RPC_URL: url });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.ok(!(result.stdout + result.stderr).includes("SEGREDO"));
  for (const f of FILES) {
    const text = await readFile(path.join(out, f), "utf8");
    assert.ok(!text.includes("SEGREDO"), `${f} holds the secret`);
    assert.equal(JSON.parse(text).rpc_url, new URL(url).origin);
  }
  assert.deepEqual((await readdir(out)).sort(), [...FILES].sort(), "no temporary files left");
});
