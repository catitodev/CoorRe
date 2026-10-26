# CoorRe applications

CoorRe is one verifiability engine. It turns the evidence and decisions of a process into signed, anchored proof, and ships a verifier anyone can run. Every application of CoorRe combines three things, and only one of them changes at a time:

1. **Domain**: the rule that decides a case.
2. **Anchor**: where the proof of each decision is recorded.
3. **Host**: an external system that hands CoorRe the decision it has to make, under the host's own rules.

The engine is the same in every combination: `coorre-model` (evidence, canonical JSON, hashes, signatures), `coorre-engine` (rules, roles, state machine, `MandateExceeded`), `coorre-anchor` (the `Anchorer` interface) and `coorre-verify` (the verifier, native and WebAssembly), all in [offchain/crates](../offchain/crates).

## Domains

All five run on the same engine and the same anchor; only the rule changes ([ADR-005](decisions/ADR-005-rule-registry-and-application-domains.md)).

| Rule | Cases | Status |
|---|---|---|
| supplier-docs v1 | SUP-001, SUP-002 (SUP-003 in tests only) | Runs on Solana devnet |
| agent-purchase v1 | AGT-001, AGT-002 | Runs on Solana devnet |
| ecosystem-services-payment v1 | PES-001, PES-002 | Runs on Solana devnet |
| milestone-payment v1 | MIL-001, MIL-002 | Runs on Solana devnet |
| service-delivery v1 | SRV-001, SRV-002 | Runs on Solana devnet |

## Anchors

| Anchor | Where it lives | Status |
|---|---|---|
| CoorRe on Solana | [onchain/](../onchain) (Anchor program) and [bridge/](../bridge) (the only component that sends Solana transactions) | Runs on devnet; recorded accounts in [docs/evidence/devnet-snapshot](evidence/devnet-snapshot) |
| CoorRe on Hedera | [hedera/](../hedera) | In development: the mandate contract, the decision adapter and the network probes run on a local Solo network in CI, against a reference host escrow ([docs/hedera/SPEC.md](hedera/SPEC.md), [PHASE0.md](hedera/PHASE0.md)). Verifier support and testnet are next steps |
| Web2 witness log | [docs/design/WEB2_MODE.md](design/WEB2_MODE.md) | Design only |
| Zcash memo | [docs/design/ZCASH_READINESS.md](design/ZCASH_READINESS.md) | Roadmap; the memo is prepared and checked offline |

The verifier reads one anchor source today, Solana accounts. Reading a second source (Hedera, then the Web2 witness log) without changing how the Solana cases verify is a next step for the shared core; the recorded devnet bundles are the reference that must keep verifying 7 of 7.

## Hosts

A host keeps its own business rules (score, thresholds, amounts, deadlines). It hands CoorRe the decision under mandate through a host profile ([schema](../hedera/spec/host-profile.schema.json)), and CoorRe answers only for that decision. This repository carries a fictitious example profile whose host is the reference escrow; each real host's profile, addresses, accounts and records live in the host's own private environment.
