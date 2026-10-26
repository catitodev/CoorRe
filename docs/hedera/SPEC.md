# CoorRe on Hedera — specification

Status: the mandate contract, the decision adapter and the network probes run on a local Solo network in CI against a reference host escrow ([PHASE0.md](PHASE0.md), run 40326559898): mandate, decision, execution, a wallet over JSON-RPC, review and the HCS log. Integrations with real hosts run in their own private environments. The Hedera source of the verifier and testnet are next steps. Mainnet is out of scope.

CoorRe on Hedera is one application of the CoorRe engine ([APPLICATIONS.md](../APPLICATIONS.md)). It answers for one moment of a host's process, the decision under mandate: who may decide what, under which mandate, with which evidence, and the public proof of it. The host keeps its business rules (scores, thresholds, amounts, deadlines, validity, tokenization); CoorRe reads them from a host profile and never sets or changes them.

This repository carries the generic engine only. A host's profile, addresses, accounts, mandates, deploy records and any analysis of its system live in the host's private environment, never here.

## Host profile

A host hands CoorRe its input through a profile that follows [host-profile.schema.json](../../hedera/spec/host-profile.schema.json) (`coorre-host-profile/1`). The repository ships a fictitious profile, [example.json](../../hedera/host-profiles/example.json), whose host is the reference escrow below. Each value carries a source:

- `host-code`: a fact read in the host's code, cited as `path:lines`;
- `host-onchain`: a value CoorRe reads from the host's contract when it decides;
- `coorre-proposal`: a CoorRe governance proposal, defined in this document.

`hedera/test/host-profile.test.mjs` checks that the profile validates, that no field is left unfilled, that it carries no host business value, that every `host-code` source names an existing file and line range, that every `coorre-proposal` source points to a heading of this document, and that every selector matches the compiled contract.

## Targets

The host contract is a **period escrow**: agreements with a period amount and a score threshold; an authorized oracle submits each period's score with the SHA-256 of its audit document; in HYBRID mode a period that meets the threshold waits for the escrow's `financialManager` to approve or reject it before a deadline. [IPeriodEscrow.sol](../../hedera/contracts/IPeriodEscrow.sol) is the interface CoorRe needs; [ReferencePeriodEscrow.sol](../../hedera/contracts/reference/ReferencePeriodEscrow.sol) is a reference implementation written for the tests and the Solo runs. A host's address enters its private profile when the host publishes it; CoorRe never deploys a host's contract on testnet.

## Decision point

`approve-or-reject-period`:

- Trigger: a HYBRID period is `PendingApproval`.
- Inputs, all produced inside the host: `agreementId`, `periodId`, `auditHash`, `score`, `scoreVersion`.
- Actions: `approve(uint256,uint256)` (`0x5d35a3d9`) and `reject(uint256,uint256)` (`0x86b2375c`), callable only by the escrow's `financialManager`.
- Deadline: `approvalDeadline = block.timestamp + approvalWindow` at submission. CoorRe reads `approvalWindow()` and the period's `approvalDeadline` on-chain and holds no copy of either.
- Modes: HYBRID only. In AUTO the escrow approves at submission and there is no decision to make.

## Mandate

A mandate is a document the issuer signs and registers on-chain before any decision uses it.

| Field | Meaning |
|---|---|
| `mandateId` | SHA-256 of the JCS form of the mandate document (RFC 8785, as every CoorRe hash) |
| `hostId` | The host's identifier |
| `issuer` | The account that registers the mandate: the escrow's current `admin()`, normally a threshold key chosen by the host. A mandate is valid only while its issuer is still the escrow's admin; after a change of admin it authorizes nothing, and the new admin registers a new one |
| `delegates` | At most 20 accounts that may decide, each with its kind (`human` or `agent`) |
| `quorum` | Number of distinct delegates whose decisions are needed before CoorRe executes; default 1, the issuer may set more |
| `scope` | Escrow address, agreement ids (a list of at most 100, or all agreements of that escrow), modes (`HYBRID`), verdicts (`approve`, `reject`, `review`) |
| `validFrom`, `validUntil` | Unix seconds, compared with `block.timestamp`; set by the issuer for each mandate, no default. Registration refuses a duration above the cap fixed when the contract is deployed (a constructor parameter, 90 days by default), a mandate already expired and a start date more than one day in the past |
| `autonomyLimit` | Optional, see below |
| `evidenceRule` | The host document a decision must name |

Issuing: the issuer's account calls the CoorRe contract to register `mandateId` and the fields the contract enforces. The registration is the proof of issue, signed by the issuer's own keys and visible on the Mirror Node. The topic carries only `mandateId` and the registration's transaction id; the mandate document stays with the parties.

