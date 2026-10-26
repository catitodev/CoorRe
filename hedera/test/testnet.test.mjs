import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PrivateKey } from "@hiero-ledger/sdk";
import { assertSeparateOperator, hostAccountIds, parseArgs, validateHostConfig, verificationInput, wordAddress } from "../testnet/deploy-gate.mjs";
import { findAccountByKey, keyFromLedger, parsePrivateKey } from "../testnet/operator.mjs";
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
