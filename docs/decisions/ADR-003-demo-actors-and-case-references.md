# ADR-003: Demo actors and case references

- Status: accepted
- Date: 2026-10-08

## Decision

Autonomy declared in each transition credential (spec section 3 allows recommend,
execute_with_approval, autonomous, escalate):

| Role | actor.kind | autonomy | Reason |
|---|---|---|---|
| submitter (supplier) | human | execute_with_approval | submits, but payment depends on approval |
| agent (pre-analysis) | agent | recommend | spec section 2: the agent only recommends |
| rule_engine | system | autonomous | spec section 3 example; it decides within the mandate |
| approver | human | autonomous | the human authority above the mandate |

The agent is simulated and deterministic: it runs the same supplier-docs evaluation
and records a recommendation; no model is called (spec section 14).

The SUP-002 "rogue" attempt is an AUTO_APPROVED credential signed by the rule_engine
key above the limit. Only that key can attempt AUTO_APPROVED (ADR-001 check order),
so this is the case where the program answers MandateExceeded.

Case references are unique per run: `urn:coorre:case:<ID>-<UTC yyyymmddThhmmssZ>`.
A CaseRecord is a PDA of (creator, case_id), so reusing `SUP-001` on a second run would
fail with "already in use".

## Consequences
The demo can be run repeatedly with the same keys; each run costs about 0.27 SOL of
escrow plus rent, and the escrow goes to the submitter key, which the operator holds.
