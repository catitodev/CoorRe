// Runs inside Solana Playground, where pg, web3, anchor, BN and assert are globals.

describe("playground_spike", () => {
  const authority = pg.wallet.publicKey;
  const [vault] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), authority.toBuffer()],
    pg.program.programId
  );
  const confirmed = { commitment: "confirmed" as const };
  const parser = new anchor.EventParser(
    pg.program.programId,
    new anchor.BorshCoder(pg.program.idl)
  );

  const DEPOSIT = 20_000_000; // 0.02 SOL
  const WITHDRAW = 10_000_000; // 0.01 SOL

  const balanceOf = (key: web3.PublicKey) =>
    pg.connection.getBalance(key, "confirmed");

  async function accountOf(key: web3.PublicKey) {
    const info = await pg.connection.getAccountInfo(key, "confirmed");
    if (!info) throw new Error(`account ${key.toBase58()} not found`);
    return info;
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
      const code = err?.error?.errorCode?.code;
      return code ? `${code} ${String(err)}` : String(err);
    }
    return "";
  }

  const withdraw = (amount: number, recipient: web3.PublicKey) =>
    pg.program.methods
      .withdraw(new BN(amount))
      .accounts({ vault, authority, recipient })
      .rpc(confirmed);

  it("opens (or tops up) the vault through a system transfer", async () => {
    const existing = await pg.connection.getAccountInfo(vault, "confirmed");
    const accounts = {
      vault,
      authority,
      systemProgram: web3.SystemProgram.programId,
    };

    const signature = existing
      ? await pg.program.methods
          .deposit(new BN(DEPOSIT))
          .accounts(accounts)
          .rpc(confirmed)
      : await pg.program.methods
          .openVault(new BN(DEPOSIT))
          .accounts(accounts)
          .rpc(confirmed);

    const info = await accountOf(vault);
    assert.ok(info.owner.equals(pg.program.programId), "vault owner");
    if (existing) {
      assert.equal(info.lamports - existing.lamports, DEPOSIT);
    } else {
      const rentMinimum =
        await pg.connection.getMinimumBalanceForRentExemption(info.data.length);
      assert.equal(info.lamports, rentMinimum + DEPOSIT);
    }

    const data = await eventData(signature, "VaultDeposited");
    assert.equal(data.amount.toString(), DEPOSIT.toString());
    assert.equal(data.balance.toString(), info.lamports.toString());
    console.log("vault:", vault.toBase58(), "balance:", info.lamports);
    console.log("deposit tx:", signature);
  });

  it("moves exactly `amount` out of the PDA to a new account", async () => {
    const recipient = web3.Keypair.generate().publicKey;
    const vaultBefore = await balanceOf(vault);

    const signature = await withdraw(WITHDRAW, recipient);

    const vaultAfter = await balanceOf(vault);
    assert.equal(vaultBefore - vaultAfter, WITHDRAW, "vault debited by amount");
    assert.equal(await balanceOf(recipient), WITHDRAW, "recipient got amount");

    const data = await eventData(signature, "VaultWithdrawn");
    assert.ok(data.to.equals(recipient), "event recipient");
    assert.equal(data.amount.toString(), WITHDRAW.toString());
    assert.equal(data.remaining.toString(), vaultAfter.toString());
    console.log("withdraw tx:", signature);
  });

  it("refuses to go below the vault's rent-exempt minimum", async () => {
    const info = await accountOf(vault);
    const rentMinimum = await pg.connection.getMinimumBalanceForRentExemption(
      info.data.length
    );
    const tooMuch = info.lamports - rentMinimum + 1;

    const error = await errorOf(() =>
      withdraw(tooMuch, web3.Keypair.generate().publicKey)
    );
    assert.ok(
      error.includes("InsufficientVaultFunds") || error.includes("0x1771"),
      `expected InsufficientVaultFunds, got: ${error}`
    );
    assert.equal(await balanceOf(vault), info.lamports, "vault unchanged");
  });

  it("documents the runtime rule: a new recipient must end rent-exempt", async () => {
    const before = await balanceOf(vault);
    const error = await errorOf(() =>
      withdraw(1_000, web3.Keypair.generate().publicKey)
    );
    assert.ok(error.toLowerCase().includes("rent"), `got: ${error}`);
    assert.equal(await balanceOf(vault), before, "vault unchanged");
  });

  it("rejects a signer that does not own the vault", async () => {
    const intruder = web3.Keypair.generate();
    const error = await errorOf(() =>
      pg.program.methods
        .withdraw(new BN(1_000_000))
        .accounts({
          vault,
          authority: intruder.publicKey,
          recipient: intruder.publicKey,
        })
        .signers([intruder])
        .rpc(confirmed)
    );
    assert.ok(
      error.includes("ConstraintSeeds") || error.includes("ConstraintHasOne"),
      `expected a seeds/has_one violation, got: ${error}`
    );
  });

  it("rejects a zero amount", async () => {
    const error = await errorOf(() =>
      withdraw(0, web3.Keypair.generate().publicKey)
    );
    assert.ok(
      error.includes("ZeroAmount") || error.includes("0x1770"),
      `expected ZeroAmount, got: ${error}`
    );
  });
});
