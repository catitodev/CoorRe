#!/usr/bin/env node
import { chmod, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { AccountId, AccountUpdateTransaction, Client, Hbar, PrivateKey, Status } from "@hiero-ledger/sdk";
import { OPERATOR_FILE, TESTNET, mirrorGet } from "./operator.mjs";

const MAX_FEE_HBAR = 1;
const ACCOUNT_MEMO = "coorre-operator";

export function parseArgs(argv) {
  const args = { confirmSpend: false };
  for (const arg of argv) {
    if (arg === "--confirm-spend") args.confirmSpend = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return args;
}

export function classifyAccount(account, publicKeyRaw) {
  if (!account || typeof account !== "object") throw new Error("the Mirror Node returned no account");
  if (account.key === null || account.key === undefined) return "hollow";
  if (account.key._type !== "ECDSA_SECP256K1") throw new Error(`the account key type is ${account.key._type}, expected ECDSA_SECP256K1`);
  if (String(account.key.key).toLowerCase() !== publicKeyRaw.toLowerCase()) throw new Error("the account key in the ledger is not the key in the operator file");
  return "complete";
}

export function readOperatorFile(data) {
  if (data.network !== "testnet") throw new Error("the operator file is not for testnet");
  if (data.keyType !== "ECDSA") throw new Error("only an ECDSA key can complete an account created from an EVM address");
  const hex = String(data.privateKey ?? "").replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("the private key in the operator file is not 32 bytes of hex");
  const key = PrivateKey.fromStringECDSA(hex);
  const evm = `0x${key.publicKey.toEvmAddress()}`.toLowerCase();
  if (String(data.evmAddress ?? "").toLowerCase() !== evm) throw new Error("the EVM address in the operator file does not belong to its key");
  return { key, evm };
}

async function waitForKey(evm, publicKeyRaw) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const account = await mirrorGet(`/api/v1/accounts/${evm}`);
    if (classifyAccount(account, publicKeyRaw) === "complete") return account;
    await new Promise((done) => setTimeout(done, 2_000));
  }
  throw new Error("the key did not appear in the ledger within 60 seconds");
}

async function saveAccountId(data, accountId) {
  const updated = { ...data, accountId };
  await writeFile(OPERATOR_FILE, `${JSON.stringify(updated)}\n`, { mode: 0o600 });
  await chmod(OPERATOR_FILE, 0o600);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const data = JSON.parse(await readFile(OPERATOR_FILE, "utf8"));
  const { key, evm } = readOperatorFile(data);
  const account = await mirrorGet(`/api/v1/accounts/${evm}`);
  const state = classifyAccount(account, key.publicKey.toStringRaw());
  console.log(`account   ${account.account} (${evm}), balance ${(account.balance.balance / 1e8).toFixed(8)} HBAR, state ${state}`);
  if (state === "complete") {
    await saveAccountId(data, account.account);
    console.log("complete  the key is already in the ledger; the account id is saved in the operator file");
    return;
  }
  console.log(`plan      one AccountUpdateTransaction paid and signed by the account itself, memo "${ACCOUNT_MEMO}", fee capped at ${MAX_FEE_HBAR} HBAR`);
  if (!args.confirmSpend) {
    console.log("dry run   nothing sent; rerun with --confirm-spend to execute");
    return;
  }
  const client = Client.forTestnet();
  client.setOperator(AccountId.fromString(account.account), key);
  const response = await new AccountUpdateTransaction()
    .setAccountId(AccountId.fromString(account.account))
    .setAccountMemo(ACCOUNT_MEMO)
    .setMaxTransactionFee(new Hbar(MAX_FEE_HBAR))
    .execute(client);
  const receipt = await response.getReceipt(client);
  if (receipt.status !== Status.Success) throw new Error(`account update returned ${receipt.status}`);
  console.log(`update    ${response.transactionId}`);
  const completed = await waitForKey(evm, key.publicKey.toStringRaw());
  await saveAccountId(data, completed.account);
  console.log(`complete  key ${completed.key._type} in the ledger, balance ${(completed.balance.balance / 1e8).toFixed(8)} HBAR; ${TESTNET.hashscan}/account/${completed.account}`);
  client.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`complete-account: ${error.message}`);
    process.exit(1);
  });
}