Revocation: the escrow's current admin or the original issuer revokes. Revoking only reduces authority, so the original issuer can always take down a mandate it created. A revoked mandate authorizes nothing from the block of its revocation on; earlier decisions stay valid and keep pointing to it. Replacing a delegate means revoking the mandate and registering a new one.

### Autonomy limit

The engine's rule, unchanged: an automated actor cannot approve above its autonomy limit; only a human approver can. A mandate may name an `agent` delegate and an `autonomyLimit` in tinybar (the unit a contract sees for HBAR sent through the SDK, probe P5). The contract rejects an agent's approval when the agreement's `periodAmount` exceeds the limit, with `MandateExceeded`, the same name and meaning as the Solana program (`onchain/programs/coorre_anchor/src/lib.rs:148-150`). An agent may only approve; a human is never bound by the limit. The limit is the host's value; an empty limit means only humans decide.

## Decision

A decision is the tuple

`(hostId, decisionPoint, agreementId, periodId, auditHash, scoreVersion, verdict, mandateId, evidenceHash, blockTimestamp)`

- `auditHash` binds the decision to the exact batch the oracle submitted. The contract reads the period and refuses a decision whose `auditHash` differs, which prevents replaying a decision in another period or on a resubmitted batch.
- `evidenceHash` is the SHA-256 of the JCS form of the decision document: a W3C Verifiable Credential signed with eddsa-jcs-2022, as in the engine (`coorre-model`). It names the host's audit document as an artifact by the SHA-256 of its raw bytes, which is the `auditHash`; CoorRe never re-canonicalizes the host's document.
- `blockTimestamp` is the `block.timestamp` of the decision transaction; the HCS message adds its own consensus timestamp.
- Case reference: `urn:coorre:case:<hostId>:<chainId>:<escrow address>:<agreementId>:<periodId>`; `case_id = SHA-256(case_ref)`, as in the engine (`coorre-model/src/evidence.rs:302`).

### States

The period's states stay the host's. CoorRe opens a case when it observes a period in `PendingApproval`; that observation, with the submission transaction and the audit document, is the case's first evidence. From there the engine's states apply:

| CoorRe transition | Who | Effect on the escrow |
|---|---|---|
| ESCALATED → APPROVED | human delegate | `approve` |
| ESCALATED → REJECTED | human delegate | `reject` |
| ESCALATED → AUTO_APPROVED | agent delegate within the autonomy limit | `approve` |

## Execution

Path A, reached through path B ([ADR-007](../decisions/ADR-007-hedera-execution-path.md)).

**A.** [CoorReMandateGate.sol](../../hedera/contracts/CoorReMandateGate.sol) is the escrow's `financialManager`. For each decision it checks, in order:

1. the mandate is registered, not revoked, `validFrom ≤ block.timestamp ≤ validUntil`, and its issuer is still the escrow's admin;
2. the caller is a delegate of the mandate and is not the account that submitted the period;
3. the agreement, the HYBRID mode and the verdict are in the mandate's scope;
4. the period is `PendingApproval`, its `auditHash` equals the decision's, and `block.timestamp` is not past its approval deadline (for approvals and for rejections alike);
5. an agent delegate approves only within the autonomy limit (`MandateExceeded`);
6. this delegate has not decided this period before, and the quorum is reached;

then it calls `approve` or `reject` and emits `DecisionAnchored` with `mandateId` and `evidenceHash`. Its errors are `NotIssuer`, `IssuerNotAdmin`, `InvalidTerms`, `MandateExists`, `UnknownMandate`, `MandateNotActive`, `UnauthorizedActor`, `OutOfScope`, `PeriodNotPending`, `PeriodNotInReview`, `AuditHashMismatch`, `DeadlinePassed`, `SubmitterCannotDecide`, `MandateExceeded`, `AlreadyDecided` and `InvalidVerdict`. Votes are counted per verdict; a quorum that is not reached, for example two delegates who disagree with a quorum of 2, leaves the period to its deadline, where `expire` sends it to review and nothing is paid. Partial votes are tied to the period and to the batch's `auditHash`, so they end with the deadline or with a resubmission. It is not upgradeable and has no payable function. The escrow keeps all its own checks. Probe P1 shows that an escrow sees the calling contract as `msg.sender`.

**B.** The financial manager's wallet keeps signing `approve`/`reject`; CoorRe records the mandate and the decision (hashes on the topic) and the verifier checks that the on-chain call matches a recorded decision by a delegate in scope. B proves; A proves and enforces.

**C.** A new host escrow with mandates built in is not proposed: A and B cover the case without changing the host's contract.

