# Demo fixtures (synthetic data only)

Everything here is invented for the demo. No real company, person, document number or
registry is represented.

| Case | Amount | Autonomy limit | Documents | Expected path |
|---|---|---|---|---|
| SUP-001 | 0.05 SOL | 0.10 SOL | tax certificate and environmental license valid | AUTO_APPROVED, escrow released to the supplier |
| SUP-002 | 0.20 SOL | 0.10 SOL | environmental license expired 2026-09-30 | rogue AUTO_APPROVED rejected on-chain with MandateExceeded, then ESCALATED, then APPROVED by the approver, escrow released |
| SUP-003 | 0.20 SOL | 0.10 SOL | environmental license expired 2026-09-30 | ESCALATED, then REJECTED, escrow refunded to the creator (tests only, `"demo": false`) |

## Other domains (rule registry, ADR-005)

These cases name their rule in `cases.json`, use `payee` instead of `supplier`, are not
part of the default demo (`"demo": false`) and run with `coorre demo run --case <ID>`.
Every document carries `"synthetic": true`; names, issuers and numbers are invented.

| Case | Rule | Amount | Autonomy limit | Documents | Expected path |
|---|---|---|---|---|---|
| AGT-001 | agent-purchase v1 | 0.02 SOL | 0.03 SOL | purchase request, supplier quote and supplier registration agree and are current | AUTO_APPROVED, escrow released to the payee |
| AGT-002 | agent-purchase v1 | 0.04 SOL | 0.03 SOL | supplier registration expired 2026-09-30 | rogue AUTO_APPROVED rejected with MandateExceeded, then ESCALATED ("supplier registration expired", "amount exceeds autonomy limit"), then APPROVED by the approver, escrow released |
| PES-001 | ecosystem-services-payment v1 | 0.02 SOL | 0.03 SOL | contract valid, monitoring observed within it, 124,500 m² verified against 120,000 m² committed | AUTO_APPROVED, escrow released to the payee |
| PES-002 | ecosystem-services-payment v1 | 0.04 SOL | 0.03 SOL | 118,000 m² verified against 150,000 m² committed | rogue AUTO_APPROVED rejected with MandateExceeded, then ESCALATED ("verified area below committed area", "amount exceeds autonomy limit"), then APPROVED by the approver, escrow released |
| MIL-001 | milestone-payment v1 | 0.02 SOL | 0.03 SOL | funding agreement, milestone report delivered in the window, previous installments accounted for with no open findings | AUTO_APPROVED, escrow released to the payee |
| MIL-002 | milestone-payment v1 | 0.02 SOL | 0.03 SOL | accountability report with two open findings | ESCALATED ("open findings in the accountability report"), then REJECTED by the approver, escrow refunded to the creator |
| SRV-001 | service-delivery v1 | 0.02 SOL | 0.03 SOL | service contract, acceptance within its validity, invoice issued after acceptance and within the price cap | AUTO_APPROVED, escrow released to the payee |
| SRV-002 | service-delivery v1 | 0.02 SOL | 0.03 SOL | invoice issued 2026-09-20, before the acceptance of 2026-09-25 | ESCALATED ("invoice issued before acceptance"), then REJECTED by the approver, escrow refunded to the creator |

`cases.json` lists the cases; each document file is a JSON artifact whose SHA-256 goes
into the evidence. Validity is evaluated on the day the demo runs.
