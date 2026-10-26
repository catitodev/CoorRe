import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AccountId, Client, Hbar, PrivateKey } from "@hiero-ledger/sdk";
import { HEDERA_ROOT } from "../lib/paths.mjs";

export const TESTNET = {
  network: "testnet",
  chainId: 296,
  mirrorRest: "https://testnet.mirrornode.hedera.com",
  relay: "https://testnet.hashio.io/api",
  hashscan: "https://hashscan.io/testnet",
  sourcify: "https://sourcify.dev/server",
};
export const MAX_FEE_HBAR = 20;
export const LOCAL_DIR = join(HEDERA_ROOT, "..", ".local");
export const OPERATOR_FILE = join(LOCAL_DIR, "hedera-testnet.json");

export async function mirrorGet(path) {
  const response = await fetch(`${TESTNET.mirrorRest}${path}`);
  if (!response.ok) throw new Error(`testnet mirror returned ${response.status} for ${path}`);
  return response.json();
}

export async function mirrorCall(to, data) {
  const response = await fetch(`${TESTNET.mirrorRest}/api/v1/contracts/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to, data, estimate: false, block: "latest" }),
  });
  if (!response.ok) throw new Error(`testnet mirror contracts/call returned ${response.status}`);
  return (await response.json()).result;
}

const LEDGER_TYPES = { ED25519: "ED25519", ECDSA: "ECDSA_SECP256K1", ECDSA_SECP256K1: "ECDSA_SECP256K1" };
const RAW_KEY = /^[0-9a-fA-F]{64}$/;
const DER_KEY = /^30(?:[0-9a-fA-F]{2}){47,}$/;

export function ledgerType(name) {
  const type = LEDGER_TYPES[String(name)];
  if (!type) throw new Error(`unsupported key type ${name}`);
  return type;
}

export function parsePrivateKey(value, keyType) {
  const clean = String(value ?? "").trim().replace(/^0x/, "");
  if (RAW_KEY.test(clean)) {
    return ledgerType(keyType) === "ED25519" ? PrivateKey.fromStringED25519(clean) : PrivateKey.fromStringECDSA(clean);
  }
  if (DER_KEY.test(clean)) {
    try {
      return PrivateKey.fromStringDer(clean);
    } catch {
      throw new Error("the private key in the operator file is not a valid DER key");
    }
  }
  throw new Error("the private key in the operator file is neither 32 bytes of hex nor a DER key");
}

export function keyFromLedger(value, ledgerKey) {
  const type = ledgerType(ledgerKey?._type);
  const key = parsePrivateKey(value, type);
  if (key.publicKey.toStringRaw().toLowerCase() !== String(ledgerKey.key).toLowerCase()) {
    throw new Error("the private key in the operator file does not control this account");
  }
  return key;
}

export async function findAccountByKey(key) {
  const raw = key.publicKey.toStringRaw();
  const body = await mirrorGet(`/api/v1/accounts?account.publickey=${raw}&limit=5`);
  const matches = (body.accounts ?? []).filter((account) => account.key && String(account.key.key).toLowerCase() === raw.toLowerCase());
  if (matches.length === 0) throw new Error("no testnet account has the public key of the operator file");
  if (matches.length > 1) throw new Error(`more than one account has this key (${matches.map((account) => account.account).join(", ")}); set accountId in the operator file`);
  return matches[0];
}

export async function loadOperator(file = OPERATOR_FILE) {
  const data = JSON.parse(await readFile(file, "utf8"));
  if (data.network !== "testnet") throw new Error("the operator file is not for testnet");
  let account;
  if (data.accountId) {
    if (!/^0\.0\.\d+$/.test(data.accountId)) throw new Error("the operator file has no valid accountId");
    account = await mirrorGet(`/api/v1/accounts/${data.accountId}`);
  } else {
    account = await findAccountByKey(parsePrivateKey(data.privateKey, data.keyType));
  }
  const key = keyFromLedger(data.privateKey, account.key);
  return {
    id: AccountId.fromString(account.account),
    key,
    keyType: account.key._type,
    evmAddress: account.evm_address,
    balanceTinybar: account.balance.balance,
  };
}

export function testnetClient(operator) {
  const client = Client.forTestnet();
  client.setOperator(operator.id, operator.key);
  client.setDefaultMaxTransactionFee(new Hbar(MAX_FEE_HBAR));
  return client;
}
