import { createHash } from "node:crypto";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

export const NETWORK_ID = "solana:devnet";
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const DEFAULT_RPC_URL = "https://api.devnet.solana.com";
export const DEFAULT_KEYS_DIR = ".local/keys";
export const DEFAULT_TIMEOUT_MS = 180_000;
export const MAX_TIMEOUT_MS = 3_600_000;
export const LOOPBACK_HOSTS = ["127.0.0.1", "[::1]", "localhost"];
export const ACTOR_ROLES = ["submitter", "agent", "rule_engine", "approver"];
export const PROGRAM_ERRORS = [
  "InvalidTransition",
  "InvalidState",
  "UnauthorizedActor",
  "PrevHashMismatch",
  "CaseClosed",
  "RolesNotDistinct",
  "MandateExceeded",
  "InsufficientEscrow",
  "Overflow",
  "AmountBelowRentExempt",
];
export const CASE_RECORD_SIZE = 8 + 32 + 32 * 5 + 8 + 8 + 1 + 32 + 4 + 1;

const U64_MAX = (1n << 64n) - 1n;

export class BridgeError extends Error {
  constructor(name, message, details = {}) {
    super(message);
    this.name = name;
    this.details = details;
  }
}

export function discriminator(namespace, name) {
  return createHash("sha256").update(`${namespace}:${name}`).digest().subarray(0, 8);
}

export function parseHex32(value, field) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new BridgeError("InvalidInput", `${field} must be 64 lowercase hex characters`);
  }
  return Buffer.from(value, "hex");
}

export function parseU64(value, field) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new BridgeError("InvalidInput", `${field} must be a canonical decimal string`);
  }
  const n = BigInt(value);
  if (n > U64_MAX) throw new BridgeError("InvalidInput", `${field} does not fit in u64`);
  return n;
}

export function parsePubkey(value, field) {
  const message = `${field} must be a base58 public key`;
  if (typeof value !== "string") throw new BridgeError("InvalidInput", message, { reason: `got ${typeof value}` });
  let key;
  try {
    key = new PublicKey(value);
  } catch (err) {
    throw new BridgeError("InvalidInput", message, { reason: String(err?.message ?? err) });
  }
  if (key.toBase58() !== value) throw new BridgeError("InvalidInput", message, { reason: "not in canonical base58 form" });
  return key;
}

export function parseWalletKey(value, field, programId) {
  const key = parsePubkey(value, field);
  if (!PublicKey.isOnCurve(key.toBytes())) {
    throw new BridgeError("InvalidInput", `${field} must be a wallet key on the ed25519 curve; a program-derived address cannot sign or receive the payout`);
  }
  if (key.equals(programId)) {
    throw new BridgeError("InvalidInput", `${field} cannot be the program id`);
  }
  return key;
}

export function rpcOrigin(value) {
  try {
    return new URL(value).origin;
  } catch (err) {
    return `<invalid URL: ${err?.code ?? "unparsable"}>`;
  }
}

export function parseRpcUrl(value, field) {
  let url;
  try {
    url = new URL(value);
  } catch (err) {
    throw new BridgeError("InvalidConfig", `${field} is not a valid URL`, { cause_code: err?.code ?? "unparsable" });
  }
  if (url.protocol === "https:") return value;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname)) return value;
  throw new BridgeError(
    "InsecureRpc",
    `${field} must use https; plain http is accepted only for ${LOOPBACK_HOSTS.join(", ")}`,
    { rpc: url.origin }
  );
}

