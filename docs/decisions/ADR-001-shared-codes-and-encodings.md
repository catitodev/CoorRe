# ADR-001: Shared codes and encodings between on-chain and off-chain

- Status: accepted
- Date: 2026-10-08

## Context
The program, the Rust core, the bridge and the browser verifier must agree byte for
byte on state codes, actor kinds, PDA seeds and Anchor encodings, or verification
check 6 cannot compare on-chain accounts with recomputed values.

## Decision

### Case states (u8)
| Code | Name | Terminal |
|---|---|---|
| 0 | OPEN | |
| 1 | SUBMITTED | |
| 2 | AGENT_REVIEWED | |
| 3 | AUTO_APPROVED | yes (release) |
| 4 | ESCALATED | |
| 5 | APPROVED | yes (release) |
| 6 | REJECTED | yes (refund) |

### Transitions and required signer
| From | To | Role | actor_kind |
|---|---|---|---|
| OPEN | SUBMITTED | submitter | 1 human |
| SUBMITTED | AGENT_REVIEWED | agent | 2 agent |
| AGENT_REVIEWED | AUTO_APPROVED (amount <= autonomy_limit) | rule_engine | 3 system |
| AGENT_REVIEWED | ESCALATED | rule_engine | 3 system |
| ESCALATED | APPROVED | approver | 1 human |
| ESCALATED | REJECTED | approver | 1 human |

actor_kind codes start at 1 so that zeroed data never decodes as a valid kind.

### Check order in `anchor_transition`
CaseClosed → InvalidState → InvalidTransition → UnauthorizedActor → PrevHashMismatch →
MandateExceeded. Consequence: an AUTO_APPROVED attempt signed by a key other than
rule_engine fails with UnauthorizedActor; MandateExceeded is reported only when the
rule_engine key itself tries to approve above the limit (the "rogue automation" case
in the demo).

### Error codes (Anchor custom errors, 6000 + index)
6000 InvalidTransition, 6001 InvalidState, 6002 UnauthorizedActor,
6003 PrevHashMismatch, 6004 CaseClosed, 6005 RolesNotDistinct, 6006 MandateExceeded,
6007 InsufficientEscrow, 6008 Overflow, 6009 AmountBelowRentExempt.

### PDA seeds
- CaseRecord: `["case", creator, case_id]`
- EvidenceAnchor: `["evidence", case_record, evidence_hash]`

### Anchor 0.29 encodings (verified against devnet on 2026-10-08)
- Instruction discriminator: `sha256("global:<snake_case_name>")[0..8]`
- Account discriminator: `sha256("account:<TypeName>")[0..8]`
- Event discriminator: `sha256("event:<TypeName>")[0..8]`, emitted as base64 in
  `Program data:` log lines
- Integers little-endian; `Pubkey` and `[u8; 32]` as 32 raw bytes; fields in
  declaration order (Borsh).

These were checked against the deployed spike: the `Vault` account data, the
`VaultDeposited`/`VaultWithdrawn` events and the `open_vault`/`withdraw` instruction
data all start with the computed discriminators, and the u64 arguments decode to the
amounts sent.

### Off-chain identifiers
- `case_id = SHA-256(UTF-8(case_ref))`; genesis `previousEvidence = "sha256:" + hex(case_id)`.
- `evidence_hash = SHA-256(JCS(document without "proof"))`.

## Consequences
The Rust core (`coorre-model`, `coorre-engine`), the bridge and the verifier import
or mirror these values; any change here is a breaking change for all of them.
