# ADR-002: What the verifier trusts

- Status: accepted
- Date: 2026-10-08

## Context
Spec section 8, check 6, compares account owners with the bundle's `program_id`. A
bundle is produced by the party being audited, so every value inside it is a claim.
If the expected program came from the bundle, anyone could deploy their own program,
write matching accounts with it and present a bundle that names that program.

## Decision
- The verifier takes the expected program id as an input that does not come from the
  bundle. The CLI defaults to the CoorRe devnet deployment
  (`9esN1A8K1SASLg17ob81dbSdB4VX8ozc6tBLmJ247Wv`, see onchain/DEPLOYMENTS.md) and
  accepts `--program-id` to verify another deployment explicitly. Check 6 fails if the
  bundle names a different program or any account is owned by another program.
- Account addresses in the bundle (case record, evidence anchors) are lookup hints
  only. They prove nothing by themselves; owner equality plus content equality with
  the recomputed values does.
- Receipts (transaction signatures) are never used to decide a check; they only feed
  Explorer links in the report.
- The report always shows the creator and the four role keys read from the on-chain
  case record, because the chain proves which keys acted, not who holds them.

## Consequences
Verifying a deployment other than the default requires the auditor to state its
program id deliberately.
