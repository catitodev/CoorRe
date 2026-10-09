# ADR-004: Verification check 7, automated decisions are reproduced

- Status: accepted
- Date: 2026-10-08
- Amends: SPEC section 8 (adds check 7), sections 7, 9 and 10

## Context
The program enforces the amount against the autonomy limit, and checks 1 to 6 prove
integrity, authorship and anchoring. None of them proves that a decision follows from
the rule. The chain cannot see documents, so a holder of the rule-engine key could
anchor AUTO_APPROVED for a case with an expired license, within the limit, and checks
1 to 6 would still pass. Likewise, an agent's recommendation was never compared with
anything.

## Decision
The verifier gets a seventh check that re-runs the rule on what the evidence itself
declares.

- Scope: every evidence whose transition is AGENT_REVIEWED to AUTO_APPROVED or
  ESCALATED (rule engine). The agent step (SUBMITTED to AGENT_REVIEWED) is compared
  too, but a difference is informational: the agent advises, the rule engine decides.
  Human decisions (APPROVED, REJECTED) are outside the rule by design.
- Inputs: documents are the artifacts listed by the SUBMITTED evidence, read from the
  provided files (their digests are verified by check 1) and parsed in the engine's
  document format; amount and limit come from the mandate in the evidence (tied to the
  chain by check 6); the evaluation date comes from the payload.
- Rule identity: only the rule the verifier ships can be run. The evidence must name
  supplier-docs v1 and carry the same rule hash as the verifier's built-in rule; any
  other rule fails the check instead of being trusted.
- Comparison: recorded state, `decision` and `reasons` must equal the result.
- Evaluation date: must be the UTC signing day (`validFrom`) or the day before. The
  day of tolerance keeps runs that cross UTC midnight valid; anything older would let a
  signer backdate the evaluation to a day on which an expired document was still valid.
- A bundle with no automated decision yet passes with a note.

## What this does not prove
- That the documents are genuine: the demo uses synthetic documents, and a real
  deployment needs a registry or issuer signature behind them.
- That the rule is the right policy.
- That role keys are held by who they should be: the chain proves which keys acted.

## Consequences
- Tampering with a document now fails check 1 and, because the decision can no longer
  be reproduced from it, check 7.
- A real LLM agent can later replace the simulated one: its advice is compared with the
  rule but cannot release funds, and a rule-engine decision that disagrees with the rule is
  caught by any verifier.
- Artifacts for supplier-docs v1 must be JSON documents in the engine's format
  (`kind`, `valid_from`, `valid_until`, plus descriptive fields).
