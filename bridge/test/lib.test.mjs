import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import * as lib from "../lib.mjs";

const PROGRAM_ID = new PublicKey("FARGzwRUNjGXKMfq5FRwNGr5rZJngJg3nDhvh1rTiFss");
const hex32 = (byte) => Buffer.alloc(32, byte);

test("discriminators match values observed on devnet (spike, 2026-10-08)", () => {
  assert.equal(lib.discriminator("account", "Vault").toString("hex"), "d308e82b02987577");
  assert.equal(lib.discriminator("event", "VaultDeposited").toString("hex"), "3b3e2bc8dc686443");
  assert.equal(lib.discriminator("event", "VaultWithdrawn").toString("hex"), "ee09dbacbc4d4868");
  assert.equal(lib.discriminator("global", "open_vault").toString("hex"), "b5f8e44306af25a7");
  assert.equal(lib.discriminator("global", "withdraw").toString("hex"), "b712469c946da122");
});

test("u64 arguments are little-endian like the spike's on-chain data", () => {
  assert.equal(lib.u64le(20_000_000n).toString("hex"), "002d310100000000");
  assert.equal(lib.u64le(10_000_000n).toString("hex"), "8096980000000000");
  assert.equal(lib.u64le((1n << 64n) - 1n).toString("hex"), "ffffffffffffffff");
});

test("open_case data layout", () => {
  const keys = [1, 2, 3, 4].map((b) => new PublicKey(hex32(b)));
  const data = lib.encodeOpenCase({
    caseId: hex32(9),
    submitter: keys[0],
    agent: keys[1],
    ruleEngine: keys[2],
    approver: keys[3],
    amount: 50_000_000n,
    autonomyLimit: 100_000_000n,
  });
  assert.equal(data.length, 8 + 32 * 5 + 8 + 8);
  assert.deepEqual(data.subarray(0, 8), lib.discriminator("global", "open_case"));
  assert.deepEqual(data.subarray(8, 40), hex32(9));
  assert.deepEqual(data.subarray(40, 72), hex32(1));
  assert.deepEqual(data.subarray(136, 168), hex32(4));
  assert.equal(data.readBigUInt64LE(168), 50_000_000n);
  assert.equal(data.readBigUInt64LE(176), 100_000_000n);
});

test("anchor_transition data layout", () => {
  const data = lib.encodeAnchorTransition({
    evidenceHash: hex32(1),
    prevHash: hex32(2),
    toState: 4,
    ruleHash: hex32(3),
  });
  assert.equal(data.length, 8 + 32 + 32 + 1 + 32);
  assert.deepEqual(data.subarray(0, 8), lib.discriminator("global", "anchor_transition"));
  assert.deepEqual(data.subarray(8, 40), hex32(1));
  assert.deepEqual(data.subarray(40, 72), hex32(2));
  assert.equal(data[72], 4);
  assert.deepEqual(data.subarray(73, 105), hex32(3));
});

test("PDAs depend on creator, case id and evidence hash", () => {
  const a = Keypair.generate().publicKey;
  const b = Keypair.generate().publicKey;
  const caseA = lib.caseRecordAddress(PROGRAM_ID, a, hex32(7));
  assert.ok(caseA.equals(lib.caseRecordAddress(PROGRAM_ID, a, hex32(7))));
  assert.ok(!caseA.equals(lib.caseRecordAddress(PROGRAM_ID, b, hex32(7))), "no squatting");
  assert.ok(!caseA.equals(lib.caseRecordAddress(PROGRAM_ID, a, hex32(8))));
  const expected = PublicKey.findProgramAddressSync(
    [Buffer.from("evidence"), caseA.toBuffer(), hex32(5)],
    PROGRAM_ID
  )[0];
  assert.ok(lib.evidenceAnchorAddress(PROGRAM_ID, caseA, hex32(5)).equals(expected));
});

test("instructions list accounts in the order of the Anchor structs", () => {
  const [caseRecord, creator, evidenceAnchor, actor, payer, submitter] = [1, 2, 3, 4, 5, 6].map(
    (b) => new PublicKey(hex32(b))
  );
  const open = lib.openCaseInstruction(PROGRAM_ID, { caseRecord, creator, data: Buffer.alloc(0) });
  assert.deepEqual(
    open.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    [
      [caseRecord.toBase58(), false, true],
      [creator.toBase58(), true, true],
      [SystemProgram.programId.toBase58(), false, false],
    ]
  );
  const transition = lib.anchorTransitionInstruction(PROGRAM_ID, {
    caseRecord,
    evidenceAnchor,
    actor,
    payer,
    submitter,
    creator,
    data: Buffer.alloc(0),
  });
  assert.deepEqual(
    transition.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    [
      [caseRecord.toBase58(), false, true],
      [evidenceAnchor.toBase58(), false, true],
      [actor.toBase58(), true, false],
      [payer.toBase58(), true, true],
      [submitter.toBase58(), false, true],
      [creator.toBase58(), false, true],
      [SystemProgram.programId.toBase58(), false, false],
    ]
  );
});

