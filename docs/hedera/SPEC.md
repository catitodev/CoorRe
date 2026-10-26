# CoorRe on Hedera — specification

Status: the mandate contract (path A) runs on a local Solo network in CI, together with the phase 0 probes ([PHASE0.md](PHASE0.md)): mandate, decision, execution on the host's escrow, release and the HCS log. The Hedera source of the verifier, the integration package for the host and testnet are next steps. Mainnet is out of scope.

CoorRe on Hedera is one application of the CoorRe engine ([APPLICATIONS.md](../APPLICATIONS.md)). It answers for one moment of a host's process, the decision under mandate: who may decide what, under which mandate, with which evidence, and the public proof of it. The host keeps its business rules (score, thresholds, amounts, deadlines, validity, tokenization); CoorRe reads them from a host profile and never sets or changes them. The first host is W.A.T.A. ([vivipolli/wata](https://github.com/vivipolli/wata), read only, pinned at 1462dfeb in [wata.lock.json](../../hedera/reference/wata.lock.json)).

Every governance value below is a proposal written by the technical core and reviewed against the environmental council's concerns (who carries the risk of a wrong payment, who can stop it, what a producer can contest). It takes effect only with the maintainers' explicit approval, recorded in [EVIDENCE_LOG.md](../evidence/EVIDENCE_LOG.md).

## Host profile

A host hands CoorRe its input through a profile that follows [host-profile.schema.json](../../hedera/spec/host-profile.schema.json) (`coorre-host-profile/1`). The schema is generic. The W.A.T.A. profile is [wata.json](../../hedera/host-profiles/wata.json). Each value carries a source:

- `host-code`: a fact read in the host's code at the pinned commit, cited as `path:lines`;
- `host-onchain`: a value CoorRe reads from the host's contract when it decides;
- `coorre-proposal`: a CoorRe governance proposal, defined in this document.

`hedera/test/host-profile.test.mjs` checks that the profile validates, that no field is left unfilled, that the profile carries no host business value (no score threshold, period amount or approval window), that every `host-code` source names a pinned file and a line range inside it, that every `coorre-proposal` source points to a heading of this document, and that every selector matches the compiled PESEscrowV3.

## Targets

