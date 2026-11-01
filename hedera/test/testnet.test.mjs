import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { PrivateKey } from "@hiero-ledger/sdk";
import {
  assertSeparateOperator,
  hostAccountIds,
  parseArgs,
  planLines,
  pollUntil,
  recordStage,
  runDeploy,
  validateHostConfig,
  verificationInput,
  verifySafely,
  wordAddress,
  writeLogKeyFile,
} from "../testnet/deploy-gate.mjs";
import { MAX_FEE_HBAR, findAccountByKey, keyFromLedger, parsePrivateKey, readPrivateFile } from "../testnet/operator.mjs";
import { CONTRACT_CREATE_MAX_FEE_HBAR } from "../lib/network.mjs";
import { REPO_ROOT } from "../lib/paths.mjs";

const OUTSIDE = join(tmpdir(), "coorre-host", "host.json");
const CONFIG = {
  hostId: "example-host",
  network: "testnet",
  chainId: 296,
  escrow: { evm: "0x00000000000000000000000000000000000003FF", runtimeSha256: "a".repeat(64) },
  admin: { id: "0.0.1001" },
  financialManager: { id: "0.0.1002" },
  oracle: { id: "0.0.1003" },
  otherHostAccounts: ["0.0.1004"],
  recordDir: join(tmpdir(), "coorre-host", "records"),
};

test("arguments need a host configuration outside the repository and spend only with --confirm-spend", () => {
  assert.deepEqual(parseArgs(["--host-config", OUTSIDE]), { hostConfig: OUTSIDE, confirmSpend: false, supersede: false });
  assert.equal(parseArgs(["--host-config", OUTSIDE, "--confirm-spend"]).confirmSpend, true);
  assert.equal(parseArgs(["--host-config", OUTSIDE, "--supersede"]).supersede, true);
  assert.throws(() => parseArgs([]), /--host-config/);
  assert.throws(() => parseArgs(["--host-config", join(REPO_ROOT, ".local", "host.json")]), /outside the repository/);
  assert.throws(() => parseArgs(["--host-config", OUTSIDE, "--yes"]), /unknown argument/);
});

test("the host configuration is checked and its records stay outside the repository", () => {
  const ok = validateHostConfig(CONFIG);
  assert.equal(ok.escrow.evm, CONFIG.escrow.evm.toLowerCase());
  assert.throws(() => validateHostConfig({ ...CONFIG, chainId: 295 }), /testnet/);
  assert.throws(() => validateHostConfig({ ...CONFIG, escrow: { ...CONFIG.escrow, runtimeSha256: "x" } }), /runtimeSha256/);
  assert.throws(() => validateHostConfig({ ...CONFIG, escrow: { ...CONFIG.escrow, evm: "0x1" } }), /escrow.evm/);
  assert.throws(() => validateHostConfig({ ...CONFIG, recordDir: join(REPO_ROOT, "hedera", "deployments") }), /outside the repository/);
  assert.throws(() => validateHostConfig({ ...CONFIG, admin: undefined, financialManager: undefined, oracle: undefined, otherHostAccounts: [] }), /host's accounts/);
  assert.throws(() => validateHostConfig({ ...CONFIG, otherHostAccounts: ["1004"] }), /bad host account id/);
});

test("the mandate validity cap defaults to 90 days and stays within its bounds", () => {
  assert.equal(validateHostConfig(CONFIG).maxMandateValiditySeconds, 90 * 24 * 3600);
  assert.equal(validateHostConfig({ ...CONFIG, maxMandateValiditySeconds: 7200 }).maxMandateValiditySeconds, 7200);
  for (const bad of [0, 3599, 365 * 24 * 3600 + 1, 1.5, "7200"]) {
    assert.throws(() => validateHostConfig({ ...CONFIG, maxMandateValiditySeconds: bad }), /maxMandateValiditySeconds/);
  }
});

test("the CoorRe operator must not be any host account", () => {
  assert.deepEqual(hostAccountIds(CONFIG), ["0.0.1001", "0.0.1002", "0.0.1003", "0.0.1004"]);
  assert.doesNotThrow(() => assertSeparateOperator("0.0.2000", CONFIG));
  for (const id of hostAccountIds(CONFIG)) assert.throws(() => assertSeparateOperator(id, CONFIG), /also a host account/);
});

test("wordAddress reads an address returned by a view", () => {
  assert.equal(wordAddress(`0x${"0".repeat(24)}00000000000000000000000000000000000003ff`), "0x00000000000000000000000000000000000003ff");
  assert.throws(() => wordAddress("0x12"), /32-byte word/);
});

test("the verification input carries only the gate and its interface", () => {
  const buildInfo = {
    input: {
      language: "Solidity",
      settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "paris" },
      sources: {
        "project/contracts/CoorReMandateGate.sol": { content: "gate" },
        "project/contracts/IPeriodEscrow.sol": { content: "interface" },
        "project/contracts/test/CoorReMandateGate.t.sol": { content: "tests" },
        "project/contracts/reference/ReferencePeriodEscrow.sol": { content: "reference" },
      },
    },
  };
  const input = verificationInput(buildInfo, "project/contracts/CoorReMandateGate.sol");
  assert.deepEqual(Object.keys(input.sources), ["project/contracts/CoorReMandateGate.sol", "project/contracts/IPeriodEscrow.sol"]);
  assert.equal(input.settings.evmVersion, "paris");
  assert.throws(() => verificationInput({ input: { sources: {} } }, "project/contracts/CoorReMandateGate.sol"), /not in the build/);
});

