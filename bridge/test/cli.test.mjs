import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { DEVNET_GENESIS_HASH, caseRecordAddress } from "../lib.mjs";

const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "anchor.mjs");
const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const PROGRAM_ID = "FARGzwRUNjGXKMfq5FRwNGr5rZJngJg3nDhvh1rTiFss";
const BPF_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ALREADY_IN_USE_LOGS = [
  "Program 11111111111111111111111111111111 invoke [2]",
  "Allocate: account Address { address: X, base: None } already in use",
  "Program 11111111111111111111111111111111 failed: custom program error: 0x0",
];

let dir;
let devnetUrl;
let mainnetUrl;
const servers = [];

function base58(bytes) {
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

function signatureOf(encoded) {
  return base58(Transaction.from(Buffer.from(encoded, "base64")).signature);
}

const context = (value) => ({ context: { slot: 7 }, value });
const status = (confirmationStatus, err = null) => ({ slot: 7, confirmations: null, err, confirmationStatus });
const account = (owner, { executable = false, data = Buffer.alloc(0) } = {}) => ({
  data: [data.toString("base64"), "base64"],
  executable,
  lamports: 1_000_000,
  owner,
  rentEpoch: 0,
  space: data.length,
});

function defaultResult(method, params) {
  switch (method) {
    case "getGenesisHash":
      return DEVNET_GENESIS_HASH;
    case "getAccountInfo":
      return context(null);
    case "getLatestBlockhash":
      return context({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 });
    case "getBlockHeight":
      return 50;
    case "sendTransaction":
      return signatureOf(params[0]);
    case "getSignatureStatuses":
      return context(params[0].map(() => status("confirmed")));
    case "getTransaction":
      return null;
    default:
      return undefined;
  }
}

function fakeRpc(handler = () => undefined) {
  const calls = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const { id, method, params } = JSON.parse(body);
        calls.push({ method, params });
        const answer = handler(method, params, calls);
        if (answer === "hang") return;
        res.setHeader("Content-Type", "application/json");
        if (answer && Object.hasOwn(answer, "error")) {
          res.end(JSON.stringify({ jsonrpc: "2.0", id, error: answer.error }));
          return;
        }
        const result = answer === undefined ? defaultResult(method, params) : answer.result;
        if (result === undefined) {
          res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `fake RPC has no ${method}` } }));
          return;
        }
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      servers.push(server);
      resolve({ url: `http://127.0.0.1:${server.address().port}`, calls });
    });
  });
}

function genesisOnly(genesis) {
  return fakeRpc((method) => (method === "getGenesisHash" ? { result: genesis } : { error: { code: -32601, message: "unexpected" } }));
}

function run(args, env = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(
      process.execPath,
      [BRIDGE, ...args],
      { env: { PATH: process.env.PATH, ...env }, timeout: 30_000 },
      (error, stdout, stderr) => {
        let output = null;
        try {
          output = JSON.parse(stdout.trim());
        } catch (err) {
          output = { unparsed: stdout, stderr, parse_error: err.message };
        }
        resolve({ code: error ? error.code : 0, output, elapsed: Date.now() - started, stderr });
      }
    );
  });
}

async function inputFile(name, value) {
  const file = path.join(dir, name);
  await writeFile(file, JSON.stringify(value));
  return file;
}

async function keysWith(...roles) {
  const keysDir = await mkdtemp(path.join(dir, "keys-"));
  const keys = {};
  for (const role of roles) {
    const keypair = Keypair.generate();
    const file = path.join(keysDir, `${role}.json`);
    await writeFile(file, JSON.stringify(Array.from(keypair.secretKey)));
    await chmod(file, 0o600);
    keys[role] = keypair;
  }
  return { keysDir, keys };
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

const sent = (calls) => calls.filter((c) => c.method === "sendTransaction");

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "coorre-bridge-"));
  devnetUrl = (await genesisOnly(DEVNET_GENESIS_HASH)).url;
  mainnetUrl = (await genesisOnly(MAINNET_GENESIS_HASH)).url;
});

