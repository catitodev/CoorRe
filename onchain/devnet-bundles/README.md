# Devnet audit bundles

Audit bundles and their synthetic documents from devnet runs, kept so that anyone can
verify the cases again against the chain. Each folder holds the `bundle.json` written
by `coorre demo run` and the documents its evidence declares, unchanged.

| Run | Cases | Transactions |
|---|---|---|
| 2026-10-10 02:12 UTC | AGT-001, PES-001, MIL-001, MIL-002, SRV-001, SRV-002 | [DEPLOYMENTS.md](../DEPLOYMENTS.md) |

AGT-002 and PES-002 from the same run, and SUP-001 and SUP-002 from 2026-10-08, are in
[web/verifier/samples](../../web/verifier/samples).

Verify one of them from the repository root (no keys and no SOL needed):

```bash
offchain/target/release/coorre verify \
  --bundle onchain/devnet-bundles/2026-10-10/MIL-002/bundle.json \
  --artifacts onchain/devnet-bundles/2026-10-10/MIL-002/artifacts
```

The bundles contain public keys, signatures, account addresses and transaction
signatures only. The documents are synthetic.