test("the operator key must control the account named in the file", () => {
  const ed = PrivateKey.generateED25519();
  const ec = PrivateKey.generateECDSA();
  assert.equal(keyFromLedger(ed.toStringRaw(), { _type: "ED25519", key: ed.publicKey.toStringRaw() }).publicKey.toStringRaw(), ed.publicKey.toStringRaw());
  assert.equal(keyFromLedger(`0x${ec.toStringRaw()}`, { _type: "ECDSA_SECP256K1", key: ec.publicKey.toStringRaw() }).publicKey.toStringRaw(), ec.publicKey.toStringRaw());
  assert.throws(() => keyFromLedger(ed.toStringRaw(), { _type: "ED25519", key: PrivateKey.generateED25519().publicKey.toStringRaw() }), /does not control/);
  assert.throws(() => keyFromLedger("abcd", { _type: "ED25519", key: "00" }), /32 bytes/);
  assert.throws(() => keyFromLedger(ed.toStringRaw(), { _type: "ProtobufEncoded", key: "00" }), /unsupported/);
});

test("a private key is read as 32-byte hex with its type or as a DER key, and errors never echo it", () => {
  const ed = PrivateKey.generateED25519();
  const ec = PrivateKey.generateECDSA();
  assert.equal(parsePrivateKey(ed.toStringRaw(), "ED25519").publicKey.toStringRaw(), ed.publicKey.toStringRaw());
  assert.equal(parsePrivateKey(`0x${ec.toStringRaw()}`, "ECDSA").publicKey.toStringRaw(), ec.publicKey.toStringRaw());
  assert.equal(parsePrivateKey(` ${ed.toStringDer()}\n`).publicKey.toStringRaw(), ed.publicKey.toStringRaw());
  assert.equal(parsePrivateKey(ec.toStringDer()).publicKey.toStringRaw(), ec.publicKey.toStringRaw());
  assert.throws(() => parsePrivateKey(ec.toStringRaw()), /unsupported key type/);
  assert.throws(() => parsePrivateKey("not a key"), /neither 32 bytes of hex nor a DER key/);
  const broken = `30${"ab".repeat(50)}`;
  assert.throws(() => parsePrivateKey(broken), (error) => /not a valid DER key/.test(error.message) && !error.message.includes(broken));
});

test("a DER key controls the account whose ledger key it matches, and no other", () => {
  const ec = PrivateKey.generateECDSA();
  const ledger = { _type: "ECDSA_SECP256K1", key: ec.publicKey.toStringRaw() };
  assert.equal(keyFromLedger(ec.toStringDer(), ledger).publicKey.toStringRaw(), ec.publicKey.toStringRaw());
  assert.throws(() => keyFromLedger(PrivateKey.generateECDSA().toStringDer(), ledger), /does not control/);
});

