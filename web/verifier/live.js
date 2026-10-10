import { base64ToBytes } from "./verify-core.js";

export const STATE_NAMES = ["OPEN", "SUBMITTED", "AGENT_REVIEWED", "AUTO_APPROVED", "ESCALATED", "APPROVED", "REJECTED"];

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
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

function u64(bytes, offset) {
  let n = 0n;
  for (let i = 7; i >= 0; i -= 1) n = n * 256n + BigInt(bytes[offset + i]);
  return Number(n);
}

function u32(bytes, offset) {
  return bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65536 + bytes[offset + 3] * 16777216;
}

export const CASE_RECORD_SIZE = 254;

export function decodeCaseRecord(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== CASE_RECORD_SIZE) throw new Error("not a case record");
  const state = bytes[216];
  return {
    amount: u64(bytes, 200),
    autonomyLimit: u64(bytes, 208),
    state: STATE_NAMES[state] ?? `unknown (${state})`,
    transitions: u32(bytes, 249),
  };
}

export function decodeUpgradeAuthority(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 45 || u32(bytes, 0) !== 3) throw new Error("not a program data account");
  return bytes[12] === 1 ? base58(bytes.slice(13, 45)) : null;
}

export async function readAccounts(rpcUrl, addresses, fetchImpl = fetch) {
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getMultipleAccounts",
      params: [addresses, { encoding: "base64", commitment: "confirmed" }],
    }),
  });
  if (!response.ok) throw new Error(`RPC answered HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`RPC error: ${body.error.message}`);
  const values = body.result?.value;
  if (!Array.isArray(values) || values.length !== addresses.length) throw new Error("RPC returned an unexpected answer");
  return {
    slot: body.result.context?.slot,
    accounts: Object.fromEntries(
      values.map((v, i) => [
        addresses[i],
        v ? { owner: v.owner, lamports: v.lamports, executable: v.executable, data: base64ToBytes(v.data[0]) } : null,
      ])
    ),
  };
}
