# CoorRe on Hedera ↔ W.A.T.A. integration (proposal)

Portuguese version: [integracao-wata.md](integracao-wata.md).

This document is a **proposal** for the W.A.T.A. team. Nothing here has been applied to the [vivipolli/wata](https://github.com/vivipolli/wata) repository, its accounts or its contracts. CoorRe read the W.A.T.A. code for reference only, at commit `1462dfeb3d492893331dc5c0b0eae15d91ec807c`, pinned in [wata.lock.json](../hedera/reference/wata.lock.json).

What runs today: the full flow below, on a local Solo network in CI, against PESEscrowV3 built from that commit with W.A.T.A.'s compiler settings (bytecode identical to the artifact W.A.T.A. committed). Nothing runs on testnet yet.

## What CoorRe does and does not do

- CoorRe answers for one moment of the process: the decision to approve or reject a HYBRID period in `PendingApproval`, taken under a mandate and with public proof.
- The business rules stay with W.A.T.A.: score, `scoreThreshold`, `periodAmount`, `approvalWindow`, deadlines, tokenization. CoorRe reads these values and never sets or changes them.
- PESEscrowV3 does not change. No line of the W.A.T.A. contract needs to be edited.
- CoorRe does not hold or move HBAR. The funds stay in the escrow, and `release` stays as it is.

Full specification: [docs/hedera/SPEC.md](hedera/SPEC.md). Threats and controls: [docs/hedera/THREAT_MODEL.md](hedera/THREAT_MODEL.md). Execution path: [ADR-007](decisions/ADR-007-hedera-execution-path.md).

## The interface (adapter)

[hedera/adapter/wata.mjs](../hedera/adapter/wata.mjs), function `prepareDecision(input, context)`.

Input, all produced inside W.A.T.A.:

```json
{
  "hostId": "wata",
  "decisionPoint": "approve-or-reject-period",
  "agreementId": "0",
  "periodId": "1",
  "auditHash": "60e923175e060c671d4191c337ba6a6936e3c6120aa9a304e5918c51f33cdd8b",
  "score": 80,
  "scoreVersion": 1
}
```

Context: `network` (`solo` or `testnet`), `escrow`, `gate` (path A only), `mandateId`, `delegate` (EVM address of the signer), `verdict` (`approve` or `reject`), `mode` (`A` or `B`).

Output: plain JSON, no SDK types. It carries `call.to`, `call.function`, `call.selector`, `call.abi`, `call.callData` (hex) and `call.value` (`"0"`); the `decisionDocument`, the `evidenceHash` (SHA-256 of the document's JCS form), the `case_ref`/`case_id` and the `logMessage` (at most 1024 bytes) for the CoorRe topic. The server never signs, as is already the case in the `POST /api/payments/approval-call/:agreementId` route (`backend/src/routes/payments.ts:514-560`).

Note: the adapter uses `@hiero-ledger/sdk` 2.90.1 internally to build the call data. W.A.T.A. uses `@hashgraph/sdk`; since only JSON crosses the interface, the two never mix.

## What W.A.T.A. needs to define first

| Item | Where it goes |
|---|---|
| PESEscrowV3 address on testnet | `targets` in the profile ([wata.json](../hedera/host-profiles/wata.json)) |
| Delegate accounts (the financial manager's people) and, if any, agents with an autonomy limit | Mandate document |
| Validity of each mandate (`validFrom`, `validUntil`) | Mandate document |
| Quorum (default 1) | Mandate document |
| Who holds the CoorRe log operator key | Joint decision of both teams |

## Proposed steps

### 1. Path B: record without changing anything on-chain

- The financial manager's wallet keeps signing `approve`/`reject` on the escrow.
- The approval-call route calls `prepareDecision(..., { mode: "B" })` and returns, besides today's call data, the `decisionDocument`, the `evidenceHash` and the `logMessage`.
- After the transaction, the `logMessage` and the transaction id go to the CoorRe HCS topic. W.A.T.A.'s current topic (`backend/src/services/hcs.ts:59-69`) stays as it is.
- What this already proves: the wallet approves with the adapter's call data, the `PeriodApproved` event names the same account named in the decision, and the message on the Mirror Node is byte-identical to the one sent (verified on Solo).

### 2. Deploy the mandate contract

- `CoorReMandateGate` ([hedera/contracts/CoorReMandateGate.sol](../hedera/contracts/CoorReMandateGate.sol)) takes only the escrow address in its constructor. It is not upgradeable and has no payable function.
- On testnet, deploying it and verifying it publicly on HashScan spend HBAR. That only happens with the explicit approval of the CoorRe maintainers.

### 3. Register the mandate

- The escrow admin (the 2-of-3 account, decision D5) calls `registerMandate`. The call data comes from [hedera/lib/gate.mjs](../hedera/lib/gate.mjs).
- The full mandate document goes to the CoorRe topic with the same `mandateId`.

### 4. Point the financial manager to the contract

- The 2-of-3 admin calls `setFinancialManager(<contract address>)`.
- From then on, the wallet that used to approve directly is refused by the escrow (`NotFinancialManager`), as verified on Solo.
- The change is public in the `FinancialManagerChanged` event and is recorded on the CoorRe topic.

### 5. Path A: decide through the contract

- The approval-call route calls `prepareDecision(..., { mode: "A", gate })` and returns `call.to` = the mandate contract and `call.callData` for `decide(...)`.
- The delegate's wallet signs and sends. The contract checks the mandate, its validity, the scope, the pending period, the batch's `auditHash`, the batch's submitter and the quorum, and only then calls `approve` or `reject` on the escrow.
- Verified on Solo: approval and rejection through the contract, a repeated decision refused, a decision on a period in review refused.

### 6. Periods in review (InReview)

- After the deadline, any account can call `expire`, and the period moves to `InReview`.
- The delegate records a review verdict on the topic: `resubmit` (with the reason) or `close-no-pay`.
- W.A.T.A. executes it: the oracle resubmits with a new `auditHash`, or the admin calls `closeNoPay`.
- Verified on Solo: an expired period, a decision refused while in review, a recorded `resubmit` verdict, and a new batch from the oracle back to `PendingApproval`.

### 7. Administrative actions

- `setFinancialManager`, `setApprovalWindow`, `createAgreement`, `deactivateAgreement`, `closeNoPay`, `refund`, `withdrawExcess`, `pause`, `unpause`, `proposeAdmin` and `acceptAdmin` stay with the W.A.T.A. admin.
- Each one is announced on the CoorRe topic, and the verifier lists any administrative event without a record.

## Recommendations

- **Separation of duties:** today the `MANAGER` role triggers the score (`backend/src/routes/oracle.ts:50,368,424`) and also requests the approval. The person who triggers a score should not be the delegate who approves the payment.
- **Deadline:** the approval-call route compares the deadline with the server clock (`payments.ts:540`). What decides is `block.timestamp`; at the exact deadline, `approve` still passes (`PESEscrowV3.sol:236`).
- **Unit:** through the SDK, the escrow records amounts in tinybar (verified on Solo, probes P5). That settles the "MUST be verified" note of `PESEscrowV3.sol:14-16` for that path.
- **EVM wallets through the relay:** two points verified on Solo. (1) The fee ethers estimated (142 wei) was below the relay's minimum (710000000000 weibar) and the transaction was refused; price it with the relay's `eth_gasPrice`. (2) Native Hedera transactions do not advance an account's EVM nonce, and the Mirror Node shows them in EVM form with nonce 0; if the same account also uses the SDK, ethers' `tx.wait()` can report "transaction was replaced". Wait for the receipt by the transaction's own hash.

## Declared limitations

- Two of the three admins can remove CoorRe from the financial manager role at any time. CoorRe detects this (`FinancialManagerChanged` event) but does not prevent it.
- The audit document stays in the W.A.T.A. database. CoorRe proves which document the decision named, not that the measurements in it are true.
- Sending from a wallet through JSON-RPC is verified on Solo: a wallet holding the delegate's ECDSA key signs the adapter's call data with `ethers` and sends it through the relay; the mandate contract records that wallet as the delegate and the escrow approves. Browser wallets (for example MetaMask) were not tested.

## How to check

In the `hedera/` folder:

```bash
npm ci
```

```bash
npm run wata:fetch && npm run probes:compile && npm run build:contracts
```

```bash
npm test && npm run test:contracts && npm run check:protections
```

The Solo flow runs in the `Hedera probes on Solo` workflow (`.github/workflows/hedera-solo.yml`); the report is in the `hedera-probe-report` artifact (`integration/report.json`).
