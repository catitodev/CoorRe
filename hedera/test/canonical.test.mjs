import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { caseId, caseRef, jcs, jcsHash, mandateId } from "../lib/canonical.mjs";
import { HEDERA_ROOT } from "../scripts/wata-lock.mjs";

const REPO = join(HEDERA_ROOT, "..");
const VECTORS = join(REPO, "offchain", "crates", "coorre-model", "tests", "vectors", "rfc8785");
const RULES = join(REPO, "offchain", "crates", "coorre-engine", "rules");
const BUNDLE_DIRS = [join(REPO, "onchain", "devnet-bundles", "2026-10-10"), join(REPO, "web", "verifier", "samples")];

test("JCS matches the RFC 8785 section 3.2.4 bytes used by the Rust core", () => {
  const input = JSON.parse(readFileSync(join(VECTORS, "sample.json"), "utf8"));
  const expected = Buffer.from(readFileSync(join(VECTORS, "sample.canonical.hex"), "utf8").trim().split(/\s+/).join(""), "hex");
  assert.deepEqual(Buffer.from(jcs(input), "utf8"), expected);
});

test("JCS sorts properties by UTF-16 code units (RFC 8785 section 3.2.3)", () => {
  const canonical = jcs(JSON.parse(readFileSync(join(VECTORS, "sorting.json"), "utf8")));
  const order = ["Carriage Return", "One", "Control", "Latin Small Letter O With Diaeresis", "Euro Sign", "Emoji: Grinning Face", "Hebrew Letter Dalet With Dagesh"];
  const positions = order.map((label) => canonical.indexOf(label));
  assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])), canonical);
});

test("JCS refuses values JSON cannot carry", () => {
  assert.throws(() => jcs({ a: undefined }), /undefined/);
  assert.throws(() => jcs(Number.NaN), /non-finite/);
  assert.throws(() => jcs(1n), /bigint/);
});

test("case_id matches the Rust core vector for SUP-001", () => {
  assert.equal(caseId("urn:coorre:case:SUP-001"), "3399ee0b9edb655f3ca4c144f4f37310fc6b20ca53423dd567d890970b50a805");
});

test("the JCS hash of every registry rule equals the hash recorded in the devnet bundles", () => {
  const recorded = new Map();
  for (const dir of BUNDLE_DIRS) {
    for (const name of readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)) {
      const bundle = JSON.parse(readFileSync(join(dir, name, "bundle.json"), "utf8"));
      for (const entry of bundle.evidence) {
        const rule = entry.document.credentialSubject.rule;
        if (rule) recorded.set(`${rule.id}-v${rule.version}`, rule.hash);
      }
    }
  }
  const files = readdirSync(RULES).filter((name) => name.endsWith(".json"));
  assert.equal(files.length, 5);
  for (const file of files) {
    const id = file.replace(/\.json$/, "");
    assert.ok(recorded.has(id), `no devnet bundle records ${id}`);
    assert.equal(`sha256:${jcsHash(JSON.parse(readFileSync(join(RULES, file), "utf8")))}`, recorded.get(id), id);
  }
});

test("caseRef names the host period and lowercases the escrow address", () => {
  const ref = caseRef("wata", 298, "0x00000000000000000000000000000000000003F9", 0, 1);
  assert.equal(ref, "urn:coorre:case:wata:298:0x00000000000000000000000000000000000003f9:0:1");
  assert.equal(caseId(ref).length, 64);
  assert.throws(() => caseRef("WATA", 298, "0x00000000000000000000000000000000000003f9", 0, 1), /hostId/);
  assert.throws(() => caseRef("wata", 0, "0x00000000000000000000000000000000000003f9", 0, 1), /chainId/);
  assert.throws(() => caseRef("wata", 298, "0x3f9", 0, 1), /escrow/);
  assert.throws(() => caseRef("wata", 298, "0x00000000000000000000000000000000000003f9", -1, 1), /agreementId/);
  assert.throws(() => caseRef("wata", 298, "0x00000000000000000000000000000000000003f9", 0, "01"), /periodId/);
});

test("mandateId does not depend on key order and refuses a document that carries its own id", () => {
  const a = { hostId: "wata", quorum: 1, delegates: [{ account: "0.0.1002", kind: "human" }] };
  const b = { delegates: [{ kind: "human", account: "0.0.1002" }], quorum: 1, hostId: "wata" };
  assert.equal(mandateId(a), mandateId(b));
  assert.notEqual(mandateId(a), mandateId({ ...a, quorum: 2 }));
  assert.throws(() => mandateId({ ...a, mandateId: "x" }), /own id/);
  assert.throws(() => mandateId([a]), /object/);
});
