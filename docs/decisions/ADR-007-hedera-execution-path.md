# ADR-007: Execution path of CoorRe on Hedera for a period escrow host

- Status: accepted (A reached through B; C discarded), approved by the maintainers on 2026-10-25
- Date: 2026-10-25

## Context
A period escrow host ([docs/hedera/SPEC.md](../hedera/SPEC.md#targets)) lets only its `financialManager` approve or reject a HYBRID period. That is usually one account, which the host's admin can replace at any time, and a decision is recorded only as an event, with no mandate, no evidence and no scope.

Three paths were open:

- **A**: a CoorRe contract is the financial manager. It checks the mandate and calls `approve`/`reject`. The host's escrow does not change.
- **B**: the financial manager's wallet keeps signing. CoorRe records the mandate and the decision, and the verifier checks that the on-chain call matches.
- **C**: a new host escrow with mandates built in.

Probe P1 on Solo: a contract set as financial manager is `msg.sender` for `approve` and `reject`, and a direct call by any other account reverts with `NotFinancialManager`.

## Decision
- **Path A**, reached through **path B**. B needs no change on the host's side except publishing decisions through CoorRe; A needs the host's admin to point the financial manager to the CoorRe contract.
- Path C is not pursued: A and B cover the case without changing the host's contract.
- Under A, CoorRe enforces the mandate for every decision that passes through it and detects, without preventing, any change of the financial manager by the admin ([THREAT_MODEL.md](../hedera/THREAT_MODEL.md), T7).

## Consequences
- The host's escrow keeps all its own checks; CoorRe adds the mandate, the scope, the validity, the anti-replay binding to `auditHash`, the quorum and the autonomy limit.
- Each integration runs in the host's private environment, with the host's private profile and accounts; this repository carries the generic engine and a fictitious example only.
- Claims stay within what holds: the host's admin can remove CoorRe as financial manager, and the texts say so.
