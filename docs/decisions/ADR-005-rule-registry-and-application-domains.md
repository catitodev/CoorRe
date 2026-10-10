# ADR-005: Rule registry and application domains

- Status: accepted
- Date: 2026-10-09
- Amends: ADR-004 (check 7 runs any rule of the registry, not only supplier-docs v1)

## Context
The program, the roles, the state machine and the evidence model do not depend on what
is being decided: they bound an amount, bind each step to a role key and chain the
evidence. Only the rule that turns documents into a decision is specific to a process.
Until now the engine and the verifier knew a single rule, supplier-docs v1, so the
build could show one process only.

## Decision
- coorre-engine ships a rule registry. Each rule is a JSON document in
  `offchain/crates/coorre-engine/rules/<id>-v1.json`, compiled in with `include_str!`,
  with its id, version, description, required document kinds, conditions (each with
  the reason it gives when it fails), mandate and outcomes. The rule hash is SHA-256 of
  its JCS form, as before.
- A rule returns AUTO_APPROVED only when every condition holds; otherwise ESCALATED
  with one reason per failed condition, in the order the rule lists them. Each required
  document kind must be submitted exactly once; a condition that reads a missing or
  duplicated document is not evaluated. The mandate condition is always evaluated and
  always last, with the same reason as supplier-docs v1: "amount exceeds autonomy limit".
- supplier-docs v1 is unchanged, byte for byte, and keeps its hash and its decisions.
- Check 7 selects the rule by the id and version named in the evidence and requires the
  hash to equal the hash of the rule the verifier ships. An unknown id or version, or a
  different hash, fails the check. The evaluation date must still be the signing day or
  the day before, for every rule.
- The demo fixtures name their rule in `demo/fixtures/cases.json` (optional `rule`
  field; when absent, supplier-docs v1). New cases are not part of the default
  `coorre demo run` and run with `--case`.

## Rules in the registry

| Rule | Process | Documents |
|---|---|---|
| supplier-docs v1 | Supplier onboarding and payment | tax certificate, environmental license |

## What this does not prove
- That the documents are genuine. Every document in the demo is synthetic; a real
  deployment needs documents signed by their issuer or registry.
- That a rule is the right policy for a given organisation or law; it proves that the
  recorded decision follows from the rule that was named.
- Integration with payment rails or real registries; both are out of scope.

## Consequences
- The registry is a trust anchor shipped with the verifier, like the expected program
  id (ADR-002): a verifier only reproduces decisions under rules it carries.
- Adding a rule, or a new version of one, means shipping a new verifier build.
