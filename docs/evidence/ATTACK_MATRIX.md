# Attack matrix

Offline attacks on the ten recorded devnet cases. Nothing is written to devnet. Each attack changes a real bundle, its documents or the recorded accounts in [devnet-snapshot/accounts.json](devnet-snapshot/accounts.json), then runs the same verifier as the CLI and the browser. The attacks are automated tests in [offchain/crates/coorre-cli/tests/attack_matrix.rs](../../offchain/crates/coorre-cli/tests/attack_matrix.rs) and run on every `cargo test`.

Run on 2026-10-10 against commit 6c3ae4d plus the working tree that adds this file. Before any change, SUP-001, SUP-002 and MIL-002 pass 7 of 7 checks (`baseline` test), as do the other seven cases (`devnet_snapshot` test).

The seven checks: 1 artifact digests, 2 evidence hash and rule document, 3 Ed25519 proof, 4 signer bound to the on-chain role key, 5 hash chain from genesis, 6 on-chain match, 7 automated decisions reproduced from the rule.

## Blocked

| # | Attack | How it was done | Checks that fail |
|---|---|---|---|
| A01 | Change one byte of a document | Flip one bit of byte 10 of SUP-001 `environmental-license.json` | 1, 7 |
| A02 | Move a credential from one case to another | Put SUP-002's SUBMITTED credential in SUP-001, keeping SUP-001's anchor address | 1, 2, 5, 6 |
| A03 | Move a credential together with its anchor | Put SUP-002's SUBMITTED credential and its anchor address in SUP-001 | 1, 2, 5, 6 |
| A04 | Reuse the anchor of another case | Point SUP-001 evidence 3 at SUP-002's evidence 3 anchor | 6 |
| A05 | Remove a link from the hash chain | Drop MIL-002's AGENT_REVIEWED credential (4 links become 3) | 5, 6 |
| A06 | Change the rule | Edit the `validity` field of the supplier-docs v1 rule inside the SUP-001 bundle | 2 |
| A07 | Sign a step with a key that does not hold the role | Re-sign SUP-002's ESCALATED → APPROVED credential with an outside key, with a valid proof | 4, 5, 6 |
| A08 | Invalid signature | Change the last character of SUP-001 evidence 1 `proofValue` | 3, 4 |
| A09 | Credential without an anchor | Remove SUP-001 evidence 2's anchor account from the recorded accounts | 4, 6 |
| A10 | Approve above the mandate without the human approver | Rewrite SUP-002 (0.2 SOL, limit 0.1 SOL) to AGENT_REVIEWED → AUTO_APPROVED with an outside key and drop the approver step | 4, 5, 6, 7 |
| A11 | Same as A10, with the real rule engine key | Replay SUP-002 with the four role keys read from its on-chain case record; the rule engine key takes AGENT_REVIEWED → AUTO_APPROVED | `MandateExceeded` |
| A12 | Release an escalated case without the approver | Same replay; submitter, agent and rule engine keys each try ESCALATED → APPROVED | `UnauthorizedActor` for all three |

Notes on what the results show:

- A04: check 4 still passes because the demo uses the same role keys in every case, so the borrowed anchor records the right key. Check 6 catches it because the anchor belongs to another case record and holds another hash, previous hash and states.
- A07 and A10 use an outside key. The private role keys stay in `.local/` and are never used in tests, so the stolen-key case cannot be reproduced offline. The check that blocks the wrong role (check 4) compares the signer with the role key stored on chain, whoever holds the signing key.
- A11 and A12 run the off-chain mirror of the program (`coorre-engine`, same check order as `anchor_transition`) with the real public role keys of SUP-002. On devnet, the program itself rejected the same attempt with the real rule engine key in simulation, with `MandateExceeded` and no transaction, for SUP-002, AGT-002 and PES-002 (see [onchain/DEPLOYMENTS.md](../../onchain/DEPLOYMENTS.md)).

## Real output

