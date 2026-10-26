import { test } from "node:test";
import assert from "node:assert/strict";
import { PrivateKey } from "@hiero-ledger/sdk";
import { parseArgs, verificationInput, wordAddress } from "../testnet/deploy-gate.mjs";
import { keyFromLedger } from "../testnet/operator.mjs";

const ESCROW = "0x00000000000000000000000000000000000003FF";

test("arguments need an escrow address and spend only with --confirm-spend", () => {
  assert.deepEqual(parseArgs(["--escrow", ESCROW]), { escrow: ESCROW.toLowerCase(), confirmSpend: false });
  assert.equal(parseArgs(["--escrow", ESCROW, "--confirm-spend"]).confirmSpend, true);
  assert.throws(() => parseArgs([]), /--escrow/);
  assert.throws(() => parseArgs(["--escrow", "0x1"]), /--escrow/);
  assert.throws(() => parseArgs(["--escrow", ESCROW, "--yes"]), /unknown argument/);
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
        "project/contracts/IPESEscrowV3.sol": { content: "interface" },
        "project/contracts/test/CoorReMandateGate.t.sol": { content: "tests" },
        "project/.cache/wata/pinned/contracts/contracts/PESEscrowV3.sol": { content: "host" },
      },
    },
  };
  const input = verificationInput(buildInfo, "project/contracts/CoorReMandateGate.sol");
  assert.deepEqual(Object.keys(input.sources), ["project/contracts/CoorReMandateGate.sol", "project/contracts/IPESEscrowV3.sol"]);
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
