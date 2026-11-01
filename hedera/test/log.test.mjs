import { test } from "node:test";
import assert from "node:assert/strict";
import { LOG_KINDS, MAX_LOG_MESSAGE_BYTES, logEntry, logFieldsBeforeSending, logMessage } from "../lib/log.mjs";

const HASH = "ab".repeat(32);
const DECISION = {
  kind: "decision",
  hostId: "example-host",
  path: "A",
  case_ref: "urn:coorre:case:example-host:298:0x00000000000000000000000000000000000003ff:0:1",
  mandateId: HASH,
  evidenceHash: HASH,
  auditHash: HASH,
  verdict: "approve",
  delegate: "0x0000000000000000000000000000000000000403",
  transactionId: "0.0.1002@1700000000.000000123",
};

test("every kind of log message needs its own fields", () => {
  for (const [kind, shape] of Object.entries(LOG_KINDS)) {
    for (const name of shape.required) {
      const fields = { kind, ...Object.fromEntries(shape.required.map((field) => [field, field === "path" ? "A" : "x"])), transactionId: "0.0.2@1.1" };
      if (shape.transaction === "none") delete fields.transactionId;
      assert.doesNotThrow(() => logEntry(fields), kind);
      delete fields[name];
      assert.throws(() => logEntry(fields), new RegExp(`a ${kind} log entry needs ${name}`), `${kind} without ${name}`);
    }
  }
  assert.deepEqual(Object.keys(LOG_KINDS).sort(), ["admin", "decision", "mandate", "review", "revocation", "rotation"]);
});

test("a log message is JCS, names one transaction and carries no field outside its kind", () => {
  assert.equal(logMessage({ ...DECISION }), JSON.stringify(Object.fromEntries(Object.entries(DECISION).sort(([a], [b]) => (a < b ? -1 : 1)))));
  const { transactionId, ...unsent } = DECISION;
  assert.throws(() => logEntry(unsent), /needs transactionId or transactionHash/);
  assert.throws(() => logEntry({ ...DECISION, transactionHash: `0x${HASH}` }), /one transaction reference/);
  assert.throws(() => logEntry({ ...DECISION, reason: "private text" }), /does not carry reason/);
  assert.throws(() => logEntry({ ...DECISION, path: "C" }), /path must be A or B/);
  assert.throws(() => logEntry({ ...DECISION, verdict: { value: "approve" } }), /non-empty string or an integer/);
  assert.throws(() => logEntry({ ...DECISION, verdict: "" }), /non-empty string or an integer/);
  assert.throws(() => logEntry({ ...DECISION, kind: "constructor" }), /unknown log kind/);
  assert.throws(() => logEntry({ ...DECISION, kind: "toString" }), /unknown log kind/);
});

test("a path B mandate has no transaction and a path A mandate names its registration", () => {
  const mandate = { kind: "mandate", hostId: "example-host", mandateId: HASH };
  assert.doesNotThrow(() => logEntry({ ...mandate, path: "B", escrow: DECISION.delegate }));
  assert.throws(() => logEntry({ ...mandate, path: "B", transactionId: "0.0.2@1.1" }), /path B mandate/);
  assert.throws(() => logEntry({ ...mandate, path: "A" }), /needs transactionId/);
});

test("a log message stays within the topic limit, and the check before sending allows for the transaction reference", () => {
  assert.equal(MAX_LOG_MESSAGE_BYTES, 1024);
  assert.throws(() => logMessage({ ...DECISION, case_ref: "x".repeat(1100) }), /exceeds 1024/);
  assert.throws(() => logMessage(DECISION, 1025), /maxBytes/);
  const { transactionId, ...unsent } = DECISION;
  const size = Buffer.byteLength(logMessage({ ...unsent, transactionHash: `0x${"f".repeat(64)}` }), "utf8");
  assert.deepEqual(logFieldsBeforeSending(unsent, size), unsent);
  assert.throws(() => logFieldsBeforeSending(unsent, size - 1), /exceeds/);
});
