# Devnet account bytes: bridge smoke case

Raw account data of the bridge smoke case (see onchain/DEPLOYMENTS.md), read with
`getAccountInfo` at commitment `finalized` from https://api.devnet.solana.com on
2026-10-08. Owner of every account: `9esN1A8K1SASLg17ob81dbSdB4VX8ozc6tBLmJ247Wv`
(coorre_anchor).

| File | Account | Bytes |
|---|---|---|
| `case-record.hex` | CaseRecord `A3GQ8hYbUfmnsbk4zsZUtgCi3XpUMeEkcFtXKBiZJZWU` | 254 |
| `anchor-submitted.hex` | EvidenceAnchor `3WMyjabKbxNVjKRx93d8E4ugsxGBgspqNssmCtexkM9i` | 188 |
| `anchor-agent-reviewed.hex` | EvidenceAnchor `AzAuDcj5jxR1da6f5ExawnK934BTzib2rcz3jNUGaT6D` | 188 |
| `anchor-auto-approved.hex` | EvidenceAnchor `68XTGwxSBcy9ZzFieHebbXQzC348NYHu9A6N44eyGTD3` | 188 |

Case: `urn:coorre:case:BRIDGE-SMOKE-20261008`, 1,000,000 lamports, autonomy limit
2,000,000, evidence hashes `SHA-256("bridge-smoke:<case_ref>:<step>")` for steps
`submitted`, `agent-reviewed`, `auto-approved`, rule hash of supplier-docs v1.
