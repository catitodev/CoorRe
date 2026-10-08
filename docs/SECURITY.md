# Security Notes and Threat Model (living document)

## Privileged roles
Creator/operator (opens and funds cases), submitter/payee, agent, rule_engine, approver. Four role keys must be distinct per case. Program upgrade authority: Playground wallet on devnet (backed up in .local/); production target: Squads multisig.

## Threats and controls
- Case squatting (someone opens our case_id first): CaseRecord PDA seeds include the creator.
- Separation of duties bypass (one key holding several roles): RolesNotDistinct.
- Rogue or compromised automated actor moving value above its mandate: MandateExceeded enforced on-chain; only the approver can take ESCALATED to APPROVED.
- Unauthorized actor or forged transition: role-bound signer checks; actor_kind derived on-chain, never trusted from input.
- Reordering or replay of evidence: prev_hash chain checked on-chain and off-chain.
- Forged evidence with a valid signature from an unrelated key: verifier check 4 binds proof key to the on-chain role key.
- Fake accounts in an audit bundle: verifier ignores receipts, checks account owner == program and content equality.
- Ambiguous JSON (parser differentials): evidence is parsed as I-JSON before canonicalization; duplicate member names and integers outside the IEEE 754 safe range are rejected.
- Signature malleability and weak keys: Ed25519 verification uses strict mode (non-canonical signatures and small-order keys rejected); multibase keys and proof values must be canonically encoded.
- Key confusion: a proof is only created when its verification method resolves to the signing key; verification resolves did:key only, so no network lookup can substitute a key.
- Escrow draining or rent violation: exact `amount` movements, rent-exempt minimum preserved, checked arithmetic, payee/refund accounts constrained to stored keys.
- Supply chain: pinned versions, committed lockfiles, CI on every push.
- Secrets: keys only in .local/ (gitignored); never logged.

## Declared limitations
Devnet only; custodial demo keys; no verifiable build; no fuzzing; simulated agent (no LLM); public RPC rate limits.