after(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
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
  assert.equal(missing.output.error.cause_code, "ENOENT");
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

test("role keys that cannot sign or receive are rejected before any network access", async () => {
  const rpc = await fakeRpc();
  const offCurve = caseRecordAddress(new PublicKey(PROGRAM_ID), Keypair.generate().publicKey, Buffer.alloc(32, 1)).toBase58();
  const cases = [
    { submitter: PROGRAM_ID },
    { agent: PROGRAM_ID },
    { submitter: offCurve },
    { agent: offCurve },
    { rule_engine: offCurve },
    { approver: offCurve },
  ];
  for (const [i, change] of cases.entries()) {
    const file = await inputFile(`roles-${i}.json`, { ...openCaseInput(), ...change });
    const { code, output } = await run(["open-case", "--input", file], { COORRE_PROGRAM_ID: PROGRAM_ID, COORRE_RPC_URL: rpc.url });
    assert.equal(code, 1, JSON.stringify(change));
    assert.equal(output.error.name, "InvalidInput", JSON.stringify(output));
  }
  assert.equal(rpc.calls.length, 0, "no RPC call was made");
});

test("a submitter account that is not a plain system account is rejected before sending", async () => {
  const rpc = await fakeRpc((method) => (method === "getAccountInfo" ? { result: context(account(BPF_LOADER, { executable: true })) } : undefined));
  const { keysDir } = await keysWith("creator");
  const file = await inputFile("exec-payee.json", openCaseInput());
  const { code, output } = await run(["open-case", "--input", file], {
    COORRE_PROGRAM_ID: PROGRAM_ID,
    COORRE_RPC_URL: rpc.url,
    COORRE_KEYS_DIR: keysDir,
  });
  assert.equal(code, 1);
  assert.equal(output.error.name, "InvalidInput");
  assert.match(output.error.message, /submitter/);
  assert.equal(sent(rpc.calls).length, 0);
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

test("plain http is refused for any RPC host other than loopback", async () => {
  const file = await inputFile("insecure.json", { address: PROGRAM_ID });
  for (const env of [
    { COORRE_RPC_URL: "http://api.devnet.solana.com" },
    { COORRE_RPC_URL: "http://127.0.0.2:8899" },
    { COORRE_RPC_URL: devnetUrl, COORRE_RPC_FALLBACK_URL: "http://rpc.example.org" },
    { COORRE_RPC_URL: "ftp://127.0.0.1" },
  ]) {
    const { code, output, elapsed } = await run(["fetch-account", "--input", file], { COORRE_PROGRAM_ID: PROGRAM_ID, ...env });
    assert.equal(code, 1);
    assert.equal(output.error.name, "InsecureRpc", JSON.stringify(env));
    assert.ok(elapsed < 10_000);
  }
  const malformed = await run(["fetch-account", "--input", file], { COORRE_PROGRAM_ID: PROGRAM_ID, COORRE_RPC_URL: "not a url" });
  assert.equal(malformed.output.error.name, "InvalidConfig");
});

test("output carries only the RPC origin, never its path or query", async () => {
  const file = await inputFile("secret-url.json", { address: PROGRAM_ID });
  for (const url of [`${mainnetUrl}/v1/SEGREDO?api-key=SEGREDO`, "http://127.0.0.1:9/?api-key=SEGREDO"]) {
    const result = await run(["fetch-account", "--input", file], { COORRE_PROGRAM_ID: PROGRAM_ID, COORRE_RPC_URL: url });
    assert.equal(result.code, 1);
    const text = JSON.stringify(result.output);
    assert.ok(!text.includes("SEGREDO"), text);
    assert.ok(!result.stderr.includes("SEGREDO"), result.stderr);
    assert.ok(text.includes(new URL(url).origin), text);
  }
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

  await writeFile(keyFile, "[12, 34, oops");
  result = await run(["open-case", "--input", file], env);
  assert.equal(result.output.error.name, "InvalidKey");
  assert.ok(!JSON.stringify(result.output).includes("oops"), "no key file content in the output");
});

test("a key file that cannot be read reports UnreadableKey with the system error code", { skip: process.getuid?.() === 0 && "running as root" }, async () => {
  const { keysDir } = await keysWith("creator");
  await chmod(path.join(keysDir, "creator.json"), 0o000);
  const file = await inputFile("open4.json", openCaseInput());
  const { code, output } = await run(["open-case", "--input", file], {
    COORRE_PROGRAM_ID: PROGRAM_ID,
    COORRE_RPC_URL: (await fakeRpc()).url,
    COORRE_KEYS_DIR: keysDir,
  });
  assert.equal(code, 1);
  assert.equal(output.error.name, "UnreadableKey");
  assert.equal(output.error.cause_code, "EACCES");
});

test("open-case sends, confirms and returns the receipt", async () => {
  const rpc = await fakeRpc();
  const { keysDir, keys } = await keysWith("creator");
  const input = openCaseInput();
  const file = await inputFile("happy.json", input);
  const { code, output } = await run(["open-case", "--input", file], {
    COORRE_PROGRAM_ID: PROGRAM_ID,
    COORRE_RPC_URL: rpc.url,
    COORRE_KEYS_DIR: keysDir,
  });
  assert.equal(code, 0, JSON.stringify(output));
  const expected = caseRecordAddress(new PublicKey(PROGRAM_ID), keys.creator.publicKey, Buffer.from(input.case_id, "hex"));
  assert.equal(output.account, expected.toBase58());
  assert.equal(output.tx_signature, signatureOf(sent(rpc.calls)[0].params[0]));
  assert.equal(sent(rpc.calls).length, 1);
});

test("an expired blockhash is retried once, after checking that the first attempt did not land", async () => {
  let blockhashes = 0;
  const rpc = await fakeRpc((method, params, calls) => {
    if (method === "getLatestBlockhash") {
      blockhashes += 1;
      return { result: context({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: blockhashes === 1 ? 100 : 1000 }) };
    }
    if (method === "getBlockHeight") return { result: 150 };
    if (method === "getSignatureStatuses") {
      const first = signatureOf(sent(calls)[0].params[0]);
      return { result: context(params[0].map((s) => (s === first ? null : status("confirmed")))) };
    }
    return undefined;
  });
  const { keysDir } = await keysWith("creator");
  const file = await inputFile("expired.json", openCaseInput());
  const { code, output } = await run(["open-case", "--input", file], {
    COORRE_PROGRAM_ID: PROGRAM_ID,
    COORRE_RPC_URL: rpc.url,
    COORRE_KEYS_DIR: keysDir,
  });
  assert.equal(code, 0, JSON.stringify(output));
  assert.equal(sent(rpc.calls).length, 2);
  assert.equal(output.tx_signature, signatureOf(sent(rpc.calls)[1].params[0]));
});

test("a resend that finds the account already in use returns the receipt of the first transaction", async () => {
  const rpc = await fakeRpc((method, params, calls) => {
    if (method === "getBlockHeight") return { result: 150 };
    if (method === "sendTransaction" && sent(calls).length === 2) {
      return {
        error: {
          code: -32002,
          message: "Transaction simulation failed: Error processing Instruction 0: custom program error: 0x0",
          data: { logs: ALREADY_IN_USE_LOGS },
        },
      };
    }
    if (method === "getSignatureStatuses") {
      const landedLate = sent(calls).length === 2;
      return { result: context(params[0].map(() => (landedLate ? status("confirmed") : null))) };
    }
    return undefined;
  });
  const { keysDir } = await keysWith("creator");
  const file = await inputFile("late.json", openCaseInput());
  const { code, output } = await run(["open-case", "--input", file], {
    COORRE_PROGRAM_ID: PROGRAM_ID,
    COORRE_RPC_URL: rpc.url,
    COORRE_KEYS_DIR: keysDir,
  });
  assert.equal(code, 0, JSON.stringify(output));
  assert.equal(output.tx_signature, signatureOf(sent(rpc.calls)[0].params[0]));
});

test("already in use without an earlier landed attempt stays AccountAlreadyInUse", async () => {
  const rpc = await fakeRpc((method) =>
    method === "sendTransaction"
      ? { error: { code: -32002, message: "Transaction simulation failed: custom program error: 0x0", data: { logs: ALREADY_IN_USE_LOGS } } }
      : undefined
  );
  const { keysDir } = await keysWith("creator");
  const file = await inputFile("replay.json", openCaseInput());
  const { code, output } = await run(["open-case", "--input", file], {
    COORRE_PROGRAM_ID: PROGRAM_ID,
    COORRE_RPC_URL: rpc.url,
    COORRE_KEYS_DIR: keysDir,
  });
  assert.equal(code, 1);
  assert.equal(output.error.name, "AccountAlreadyInUse");
});

test("program errors from the send are reported by name and code", async () => {
  const rpc = await fakeRpc((method) =>
    method === "sendTransaction"
      ? {
          error: {
            code: -32002,
            message: "Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1775",
            data: {
              logs: [
                "Program log: Instruction: OpenCase",
                "Program log: AnchorError thrown in programs/coorre_anchor/src/lib.rs:85. Error Code: RolesNotDistinct. Error Number: 6005. Error Message: The four role keys must be distinct.",
              ],
            },
          },
        }
      : undefined
  );
  const { keysDir } = await keysWith("creator");
  const file = await inputFile("roles.json", openCaseInput());
  const { code, output } = await run(["open-case", "--input", file], {
    COORRE_PROGRAM_ID: PROGRAM_ID,
    COORRE_RPC_URL: rpc.url,
    COORRE_KEYS_DIR: keysDir,
  });
  assert.equal(code, 1);
  assert.equal(output.error.name, "RolesNotDistinct");
  assert.equal(output.error.code, 6005);
});

test("a transaction that lands with a program error is reported by name, code and signature", async () => {
  const rpc = await fakeRpc((method, params) =>
    method === "getSignatureStatuses"
      ? { result: context(params[0].map(() => status("confirmed", { InstructionError: [0, { Custom: 6006 }] }))) }
      : undefined
  );
  const { keysDir } = await keysWith("creator");
  const file = await inputFile("landed-error.json", openCaseInput());
  const { code, output } = await run(["open-case", "--input", file], {
    COORRE_PROGRAM_ID: PROGRAM_ID,
    COORRE_RPC_URL: rpc.url,
    COORRE_KEYS_DIR: keysDir,
  });
  assert.equal(code, 1);
  assert.equal(output.error.name, "MandateExceeded");
  assert.equal(output.error.code, 6006);
  assert.equal(output.error.tx_signature, signatureOf(sent(rpc.calls)[0].params[0]));
});

test("anchor-transition refuses a case record owned by another program", async () => {
  const rpc = await fakeRpc((method) =>
    method === "getAccountInfo" ? { result: context(account(Keypair.generate().publicKey.toBase58(), { data: Buffer.alloc(300) })) } : undefined
  );
  const { keysDir } = await keysWith("creator", "submitter");
  const file = await inputFile("foreign.json", {
    case_record: Keypair.generate().publicKey.toBase58(),
    evidence_hash: "01".repeat(32),
    prev_hash: "02".repeat(32),
    rule_hash: "03".repeat(32),
    to_state: 1,
    actor_role: "submitter",
  });
  const { code, output } = await run(["anchor-transition", "--input", file], {
    COORRE_PROGRAM_ID: PROGRAM_ID,
    COORRE_RPC_URL: rpc.url,
    COORRE_KEYS_DIR: keysDir,
  });
  assert.equal(code, 1);
  assert.equal(output.error.name, "InvalidAccount");
  assert.equal(sent(rpc.calls).length, 0);
});

test("a deadline stops a bridge whose RPC never answers", async () => {
  const rpc = await fakeRpc(() => "hang");
  const file = await inputFile("hang.json", { address: PROGRAM_ID });
  const { code, output, elapsed } = await run(["fetch-account", "--input", file], {
    COORRE_PROGRAM_ID: PROGRAM_ID,
    COORRE_RPC_URL: rpc.url,
    COORRE_BRIDGE_TIMEOUT_MS: "700",
  });
  assert.equal(code, 1);
  assert.equal(output.error.name, "Timeout", JSON.stringify(output));
  assert.ok(elapsed < 10_000, `took ${elapsed} ms`);

  for (const bad of ["0", "-1", "1.5", "abc", "3600001"]) {
    const result = await run(["fetch-account", "--input", file], { COORRE_PROGRAM_ID: PROGRAM_ID, COORRE_BRIDGE_TIMEOUT_MS: bad });
    assert.equal(result.output.error.name, "InvalidConfig", bad);
  }
});
