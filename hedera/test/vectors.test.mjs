import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { caseId, caseRef, jcs, mandateId, sha256Hex } from "../lib/canonical.mjs";
import { logMessage } from "../lib/log.mjs";
import { HEDERA_ROOT } from "../lib/paths.mjs";

const vectors = JSON.parse(readFileSync(join(HEDERA_ROOT, "test", "vectors", "hedera-ids.json"), "utf8"));

test("mandateId vector", () => {
  assert.equal(jcs(vectors.mandateId.document), vectors.mandateId.jcs);
  assert.equal(mandateId(vectors.mandateId.document), vectors.mandateId.mandateId);
});

test("case_ref and case_id vector", () => {
  const { hostId, chainId, escrow, agreementId, periodId } = vectors.caseRef.input;
  assert.equal(caseRef(hostId, chainId, escrow, agreementId, periodId), vectors.caseRef.case_ref);
  assert.equal(caseId(vectors.caseRef.case_ref), vectors.caseRef.case_id);
});

test("HCS decision message vector", () => {
  const message = logMessage(vectors.hcsMessage.entry);
  assert.equal(message, vectors.hcsMessage.message);
  assert.equal(Buffer.byteLength(message, "utf8"), vectors.hcsMessage.bytes);
  assert.equal(sha256Hex(Buffer.from(message, "utf8")), vectors.hcsMessage.sha256);
  assert.equal(vectors.hcsMessage.entry.case_ref, vectors.caseRef.case_ref);
  assert.equal(vectors.hcsMessage.entry.mandateId, vectors.mandateId.mandateId);
});
