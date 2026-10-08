// Runs inside Solana Playground, where pg, web3, anchor, BN and assert are globals.

describe("coorre_anchor", () => {
  const program = pg.program;
  const wallet = pg.wallet.publicKey;
  const confirmed = { commitment: "confirmed" as const };
  const systemProgram = web3.SystemProgram.programId;
  const parser = new anchor.EventParser(
    program.programId,
    new anchor.BorshCoder(program.idl)
  );

  const OPEN = 0;
  const SUBMITTED = 1;
  const AGENT_REVIEWED = 2;
  const AUTO_APPROVED = 3;
  const ESCALATED = 4;
  const APPROVED = 5;
  const REJECTED = 6;
  const HUMAN = 1;
  const AGENT = 2;
  const SYSTEM = 3;

  const LIMIT = 2_000_000; // autonomy limit: 0.002 SOL
  const WITHIN = 1_000_000; // 0.001 SOL, within the mandate
  const ABOVE = 3_000_000; // 0.003 SOL, above the mandate
  const RULE_HASH = random32();

  type Roles = {
    submitter: web3.Keypair;
    agent: web3.Keypair;
    ruleEngine: web3.Keypair;
    approver: web3.Keypair;
  };
  type Case = {
    roles: Roles;
    caseId: number[];
    caseRecord: web3.PublicKey;
    creator: web3.PublicKey;
    amount: number;
    lastHash: number[];
  };

  function random32(): number[] {
    return Array.from(web3.Keypair.generate().publicKey.toBytes());
  }

  function newRoles(): Roles {
    return {
      submitter: web3.Keypair.generate(),
      agent: web3.Keypair.generate(),
      ruleEngine: web3.Keypair.generate(),
      approver: web3.Keypair.generate(),
    };
  }

  const casePda = (creator: web3.PublicKey, caseId: number[]) =>
    web3.PublicKey.findProgramAddressSync(
      [Buffer.from("case"), creator.toBuffer(), Buffer.from(caseId)],
      program.programId
    )[0];

  const evidencePda = (caseRecord: web3.PublicKey, evidenceHash: number[]) =>
    web3.PublicKey.findProgramAddressSync(
      [Buffer.from("evidence"), caseRecord.toBuffer(), Buffer.from(evidenceHash)],
      program.programId
    )[0];

  const balanceOf = (key: web3.PublicKey) =>
    pg.connection.getBalance(key, "confirmed");

  async function rentFor(key: web3.PublicKey): Promise<number> {
    const info = await pg.connection.getAccountInfo(key, "confirmed");
    if (!info) throw new Error(`account ${key.toBase58()} not found`);
    return pg.connection.getMinimumBalanceForRentExemption(info.data.length);
  }

  async function eventData(signature: string, name: string): Promise<any> {
    const tx = await pg.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const events = Array.from(parser.parseLogs(tx?.meta?.logMessages ?? []));
    const event: any = events.find((e: any) => e.name === name);
    if (!event) throw new Error(`event ${name} not found in ${signature}`);
    return event.data;
  }

  async function errorOf(action: () => Promise<unknown>): Promise<string> {
    try {
      await action();
    } catch (err: any) {
      const code = err?.error?.errorCode?.code ?? "";
      const logs = Array.isArray(err?.logs) ? err.logs.join("\n") : "";
      return `${code} ${String(err)}\n${logs}`;
    }
    return "";
  }

  async function expectError(action: () => Promise<unknown>, name: string) {
    const error = await errorOf(action);
    assert.ok(error.includes(name), `expected ${name}, got: ${error || "success"}`);
  }

  async function fundedKeypair(lamports: number): Promise<web3.Keypair> {
    const keypair = web3.Keypair.generate();
    const tx = new web3.Transaction().add(
      web3.SystemProgram.transfer({
        fromPubkey: wallet,
        toPubkey: keypair.publicKey,
        lamports,
      })
    );
    await (program.provider as any).sendAndConfirm(tx, [], confirmed);
    return keypair;
  }

  function sendOpenCase(
    caseId: number[],
    keys: web3.PublicKey[],
    amount: number,
    creator?: web3.Keypair
  ) {
    const creatorKey = creator ? creator.publicKey : wallet;
    const builder = program.methods
      .openCase(caseId, keys[0], keys[1], keys[2], keys[3], new BN(amount), new BN(LIMIT))
      .accounts({ caseRecord: casePda(creatorKey, caseId), creator: creatorKey, systemProgram });
    return (creator ? builder.signers([creator]) : builder).rpc(confirmed);
  }

  async function openCase(amount: number, creator?: web3.Keypair, caseId = random32()): Promise<Case> {
    const roles = newRoles();
    const keys = [roles.submitter, roles.agent, roles.ruleEngine, roles.approver].map((k) => k.publicKey);
    await sendOpenCase(caseId, keys, amount, creator);
    const creatorKey = creator ? creator.publicKey : wallet;
    return { roles, caseId, caseRecord: casePda(creatorKey, caseId), creator: creatorKey, amount, lastHash: caseId };
  }

  async function transition(
    c: Case,
    toState: number,
    signer: web3.Keypair,
    options: { prevHash?: number[]; evidenceHash?: number[]; submitter?: web3.PublicKey; creator?: web3.PublicKey } = {}
  ) {
    const evidenceHash = options.evidenceHash ?? random32();
    const evidenceAnchor = evidencePda(c.caseRecord, evidenceHash);
    const signature = await program.methods
      .anchorTransition(evidenceHash, options.prevHash ?? c.lastHash, toState, RULE_HASH)
      .accounts({
        caseRecord: c.caseRecord,
        evidenceAnchor,
        actor: signer.publicKey,
        payer: wallet,
        submitter: options.submitter ?? c.roles.submitter.publicKey,
        creator: options.creator ?? c.creator,
        systemProgram,
      })
      .signers([signer])
      .rpc(confirmed);
    c.lastHash = evidenceHash;
    return { signature, evidenceHash, evidenceAnchor };
  }

  async function stateOf(c: Case): Promise<number> {
    return (await program.account.caseRecord.fetch(c.caseRecord)).state;
  }

  it("opens a case and escrows exactly the amount", async () => {
    const roles = newRoles();
    const caseId = random32();
    const keys = [roles.submitter, roles.agent, roles.ruleEngine, roles.approver].map((k) => k.publicKey);
    const signature = await sendOpenCase(caseId, keys, WITHIN);
    const caseRecord = casePda(wallet, caseId);

    assert.equal(await balanceOf(caseRecord), (await rentFor(caseRecord)) + WITHIN);
    const record = await program.account.caseRecord.fetch(caseRecord);
    assert.deepEqual(Array.from(record.caseId), caseId);
    assert.ok(record.creator.equals(wallet));
    assert.ok(record.submitter.equals(keys[0]));
    assert.ok(record.agent.equals(keys[1]));
    assert.ok(record.ruleEngine.equals(keys[2]));
    assert.ok(record.approver.equals(keys[3]));
    assert.equal(record.amount.toNumber(), WITHIN);
    assert.equal(record.autonomyLimit.toNumber(), LIMIT);
    assert.equal(record.state, OPEN);
    assert.equal(record.transitionCount, 0);

    const opened = await eventData(signature, "CaseOpened");
    assert.deepEqual(Array.from(opened.caseId), caseId);
    assert.equal(opened.amount.toNumber(), WITHIN);
    assert.equal(opened.autonomyLimit.toNumber(), LIMIT);
  });

  it("within the mandate: AUTO_APPROVED releases exactly the amount to the submitter", async () => {
    const c = await openCase(WITHIN);
    const submitted = await transition(c, SUBMITTED, c.roles.submitter);
    const reviewed = await transition(c, AGENT_REVIEWED, c.roles.agent);
    const escrowBefore = await balanceOf(c.caseRecord);
    const approved = await transition(c, AUTO_APPROVED, c.roles.ruleEngine);

    assert.equal(await balanceOf(c.roles.submitter.publicKey), WITHIN, "payee got exactly amount");
    assert.equal(escrowBefore - (await balanceOf(c.caseRecord)), WITHIN, "escrow paid exactly amount");
    assert.equal(await balanceOf(c.caseRecord), await rentFor(c.caseRecord), "escrow back to rent minimum");

    const record = await program.account.caseRecord.fetch(c.caseRecord);
    assert.equal(record.state, AUTO_APPROVED);
    assert.equal(record.transitionCount, 3);
    assert.deepEqual(Array.from(record.lastEvidenceHash), approved.evidenceHash);

    const expected = [
      { step: submitted, prev: c.caseId, from: OPEN, to: SUBMITTED, actor: c.roles.submitter, kind: HUMAN },
      { step: reviewed, prev: submitted.evidenceHash, from: SUBMITTED, to: AGENT_REVIEWED, actor: c.roles.agent, kind: AGENT },
      { step: approved, prev: reviewed.evidenceHash, from: AGENT_REVIEWED, to: AUTO_APPROVED, actor: c.roles.ruleEngine, kind: SYSTEM },
    ];
    for (const e of expected) {
      const a = await program.account.evidenceAnchor.fetch(e.step.evidenceAnchor);
      assert.deepEqual(Array.from(a.evidenceHash), e.step.evidenceHash);
      assert.ok(a.caseRecord.equals(c.caseRecord));
      assert.deepEqual(Array.from(a.prevHash), e.prev);
      assert.equal(a.fromState, e.from);
      assert.equal(a.toState, e.to);
      assert.ok(a.actor.equals(e.actor.publicKey));
      assert.equal(a.actorKind, e.kind);
      assert.deepEqual(Array.from(a.ruleHash), RULE_HASH);
      assert.ok(a.slot.toNumber() > 0);
      assert.ok(a.unixTs.toNumber() > 0);
    }

    const released = await eventData(approved.signature, "FundsReleased");
    assert.ok(released.to.equals(c.roles.submitter.publicKey));
    assert.equal(released.amount.toNumber(), WITHIN);
    const anchored = await eventData(approved.signature, "TransitionAnchored");
    assert.equal(anchored.actorKind, SYSTEM);
    assert.equal(anchored.toState, AUTO_APPROVED);
  });

  it("above the mandate: AUTO_APPROVED fails with MandateExceeded; approver releases after ESCALATED", async () => {
    const c = await openCase(ABOVE);
    await transition(c, SUBMITTED, c.roles.submitter);
    await transition(c, AGENT_REVIEWED, c.roles.agent);

    await expectError(() => transition(c, AUTO_APPROVED, c.roles.ruleEngine), "MandateExceeded");
    assert.equal(await stateOf(c), AGENT_REVIEWED, "state unchanged after the rejected attempt");
    assert.equal(await balanceOf(c.roles.submitter.publicKey), 0, "nothing paid");

    await transition(c, ESCALATED, c.roles.ruleEngine);
    await expectError(() => transition(c, APPROVED, c.roles.ruleEngine), "UnauthorizedActor");
    const escrowBefore = await balanceOf(c.caseRecord);
    const approved = await transition(c, APPROVED, c.roles.approver);

    assert.equal(await balanceOf(c.roles.submitter.publicKey), ABOVE);
    assert.equal(escrowBefore - (await balanceOf(c.caseRecord)), ABOVE);
    assert.equal(await stateOf(c), APPROVED);
    const a = await program.account.evidenceAnchor.fetch(approved.evidenceAnchor);
    assert.equal(a.actorKind, HUMAN);
  });

  it("REJECTED refunds exactly the amount to the creator", async () => {
    const creator = await fundedKeypair(10_000_000);
    const c = await openCase(ABOVE, creator);
    await transition(c, SUBMITTED, c.roles.submitter);
    await transition(c, AGENT_REVIEWED, c.roles.agent);
    await transition(c, ESCALATED, c.roles.ruleEngine);

    const creatorBefore = await balanceOf(creator.publicKey);
    const escrowBefore = await balanceOf(c.caseRecord);
    const rejected = await transition(c, REJECTED, c.roles.approver);

    assert.equal((await balanceOf(creator.publicKey)) - creatorBefore, ABOVE, "creator refunded exactly amount");
    assert.equal(escrowBefore - (await balanceOf(c.caseRecord)), ABOVE);
    assert.equal(await balanceOf(c.roles.submitter.publicKey), 0, "payee got nothing");
    const refunded = await eventData(rejected.signature, "FundsRefunded");
    assert.ok(refunded.to.equals(creator.publicKey));
    assert.equal(refunded.amount.toNumber(), ABOVE);

    await expectError(() => transition(c, APPROVED, c.roles.approver), "CaseClosed");
  });

  it("rejects repeated role keys with RolesNotDistinct", async () => {
    const [a, b, d, e] = [0, 1, 2, 3].map(() => web3.Keypair.generate().publicKey);
    const layouts = [
      [a, b, d, a],
      [a, b, b, e],
      [a, a, d, e],
      [a, b, d, d],
    ];
    for (const keys of layouts) {
      await expectError(() => sendOpenCase(random32(), keys, WITHIN), "RolesNotDistinct");
    }
  });

  it("rejects an amount below the payee rent-exempt minimum", async () => {
    const minimum = await pg.connection.getMinimumBalanceForRentExemption(0);
    const keys = [0, 1, 2, 3].map(() => web3.Keypair.generate().publicKey);
    await expectError(() => sendOpenCase(random32(), keys, minimum - 1), "AmountBelowRentExempt");
    await sendOpenCase(random32(), keys, minimum);
  });

  it("rejects signers that do not hold the required role", async () => {
    const c = await openCase(WITHIN);
    const outsider = web3.Keypair.generate();
    await expectError(() => transition(c, SUBMITTED, c.roles.agent), "UnauthorizedActor");
    await expectError(() => transition(c, SUBMITTED, outsider), "UnauthorizedActor");
    await transition(c, SUBMITTED, c.roles.submitter);
    await expectError(() => transition(c, AGENT_REVIEWED, c.roles.submitter), "UnauthorizedActor");
    await transition(c, AGENT_REVIEWED, c.roles.agent);
    await expectError(() => transition(c, AUTO_APPROVED, c.roles.agent), "UnauthorizedActor");
    await expectError(() => transition(c, ESCALATED, c.roles.approver), "UnauthorizedActor");
    await transition(c, ESCALATED, c.roles.ruleEngine);
    await expectError(() => transition(c, REJECTED, c.roles.agent), "UnauthorizedActor");
    await expectError(() => transition(c, APPROVED, c.roles.submitter), "UnauthorizedActor");
  });

  describe("every transition outside the table fails with InvalidTransition", () => {
    const forbidden: Record<number, number[]> = {
      [OPEN]: [OPEN, AGENT_REVIEWED, AUTO_APPROVED, ESCALATED, APPROVED, REJECTED],
      [SUBMITTED]: [OPEN, SUBMITTED, AUTO_APPROVED, ESCALATED, APPROVED, REJECTED],
      [AGENT_REVIEWED]: [OPEN, SUBMITTED, AGENT_REVIEWED, APPROVED, REJECTED],
      [ESCALATED]: [OPEN, SUBMITTED, AGENT_REVIEWED, AUTO_APPROVED, ESCALATED],
    };
    let c: Case;
    const advance: [number, (c: Case) => web3.Keypair][] = [
      [SUBMITTED, (c) => c.roles.submitter],
      [AGENT_REVIEWED, (c) => c.roles.agent],
      [ESCALATED, (c) => c.roles.ruleEngine],
    ];

    it("from OPEN", async () => {
      c = await openCase(WITHIN);
      for (const to of forbidden[OPEN]) {
        await expectError(() => transition(c, to, c.roles.submitter), "InvalidTransition");
      }
    });

    for (const [i, from] of [SUBMITTED, AGENT_REVIEWED, ESCALATED].entries()) {
      it(`from state ${from}`, async () => {
        const [to, signer] = advance[i];
        await transition(c, to, signer(c));
        assert.equal(await stateOf(c), from);
        for (const target of forbidden[from]) {
          await expectError(() => transition(c, target, c.roles.approver), "InvalidTransition");
        }
      });
    }

    it("unknown state codes fail with InvalidState", async () => {
      for (const code of [7, 42, 255]) {
        await expectError(() => transition(c, code, c.roles.approver), "InvalidState");
      }
    });
  });

  it("rejects a wrong prev_hash with PrevHashMismatch", async () => {
    const c = await openCase(WITHIN);
    await expectError(
      () => transition(c, SUBMITTED, c.roles.submitter, { prevHash: random32() }),
      "PrevHashMismatch"
    );
    await transition(c, SUBMITTED, c.roles.submitter);
    await expectError(
      () => transition(c, AGENT_REVIEWED, c.roles.agent, { prevHash: c.caseId }),
      "PrevHashMismatch"
    );
  });

  it("rejects a replayed evidence hash", async () => {
    const c = await openCase(WITHIN);
    const first = await transition(c, SUBMITTED, c.roles.submitter);
    const error = await errorOf(() =>
      transition(c, AGENT_REVIEWED, c.roles.agent, { evidenceHash: first.evidenceHash, prevHash: first.evidenceHash })
    );
    assert.ok(error.includes("already in use"), `got: ${error || "success"}`);
    assert.equal(await stateOf(c), SUBMITTED);
  });

  it("rejects payee or refund accounts that differ from the stored keys", async () => {
    const c = await openCase(WITHIN);
    const stranger = web3.Keypair.generate().publicKey;
    await expectError(
      () => transition(c, SUBMITTED, c.roles.submitter, { submitter: stranger }),
      "ConstraintAddress"
    );
    await expectError(
      () => transition(c, SUBMITTED, c.roles.submitter, { creator: stranger }),
      "ConstraintAddress"
    );
  });

  it("two creators with the same case_id get different case records", async () => {
    const otherCreator = await fundedKeypair(10_000_000);
    const caseId = random32();
    const mine = await openCase(WITHIN, undefined, caseId);
    const theirs = await openCase(WITHIN, otherCreator, caseId);
    assert.ok(!mine.caseRecord.equals(theirs.caseRecord));
    const a = await program.account.caseRecord.fetch(mine.caseRecord);
    const b = await program.account.caseRecord.fetch(theirs.caseRecord);
    assert.ok(a.creator.equals(wallet));
    assert.ok(b.creator.equals(otherCreator.publicKey));
    assert.deepEqual(Array.from(a.caseId), Array.from(b.caseId));
  });
});
