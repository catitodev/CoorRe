// Cross-checks the bridge against the IDL exported from the deployed program,
// so a program change that the bridge does not follow fails CI.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import * as lib from "../lib.mjs";

const idl = JSON.parse(readFileSync(new URL("../../onchain/idl/coorre_anchor.json", import.meta.url), "utf8"));
const instruction = (name) => idl.instructions.find((i) => i.name === name);
const account = (name) => idl.accounts.find((a) => a.name === name);
const fieldSize = (type) =>
  type === "publicKey" ? 32 : type === "u64" || type === "i64" ? 8 : type === "u32" ? 4 : type === "u8" ? 1 : type.array[1];

test("open_case accounts and args follow the IDL order", () => {
  const ix = instruction("openCase");
  assert.deepEqual(ix.accounts.map((a) => [a.name, a.isMut, a.isSigner]), [
    ["caseRecord", true, false],
    ["creator", true, true],
    ["systemProgram", false, false],
  ]);
  const built = lib.openCaseInstruction(PublicKey.default, {
    caseRecord: PublicKey.default,
    creator: PublicKey.default,
    data: Buffer.alloc(0),
  });
  assert.deepEqual(built.keys.map((k) => [k.isWritable, k.isSigner]), ix.accounts.map((a) => [a.isMut, a.isSigner]));
  assert.deepEqual(ix.args.map((a) => a.name), ["caseId", "submitter", "agent", "ruleEngine", "approver", "amount", "autonomyLimit"]);
});

test("anchor_transition accounts and args follow the IDL order", () => {
  const ix = instruction("anchorTransition");
  const built = lib.anchorTransitionInstruction(PublicKey.default, {
    caseRecord: PublicKey.default,
    evidenceAnchor: PublicKey.default,
    actor: PublicKey.default,
    payer: PublicKey.default,
    submitter: PublicKey.default,
    creator: PublicKey.default,
    data: Buffer.alloc(0),
  });
  assert.deepEqual(ix.accounts.map((a) => a.name), ["caseRecord", "evidenceAnchor", "actor", "payer", "submitter", "creator", "systemProgram"]);
  assert.deepEqual(built.keys.map((k) => [k.isWritable, k.isSigner]), ix.accounts.map((a) => [a.isMut, a.isSigner]));
  assert.deepEqual(ix.args.map((a) => [a.name, a.type]), [
    ["evidenceHash", { array: ["u8", 32] }],
    ["prevHash", { array: ["u8", 32] }],
    ["toState", "u8"],
    ["ruleHash", { array: ["u8", 32] }],
  ]);
});

test("CaseRecord layout in the IDL matches the bridge decoder", () => {
  const fields = account("CaseRecord").type.fields;
  assert.deepEqual(fields.map((f) => f.name), [
    "caseId", "creator", "submitter", "agent", "ruleEngine", "approver",
    "amount", "autonomyLimit", "state", "lastEvidenceHash", "transitionCount", "bump",
  ]);
  assert.equal(8 + fields.reduce((n, f) => n + fieldSize(f.type), 0), lib.CASE_RECORD_SIZE);
});

test("program error codes in the IDL match the bridge table", () => {
  assert.deepEqual(idl.errors.map((e) => [e.code, e.name]), lib.PROGRAM_ERRORS.map((name, i) => [6000 + i, name]));
});

test("events in the IDL", () => {
  assert.deepEqual(idl.events.map((e) => e.name), ["CaseOpened", "TransitionAnchored", "FundsReleased", "FundsRefunded"]);
});
