# CoorRe on Hedera — threat model

Path A is assumed ([SPEC.md](SPEC.md#execution)); the last section says where path B differs. Each contract control has a test that fails when the control is removed: `npm run check:protections` removes each protection of the mandate contract in turn and requires a failing test, and `hedera/test/docs.test.mjs` checks that every test named below exists.

## Assets and actors

- Assets: the host's escrowed funds (held by the host's escrow, never by CoorRe); the authority to approve or reject a period; the integrity of the public trail; the host's private data.
- Actors: the host admin, the issuer (the escrow's admin), delegates (human or agent), the host oracle, the CoorRe operator, the CoorRe log operator, any third party with a Hedera account, the Mirror Node and the relay as read paths.

## Threats and controls

| # | Threat | Control | Test |
|---|---|---|---|
| T1 | A forged mandate: someone registers delegates without being the issuer | Registration accepts only the escrow's current `admin()`; revocation accepts the current admin or the original issuer | `testOnlyTheEscrowAdminRegisters`, `testOnlyTheIssuerOrTheAdminRevokes` |
| T2 | A decision outside the mandate: wrong agreement, mode or verdict | Scope check before any call to the escrow | `testAgreementOutsideTheListIsRefused`, `testVerdictOutsideTheMandateIsRefused`, `testAutoAgreementIsOutOfScope` |
| T3 | Replay in another period, on a resubmitted batch or twice | The decision carries `auditHash`, compared with the period; one vote per delegate and period; a concluded ballot is closed before the escrow call | `testADecisionForAnotherBatchIsRefused`, `testADecisionCannotBeReplayedOnAResubmittedBatch`, `testQuorumWaitsForTheSecondDelegate` |
| T4 | An expired or revoked mandate still used, or a mandate registered with an unbounded life | Validity window and revocation are checked in the same transaction as the call to the escrow; registration refuses a duration above the cap fixed at deploy, an already expired mandate and a start date more than one day in the past | `testExpiredMandateIsRefused`, `testMandateBeforeItsStartIsRefused`, `testRevokedMandateIsRefused`, `testFuzzMandateWindow`, `testMandateDurationAboveTheCapIsRefused`, `testAMandateAlreadyExpiredIsRefused`, `testAMandateBackdatedTooFarIsRefused` |
| T5 | A malicious or compromised delegate | Quorum above 1 when the issuer chooses it; scope; revocation; every decision is public with its evidence hash. Delegates who disagree leave the period to its deadline, and nothing is paid | `testQuorumWaitsForTheSecondDelegate`, `testDelegatesWhoDisagreeLeaveThePeriodToTheDeadlineAndNothingIsPaid` |
| T6 | An automated delegate approving a large amount | `autonomyLimit` against `periodAmount` with `MandateExceeded`; agents only approve | `testAnAgentAboveTheLimitIsMandateExceeded`, `testFuzzAgentLimit`, `testAnAgentCannotReject` |
| T7 | The admin replaces the financial manager to bypass CoorRe | Not prevented. Detected: the verifier reads `FinancialManagerChanged` and reports decisions taken while CoorRe was not the financial manager | Verifier source (next step) |
| T8 | Unrecorded administrative actions | Recorded policy; the verifier lists every admin event with or without a record | Verifier source (next step) |
| T9 | HCS order differs from on-chain order | The contract is the authority for state; the verifier matches each message to its transaction id and reports gaps | Verifier source (next step) |
| T10 | A forged log message | Topic submit key held by the log operator (probe P4); messages carry only hashes that the verifier recomputes | Probe P4 |
| T11 | The log operator key is lost or leaked | No admin key, so nobody can rewrite the topic; rotation to a new topic announced in the old one | Probe P4 |
| T12 | Clock divergence at the deadline | Every check uses `block.timestamp` in the same transaction; the gate refuses a decision or a vote after the period's deadline, so a late rejection cannot execute before `expire`; host server clocks are not trusted | `testApprovalAndRejectionPassAtTheLastSecondOfTheDeadline`, `testApprovalAndRejectionAreRefusedOneSecondAfterTheDeadline`, `testFuzzDeadline` |
| T13 | Reentrancy through the escrow call | The contract records the vote and closes the period before calling the escrow | `testReentryFromTheEscrowIsRefused` |
| T14 | The CoorRe contract replaced by a look-alike | Not upgradeable; the verifier ships the expected contract, escrow, topic and chain ids (ADR-002) | Verifier source (next step) |
| T15 | Self-approval by the account that submitted the period | The contract refuses a delegate equal to the period's submitter | `testTheSubmitterCannotDecide` |
| T16 | An off-chain role (for example a web session) used as authority | Only delegate accounts decide, checked on-chain | Documented boundary |
| T17 | Read-path tampering (Mirror Node or relay) | The verifier recomputes hashes; anyone can repeat it against another mirror. Declared limitation | — |
| T18 | One account holding several roles (host admin or oracle and CoorRe operator) | The deploy script refuses a CoorRe operator that is any host account | `the CoorRe operator must not be any host account` |
| T19 | Host data published by CoorRe | The public repository carries the generic engine and a fictitious example only; host profiles, addresses, accounts and records live in the host's private environment | The deploy script refuses configuration and record paths inside the repository |
| T20 | Wallet transactions refused or misread on the relay | Price with the relay's `eth_gasPrice`; wait for the receipt by transaction hash (native transactions do not advance the EVM nonce) | Integration on Solo, JSON-RPC step |
| T21 | A mandate left behind when the escrow's admin changes | A mandate is valid only while its issuer is the escrow's current admin; the original issuer and the new admin can revoke it; the new admin registers a new one | `testDecisionIsRefusedAfterTheAdminChanges`, `testTheOriginalIssuerCanStillRevokeAfterTheAdminChanges`, `testTheNewAdminRegistersAMandateAndDecides`, `testFuzzNoDecisionOutsideTheAuthority` |
| T22 | A late vote or rejection recorded after the deadline | The deadline is read from the period for every verdict; a vote refused after it stores nothing | `testAPartialVoteAfterTheDeadlineIsRefusedAndNothingIsStored`, `testARejectionAfterTheDeadlineIsRefusedAndExpireLeadsToReview` |
| T23 | A review verdict by someone without authority | A review needs the permission in the mandate, a human delegate, a period in review, the batch's hash, a delegate who did not submit it, and the quorum; the gate never moves the period | `testAReviewNeedsThePermissionInTheMandate`, `testAnAgentCannotRecordAReview`, `testAReviewOfAPendingPeriodIsRefused`, `testAReviewForAnotherBatchIsRefused`, `testTheSubmitterCannotRecordAReview`, `testAReviewNeedsTheQuorumAndEachDelegateRecordsOnce` |
| T24 | Registration that costs unbounded gas or overflows the vote counter | At most 20 delegates and 100 listed agreements per mandate | `testTooManyDelegatesAreRefused`, `testTooManyAgreementsAreRefused` |
| T25 | The escrow pauses or runs out of free balance during a decision | The escrow's own checks revert the whole transaction, so no vote is stored; a rejection still executes under pause, as in the escrow | `testApprovalWithThePausedEscrowRevertsWholeAndStoresNoVote`, `testRejectionWithThePausedEscrowExecutes`, `testApprovalWithoutFreeBalanceRevertsWholeUntilTheAgreementIsFunded` |

Path B: T1 to T6 and T15 become detection only (the financial manager's wallet signs; the verifier reports a call without a matching recorded decision), and T7 does not apply.

## Declared limitations

- CoorRe does not hold or move funds; it can only refuse to decide and make every decision public.
- The escrow's admin can remove CoorRe as financial manager at any time; this is detected, not prevented.
- The audit document stays with the host; CoorRe proves which document a decision named, not that its content is true.
- Topic messages and contract events are public on the ledger by design; they carry ids and hashes, and permissioned verification remains on the roadmap.
