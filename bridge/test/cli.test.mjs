import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import { DEVNET_GENESIS_HASH } from "../lib.mjs";

const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "anchor.mjs");
const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const PROGRAM_ID = "FARGzwRUNjGXKMfq5FRwNGr5rZJngJg3nDhvh1rTiFss";

let dir;
let devnetUrl;
let mainnetUrl;
const servers = [];

function fakeRpc(genesis) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const { id } = JSON.parse(body);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: genesis }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      servers.push(server);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function run(args, env = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BRIDGE, ...args],
      { env: { PATH: process.env.PATH, ...env }, timeout: 20_000 },
      (error, stdout) => {
        resolve({ code: error ? error.code : 0, output: JSON.parse(stdout.trim()) });
      }
    );
  });
}

async function inputFile(name, value) {
  const file = path.join(dir, name);
  await writeFile(file, JSON.stringify(value));
  return file;
}

const openCaseInput = () => ({
  case_id: "ab".repeat(32),
  submitter: Keypair.generate().publicKey.toBase58(),
  agent: Keypair.generate().publicKey.toBase58(),
  rule_engine: Keypair.generate().publicKey.toBase58(),
  approver: Keypair.generate().publicKey.toBase58(),
  amount_lamports: "50000000",
  autonomy_limit_lamports: "100000000",
});

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "coorre-bridge-"));
  devnetUrl = await fakeRpc(DEVNET_GENESIS_HASH);
  mainnetUrl = await fakeRpc(MAINNET_GENESIS_HASH);
});

after(async () => {
  for (const server of servers) server.close();
  await rm(dir, { recursive: true, force: true });
});

test("usage errors print one JSON object and exit 1", async () => {
  for (const args of [[], ["bogus", "--input", "x.json"], ["open-case", "x.json"], ["fetch-account", "--input"]]) {
    const { code, output } = await run(args, { COORRE_PROGRAM_ID: PROGRAM_ID });
    assert.equal(code, 1);
    assert.equal(output.error.name, "Usage");
  }
});

test("missing program id and unreadable input are reported", async () => {
  const file = await inputFile("fetch.json", { address: PROGRAM_ID });
  assert.equal((await run(["fetch-account", "--input", file])).output.error.name, "MissingConfig");
  const missing = await run(["fetch-account", "--input", path.join(dir, "nope.json")], { COORRE_PROGRAM_ID: PROGRAM_ID });
  assert.equal(missing.output.error.name, "InvalidInput");
});

test("invalid input is rejected before any network access", async () => {
  const bad = { ...openCaseInput(), amount_lamports: "-5" };
  const file = await inputFile("bad.json", bad);
  const { code, output } = await run(["open-case", "--input", file], {
    COORRE_PROGRAM_ID: PROGRAM_ID,
    COORRE_RPC_URL: "http://127.0.0.1:9",
  });
  assert.equal(code, 1);
  assert.equal(output.error.name, "InvalidInput");

  const extra = await inputFile("extra.json", { ...openCaseInput(), memo: "x" });
  assert.equal((await run(["open-case", "--input", extra], { COORRE_PROGRAM_ID: PROGRAM_ID })).output.error.name, "InvalidInput");
});

test("refuses to send to any network other than devnet", async () => {
  const file = await inputFile("open.json", openCaseInput());
  const { code, output } = await run(["open-case", "--input", file], {
    COORRE_PROGRAM_ID: PROGRAM_ID,
    COORRE_RPC_URL: mainnetUrl,
    COORRE_KEYS_DIR: dir,
  });
  assert.equal(code, 1);
  assert.equal(output.error.name, "WrongNetwork");
});

test("falls back to the second RPC when the first is unreachable", async () => {
  const file = await inputFile("open2.json", openCaseInput());
  const { output } = await run(["open-case", "--input", file], {
    COORRE_PROGRAM_ID: PROGRAM_ID,
    COORRE_RPC_URL: "http://127.0.0.1:9",
    COORRE_RPC_FALLBACK_URL: devnetUrl,
    COORRE_KEYS_DIR: path.join(dir, "no-keys"),
  });
  assert.equal(output.error.name, "MissingKey");
});

test("key files must be private and well formed", async () => {
  const keysDir = await mkdtemp(path.join(dir, "keys-"));
  const keyFile = path.join(keysDir, "creator.json");
  await writeFile(keyFile, JSON.stringify(Array.from(Keypair.generate().secretKey)));
  await chmod(keyFile, 0o644);
  const file = await inputFile("open3.json", openCaseInput());
  const env = { COORRE_PROGRAM_ID: PROGRAM_ID, COORRE_RPC_URL: devnetUrl, COORRE_KEYS_DIR: keysDir };

  let result = await run(["open-case", "--input", file], env);
  assert.equal(result.output.error.name, "InsecureKeyFile");
  assert.ok(!JSON.stringify(result.output).includes("["), "no key material in the output");

  const tampered = Array.from(Keypair.generate().secretKey);
  tampered[63] ^= 1;
  await writeFile(keyFile, JSON.stringify(tampered));
  await chmod(keyFile, 0o600);
  result = await run(["open-case", "--input", file], env);
  assert.equal(result.output.error.name, "InvalidKey");
});
