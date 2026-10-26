# CoorRe on Hedera — threat model

Status: specification for phase 2. Each control below becomes a test that fails when the control is removed, shown by removing it and running the suite. Path A is assumed ([SPEC.md](SPEC.md#execution)); a line marks where path B differs.

## Assets and actors

- Assets: the escrowed HBAR of each agreement (held by PESEscrowV3, never by CoorRe); the authority to approve or reject a period; the integrity of the public trail.
- Actors: the host admin (2-of-3 account), the issuer (the same account for W.A.T.A.), delegates (human or agent), the host oracle, the CoorRe log operator, the CoorRe deployer, any third party with a Hedera account, the Mirror Node and the relay as read paths.

## Threats and controls

| # | Threat | Control | Test in phase 2 |
|---|---|---|---|
| T1 | A forged mandate: someone registers delegates without being the issuer | Registration accepts only the issuer account named at deployment; the issuer is a threshold account (probe P4 shows threshold keys are enforced) | Register from a non-issuer account → revert |
| T2 | A decision outside the mandate: wrong escrow, agreement, mode or verdict | Scope check before any call to the escrow | One test per scope field |
| T3 | Replay: a decision reused in another period, on a resubmitted batch or twice | The decision carries `auditHash`; the contract compares it with `getPeriod`; one decision per delegate and period; the escrow refuses a period that is no longer `PendingApproval` | Same decision on another period, after a resubmission, and twice |
| T4 | An expired or revoked mandate still used | `validFrom ≤ block.timestamp ≤ validUntil` and the revocation block, checked in the same transaction as the call to the escrow | Decision one second after `validUntil` and in the block after revocation |
| T5 | A malicious or compromised delegate | Quorum above 1 when the issuer chooses it; scope limited to listed agreements; revocation by the issuer; every decision is public with its evidence | Quorum 2: one decision does not execute |
| T6 | An automated delegate approving a large amount | `autonomyLimit` checked against `periodAmount` with `MandateExceeded`; a human delegate is never limited | Agent above the limit → `MandateExceeded`; at the limit → passes |
| T7 | The admin replaces the financial manager to bypass CoorRe | Not prevented (two of three admin keys can do it). Detected: the verifier reads `FinancialManagerChanged` and reports decisions taken while CoorRe was not the financial manager | Bundle with an approval after a manager change → reported |
| T8 | Unrecorded admin actions (refund, close, pause, window change) | Recorded policy; the verifier lists every admin event with or without a record | Admin event without a record → reported |
| T9 | Order of messages in HCS differs from on-chain order | The on-chain contract is the authority for state; HCS gives order and time of the record; the verifier matches each message to its transaction id and reports gaps | Messages out of order and a missing message → reported |
| T10 | A forged log message | Topic submit key held by the log operator (probe P4); the message only carries hashes that the verifier recomputes from the bundle and the chain | Message with a wrong `evidenceHash` → check fails |
| T11 | The log operator key is lost or leaked | No admin key, so nobody can rewrite the topic (probe P4); rotation to a new topic announced in the old one; the contract state stays the authority | Rotation message followed by entries in the new topic |
| T12 | Clock divergence at the deadline | Every check uses `block.timestamp` in the same transaction; the escrow lets `approve` pass at exactly `approvalDeadline` and `expire` revert (`PESEscrowV3.sol:236,256`); the host server clock (`payments.ts:540`) is not trusted | Decision at `approvalDeadline` and one second later |
| T13 | Reentrancy through the escrow call | The CoorRe contract updates its own state (decided, quorum count) before calling `approve`/`reject`; neither function sends value (`PESEscrowV3.sol:231-249`); payouts happen in `release`, which CoorRe never calls | A malicious escrow mock that calls back into the contract |
| T14 | The CoorRe contract replaced by a look-alike | Not upgradeable; the verifier ships the expected contract address, escrow address, topic id and chain id (ADR-002) | Bundle pointing to another contract → check fails |
| T15 | Self-approval: the oracle that submitted also approves | The escrow refuses `msg.sender == submitter` (`SameAccount`); under path A the caller is the CoorRe contract, so CoorRe also refuses a delegate whose account is the period's submitter | Delegate equal to the submitter → revert |
| T16 | The host's JWT `MANAGER` used as authority | The JWT never reaches the contract; only delegate accounts decide | Not a contract test: a documented boundary |
| T17 | Read path tampering (Mirror Node or relay returns false data) | The verifier reads from the public Mirror Node and recomputes hashes; anyone can repeat it against another mirror. Declared limitation: the verifier trusts the Mirror Node it queries | — |

Path B: T1 to T6 and T15 become detection only (the financial manager's wallet signs; the verifier reports a call without a matching recorded decision), and T7 does not apply.

## Declared limitations

- CoorRe does not hold or move funds, so it cannot stop a payment the escrow allows; it can only refuse to decide and make every decision public.
- Two of the three admin keys can remove CoorRe as financial manager at any time; this is detected, not prevented.
- The audit document stays in the host's database (`scorePeriod.ts:73-83`); CoorRe proves which document a decision named, not that the measurements in it are true.
