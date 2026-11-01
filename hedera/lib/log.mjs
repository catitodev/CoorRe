import { jcs } from "./canonical.mjs";

export const MAX_LOG_MESSAGE_BYTES = 1024;
export const TRANSACTION_REFERENCES = ["transactionId", "transactionHash"];
export const LOG_KINDS = {
  mandate: { required: ["hostId", "path", "mandateId"], optional: ["gate", "escrow"], transaction: "path-A" },
  revocation: { required: ["hostId", "mandateId"], optional: ["gate"], transaction: "required" },
  decision: { required: ["hostId", "path", "case_ref", "mandateId", "evidenceHash", "auditHash", "verdict", "delegate"], optional: ["blockTimestamp"], transaction: "required" },
  review: { required: ["hostId", "case_ref", "mandateId", "evidenceHash", "auditHash", "outcome", "delegate"], optional: [], transaction: "required" },
  admin: { required: ["hostId", "action", "escrow"], optional: ["from", "to", "value"], transaction: "required" },
  rotation: { required: ["hostId", "nextTopic"], optional: [], transaction: "none" },
};
const LONGEST_TRANSACTION_REFERENCE = { transactionHash: `0x${"f".repeat(64)}` };

function scalar(value) {
  return typeof value === "string" ? value.length > 0 : Number.isSafeInteger(value);
}

export function logEntry(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("a log entry is a JSON object");
  const { kind, ...rest } = fields;
  if (!Object.hasOwn(LOG_KINDS, kind)) throw new Error(`unknown log kind ${kind}`);
  const shape = LOG_KINDS[kind];
  const allowed = new Set([...shape.required, ...shape.optional, ...(shape.transaction === "none" ? [] : TRANSACTION_REFERENCES)]);
  for (const name of shape.required) if (!Object.hasOwn(rest, name)) throw new Error(`a ${kind} log entry needs ${name}`);
  for (const [name, value] of Object.entries(rest)) {
    if (!allowed.has(name)) throw new Error(`a ${kind} log entry does not carry ${name}`);
    if (!scalar(value)) throw new Error(`${name} of a ${kind} log entry must be a non-empty string or an integer`);
  }
  if (Object.hasOwn(rest, "path") && rest.path !== "A" && rest.path !== "B") throw new Error("path must be A or B");
  const references = TRANSACTION_REFERENCES.filter((name) => Object.hasOwn(rest, name));
  if (references.length > 1) throw new Error("a log entry names one transaction reference");
  const needsReference = shape.transaction === "required" || (shape.transaction === "path-A" && rest.path === "A");
  if (needsReference && references.length === 0) throw new Error(`a ${kind} log entry needs ${TRANSACTION_REFERENCES.join(" or ")}`);
  if (shape.transaction === "path-A" && rest.path === "B" && references.length > 0) throw new Error("a path B mandate has no registration transaction");
  return { kind, ...rest };
}

export function logMessage(fields, maxBytes = MAX_LOG_MESSAGE_BYTES) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_LOG_MESSAGE_BYTES) throw new Error(`maxBytes must be between 1 and ${MAX_LOG_MESSAGE_BYTES}`);
  const text = jcs(logEntry(fields));
  const size = Buffer.byteLength(text, "utf8");
  if (size > maxBytes) throw new Error(`log message of ${size} bytes exceeds ${maxBytes}`);
  return text;
}

export function logFieldsBeforeSending(fields, maxBytes = MAX_LOG_MESSAGE_BYTES) {
  logMessage({ ...fields, ...LONGEST_TRANSACTION_REFERENCE }, maxBytes);
  return { ...fields };
}