test("an account is found by the public key and only when exactly one matches", async (t) => {
  const key = PrivateKey.generateECDSA();
  const raw = key.publicKey.toStringRaw();
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const answer = (accounts) => async (url) => {
    assert.match(String(url), new RegExp(`account\\.publickey=${raw}`));
    return new Response(JSON.stringify({ accounts }), { status: 200 });
  };
  globalThis.fetch = answer([{ account: "0.0.2001", key: { _type: "ECDSA_SECP256K1", key: raw } }]);
  assert.equal((await findAccountByKey(key)).account, "0.0.2001");
  globalThis.fetch = answer([]);
  await assert.rejects(findAccountByKey(key), /no testnet account/);
  globalThis.fetch = answer([
    { account: "0.0.2001", key: { _type: "ECDSA_SECP256K1", key: raw } },
    { account: "0.0.2002", key: { _type: "ECDSA_SECP256K1", key: raw } },
  ]);
  await assert.rejects(findAccountByKey(key), /more than one account.*0\.0\.2001, 0\.0\.2002/);
  globalThis.fetch = answer([{ account: "0.0.2003", key: { _type: "ECDSA_SECP256K1", key: PrivateKey.generateECDSA().publicKey.toStringRaw() } }]);
  await assert.rejects(findAccountByKey(key), /no testnet account/);
});

async function privateDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "coorre-testnet-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("a key file readable by other users is refused before it is read", async (t) => {
  const dir = await privateDir(t);
  const file = join(dir, "operator.json");
  await writeFile(file, '{"network":"testnet"}\n', { mode: 0o644 });
  await chmod(file, 0o644);
  await assert.rejects(readPrivateFile(file), /readable by other users \(mode 644\); run chmod 600/);
  await chmod(file, 0o640);
  await assert.rejects(readPrivateFile(file), /mode 640/);
  await chmod(file, 0o600);
  assert.equal(await readPrivateFile(file), '{"network":"testnet"}\n');
});

test("the log key file is created once and never overwritten", async (t) => {
  const dir = await privateDir(t);
  const file = join(dir, "testnet-log-key.json");
  await writeLogKeyFile(file, "aa".repeat(32));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await assert.rejects(writeLogKeyFile(file, "bb".repeat(32)), /EEXIST/);
  assert.match(await readFile(file, "utf8"), /"privateKey":"a{64}"/);
});

test("polling keeps the last error and reports it", async () => {
  let calls = 0;
  assert.equal(await pollUntil(async () => (++calls < 3 ? Promise.reject(new Error(`not yet ${calls}`)) : "found"), { attempts: 5, intervalMs: 1 }), "found");
  await assert.rejects(pollUntil(async () => Promise.reject(new Error("HTTP 404")), { attempts: 2, intervalMs: 1 }), /gave up after 2 attempts: HTTP 404/);
});

test("a Sourcify failure is recorded as an error, not lost", async () => {
  assert.deepEqual(await verifySafely(async () => Promise.reject(new TypeError("fetch failed")), "0x01"), { status: "error", error: "TypeError: fetch failed" });
  assert.deepEqual(await verifySafely(async (evm) => ({ status: "completed", match: "exact_match", evm }), "0x01"), { status: "completed", match: "exact_match", evm: "0x01" });
});

test("the dry-run plan states both fee caps", () => {
  const config = validateHostConfig(CONFIG);
  const text = planLines({ config, previous: null, stage: null }).join("\n");
  assert.match(text, new RegExp(`at most ${MAX_FEE_HBAR} HBAR per transaction`));
  assert.match(text, new RegExp(`at most ${CONTRACT_CREATE_MAX_FEE_HBAR} HBAR for the gate's ContractCreate`));
  assert.equal(MAX_FEE_HBAR, 20);
  assert.equal(CONTRACT_CREATE_MAX_FEE_HBAR, 40);
  const resumed = planLines({ config, previous: { gate: { id: "0.0.7" } }, stage: "gate-deployed" }).join("\n");
  assert.match(resumed, /gate 0\.0\.7 stopped at stage gate-deployed; it is resumed, the gate is not deployed again/);
  assert.doesNotMatch(resumed, /1\. deploy/);
});

