# ADR-007: Execution path of CoorRe on Hedera for W.A.T.A.

- Status: accepted (A reached through B; C discarded), approved by the maintainers on 2026-10-25
- Date: 2026-10-25

## Context
W.A.T.A.'s PESEscrowV3 lets only its `financialManager` approve or reject a HYBRID period (`PESEscrowV3.sol:231-249`). Today that is one account, which the admin can replace at any time (`PESEscrowV3.sol:347-351`); the admin is a 2-of-3 threshold account (host decision D5). A decision is recorded only as an event, with no mandate, no evidence and no scope.

Three paths were open:

- **A**: a CoorRe contract is the financial manager. It checks the mandate and calls `approve`/`reject`. PESEscrowV3 does not change.
- **B**: the financial manager's wallet keeps signing. CoorRe records the mandate and the decision, and the verifier checks that the on-chain call matches.
- **C**: a new escrow version with mandates built in.

Phase 0 probe P1 ran on Solo: a contract set as financial manager is `msg.sender` for `approve` and `reject`, and a direct call by the admin reverts with `NotFinancialManager`.

## Decision
- **Path A**, reached through **path B**. B needs no change on the host's side except publishing the decision through CoorRe; A needs the host's admin to call `setFinancialManager` with the CoorRe contract address.
- Path C is not pursued: A and B cover the case without changing the host's contract.
- Under A, CoorRe enforces the mandate for every decision that passes through it and detects, without preventing, any change of the financial manager by the admin ([THREAT_MODEL.md](../hedera/THREAT_MODEL.md), T7).

## Consequences
- The escrow keeps all its own checks; CoorRe adds the mandate, the scope, the validity, the anti-replay binding to `auditHash`, the quorum and the autonomy limit.
- The integration is a proposal for the host team (phase 3): nothing is applied in the host's repository or on its accounts.
- Claims stay within what holds: two of the host's admin keys can remove CoorRe as financial manager, and the texts say so.
