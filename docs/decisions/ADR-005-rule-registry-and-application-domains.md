# ADR-005: Rule registry and application domains

- Status: accepted
- Date: 2026-10-09
- Amends: ADR-004 (check 7 runs any rule of the registry, not only supplier-docs v1)
- Amended: 2026-11-01 (version 2 of agent-purchase, milestone-payment and service-delivery)

## Context
The program, the roles, the state machine and the evidence model do not depend on what
is being decided: they bound an amount, bind each step to a role key and chain the
evidence. Only the rule that turns documents into a decision is specific to a process.
Until now the engine and the verifier knew a single rule, supplier-docs v1, so the
build could show one process only.

## Decision
- coorre-engine ships a rule registry. Each rule is a JSON document in
  `offchain/crates/coorre-engine/rules/<id>-v<version>.json`, compiled in with `include_str!`,
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
| agent-purchase v1 | Purchases prepared by AI agents | purchase request, supplier quote, supplier registration |
| ecosystem-services-payment v1 | Payments for ecosystem services with monitoring evidence | contract, monitoring report |
| milestone-payment v1 | Milestone payments in funded projects, with accountability | funding agreement, milestone report, accountability report |
| service-delivery v1 | Service contracts delivered by consultancies | service contract, acceptance record, invoice |
| agent-purchase v2 | As v1, and the request must not be past its needed-by date | as v1 |
| milestone-payment v2 | As v1, and the delivery must not be dated after the evaluation date | as v1 |
| service-delivery v2 | As v1, and the acceptance and the invoice must not be dated after the evaluation date | as v1 |

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

## Amendment of 2026-11-01: version 2 of three rules

### Context
ecosystem-services-payment v1 escalates a monitoring report observed after the
evaluation date. agent-purchase v1, milestone-payment v1 and service-delivery v1 read
document dates too, but never compare them with the evaluation date: a milestone
report, an acceptance record or an invoice dated after the day of the decision is
approved by them. agent-purchase v1 parses the purchase request's needed_by date and
does not use it.

### Decision
- One comparison serves every rule: a document date is after the evaluation date when
  it falls on a later calendar day. ecosystem-services-payment v1 uses it with no change
  in its bytes, hash or decisions.
- milestone-payment v2, service-delivery v2 and agent-purchase v2 are new rule
  documents, each identified by the SHA-256 of its JCS form like every rule:
  - milestone-payment v2: "milestone delivered after the evaluation date", as the
    second reason of the window condition (a delivery outside the window gives only the
    window reason, as in ecosystem-services-payment v1);
  - service-delivery v2: "acceptance recorded after the evaluation date" in the
    acceptance condition and "invoice issued after the evaluation date" in the invoice
    condition, each after the reason that condition already gave;
  - agent-purchase v2: "purchase request is past its needed-by date" when the
    evaluation date is after purchase_request.needed_by, listed after "supplier quote
    expired", with the other date conditions; the mandate stays last.
  A date on the evaluation date itself passes: comparisons are inclusive, as every rule
  states.
- v1 stays in the registry, unchanged byte for byte. The evidence names the rule id,
  version and hash, and check 7 re-runs that exact rule: a decision recorded under v1,
  such as the devnet runs of 2026-10-10, is reproduced under v1. Replacing v1 in place
  would change its hash and make every recorded decision fail check 7, or change the
  meaning of a hash that already exists.
- The cases AGT-001/002, MIL-001/002 and SRV-001/002 in demo/fixtures/cases.json name
  v2, so the next runs decide under it. Their outcomes are unchanged; the synthetic
  needed_by and quote validity dates of AGT-001 and AGT-002 moved to 2027-06-30 so that
  the outcomes hold on every day up to that date, and a test evaluates them on each day
  from 2026-11-01 to 2027-06-30.
