# Web2 mode (design only)

Status: design. Nothing in this document is implemented, and no code for this mode lives in this repository. The code will be written only after the repository that will hold it is chosen.

## Goal

Some processes need provable decisions but involve no payment on a blockchain: a document review, a compliance sign-off, an internal approval. Web2 mode keeps the CoorRe evidence model and the verifier and replaces the on-chain anchor with a signed witness log. No RPC call and no transaction fee.

## What stays the same: the open core in this repository

| Crate or file | Reused as is |
|---|---|
| `coorre-model` | Evidence as W3C Verifiable Credentials, RFC 8785 canonical JSON, SHA-256 hashes, eddsa-jcs-2022 proofs, did:key, case_id = sha256(case_ref) |
| `coorre-engine` | The rule registry and the rules, rule evaluation, the state machine and `CaseTracker` (roles, previous-hash chain, `MandateExceeded`, `UnauthorizedActor`) |
| `coorre-verify` checks 1, 2, 3 and 7 | Artifact digests, evidence hashes, proofs and reproduced decisions do not depend on where the anchor lives |
| `coorre-verify` checks 4 and 5 | Signer binding and the chain replay, once the role keys and the case state come from the witness log instead of a CaseRecord account |
| Audit bundle format (`coorre-audit-bundle/1`) | Unchanged, except that `network_id` names the witness and the receipts carry witness entries |
| Browser verifier | Same page and the same WebAssembly, with a second anchor source |

## What would be proprietary (separate repository)

- The hosted witness service: it receives anchor requests, runs `CaseTracker` before accepting each transition, appends to the log and signs each entry.
- Case orchestration for organisations: intake of documents, task queues for each role, notifications.
- Integrations with document systems, ERPs and identity providers.
- Key custody for the role keys and the witness key, tenants and access control.

This repository has no such code, and that repository does not exist yet.

## Changes to the anchoring interface (open, in this repository, when the mode is built)

The `Anchorer` trait ([coorre-anchor/src/lib.rs](../../offchain/crates/coorre-anchor/src/lib.rs)) is neutral in its writes: `open_case` and `anchor_transition` take hashes, keys and amounts and return a `Receipt` with a `network_id`. Its read side and the verifier are Solana-shaped:

1. `fetch_account` returns `AccountSnapshot { owner, data }`: raw account bytes plus an owner program. A neutral read would return an anchor record: case_id, the four role keys, amount, autonomy limit, state, and for each transition the evidence hash, previous hash, states, actor, rule hash and time, together with the proof of where the record came from.
2. `coorre-verify` decodes Anchor account layouts and requires `owner == program` ([verify.rs](../../offchain/crates/coorre-verify/src/verify.rs), `owned`, `check_signers`, `check_chain`, `check_onchain`). The verifier input would carry an anchor source with two variants: Solana accounts, checked as today, and a witness log, checked by the witness's Ed25519 signature on each entry.
3. The expected witness key becomes a trust anchor shipped with the verifier, like the expected program id today (ADR-002). It never comes from the bundle.
4. Check 6 keeps its meaning (the anchor holds exactly the recomputed values) with one owner rule per source.

## What changes in trust

| Property | CoorRe on Solana | Web2 mode |
|---|---|---|
| Who enforces roles and the mandate | The program, before anything is recorded | The witness service, before it signs |
| Can the operator break the rule? | No: the program rejects the transaction | Yes, if it controls the witness; the verifier detects it afterwards (check 5 replays the transitions and reports `MandateExceeded` or `UnauthorizedActor`) |
| Can history be rewritten? | Not without rewriting the chain | Only if the log is not published. The log has to be append-only, with signed heads published where others keep copies |
| Cost and dependency | Transaction fees and rent, a public RPC | None beyond the witness service |

Web2 mode is weaker than the on-chain mode on enforcement and stronger on cost and privacy. A middle path, already on the roadmap, is to batch the witness log into Merkle roots anchored on a public chain from time to time.
