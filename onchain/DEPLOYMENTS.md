# Deployments

Devnet only. Every entry was checked against the chain through JSON-RPC
(`getAccountInfo`, `getTransaction`) at https://api.devnet.solana.com.

## `coorre_anchor` v0.1.0 (2026-10-08)

| Field | Value |
|---|---|
| Network | Solana devnet |
| Program ID | [`9esN1A8K1SASLg17ob81dbSdB4VX8ozc6tBLmJ247Wv`](https://explorer.solana.com/address/9esN1A8K1SASLg17ob81dbSdB4VX8ozc6tBLmJ247Wv?cluster=devnet) |
| ProgramData account | `FHJ9rgj9U8R77s7QPfngAK543EonGpznTA7cirnxFN3S` (261,301 bytes) |
| Upgrade authority | `7yAwBDhFs8TdMurdwJsq4AB41tX2H9PULpxeAnf87zyZ` (Solana Playground wallet; keypair backed up in `.local/`, gitignored) |
| Deploy transaction | [`2ku5UxeTyM1qrVcKhB3s68pDVh2cZyyTpFXuhF8orWjzvswoCguiN5AjoLAAvbxLbG6yRBDHvxgAFYKzcsq7JJxY`](https://explorer.solana.com/tx/2ku5UxeTyM1qrVcKhB3s68pDVh2cZyyTpFXuhF8orWjzvswoCguiN5AjoLAAvbxLbG6yRBDHvxgAFYKzcsq7JJxY?cluster=devnet) — `deployWithMaxDataLen` (max data len 261,256), slot 508896714, 2026-10-08 17:46:34 UTC |
| Toolchain | Solana Playground, default `legacy` template (anchor-lang 0.29.0, Rust 1.68.0, Solana 1.17.25) |
| Source | `onchain/programs/coorre_anchor/src/lib.rs` as of commit `dd057f8` (later commits only set `declare_id!` to this id and removed source comments; no code change) |
| IDL | `onchain/idl/coorre_anchor.json` (pre-0.30 format) |
| Program keypair | backed up in `.local/` (gitignored); public half matches the Program ID |

Deploy note: the Playground deploy hit public RPC rate limits and retried for 6m40s
before succeeding.

Test run (Playground, `onchain/tests/coorre_anchor.test.ts`): **17 passing**, covering
every case in spec section 10 (forbidden transitions from each state, InvalidState,
wrong role signer, PrevHashMismatch, RolesNotDistinct, AmountBelowRentExempt,
MandateExceeded, exact release and refund amounts, replayed evidence, wrong payee or
refund account, two creators with the same case_id). The program account shows 33
successful transactions after the run, none failed (rejected attempts fail in
simulation and are never sent).

### Bridge smoke test on devnet (2026-10-08)

First case sent through `bridge/anchor.mjs` with the demo keys in `.local/keys`
(creator `HX4cZ2jyJxJ4iFV2CjjzdLVzNM1wQ1KvBm2MiXYdowGr`). Evidence hashes are
`SHA-256("bridge-smoke:<case_ref>:<step>")`: this checks the transport, not real
evidence.

| Step | Account | Transaction |
|---|---|---|
| open_case `urn:coorre:case:BRIDGE-SMOKE-20261008`, 1,000,000 lamports, limit 2,000,000 | CaseRecord `A3GQ8hYbUfmnsbk4zsZUtgCi3XpUMeEkcFtXKBiZJZWU` | `5tr8X9MG2QfdyQoKLrfZD5aj8KXZcEw4CCqCkqNcDGkKT7skeWooJnrR8b923Ey2w9Lo5XAkmecHQ42mb9KSsbab` |
| SUBMITTED (submitter) | `3WMyjabKbxNVjKRx93d8E4ugsxGBgspqNssmCtexkM9i` | `21GD5yD1zSyjVA6BixqcN28x19h23NPQCewgF29HATuL1NXKV6N3bcp16CzcaqETdURhqPgca8oJCvR7qZTqYHtV` |
| AGENT_REVIEWED (agent) | `AzAuDcj5jxR1da6f5ExawnK934BTzib2rcz3jNUGaT6D` | `4iLkMxSSUBMTHhVP3H4FhLWA7Ta8f4xojKYFa9PQFQ6MG7kPybr6qhDG7AcbQpa76LzWkzWYgbZGeM8ZQ6R4JR5i` |
| AUTO_APPROVED signed by the agent key | rejected in simulation: `UnauthorizedActor` (6002), reported by name | none |
| AUTO_APPROVED (rule_engine) | `68XTGwxSBcy9ZzFieHebbXQzC348NYHu9A6N44eyGTD3` | `56empsZMHiy4psYU5xTUohbkP4ryr7xcAmzQvj4QTquj5QtRYZwSnDDahth9z7ubMWNZd9YBEbsuPEDUjL3MqUVi` |

Verified independently of the bridge code (raw `getAccountInfo`/`getProgramAccounts`
decoded separately): CaseRecord state 3, 3 transitions, last hash = AUTO_APPROVED
evidence, lamports back to its rent-exempt minimum (1,940,560); submitter balance
exactly 1,000,000; each EvidenceAnchor holds the expected hash, case record,
prev_hash, from/to states, actor kind (1, 2, 3) and rule hash.

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
