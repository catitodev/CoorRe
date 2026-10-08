# Demo fixtures (synthetic data only)

Everything here is invented for the demo. No real company, person, document number or
registry is represented.

| Case | Amount | Autonomy limit | Documents | Expected path |
|---|---|---|---|---|
| SUP-001 | 0.05 SOL | 0.10 SOL | tax certificate and environmental license valid | AUTO_APPROVED, escrow released to the supplier |
| SUP-002 | 0.20 SOL | 0.10 SOL | environmental license expired 2026-09-30 | rogue AUTO_APPROVED rejected on-chain with MandateExceeded, then ESCALATED, then APPROVED by the approver, escrow released |
| SUP-003 | 0.20 SOL | 0.10 SOL | environmental license expired 2026-09-30 | ESCALATED, then REJECTED, escrow refunded to the creator (tests only, `"demo": false`) |

`cases.json` lists the cases; each document file is a JSON artifact whose SHA-256 goes
into the evidence. Validity is evaluated on the day the demo runs.