| Network | Chain id | Contract | Address |
|---|---|---|---|
| solo | 298 (read from the relay, probe P0) | PESEscrowV3 | The fixture CoorRe deploys in each Solo run; never a fixed value |
| testnet | 296 (read from https://testnet.hashio.io/api) | PESEscrowV3 | None yet: the host has not deployed it (`backend/.env.example:11-12` holds the zero address; `contracts/deployment.json` points to the 2025-09-25 contract) |

The address enters the profile only when the host publishes it. CoorRe never deploys the host's contract on testnet.

## Decision point

`approve-or-reject-period` (`PESEscrowV3.sol:192-249`):

- Trigger: a period of a HYBRID agreement is `PendingApproval`, which happens when an authorized oracle submits a score at or above the agreement's threshold (`PESEscrowV3.sol:217-225`).
- Inputs, all produced inside the host: `agreementId`, `periodId`, `auditHash`, `score`, `scoreVersion`.
- Actions: `approve(uint256,uint256)` (`0x5d35a3d9`) and `reject(uint256,uint256)` (`0x86b2375c`), callable only by the escrow's `financialManager`.
- Deadline: `approvalDeadline = block.timestamp + approvalWindow` at submission. CoorRe reads `approvalWindow()` and the period's `approvalDeadline` on-chain; it holds no copy of either.
- Modes: HYBRID only. In AUTO the escrow approves inside `submitBatch` (`PESEscrowV3.sol:219-221`) and there is no decision to make.

## Mandate

A mandate is a document the issuer signs and registers on-chain before any decision uses it.

| Field | Meaning |
|---|---|
| `mandateId` | SHA-256 of the JCS form of the mandate document (RFC 8785, as every CoorRe hash) |
| `hostId` | `wata` |
| `issuer` | The account that registers the mandate. For W.A.T.A., the escrow's admin account, controlled by a 2-of-3 threshold key (host decision D5, `localEscrowCycle.ts:89-97`) |
| `delegates` | Accounts that may decide, each with its kind (`human` or `agent`) |
| `quorum` | Number of distinct delegates whose decisions are needed before CoorRe executes. Default 1, the same as today's single financial manager; the issuer may set more |
| `scope` | `chainId`, escrow address, agreement ids (a list, or all agreements of that escrow), modes (`HYBRID`), verdicts (`approve`, `reject`, `review`) |
| `validFrom`, `validUntil` | Unix seconds, compared with `block.timestamp`. Set by the issuer for each mandate; CoorRe has no default |
| `autonomyLimit` | Optional, see below |
| `evidenceRule` | The host document a decision must name (for W.A.T.A., the `wata-score-period` audit document whose SHA-256 is the period's `auditHash`) |

Issuing: the issuer's account calls the CoorRe contract to register `mandateId` and the fields the contract enforces (delegates, quorum, scope, validity, limit). The registration is the proof of issue: it is a transaction signed by the issuer's own keys, visible on the Mirror Node, and the full mandate document goes to the CoorRe topic with the same `mandateId`.

Revocation: only the issuer revokes. A revoked mandate authorizes nothing from the block of its revocation on. Decisions taken earlier stay valid and keep pointing to the mandate.

### Autonomy limit

The engine's rule, unchanged: an automated actor cannot approve above its autonomy limit; only a human approver can. For W.A.T.A., a mandate may name an `agent` delegate and an `autonomyLimit` in tinybar (the unit the escrow records, probes P5-sdk and P5-deposit). The contract rejects an approval by an agent delegate when the agreement's `periodAmount` exceeds the limit, with the error `MandateExceeded`, the same name and meaning as the Solana program (`onchain/programs/coorre_anchor/src/lib.rs:148-150`). A human delegate is never bound by the limit. The limit is the host's value: the W.A.T.A. profile leaves it empty, which means only humans decide.

## Decision

A decision is the tuple

`(hostId, decisionPoint, agreementId, periodId, auditHash, scoreVersion, verdict, mandateId, evidenceHash, blockTimestamp)`

- `auditHash` binds the decision to the exact batch the oracle submitted. The contract reads the period with `getPeriod` and refuses a decision whose `auditHash` differs, which prevents replaying a decision in another period or on a resubmitted batch.
- `evidenceHash` is the SHA-256 of the JCS form of the decision credential without its proof: a W3C Verifiable Credential signed with eddsa-jcs-2022, as in the engine (`coorre-model`). It names the host's audit document as an artifact by the SHA-256 of its raw bytes, which is the `auditHash` itself (`scorePeriod.ts:73-83`); CoorRe never re-canonicalizes the host's document.
- `blockTimestamp` is the `block.timestamp` of the decision transaction; the HCS message adds its own consensus timestamp (see [Clocks](#clocks)).
- Case reference: `urn:coorre:case:wata:<chainId>:<escrow address>:<agreementId>:<periodId>`; `case_id = SHA-256(case_ref)`, as in the engine (`coorre-model/src/evidence.rs:302`).

### States

The period's own states stay the host's (`PESEscrowV3.sol:20`). CoorRe opens a case when it observes a period in `PendingApproval`; that observation, with the `BatchSubmitted` transaction and the audit document, is the first evidence of the case. From there the engine's states apply:

| CoorRe transition | Who | Effect on the escrow |
|---|---|---|
| ESCALATED → APPROVED | human delegate | `approve` |
| ESCALATED → REJECTED | human delegate | `reject` |
| ESCALATED → AUTO_APPROVED | agent delegate within the autonomy limit | `approve` |

The host's submission is evidence, not a CoorRe-signed step: the oracle's key belongs to the host. This differs from the four-role chain of the Solana build ([DIVERGENCES.md](DIVERGENCES.md)).

## Execution

Path A, with path B as the step before it ([ADR-007](../decisions/ADR-007-hedera-execution-path.md)).

**A.** A CoorRe contract is the escrow's `financialManager`. For each decision it checks, in order:

1. the mandate is registered, not revoked, and `validFrom ≤ block.timestamp ≤ validUntil`;
2. the caller is a delegate of the mandate and is not the account that submitted the period;
3. the escrow, the agreement, the mode and the verdict are in the mandate's scope;
4. the period is `PendingApproval` and its `auditHash` equals the decision's;
5. an agent delegate approves only within the autonomy limit (`MandateExceeded`);
6. this delegate has not decided this period before, and the quorum is reached;

then it calls `approve` or `reject` and emits the decision with `mandateId` and `evidenceHash`. PESEscrowV3 does not change. Probe P1 shows that the escrow sees the CoorRe contract as `msg.sender` and that a direct call by any other account reverts with `NotFinancialManager`. The escrow still enforces its own checks (`SameAccount`, the deadline, `whenNotPaused` on `approve`).

The contract is [CoorReMandateGate.sol](../../hedera/contracts/CoorReMandateGate.sol). Its errors are `NotIssuer`, `InvalidTerms`, `MandateExists`, `UnknownMandate`, `MandateNotActive`, `UnauthorizedActor`, `OutOfScope`, `PeriodNotPending`, `AuditHashMismatch`, `SubmitterCannotDecide`, `MandateExceeded`, `AlreadyDecided` and `InvalidVerdict`. The issuer is read from the escrow on every call (`admin()`), so a change of admin needs no change here. An agent delegate may only approve. The tests run against the host's own PESEscrowV3, built from the pinned commit with the host's compiler settings ([CoorReMandateGate.t.sol](../../hedera/contracts/test/CoorReMandateGate.t.sol)), and `npm run check:protections` shows that removing any protection fails a test.

**B.** The financial manager's wallet keeps signing `approve`/`reject` (the host's approval-call route, `payments.ts:514-560`). CoorRe registers the mandate and the decision (HCS message and hash) and the verifier checks that the on-chain call matches a recorded decision by a delegate in scope. B proves; A proves and enforces.

**C.** A new escrow version is not proposed: A and B cover the case without changing the host's contract.

### Admin governance under path A

The escrow's admin can replace the financial manager at any time (`setFinancialManager`, `PESEscrowV3.sol:347-351`). Under D5 that takes two of the three admin keys. CoorRe does not prevent it and does not claim to. It detects it: the verifier reads every `FinancialManagerChanged` event of the escrow and reports any `PeriodApproved` or `PeriodRejected` emitted while the financial manager was not the CoorRe contract as "outside the mandate". The same holds for the upgrade of the CoorRe contract itself: it is not upgradeable, and a replacement is a new address the issuer has to register again.

## Review

When the deadline passes, anyone can call `expire`, which moves the period to `InReview` (`PESEscrowV3.sol:251-259`). The escrow lets it out only through a new `submitBatch` with another `auditHash` (`PESEscrowV3.sol:207`) or through the admin's `closeNoPay` (`PESEscrowV3.sol:261-267`). Without changing the escrow:

1. a delegate under a mandate whose scope includes the verdict `review` records a review decision: `resubmit` (with the reason, for example new measurements) or `close-no-pay`;
2. the host executes it: its oracle submits a new batch, or its admin calls `closeNoPay`;
3. the verifier checks that the next on-chain event of the period matches the recorded verdict, and reports a mismatch or an execution without a review decision.

## Administration

The admin actions of the escrow are `setFinancialManager`, `setApprovalWindow`, `createAgreement` (which also sets the mode), `deactivateAgreement`, `closeNoPay`, `refund`, `withdrawExcess`, `pause`, `unpause`, `proposeAdmin` and `acceptAdmin`. Policy: **recorded, not enforced**. The admin stays the host's 2-of-3 account. Each action is announced on the CoorRe topic with its reason before or after it runs, and the verifier lists every admin event of the escrow with or without a matching record. Moving an action under enforcement would need the admin itself to be a CoorRe contract, which is the host's decision and is not proposed here.

## Log

- One HCS topic owned by CoorRe, never the host's topic. The host's current topic has no submit key and keeps its id only in memory (`hcs.ts:59-69`).
- `submitKey`: the CoorRe log operator key. Probe P4 shows that a message without it fails with `INVALID_SIGNATURE`.
- `adminKey`: none, so the topic cannot be updated or deleted (probe P4: `UNAUTHORIZED`). If the operator key has to change, CoorRe opens a new topic and announces it in a final message of the old one.
- Messages: one JSON object in JCS form, at most 1024 bytes (probe P3: 1025 bytes return `MESSAGE_SIZE_TOO_LARGE`). A message carries hashes and a compact payload: kind (`mandate`, `revocation`, `decision`, `review`, `admin`, `rotation`), `hostId`, `case_ref` or `mandateId`, `evidenceHash`, the transaction id of the on-chain step and its `block.timestamp`. Full documents travel in the audit bundle, not in the topic.
- Order: the topic's sequence number and consensus timestamp. The verifier reads them from the Mirror Node, together with `running_hash` and `running_hash_version` (the SDK receipt leaves the version empty, probe P3).

## Clocks

| Clock | Used for | Source |
|---|---|---|
| `block.timestamp` | Mandate validity, the escrow's `approvalDeadline`, the decision's `blockTimestamp` | The second of the block's first record (HIP-415; probe P2, 4 of 4) |
| HCS consensus timestamp | Order and time of each log message | Mirror Node, per message |
| Host server clock | The host's approval-call route refuses an approval after the deadline with `Date.now()` (`payments.ts:540`) | Not trusted by CoorRe |

Every decision records the first two. At `block.timestamp == approvalDeadline`, `approve` still passes and `expire` reverts (`PESEscrowV3.sol:236,256`); phase 2 tests that edge, and a call whose block began in the previous second.

## Roles and authorization

The host's `MANAGER` role (a JWT) covers more than approving: it also triggers scoring (`oracle.ts:50,368,424`) and the approval call. Under CoorRe the JWT only lets a user ask for a decision; the authority to decide comes from being a delegate of a registered mandate, checked on-chain. Recommendation to the host: the person who triggers a score should not be the delegate who approves it.

## Tooling

- Contracts: Hardhat 3. It installs from npm like the rest of the module, and runs Solidity tests and fuzz tests built in (hardhat.org, "Using Solidity tests"). Fuzz and unit tests run on its in-memory network every day; integration tests run against Solo in CI through the SDK and the relay. Foundry is not used: the brief admits it only if fuzz and invariant tests run against Solo, which neither tool does. Installing Hardhat is a new dependency, asked for at the start of phase 2.
- System contracts: none is needed for path A. HTS (0x167): no token is created or moved. Exchange Rate (0x168): no fee or value is converted. PRNG (0x169): nothing is random. Account Service (0x16a): CoorRe moves no HBAR and needs no allowance. Schedule Service (0x16b, HIP-755): a decision is executed when it is made, never later.

## Verification

For a Hedera case the verifier keeps checks 1, 2, 3 and 7 as they are and reads the anchor from a second source ([ADR-006](../decisions/ADR-006-neutral-anchor-source.md)): the CoorRe contract's state and events and the topic's messages, through the Mirror Node. Trust anchors ship with the verifier and never come from the bundle (ADR-002): the chain id, the CoorRe contract address, the escrow address and the topic id.

## Review by the environmental council

| Value | Proposal | Concern addressed |
|---|---|---|
| Quorum | 1 by default; the issuer may raise it | Today one financial manager decides; more signatures slow every payment to producers, so the host chooses |
| Validity | No default; set per mandate | A mandate without an end date would outlive the person it names |
| Autonomy limit | Empty for W.A.T.A. | No automated approval of a producer payment until the host sets a limit |
| Review | Recorded verdict, executed by the host | A period that misses its deadline is neither paid nor closed silently |
| Administration | Recorded, not enforced | Every admin action that changes who is paid or when is visible, without taking control from the host |
| Separation of duties | Recommended | The person who triggers a score does not approve the payment it leads to |
