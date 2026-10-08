# Deployments

Devnet only. Every entry was checked against the chain through JSON-RPC
(`getAccountInfo`, `getTransaction`) at https://api.devnet.solana.com.

## Spike: `playground_spike` (2026-10-08)

Throwaway program used to validate the escrow pattern before writing
`coorre_anchor`: a PDA funded by system transfer right after `init`, paid out by
direct lamport edits without dropping below rent exemption. It is not part of the
CoorRe product.

| Field | Value |
|---|---|
| Network | Solana devnet |
| Program ID | [`FARGzwRUNjGXKMfq5FRwNGr5rZJngJg3nDhvh1rTiFss`](https://explorer.solana.com/address/FARGzwRUNjGXKMfq5FRwNGr5rZJngJg3nDhvh1rTiFss?cluster=devnet) |
| ProgramData account | `2b5qajpCaSmac2VWb84xxN2NQEqGkq3Eed7JFsWdYY1B` (237,341 bytes) |
| Upgrade authority | `7yAwBDhFs8TdMurdwJsq4AB41tX2H9PULpxeAnf87zyZ` (Solana Playground wallet; keypair backed up in `.local/`, gitignored) |
| Deploy transaction | [`5P4dr8UAHhY9jz3GLweCekpgkdWs1cQG22naYkqG3Mr72KvxsgvHU2f3jDF2YyGbaT3GScpPf3SSwdAo7jkYyTKv`](https://explorer.solana.com/tx/5P4dr8UAHhY9jz3GLweCekpgkdWs1cQG22naYkqG3Mr72KvxsgvHU2f3jDF2YyGbaT3GScpPf3SSwdAo7jkYyTKv?cluster=devnet) — `deployWithMaxDataLen`, slot 508871411, 2026-10-08 16:05:53 UTC |
| Toolchain | Solana Playground (beta.solpg.io), default `legacy` template: anchor-lang 0.29.0 |
| Source | `spike/playground_spike.rs` (unchanged since commit `a3c3ee4`) |
| IDL | `spike/idl/playground_spike.json` (pre-0.30 IDL format, consistent with Anchor 0.29) |
| Program keypair | backed up in `.local/` (gitignored); public half matches the Program ID |

### Test run (Playground, 2026-10-08 16:15 UTC): 6 passing

| Step | Transaction | Verified on chain |
|---|---|---|
| `open_vault` (0.02 SOL) | [`5o6bo1yo…cigqwrA`](https://explorer.solana.com/tx/5o6bo1yo4jXufU4Ax8yFgbfGwVvb5an62SCeTE29NW8PAVYQWqYCLoR8TpXbFbw61F47ovsExii2mVhVwcigqwrA?cluster=devnet) | vault `23gofPxYzvNoQU6giLN1GVKg6Bvcj6LxJwHTf5PWNJwz` +20,858,520 lamports (858,520 rent-exempt minimum for 41 bytes + 20,000,000); 13,624 CU; `VaultDeposited` emitted |
| `withdraw` (0.01 SOL) | [`TuSSx2sU…TP9VdmXg`](https://explorer.solana.com/tx/TuSSx2sUVhbJvJT2KHXbm1aUBxzKHUVeyienbk2gwcALKNjtWHBwUN8B1ePC2fhBHgiNDCET3THu2woTP9VdmXg?cluster=devnet) | vault −10,000,000; new recipient +10,000,000; fee paid only by the wallet; 5,200 CU; `VaultWithdrawn` emitted |

Failure cases also passed: withdrawal below the vault's rent-exempt minimum
(`InsufficientVaultFunds`), withdrawal of 1,000 lamports to a new account (rejected
by the runtime rent rule), wrong signer (seeds/has_one constraint) and zero amount
(`ZeroAmount`).

### Findings carried into `coorre_anchor`
- Anchor 0.29.0 confirmed as the Playground default; keep the 0.29 target.
- Devnet rent-exempt minimum on this date: 650,240 lamports for 0 data bytes and
  858,520 for 41 bytes (5,080 lamports per byte including the 128-byte overhead).
  Always read rent from the `Rent` sysvar or RPC; never hard-code it.
- A payout to an account that ends below its rent-exempt minimum fails the whole
  transaction, so release/refund amounts must leave the payee rent-exempt.
- Playground rejects test code containing `window`, `globalThis`, `document`,
  `location`, `top` or `chrome` anywhere, even inside other words.
