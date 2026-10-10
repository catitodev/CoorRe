# CoorRe — Hackathon MVP Specification

## 1. Product and insight
As work is distributed across people, systems and AI agents, organizations must later prove how processes happened, and must bound what automated actors may do. CoorRe makes three things true at once:
1. Mandates are enforced on-chain: an automated actor cannot approve or release a payment above its autonomy limit; only a designated human authority can approve beyond it.
2. Proof releases payment: escrowed payments are released only when an evidence-backed decision is anchored.
3. Anyone can verify the whole trail without trusting the operator: evidence is portable (W3C Verifiable Credentials), data stays off-chain (only hashes go on-chain), and the verifier runs in any browser.
Core flow: EVENT/DELIVERY → EVIDENCE → RULE/VALIDATION → DECISION → STATE → AUDITABLE TRAIL.
Network neutrality: the anchoring interface is network-agnostic; Solana is the first implementation; Hedera/Regen are out of scope but must not be prevented.

## 2. Demo case (synthetic data only): AI procurement agent with a mandate
Actors per case (four distinct keys): submitter (supplier, human, also the payee), agent (pre-analysis AI agent, simulated, autonomy "recommend"), rule_engine (system, deterministic), approver (human with authority). Creator = operator who opens the case and funds the escrow.
Rule "supplier-docs" v1 (deterministic, off-chain): AUTO_APPROVED iff all required documents (tax certificate, environmental license) are present AND valid on the evaluation date AND amount <= autonomy_limit; otherwise ESCALATED with explicit reasons.
Scenario (devnet SOL, small amounts):
- SUP-001: amount 0.05 SOL, limit 0.10 SOL, documents valid → AUTO_APPROVED → escrow released to the supplier automatically.
- SUP-002: amount 0.20 SOL, limit 0.10 SOL, environmental license expired → a "rogue automation" attempt to AUTO_APPROVE (the rule-engine key approving above its limit; the AI agent's key would be rejected earlier with UnauthorizedActor, see ADR-001 and ADR-003) is sent on purpose and the program rejects it with MandateExceeded (shown in the demo) → rule engine anchors ESCALATED → approver anchors APPROVED with a justification → escrow released.
- SUP-003 (tests only): ESCALATED → REJECTED → escrow refunded to the creator.
- Tamper: changing 1 byte of an artifact makes verification fail.
Further domains (off-chain rules in the registry, ADR-005; synthetic documents; `"demo": false`, run with `--case`; amounts 0.02 or 0.04 SOL against a 0.03 SOL limit):
- agent-purchase v1 (purchase request, supplier quote, supplier registration): AGT-001 → AUTO_APPROVED; AGT-002, supplier registration expired and amount above the limit → MandateExceeded attempt rejected → ESCALATED with both reasons → APPROVED.
- ecosystem-services-payment v1 (contract for payments for ecosystem services, monitoring report): PES-001 → AUTO_APPROVED; PES-002, verified area below the committed area and amount above the limit → MandateExceeded attempt rejected → ESCALATED with both reasons → APPROVED.
- milestone-payment v1 (funding agreement, milestone report, accountability report): MIL-001 → AUTO_APPROVED; MIL-002, open findings on a previous installment, amount within the limit → ESCALATED with that reason → REJECTED → escrow refunded to the creator.
- service-delivery v1 (service contract, acceptance record, invoice): SRV-001 → AUTO_APPROVED; SRV-002, invoice issued before the acceptance, amount within the limit → ESCALATED with that reason → REJECTED → escrow refunded to the creator.

## 3. Evidence model
- JSON compatible with W3C VC Data Model 2.0. Canonicalization RFC 8785 (JCS). evidence_hash = SHA-256(JCS(document without "proof")).
- Proof: DataIntegrityProof, cryptosuite eddsa-jcs-2022, Ed25519 (W3C Recommendation vc-di-eddsa).
- Numbers inside credentialSubject are strings (amounts in lamports as decimal strings). Timestamps RFC 3339 UTC "Z", second precision.
- Artifact digests: lowercase hex SHA-256 of raw bytes.
- Actor ids: did:key with Ed25519 multikey (multicodec 0xed01, base58btc "z").
- case_id = SHA-256(UTF-8 of case_ref, e.g. "urn:coorre:case:SUP-001"). Genesis previousEvidence = "sha256:<hex of case_id>". rule.hash = SHA-256(JCS(rule JSON)).
Unsecured evidence document:
{
  "@context": ["https://www.w3.org/ns/credentials/v2", "https://coorre.example/ns/v1"],
  "id": "urn:uuid:<v4>",
  "type": ["VerifiableCredential", "CoorReTransition"],
  "issuer": "did:key:<actor>",
  "validFrom": "2026-10-09T12:00:00Z",
  "credentialSubject": {
    "case": "urn:coorre:case:SUP-002",
    "fromState": "AGENT_REVIEWED", "toState": "ESCALATED",
    "actor": { "id": "did:key:...", "kind": "system", "autonomy": "autonomous" },
    "mandate": { "amountLamports": "200000000", "autonomyLimitLamports": "100000000" },
    "rule": { "id": "supplier-docs", "version": "1", "hash": "sha256:<hex>" },
    "artifacts": [ { "name": "license.pdf", "mediaType": "application/pdf", "digestSHA256": "<hex>" } ],
    "payload": { "reasons": ["environmental license expired", "amount exceeds autonomy limit"] },
    "previousEvidence": "sha256:<hex>"
  }
}
actor.kind ∈ {human, agent, system}; autonomy ∈ {recommend, execute_with_approval, autonomous, escalate}.

## 4. State machine (u8 codes shared on-chain and off-chain)
0 OPEN → 1 SUBMITTED (signer: submitter)
1 SUBMITTED → 2 AGENT_REVIEWED (signer: agent)
2 AGENT_REVIEWED → 3 AUTO_APPROVED (signer: rule_engine; requires amount <= autonomy_limit) | 4 ESCALATED (signer: rule_engine)
4 ESCALATED → 5 APPROVED | 6 REJECTED (signer: approver)
Terminal: 3, 5, 6. On entering 3 or 5: release escrow to submitter. On entering 6: refund escrow to creator.

## 5. On-chain program `coorre_anchor` (Anchor 0.29 unless the spike says otherwise)
Accounts:
- CaseRecord, PDA seeds ["case", creator, case_id]: case_id [u8;32], creator, submitter, agent, rule_engine, approver (Pubkey), amount u64, autonomy_limit u64, state u8, last_evidence_hash [u8;32], transition_count u32, bump u8. Holds the escrowed lamports on top of its rent-exempt minimum.
- EvidenceAnchor, PDA seeds ["evidence", case_record, evidence_hash]: evidence_hash [u8;32], case_record Pubkey, prev_hash [u8;32], from_state u8, to_state u8, actor Pubkey, actor_kind u8 (derived from role, never an argument), rule_hash [u8;32], slot u64, unix_ts i64, bump u8.
Instructions:
- open_case(case_id, submitter, agent, rule_engine, approver, amount, autonomy_limit): signer creator. Requires the four role keys pairwise distinct (RolesNotDistinct). Requires `amount` >= the rent-exempt minimum of a zero-data account, read from the Rent sysvar at execution time and never hard-coded (AmountBelowRentExempt); this guarantees the final release or refund cannot be rejected by the runtime rent rule. Transfers `amount` lamports from creator into CaseRecord.
- anchor_transition(evidence_hash, prev_hash, to_state, rule_hash): signers actor + payer. Checks: case not terminal (CaseClosed); to_state valid (InvalidState); transition allowed (InvalidTransition); actor equals the role key for that transition (UnauthorizedActor); prev_hash == last_evidence_hash, or == case_id when transition_count == 0 (PrevHashMismatch); AUTO_APPROVED only if amount <= autonomy_limit (MandateExceeded); checked arithmetic (Overflow). Creates EvidenceAnchor, updates CaseRecord, then releases or refunds escrow on terminal states by moving exactly `amount` lamports from CaseRecord (never below rent-exempt minimum: InsufficientEscrow). Payee account must equal submitter; refund account must equal creator.
- slot and unix_ts come from the Clock sysvar.
Events: CaseOpened {case_id, creator, amount, autonomy_limit}; TransitionAnchored {case_record, evidence_hash, prev_hash, from_state, to_state, actor, actor_kind, rule_hash, slot, unix_ts}; FundsReleased {case_record, to, amount}; FundsRefunded {case_record, to, amount}.
Errors: InvalidTransition, InvalidState, UnauthorizedActor, PrevHashMismatch, CaseClosed, RolesNotDistinct, MandateExceeded, InsufficientEscrow, Overflow, AmountBelowRentExempt.
Workflow: source of truth is onchain/programs/coorre_anchor/src/lib.rs (single file), pasted into Playground to build, test (onchain/tests/*.ts) and deploy. After each deploy, commit the IDL to onchain/idl/coorre_anchor.json and record program id, upgrade authority and deploy tx in onchain/DEPLOYMENTS.md. Back up the Playground wallet keypair to .local/ (gitignored).

## 6. Bridge (bridge/, Node)
`node bridge/anchor.mjs <open-case|anchor-transition|fetch-account> --input <file.json>` prints one JSON object to stdout; non-zero exit on error, with the program error name when available.
Env: COORRE_RPC_URL (default https://api.devnet.solana.com; fallback URL allowed), COORRE_PROGRAM_ID, COORRE_KEYS_DIR (default .local/keys). Commitment "confirmed"; one retry with a fresh blockhash on expiry.
Keys: .local/keys/{creator,submitter,agent,rule_engine,approver}.json in Solana keypair format (64 bytes: 32-byte seed + 32-byte public key). Rust uses the first 32 bytes as the Ed25519 seed. Creator is funded via faucet.solana.com.
Receipt: { network_id: "solana:devnet", program_id, account, tx_signature }.

## 7. Off-chain core (offchain/, Cargo workspace)
- coorre-model: types, JCS, hashing, did:key, eddsa-jcs-2022 create/verify.
- coorre-engine: state machine and the rule registry (ADR-005): supplier-docs v1, agent-purchase v1, ecosystem-services-payment v1, milestone-payment v1 and service-delivery v1, each a JSON document compiled in, with its document formats and the evaluation-date check used by verification check 7; pure, no I/O.
- coorre-verify: pure verification over (bundle, artifact bytes, on-chain account bytes); native + wasm (feature "wasm").
- coorre-anchor: `Anchorer` trait (network_id, open_case, anchor_transition, fetch_account) + `BridgeAnchorer`.
- coorre-cli: `coorre demo run` (narrated scenario with Solana Explorer links; writes audit bundles and artifacts to out/; with no `--case` it runs the cases marked `"demo": true`, SUP-001 and SUP-002; `--case <ID>` runs any case of demo/fixtures/cases.json, whose optional `rule` field names the rule and defaults to supplier-docs v1; `--offline` uses the in-memory simulator) and `coorre verify --bundle <file> --artifacts <dir>`.
Audit bundle: case_ref, case_record address, program_id, ordered secured evidence documents, rule documents, artifact digests, receipts (receipts are hints; the verifier never trusts them).

## 8. Verification checks (CLI and browser; each PASS/FAIL with reason; non-zero exit on any FAIL)
1 Artifact digests match.
2 Evidence hash recomputed via JCS + SHA-256.
3 Ed25519 eddsa-jcs-2022 proof valid.
4 Signer binding: proof key == issuer did:key == on-chain EvidenceAnchor.actor == role key in on-chain CaseRecord for that transition.
5 Hash chain continuity from genesis to final state.
6 On-chain match: account owner == program_id, Anchor discriminator correct, stored evidence_hash/prev_hash/to_state/actor/rule_hash equal the recomputed values; final CaseRecord state and amount consistent with the bundle.
7 Automated decisions reproduced: for every rule-engine decision (AGENT_REVIEWED to AUTO_APPROVED or ESCALATED) the verifier re-runs the rule named in the evidence, selected by id and version from the registry it ships, whose hash must equal the shipped rule's hash (any other rule, version or hash fails the check, ADR-005) over the documents listed by the SUBMITTED evidence (digest-checked by check 1), the mandate in the evidence and the payload's evaluation_date; the recorded state, decision and reasons must equal the result. The evaluation_date must be the UTC signing day of the evidence or the day before. The agent's recommendation is compared too, but a difference is reported as informational: the agent advises, the rule engine decides. Cases with no automated decision yet pass with a note.
Rationale: only the program can write program-owned accounts, so owner check + content match proves anchoring without deriving PDAs in the verifier. The chain enforces the amount against the mandate but cannot see documents, so check 7 closes the gap where a compromised rule-engine key anchors an approval that the rule would not give (ADR-004).

## 9. Browser verifier (web/verifier/)
Static page: drop bundle + artifact files; computes everything locally with the wasm build; fetches all accounts of the bundle in one JSON-RPC getMultipleAccounts call carrying only public addresses; shows the timeline (actor kind, decision, mandate, Explorer links) and the seven checks. Deployed to GitHub Pages by a GitHub Actions workflow.

## 10. Mandatory acceptance tests
- coorre-model reproduces W3C vc-di-eddsa test vector B.3 (eddsa-jcs-2022): canonical document hash 59b7cb6251b8991add1ce0bc83107e3db9dbbab5bd2c28f687db1a03abc92f19, proof config hash 66ab154f5c2890a140cb8388a22a160454f80575f6eae09e5a097cabe539a1db, and verifies the published proofValue with the published key (https://www.w3.org/TR/vc-di-eddsa/, Appendix B.3).
- Different key order/whitespace → identical hash.
- On-chain TS tests (Playground): every forbidden transition → its specific error; wrong role signer → UnauthorizedActor; wrong prev_hash → PrevHashMismatch; repeated role keys → RolesNotDistinct; amount below the rent-exempt minimum → AmountBelowRentExempt; AUTO_APPROVED above limit → MandateExceeded; release and refund move exactly `amount` (balance assertions); two creators using the same case_id get different CaseRecords (no squatting).
- coorre-verify: valid signature from a non-role key → check 4 FAILS; account with wrong owner → check 6 FAILS; a rule-engine approval the rule would not give (expired license anchored as AUTO_APPROVED within the limit) → checks 1 to 6 pass and check 7 FAILS; a backdated evaluation_date → check 7 FAILS.
- Rule registry (ADR-005): supplier-docs v1 bytes, hash and decisions on its fixtures unchanged; every condition of every rule passes and fails with its exact reason and in the rule's order, the mandate reason last; every rule hash equals an independent computation; each new demo case runs offline and verifies 7/7, and one changed byte in any of its documents fails checks 1 and 7; for each new rule, a rule-engine decision that contradicts the rule passes checks 1 to 6 and fails check 7; a known rule with a different hash and an unknown rule id or version fail check 7 only.
- E2E on devnet: SUP-001 → AUTO_APPROVED + released; SUP-002 → MandateExceeded attempt rejected → ESCALATED → APPROVED + released; verify 7/7 PASS for both in CLI and browser; 1-byte artifact change → check 1 FAILS.

## 11. Repository layout
README.md · LICENSE · docs/spec/ · docs/SECURITY.md · docs/evidence/ · docs/decisions/ (ADR-NNN-*.md) · onchain/programs/coorre_anchor/src/lib.rs · onchain/tests/ · onchain/idl/ · onchain/DEPLOYMENTS.md · bridge/ · offchain/crates/{coorre-model,coorre-engine,coorre-verify,coorre-anchor,coorre-cli} · web/verifier/ · demo/fixtures/ · tools/playground-preflight/ (Playground preflight, run with scripts/playground-preflight) · scripts/ · .github/workflows/ · .local/ (gitignored) · out/ (gitignored)

## 12. Schedule (BRT)
- Thu 10-08: docs + environment + CI; Playground spike (human, browser); coorre-model with the W3C vector tests.
- Fri 10-09: program + TS tests + devnet deploy via Playground; bridge; coorre-engine; early wasm check (install only the wasm32-unknown-unknown target and confirm coorre-model and its signature dependencies compile for it).
- Sat 10-10: coorre-verify + coorre-anchor + coorre-cli (demo run, verify); E2E on devnet.
- Sun 10-11: wasm build + browser verifier + GitHub Pages; SECURITY.md final; README (setup, demo, limitations, prior-work disclosure "no code before 2026-10-07"); demo recording; freeze.
- Mon 10-12: submission by 18:00.

## 13. Cut order (apply only when the human says so)
1st: browser verifier → CLI-only verification. 2nd: escrow → mandate enforcement only. Never cut: on-chain mandate enforcement, signer binding, evidence model.

## 14. Out of scope (declared)
Real LLM calls, end-user auth, mainnet, SPL tokens, selective disclosure, production key management (demo keys custodial), verifiable builds (require local Docker build), fuzzing (Trident requires local toolchain), Hedera/Regen adapters, integration with agent payment rails (AP2, x402, Solana Payment Channels), real registries and document issuers (all domain documents are synthetic). Roadmap: upgrade authority under a Squads multisig, batch anchoring via Merkle roots, Solana Actions/Blinks for approver decisions, x402-style agent payments.
