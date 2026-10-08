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
- Bundle naming its own program: the expected program id is an input of the verifier (default: the CoorRe devnet deployment), never read from the bundle (ADR-002).
- Path traversal through artifact names: names are limited to 1-128 characters of [A-Za-z0-9._-] and cannot start with a dot, enforced in evidence validation and in verification check 1.
- Identity of role keys: the chain proves which keys acted; the verifier report shows the creator and the four role keys read from the case record so an auditor can match them to people or systems.
- Ambiguous JSON (parser differentials): evidence is parsed as I-JSON before canonicalization; duplicate member names and integers outside the IEEE 754 safe range are rejected.
- Signature malleability and weak keys: Ed25519 verification uses strict mode (non-canonical signatures and small-order keys rejected); multibase keys and proof values must be canonically encoded.
- Key confusion: a proof is only created when its verification method resolves to the signing key; verification resolves did:key only, so no network lookup can substitute a key.
- Escrow draining or rent violation: exact `amount` movements, rent-exempt minimum preserved, checked arithmetic, payee/refund accounts constrained to stored keys.
- Payout stuck at the end of a case (payee left below the rent-exempt minimum): open_case rejects any `amount` below the rent-exempt minimum of a zero-data account, read from the Rent sysvar at runtime (AmountBelowRentExempt).
- Supply chain: pinned versions, committed lockfiles, CI on every push.
- Secrets: keys only in .local/ (gitignored); never logged.
- Wrong network: the bridge refuses to send unless the RPC reports the devnet genesis hash; mainnet is never reachable by accident.
- Key files: the bridge and the CLI refuse key files readable by group or others and keypairs whose public half does not match the seed; key material never appears in output or errors. The CLI spawns the bridge without a shell, with a cleared environment that carries only PATH and the COORRE_* settings.
- Bridge input: strict JSON members, canonical hex/u64/base58 parsing, validated before any network call; the bridge is spawned without a shell.
- Browser verifier: bundle content is rendered as text only (no innerHTML or eval, enforced by a test), Explorer links only after base58 validation, Content-Security-Policy `default-src 'none'` with scripts from the page itself and `wasm-unsafe-eval` for WebAssembly; the only data sent out is the list of public account addresses in one `getMultipleAccounts` call.
- Build supply chain of the verifier: wasm-bindgen pinned to `=0.2.128` in the crate; CI downloads the official CLI release and checks its pinned SHA-256 before use.

## Bridge dependencies (checked 2026-10-08)
- Single direct dependency, pinned: @solana/web3.js 1.99.0 (published 2026-09-08). Lockfile committed; installs use `npm ci` with install scripts disabled (bridge/.npmrc).
- uuid < 11.1.1 (GHSA-w5hq-g745-h8pq, via jayson): only `uuid.v4` is used, which the advisory does not cover; still overridden to 11.1.1, which keeps the CommonJS `v4` export jayson needs.
- stream-json <= 3.5.0 (GHSA-528h-pc64-c93x, GHSA-hqr4-qq8f-hg3x, GHSA-mjw6-4jj6-33hc, via jayson): no compatible patched release exists (3.x changed its module layout). The code is unreachable: @solana/web3.js imports only `jayson/lib/client/browser`, and stream-json is loaded only by `jayson/lib/utils.js`. A runtime test (bridge/test/deps.test.mjs) fails if stream-json is ever loaded. CI fails on any high or critical advisory.

## Declared limitations
Devnet only; custodial demo keys; no verifiable build; no fuzzing; simulated agent (no LLM); public RPC rate limits.
