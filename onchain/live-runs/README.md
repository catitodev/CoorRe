# Live devnet runs

Cases run again on devnet after the recorded runs, one folder per date and case. Each
case folder holds the `bundle.json` written by `coorre demo run`, the synthetic
documents its evidence declares, and `accounts.json`: the program accounts of the case
read with `finalized` commitment right after the run, with the transaction statuses.
The recorded runs in [devnet-bundles](../devnet-bundles) and the snapshot in
[docs/evidence/devnet-snapshot](../../docs/evidence/devnet-snapshot) are not changed.

| Date | Case | Path through the program | Record |
|---|---|---|---|
| 2026-11-01 | SUP-002 | escalated after a refused approval above the limit (MandateExceeded), approved by the human approver | [DEPLOYMENTS.md](../DEPLOYMENTS.md) |

Verify against the chain, from the repository root (no keys and no SOL needed):

```bash
offchain/target/release/coorre verify \
  --bundle onchain/live-runs/2026-11-01/SUP-002/bundle.json \
  --artifacts onchain/live-runs/2026-11-01/SUP-002/artifacts
```

Add `--accounts onchain/live-runs/2026-11-01/SUP-002/accounts.json` to verify from the
recorded accounts with no network access, which also works after a devnet reset. The
test `offchain/crates/coorre-cli/tests/live_runs.rs` checks every folder here 7 of 7 from
its own `accounts.json` on every `cargo test`.

The bundles contain public keys, signatures, account addresses and transaction
signatures only. The documents are synthetic.