export function parseTimeoutMs(value) {
  if (value === undefined || value === "") return DEFAULT_TIMEOUT_MS;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value) || Number(value) > MAX_TIMEOUT_MS) {
    throw new BridgeError("InvalidConfig", `COORRE_BRIDGE_TIMEOUT_MS must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
  }
  return Number(value);
}

export function redactRpcUrls(text, urls) {
  let out = text;
  for (const url of [...urls].filter(Boolean).sort((a, b) => b.length - a.length)) {
    const origin = rpcOrigin(url);
    out = out.split(url).join(origin);
    const escaped = JSON.stringify(url).slice(1, -1);
    if (escaped !== url) out = out.split(escaped).join(origin);
  }
  return out;
}

export function parseStateCode(value, field) {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new BridgeError("InvalidInput", `${field} must be an integer from 0 to 255`);
  }
  return value;
}

export function parseActorRole(value, field) {
  if (!ACTOR_ROLES.includes(value)) {
    throw new BridgeError("InvalidInput", `${field} must be one of ${ACTOR_ROLES.join(", ")}`);
  }
  return value;
}

export function requireMembers(input, members) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new BridgeError("InvalidInput", "input must be a JSON object");
  }
  const actual = Object.keys(input).sort();
  const expected = [...members].sort();
  if (actual.length !== expected.length || actual.some((k, i) => k !== expected[i])) {
    throw new BridgeError("InvalidInput", `input members must be exactly: ${expected.join(", ")}`);
  }
  return input;
}

export function u64le(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value);
  return buffer;
}

export function encodeOpenCase({ caseId, submitter, agent, ruleEngine, approver, amount, autonomyLimit }) {
  return Buffer.concat([
    discriminator("global", "open_case"),
    caseId,
    submitter.toBuffer(),
    agent.toBuffer(),
    ruleEngine.toBuffer(),
    approver.toBuffer(),
    u64le(amount),
    u64le(autonomyLimit),
  ]);
}

export function encodeAnchorTransition({ evidenceHash, prevHash, toState, ruleHash }) {
  return Buffer.concat([
    discriminator("global", "anchor_transition"),
    evidenceHash,
    prevHash,
    Buffer.from([toState]),
    ruleHash,
  ]);
}

export function caseRecordAddress(programId, creator, caseId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("case"), creator.toBuffer(), caseId],
    programId
  )[0];
}

export function evidenceAnchorAddress(programId, caseRecord, evidenceHash) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("evidence"), caseRecord.toBuffer(), evidenceHash],
    programId
  )[0];
}

export function openCaseInstruction(programId, { caseRecord, creator, data }) {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: caseRecord, isSigner: false, isWritable: true },
      { pubkey: creator, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function anchorTransitionInstruction(
  programId,
  { caseRecord, evidenceAnchor, actor, payer, submitter, creator, data }
) {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: caseRecord, isSigner: false, isWritable: true },
      { pubkey: evidenceAnchor, isSigner: false, isWritable: true },
      { pubkey: actor, isSigner: true, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: submitter, isSigner: false, isWritable: true },
      { pubkey: creator, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function decodeCaseRecord(data) {
  if (data.length < CASE_RECORD_SIZE) {
    throw new BridgeError("InvalidAccount", "case record data is too short");
  }
  if (!data.subarray(0, 8).equals(discriminator("account", "CaseRecord"))) {
    throw new BridgeError("InvalidAccount", "account is not a CaseRecord");
  }
  let offset = 8;
  const take = (n) => {
    const slice = data.subarray(offset, offset + n);
    offset += n;
    return slice;
  };
  return {
    caseId: Buffer.from(take(32)),
    creator: new PublicKey(take(32)),
    submitter: new PublicKey(take(32)),
    agent: new PublicKey(take(32)),
    ruleEngine: new PublicKey(take(32)),
    approver: new PublicKey(take(32)),
    amount: take(8).readBigUInt64LE(),
    autonomyLimit: take(8).readBigUInt64LE(),
    state: take(1)[0],
    lastEvidenceHash: Buffer.from(take(32)),
    transitionCount: take(4).readUInt32LE(),
    bump: take(1)[0],
  };
}

export function parseProgramError(logs = [], message = "") {
  for (const line of logs) {
    const match = /Error Code: (\w+)\. Error Number: (\d+)\./.exec(line);
    if (match) return { name: match[1], code: Number(match[2]) };
  }
  const text = `${message}\n${logs.join("\n")}`;
  const custom = /custom program error: 0x([0-9a-f]+)/i.exec(text);
  if (custom) {
    const code = parseInt(custom[1], 16);
    const name = PROGRAM_ERRORS[code - 6000];
    if (name) return { name, code };
  }
  const instruction = /"Custom":(\d+)/.exec(text);
  if (instruction) {
    const code = Number(instruction[1]);
    const name = PROGRAM_ERRORS[code - 6000];
    if (name) return { name, code };
  }
  if (/already in use/.test(text)) return { name: "AccountAlreadyInUse" };
  return null;
}