### Admin governance under path A

The escrow's admin can replace the financial manager at any time. CoorRe does not prevent it and does not claim to. It detects it: the verifier reads every `FinancialManagerChanged` event and reports any approval or rejection emitted while the financial manager was not the CoorRe contract as outside the mandate. The CoorRe contract is not upgradeable; a replacement is a new address the issuer has to register again.

## Review

After the deadline, anyone can call `expire`, which moves the period to `InReview`. Without changing the escrow:

1. a human delegate under a mandate whose scope allows review calls `recordReview` with an outcome (`resubmit` or `close-no-pay`) and the evidence hash of a review document that carries the reason. The gate checks the same things as for a decision (valid mandate bound to the current admin, delegate, agreement in scope, HYBRID mode, the batch's hash, a delegate who did not submit it, the quorum), requires the period to be `InReview`, **does not call the escrow** and emits `ReviewRecorded`. Agents cannot record a review;
2. the host executes the outcome with its own roles: its oracle submits a new batch with another `auditHash`, or its admin closes the period without payment;
3. the verifier checks that the next on-chain event of the period matches the recorded outcome. A resubmission needs a new decision on the new hash.

## Administration

The escrow's administrative actions stay with the host's admin. Policy: **recorded, not enforced**. Each action is announced on the CoorRe topic with its transaction id, and the verifier lists every administrative event with or without a matching record.

## Log

- One HCS topic owned by CoorRe for each host, never the host's own topic.
- `submitKey`: the CoorRe log operator key, kept in the host's private environment. Probe P4: a message without it fails with `INVALID_SIGNATURE`.
- `adminKey`: none, so the topic cannot be updated or deleted (probe P4). If the operator key has to change, CoorRe opens a new topic and announces it in a final message of the old one.
- Messages: one JSON object in JCS form, at most 1024 bytes (probe P3). They carry **ids and hashes only**: kind (`mandate`, `revocation`, `decision`, `review`, `admin`, `rotation`), `hostId`, `case_ref` or `mandateId`, `evidenceHash`, `auditHash`, the verdict, the delegate address and the transaction id. Documents (mandate, decision credential, audit document) travel to the parties and in audit bundles, never in the topic.
- Order: the topic's sequence number and consensus timestamp, read from the Mirror Node with `running_hash` and `running_hash_version`.

## Clocks

| Clock | Used for | Source |
|---|---|---|
| `block.timestamp` | Mandate validity, the escrow's deadline, the decision's `blockTimestamp` | The second of the block's first record (HIP-415; probe P2) |
| HCS consensus timestamp | Order and time of each log message | Mirror Node, per message |
| Host server clock | Any off-chain deadline check a host does | Not trusted by CoorRe |

At `block.timestamp == approvalDeadline`, `approve` still passes in the reference escrow; the tests cover that edge.

## Accounts

One account per role: the host's admin, the host's oracle, the host's financial manager or delegates, the CoorRe operator that deploys the contract, and the CoorRe log operator. The testnet deploy script refuses to run when the CoorRe operator is any of the host's accounts.

## Tooling

- Contracts: Hardhat 3 (npm; Solidity tests and fuzz tests built in). Fuzz and unit tests run on its in-memory network; network tests run against Solo in CI. Telemetry is disabled in every script.
- Verification on testnet: Sourcify (`https://sourcify.dev/server`, chain 296), as the Hedera documentation now directs, with the CoorRe sources only.
- System contracts: none is needed. HTS: no token. Exchange Rate: no conversion. PRNG: nothing random. Account Service: CoorRe moves no HBAR. Schedule Service: a decision executes when it is made.

## Verification

For a Hedera case the verifier keeps checks 1, 2, 3 and 7 and reads the anchor from a second source ([ADR-006](../decisions/ADR-006-neutral-anchor-source.md)): the CoorRe contract's state and events and the topic's messages, through the Mirror Node. Trust anchors ship with the verifier and never come from the bundle (ADR-002): chain id, CoorRe contract address, escrow address and topic id.

## Governance values

| Value | Proposal | Concern addressed |
|---|---|---|
| Quorum | 1 by default; the issuer may raise it | More signatures slow every payment, so the host chooses |
| Validity | No default; set per mandate | A mandate without an end date would outlive the person it names |
| Autonomy limit | Empty unless the host sets it | No automated approval of a payment until the host decides |
| Review | Recorded verdict, executed by the host | A period that misses its deadline is neither paid nor closed silently |
| Administration | Recorded, not enforced | Every admin action that changes who is paid or when is visible |
| Separation of duties | Required for accounts, recommended for people | The person who triggers a score should not approve the payment it leads to |