test("decodeCaseRecord reads the CaseRecord layout and rejects other accounts", () => {
  const keys = [1, 2, 3, 4, 5].map((b) => hex32(b));
  const data = Buffer.concat([
    lib.discriminator("account", "CaseRecord"),
    hex32(9),
    ...keys,
    lib.u64le(3_000_000n),
    lib.u64le(2_000_000n),
    Buffer.from([4]),
    hex32(8),
    Buffer.from([3, 0, 0, 0]),
    Buffer.from([254]),
  ]);
  assert.equal(data.length, lib.CASE_RECORD_SIZE);
  const record = lib.decodeCaseRecord(data);
  assert.deepEqual(record.caseId, hex32(9));
  assert.ok(record.creator.equals(new PublicKey(hex32(1))));
  assert.ok(record.submitter.equals(new PublicKey(hex32(2))));
  assert.ok(record.approver.equals(new PublicKey(hex32(5))));
  assert.equal(record.amount, 3_000_000n);
  assert.equal(record.autonomyLimit, 2_000_000n);
  assert.equal(record.state, 4);
  assert.deepEqual(record.lastEvidenceHash, hex32(8));
  assert.equal(record.transitionCount, 3);
  assert.equal(record.bump, 254);

  const wrong = Buffer.from(data);
  lib.discriminator("account", "EvidenceAnchor").copy(wrong, 0);
  assert.throws(() => lib.decodeCaseRecord(wrong), { name: "InvalidAccount" });
  assert.throws(() => lib.decodeCaseRecord(data.subarray(0, 100)), { name: "InvalidAccount" });
});

test("parseProgramError reads Anchor logs, custom codes and replays", () => {
  const anchorLog = [
    "Program log: Instruction: AnchorTransition",
    "Program log: AnchorError thrown in programs/coorre_anchor/src/lib.rs:158. Error Code: MandateExceeded. Error Number: 6006. Error Message: Amount exceeds the automated actor's autonomy limit.",
  ];
  assert.deepEqual(lib.parseProgramError(anchorLog), { name: "MandateExceeded", code: 6006 });
  assert.deepEqual(
    lib.parseProgramError([], "Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1775"),
    { name: "RolesNotDistinct", code: 6005 }
  );
  assert.deepEqual(
    lib.parseProgramError(["Allocate: account Address { address: X, base: None } already in use"], "custom program error: 0x0"),
    { name: "AccountAlreadyInUse" }
  );
  assert.equal(lib.parseProgramError(["Program log: ok"], "boom"), null);
  assert.equal(lib.PROGRAM_ERRORS.indexOf("AmountBelowRentExempt") + 6000, 6009);
});

test("input validation is strict", () => {
  assert.equal(lib.parseHex32("ab".repeat(32), "x").length, 32);
  for (const bad of ["AB".repeat(32), "ab".repeat(31), 42, null]) {
    assert.throws(() => lib.parseHex32(bad, "x"), { name: "InvalidInput" });
  }
  assert.equal(lib.parseU64("18446744073709551615", "x"), (1n << 64n) - 1n);
  for (const bad of ["18446744073709551616", "01", "-1", "1.5", "", 5]) {
    assert.throws(() => lib.parseU64(bad, "x"), { name: "InvalidInput" });
  }
  const key = Keypair.generate().publicKey.toBase58();
  assert.equal(lib.parsePubkey(key, "x").toBase58(), key);
  for (const bad of ["not-a-key", "", 7, `${key}x`]) {
    assert.throws(() => lib.parsePubkey(bad, "x"), { name: "InvalidInput" });
  }
  assert.equal(lib.parseStateCode(6, "x"), 6);
  for (const bad of [-1, 256, 1.5, "3"]) {
    assert.throws(() => lib.parseStateCode(bad, "x"), { name: "InvalidInput" });
  }
  assert.equal(lib.parseActorRole("rule_engine", "x"), "rule_engine");
  assert.throws(() => lib.parseActorRole("creator", "x"), { name: "InvalidInput" });
  assert.deepEqual(lib.requireMembers({ a: 1, b: 2 }, ["b", "a"]), { a: 1, b: 2 });
  assert.throws(() => lib.requireMembers({ a: 1 }, ["a", "b"]), { name: "InvalidInput" });
  assert.throws(() => lib.requireMembers({ a: 1, c: 3 }, ["a"]), { name: "InvalidInput" });
  assert.throws(() => lib.requireMembers([], []), { name: "InvalidInput" });
});
