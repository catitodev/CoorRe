import { test } from "node:test";
import assert from "node:assert/strict";
import { PrivateKey } from "@hiero-ledger/sdk";
import { classifyAccount, parseArgs, readOperatorFile } from "../testnet/complete-account.mjs";

test("arguments spend only with --confirm-spend", () => {
  assert.deepEqual(parseArgs([]), { confirmSpend: false });
  assert.deepEqual(parseArgs(["--confirm-spend"]), { confirmSpend: true });
  assert.throws(() => parseArgs(["--yes"]), /unknown argument/);
});

test("an account without a key is hollow, with the file's key it is complete, and any other key is refused", () => {
  const key = PrivateKey.generateECDSA();
  const raw = key.publicKey.toStringRaw();
  assert.equal(classifyAccount({ key: null }, raw), "hollow");
  assert.equal(classifyAccount({}, raw), "hollow");
  assert.equal(classifyAccount({ key: { _type: "ECDSA_SECP256K1", key: raw.toUpperCase() } }, raw), "complete");
  assert.throws(() => classifyAccount({ key: { _type: "ECDSA_SECP256K1", key: PrivateKey.generateECDSA().publicKey.toStringRaw() } }, raw), /not the key in the operator file/);
  assert.throws(() => classifyAccount({ key: { _type: "ED25519", key: raw } }, raw), /expected ECDSA_SECP256K1/);
  assert.throws(() => classifyAccount(null, raw), /no account/);
});

test("the operator file must be testnet, ECDSA, a 32-byte key and an address that belongs to it", () => {
  const key = PrivateKey.generateECDSA();
  const file = { network: "testnet", keyType: "ECDSA", evmAddress: `0x${key.publicKey.toEvmAddress()}`, privateKey: `0x${key.toStringRaw()}` };
  assert.equal(readOperatorFile(file).evm, file.evmAddress);
  assert.throws(() => readOperatorFile({ ...file, network: "mainnet" }), /not for testnet/);
  assert.throws(() => readOperatorFile({ ...file, keyType: "ED25519" }), /only an ECDSA key/);
  assert.throws(() => readOperatorFile({ ...file, privateKey: "0x12" }), /32 bytes/);
  assert.throws(() => readOperatorFile({ ...file, evmAddress: `0x${PrivateKey.generateECDSA().publicKey.toEvmAddress()}` }), /does not belong/);
});