```
ATTACK A01 one byte of a SUP-001 document flipped
  result: 5/7 checks passed, failing [1, 7]
  [FAIL] 1 Artifact digests match: environmental-license.json: sha256 of the file is fb246a8cf88f0a978ba73ca6ed754bb69dca0388981c354b72c34d96633c8b4e, evidence declares 0eab0e432f789d888382e09bc51f2e1f4149e4aa8969bd490681f2a8ebd1aa42
  [FAIL] 7 Automated decisions reproduced from the rule: evidence 3: decision cannot be reproduced: environmental-license.json: invalid rule input: document format: unknown field `synthdtic`, expected one of `synthetic`, `kind`, `supplier`, `issuer`, `number`, `valid_from`, `valid_until`
ATTACK A02 SUP-002's SUBMITTED credential placed in SUP-001 (anchor address kept)
  result: 3/7 checks passed, failing [1, 2, 5, 6]
  [FAIL] 1 Artifact digests match: tax-certificate.json is declared with two different digests
  [FAIL] 2 Evidence hash recomputed (JCS + SHA-256): evidence 1: belongs to case urn:coorre:case:SUP-002-20261008T193251Z, not urn:coorre:case:SUP-001-20261008T193251Z
  [FAIL] 5 Hash chain continuous from genesis: evidence 1: previousEvidence does not point to evidence 0
  [FAIL] 6 On-chain match (owner, discriminator, content): evidence 1: mandate differs from the on-chain amount/limit
ATTACK A03 SUP-002's SUBMITTED credential and its anchor placed in SUP-001
  result: 3/7 checks passed, failing [1, 2, 5, 6]
  [FAIL] 1 Artifact digests match: tax-certificate.json is declared with two different digests
  [FAIL] 2 Evidence hash recomputed (JCS + SHA-256): evidence 1: belongs to case urn:coorre:case:SUP-002-20261008T193251Z, not urn:coorre:case:SUP-001-20261008T193251Z
  [FAIL] 5 Hash chain continuous from genesis: evidence 1: previousEvidence does not point to evidence 0
  [FAIL] 6 On-chain match (owner, discriminator, content): evidence 1: mandate differs from the on-chain amount/limit
ATTACK A04 SUP-001 evidence 3 pointed at SUP-002's evidence 3 anchor
  result: 6/7 checks passed, failing [6]
  [FAIL] 6 On-chain match (owner, discriminator, content): evidence 3: on-chain anchor differs in evidence_hash, case_record, prev_hash, states
ATTACK A05 MIL-002 agent review removed (4 links become 3)
  result: 5/7 checks passed, failing [5, 6]
  [FAIL] 5 Hash chain continuous from genesis: evidence 2: previousEvidence does not point to evidence 1
  [FAIL] 6 On-chain match (owner, discriminator, content): case record has 4 transitions, bundle has 3
ATTACK A06 supplier-docs v1 rule in the SUP-001 bundle edited
  result: 6/7 checks passed, failing [2]
  [FAIL] 2 Evidence hash recomputed (JCS + SHA-256): evidence 1: rule hash does not match the included rule document
ATTACK A07 SUP-002 approver step re-signed by a key that is not the approver
  result: 4/7 checks passed, failing [4, 5, 6]
  [FAIL] 4 Signer bound to the on-chain role key: evidence 4: signed by uY46ibBrA5pEsx4z8iiQ6BpNeBuMR6weo4u2ubREB9q but the on-chain approver key is FMn9kaTjuar4URdxcNjxHQr2SJjDfdMvk29b6qZ91ie2
  [FAIL] 5 Hash chain continuous from genesis: evidence 4: replay rejected: signer is not the role key required for this transition
  [FAIL] 6 On-chain match (owner, discriminator, content): case record last_evidence_hash differs from the last evidence
ATTACK A08 last character of SUP-001 evidence 1 proofValue changed
  result: 5/7 checks passed, failing [3, 4]
  [FAIL] 3 Ed25519 eddsa-jcs-2022 proof valid: evidence 1: signature verification failed
  [FAIL] 4 Signer bound to the on-chain role key: evidence 1: no valid proof to bind
ATTACK A09 SUP-001 evidence 2 presented without its anchor account
  result: 5/7 checks passed, failing [4, 6]
  [FAIL] 4 Signer bound to the on-chain role key: evidence 2: on-chain anchor unavailable
  [FAIL] 6 On-chain match (owner, discriminator, content): evidence 2: account G35R7tEc1aJiVoE72rF8T5vA6sUCGSqFZ56WeaU4ktsd was not provided
ATTACK A10 SUP-002 (0.2 SOL, limit 0.1 SOL) rewritten to AUTO_APPROVED, approver step dropped
  result: 3/7 checks passed, failing [4, 5, 6, 7]
  [FAIL] 4 Signer bound to the on-chain role key: evidence 3: signed by uY46ibBrA5pEsx4z8iiQ6BpNeBuMR6weo4u2ubREB9q but the on-chain rule_engine key is 6296obD4FzBygg2BiC2K2DAyEtCLbDNvDEmXvMTg4AGc
  [FAIL] 5 Hash chain continuous from genesis: evidence 3: replay rejected: signer is not the role key required for this transition
  [FAIL] 6 On-chain match (owner, discriminator, content): case record has 4 transitions, bundle has 3
  [FAIL] 7 Automated decisions reproduced from the rule: evidence 3: the rule gives ESCALATED but AUTO_APPROVED was recorded; reasons recorded [] but the rule gives [environmental license expired; amount exceeds autonomy limit]
ATTACK A11 SUP-002 replayed with its on-chain role keys; rule_engine key takes AGENT_REVIEWED -> AUTO_APPROVED
  result: Err(MandateExceeded)
ATTACK A12 SUP-002 ESCALATED -> APPROVED attempted by each non-approver role key
  submitter: Err(UnauthorizedActor)
  agent: Err(UnauthorizedActor)
  rule_engine: Err(UnauthorizedActor)
```

## Gaps (not blocked today)

| Attack | Why it passes | What would close it (next step) |
|---|---|---|
| False source document | Check 7 proves the decision follows the rule for the documents given, not that a document is genuine. All the documents in the ten cases are synthetic and they pass 7 of 7. | Documents signed by a real issuer or registry, checked like the evidence proofs. |
| Stolen role key | A signature made with a stolen key is identical to one made by its owner. Checks 3, 4 and 6 pass. | Key custody outside the operator (hardware keys, multisig for the approver), key rotation and revocation recorded on chain. |
| Collusion | The creator chooses the four role keys when opening a case. The program enforces four distinct keys, not four distinct people. In this build all demo keys are operated by the CoorRe team. An approver acting together with the creator can release any escalated case. | Role keys bound to identities by a party other than the creator; approver under multisig. |
| Human approval quality | The approver's decision and justification are signed and anchored, but no rule reproduces them, so check 7 does not judge them. | Out of scope by design: the exception is a human decision, recorded and attributable. |
| Trust in an offline snapshot | Offline verification proves agreement with the recorded accounts. Whoever records them could forge them. | Re-check the transaction signatures and slots in [devnet-snapshot/signatures.json](devnet-snapshot/signatures.json) against the chain or an archive of it. |

## Reproduce

```bash
cd offchain && cargo test -p coorre-cli --test attack_matrix -- --test-threads=1 --nocapture
```
