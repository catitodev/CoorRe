# CoorRe bridge

The only component that sends Solana transactions. The Rust core calls it through
the `Anchorer` trait, spawning it without a shell and passing inputs via files.

```
node bridge/anchor.mjs <open-case|anchor-transition|fetch-account> --input <file.json>
```

Prints exactly one JSON object to stdout. On failure it prints `{"error": {...}}`,
with the program error name (for example `MandateExceeded`) when available, and
exits with status 1.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `COORRE_PROGRAM_ID` | (required) | `coorre_anchor` program id on devnet |
| `COORRE_RPC_URL` | `https://api.devnet.solana.com` | |
| `COORRE_RPC_FALLBACK_URL` | (none) | used when the first RPC is unreachable |
| `COORRE_KEYS_DIR` | `.local/keys` | `creator.json`, `submitter.json`, `agent.json`, `rule_engine.json`, `approver.json` (Solana keypair format, mode 600) |

The bridge refuses to send anything unless the RPC reports the devnet genesis hash
(`EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`). Commitment is `confirmed`; an
expired blockhash is retried once with a fresh one after checking that the first
attempt did not land.

## Inputs

`open-case` (signed and paid by `creator`):

```json
{
  "case_id": "<64 lowercase hex>",
  "submitter": "<base58>", "agent": "<base58>", "rule_engine": "<base58>", "approver": "<base58>",
  "amount_lamports": "50000000",
  "autonomy_limit_lamports": "100000000"
}
```

`anchor-transition` (signed by the role key in `actor_role`, paid by `creator`;
submitter and creator accounts are read from the on-chain case record):

```json
{
  "case_record": "<base58>",
  "evidence_hash": "<64 hex>", "prev_hash": "<64 hex>", "rule_hash": "<64 hex>",
  "to_state": 4,
  "actor_role": "rule_engine"
}
```

`fetch-account`: `{ "address": "<base58>" }` returns owner, lamports, executable flag,
raw data as lowercase hex (`data_hex`) and the context slot.

Receipts: `{ "network_id": "solana:devnet", "program_id", "account", "tx_signature" }`.
Receipts are hints only; the verifier never trusts them.

## Development

```
npm ci        # install scripts are disabled by .npmrc
npm test      # offline: encodings, PDAs, input validation, network guard, key files
```
