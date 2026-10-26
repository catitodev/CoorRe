import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AccountId, Client, PrivateKey } from "@hiero-ledger/sdk";
import { HEDERA_ROOT } from "../scripts/wata-lock.mjs";

export const TESTNET = {
  network: "testnet",
  chainId: 296,
  mirrorRest: "https://testnet.mirrornode.hedera.com",
  relay: "https://testnet.hashio.io/api",
  hashscan: "https://hashscan.io/testnet",
  sourcify: "https://sourcify.dev/server",
};
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

export function keyFromLedger(hex, ledgerKey) {
  const clean = String(hex).replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new Error("the private key in the operator file is not 32 bytes of hex");
  const candidates = { ED25519: () => PrivateKey.fromStringED25519(clean), ECDSA_SECP256K1: () => PrivateKey.fromStringECDSA(clean) };
  const make = candidates[ledgerKey?._type];
  if (!make) throw new Error(`unsupported ledger key type ${ledgerKey?._type}`);
  const key = make();
  if (key.publicKey.toStringRaw().toLowerCase() !== String(ledgerKey.key).toLowerCase()) {
    throw new Error("the private key in the operator file does not control this account");
  }
  return key;
}

export async function loadOperator(file = OPERATOR_FILE) {
  const data = JSON.parse(await readFile(file, "utf8"));
  if (data.network !== "testnet") throw new Error("the operator file is not for testnet");
  if (!/^0\.0\.\d+$/.test(data.accountId ?? "")) throw new Error("the operator file has no valid accountId");
  const account = await mirrorGet(`/api/v1/accounts/${data.accountId}`);
  const key = keyFromLedger(data.privateKey, account.key);
  return {
    id: AccountId.fromString(data.accountId),
    key,
    keyType: account.key._type,
    evmAddress: account.evm_address,
    balanceTinybar: account.balance.balance,
  };
}

export function testnetClient(operator) {
  const client = Client.forTestnet();
  client.setOperator(operator.id, operator.key);
  return client;
}
