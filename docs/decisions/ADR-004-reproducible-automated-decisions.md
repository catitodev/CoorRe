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
- Evaluation date against the chain (amended 2026-11-01): `validFrom` is written by the
  signer, so it is not enough on its own. The evaluation date must also be the UTC day
  of the EvidenceAnchor's `unix_ts` (Clock sysvar) or the day before; without the
  anchor the decision fails. Check 6 requires every evidence's `validFrom` to be
  within 300 seconds of its anchor's `unix_ts`.
  Across the 35 recorded devnet anchors, `unix_ts` is 1 to 5 seconds after `validFrom`.
  300 seconds covers the slowest path the bridge allows: a transaction can land until
  its blockhash expires (150 slots, about 120 seconds at 400 ms slots), the bridge
  retries once with a new blockhash; when the CLI runs it, the bridge stops itself after
  150 seconds and the CLI stops the bridge process after 180 seconds, so a transaction
  it sent lands at the latest about 270 seconds after the evidence was signed.
- A bundle with no automated decision yet passes with a note.

## What this does not prove
- That the documents are genuine: the demo uses synthetic documents, and a real
  deployment needs a registry or issuer signature behind them.
- That the rule is the right policy.
- That role keys are held by who they should be: the chain proves which keys acted.

## Consequences
- Tampering with a document now fails check 1 and, because the decision can no longer
  be reproduced from it, check 7.
- Check 7 needs the on-chain anchors: without them (no network and no recorded
  accounts) automated decisions cannot be dated and the check fails.
- A real LLM agent can later replace the simulated one: its advice is compared with the
  rule but cannot release funds, and a rule-engine decision that disagrees with the rule is
  caught by any verifier.
- Artifacts for supplier-docs v1 must be JSON documents in the engine's format
  (`kind`, `valid_from`, `valid_until`, plus descriptive fields).