function fakeSteps(overrides = {}) {
  const calls = { deployGate: 0, createTopic: 0, verify: 0, confirmNoAdmin: 0 };
  const steps = {
    deployGate: async () => {
      calls.deployGate += 1;
      return { id: `0.0.${100 + calls.deployGate}`, evm: "0x0000000000000000000000000000000000000065", transactionId: "0.0.2@1.1", chunks: 7 };
    },
    confirmNoAdmin: async () => {
      calls.confirmNoAdmin += 1;
    },
    generateLogKey: () => PrivateKey.generateED25519(),
    createTopic: async () => {
      calls.createTopic += 1;
      return { id: "0.0.900", transactionId: "0.0.2@2.2" };
    },
    verify: async () => {
      calls.verify += 1;
      return { status: "completed", match: "exact_match" };
    },
    ...overrides,
  };
  return { steps, calls };
}

function deployInput(dir, previous = null, supersede = false) {
  return { args: { supersede }, recordFile: join(dir, "testnet-gate.json"), logKeyFile: join(dir, "testnet-log-key.json"), previous, base: { network: "testnet", hostId: "example-host" } };
}

const quiet = () => {};

test("a deploy writes its record after the gate, after the topic and at the end", async (t) => {
  const dir = await privateDir(t);
  const { steps, calls } = fakeSteps({ verify: async () => Promise.reject(new Error("Sourcify is down")) });
  const record = await runDeploy(deployInput(dir), steps, quiet);
  assert.equal(record.stage, "complete");
  assert.deepEqual(record.gate.verification, { status: "error", error: "Error: Sourcify is down" });
  assert.equal(record.topic.id, "0.0.900");
  assert.deepEqual(JSON.parse(await readFile(join(dir, "testnet-gate.json"), "utf8")), record);
  assert.equal((await stat(join(dir, "testnet-gate.json"))).mode & 0o777, 0o600);
  assert.deepEqual(calls, { deployGate: 1, createTopic: 1, verify: 0, confirmNoAdmin: 1 });
});

test("a deploy that stops after the gate resumes without deploying it again", async (t) => {
  const dir = await privateDir(t);
  const failing = fakeSteps({ createTopic: async () => Promise.reject(new Error("network down")) });
  await assert.rejects(runDeploy(deployInput(dir), failing.steps, quiet), /network down/);
  const partial = JSON.parse(await readFile(join(dir, "testnet-gate.json"), "utf8"));
  assert.equal(partial.stage, "gate-deployed");
  assert.equal(partial.gate.id, "0.0.101");
  assert.equal(recordStage(partial), "gate-deployed");
  await assert.rejects(runDeploy(deployInput(dir, partial), fakeSteps().steps, quiet), /a log key file exists but no topic is recorded/);
  await rm(join(dir, "testnet-log-key.json"));
  const resumed = fakeSteps();
  const record = await runDeploy(deployInput(dir, partial), resumed.steps, quiet);
  assert.equal(resumed.calls.deployGate, 0);
  assert.equal(record.gate.id, "0.0.101");
  assert.equal(record.stage, "complete");
  await assert.rejects(runDeploy(deployInput(dir, partial, true), fakeSteps().steps, quiet), /finish it before superseding it/);
});

test("a complete record is kept unless superseded, and superseding archives it and keeps its topic", async (t) => {
  const dir = await privateDir(t);
  const first = await runDeploy(deployInput(dir), fakeSteps().steps, quiet);
  await assert.rejects(runDeploy(deployInput(dir, first), fakeSteps().steps, quiet), /already recorded/);
  const second = fakeSteps();
  const record = await runDeploy(deployInput(dir, first, true), second.steps, quiet);
  assert.equal(second.calls.createTopic, 0);
  assert.equal(record.supersedes, first.gate.id);
  assert.equal(record.topic.id, first.topic.id);
  assert.equal(record.topic.reused, true);
  const files = (await readdir(dir)).sort();
  assert.equal(files.filter((name) => name.startsWith("testnet-gate-superseded-")).length, 1);
  assert.ok(!files.some((name) => name.endsWith(".writing")));
  assert.equal(recordStage({ gate: {}, topic: {} }), "complete");
  assert.throws(() => recordStage({ stage: "half" }), /unknown stage half/);
});
