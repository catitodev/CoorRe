# Evidence Log — CoorRe build

Purpose: dated, factual record of what was built, how, where and by whom, for the Colosseum submission and the Centelha RJ technical evidence. Record facts only; record failures and limitations when they happen.

Entry template:
### YYYY-MM-DD HH:MM BRT — <task>
- Author:
- Environment: OS, machine, tool versions
- Commands run:
- Result: tests passed/failed, program id, tx signatures, links
- Limitations / deviations:
- Commit(s):

### 2026-10-07 — Pre-build
- Author: Clarkson Luiz Buriche Bartalini
- Work: specification and architecture decisions; no code written before 2026-10-07.

### 2026-10-08 11:13 BRT — Environment, license, gitignore and CI
- Author: Clarkson Luiz Buriche Bartalini
- Environment: Linux Mint 22.3 (kernel 7.0.0-38-generic), Lenovo IdeaPad 1 15AMN7, 5.5 GiB RAM + 4.8 GiB swap, 8 threads, 200 GB free disk.
- Already present: git 2.43.0, curl 8.5.0, build-essential 12.10ubuntu1 (gcc 13.3.0, make 4.3), pkg-config 1.8.1, gh 2.45.0.
- Installed now:
  - Rust via rustup 1.29.1 (installer from https://sh.rustup.rs, profile minimal): rustc 1.99.0, cargo 1.99.0, rustfmt 1.10.0, clippy 0.1.99.
  - nvm v0.40.8 (official nvm-sh/nvm release) and Node v24.21.0 LTS "Krypton" (npm 11.19.0), checksum verified by nvm; latest LTS per https://nodejs.org/dist/index.json on this date.
- Configuration: ~/.cargo/config.toml created with [build] jobs = 2 and [profile.dev] debug = 0. Repository-local git identity set. gh re-authenticated over HTTPS with scopes repo, read:org, gist, workflow.
- Repository: .gitignore; LICENSE (Apache-2.0, official text from https://www.apache.org/licenses/LICENSE-2.0.txt, sha256 cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30); .github/workflows/ci.yml running cargo fmt --check, clippy -D warnings and test for offchain/ (skipped until offchain/Cargo.toml exists). actions/checkout pinned to commit 3d3c42e5aac5ba805825da76410c181273ba90b1 (v7.0.1).
- Not installed by design: Solana CLI, Anchor CLI (all on-chain work goes through Solana Playground); wasm toolchain deferred to 2026-10-11.
- Limitations / deviations: none.
- Commit(s): chore: environment, license, gitignore and CI
- CI: first run green (Rust steps skipped as designed): https://github.com/catitodev/CoorRe/actions/runs/37790733309
- Repository created: https://github.com/catitodev/CoorRe (public).

### 2026-10-08 11:20 BRT — Playground spike prepared (pending execution in the browser)
- Author: Clarkson Luiz Buriche Bartalini
- Work: spike/playground_spike.rs (vault PDA seeded by ["vault", signer]; open_vault/deposit via system transfer; withdraw by direct lamport edit keeping the rent-exempt minimum; VaultDeposited/VaultWithdrawn events) and spike/playground_spike.test.ts (exact balance deltas, events, rent floor, wrong signer, zero amount, runtime rent rule for new recipients).
- Findings from the official Solana Playground repository (github.com/solana-playground/solana-playground, checked 2026-10-08): the default build template is `legacy`, whose Cargo.lock pins anchor-lang 0.29.0 (solana-program 1.16.24); an `anchor-1.1.2` template also exists. A commit on 2026-10-08 removed the `anchor`/`web3` test globals only when the experimental "unstable" setting is on; the default mode keeps them. `ctx.bumps.<account>` is valid from Anchor 0.29.0 (CHANGELOG #2542).
- Result: pending human execution on beta.solpg.io (build, deploy, test, IDL export, wallet backup).
- Commit(s): chore: add Playground spike for the PDA vault pattern

### 2026-10-08 11:33 BRT — Task 1: offchain workspace and coorre-model
- Author: Clarkson Luiz Buriche Bartalini
- Environment: rustc 1.99.0, cargo 1.99.0, edition 2024, rust-version 1.88 (required by time 0.3.55).
- Dependencies (latest stable on crates.io, checked 2026-10-08): bs58 0.5.1, ed25519-dalek 3.0.0, hex 0.4.3, serde 1.0.229, serde_json 1.0.151, serde_json_canonicalizer 0.3.2, sha2 0.11.0, thiserror 2.0.21, time 0.3.55. Cargo.lock committed; CI uses --locked.
- Work: modules jcs (strict I-JSON parsing + RFC 8785), hash (SHA-256, lowercase hex, `sha256:` prefix), did_key (ed25519-pub 0xed01 / ed25519-priv 0x1300, base58btc, canonical encoding enforced), keys (Solana 64-byte keypair loading with public-key check, strict Ed25519 verification, secret never printed), datetime (RFC 3339; strict UTC-seconds form), eddsa_jcs_2022 (W3C sections 3.3.1–3.3.7 and the CoorRe evidence hash). Clippy denies unwrap/expect/panic outside tests; unsafe code forbidden.
- Official test data: W3C vc-di-eddsa Appendix B.3 (Examples 29–39) and RFC 8785 sections 3.2.2–3.2.4, both extracted programmatically from the published documents (sources and sha256 in tests/vectors/*/README.md); RFC 8032 section 7.1 TEST 1; FIPS 180-2 SHA-256("abc").
- Commands run: cargo fmt --all -- --check; cargo clippy --workspace --all-targets --locked -- -D warnings; cargo test --workspace --locked; cargo doc --no-deps.
- Result: 55 tests passed (47 unit, 8 W3C B.3 integration), 0 failed. Reproduced canonical document hash 59b7cb62…abc92f19, proof config hash 66ab154f…be539a1db, the published signature and proofValue byte for byte, and verified the published signed credential with the published key. Key order/whitespace changes give an identical hash. Mutation check: swapping the hash order in hash_data makes the suite fail. Peak build memory about 360 MB.
- Limitations / deviations: evidence document types and state codes will land in coorre-model in a follow-up commit (planned before coorre-engine). Only did:key verification methods are resolved, by design.
- Commit(s): feat: add coorre-model with JCS, did:key and eddsa-jcs-2022

### 2026-10-08 13:15 BRT — Playground spike executed on devnet
- Author: Clarkson Luiz Buriche Bartalini
- Environment: Solana Playground (beta.solpg.io) in the browser, default `legacy` template (anchor-lang 0.29.0); Playground wallet funded with 10 devnet SOL from faucet.solana.com (the automatic Playground airdrop was rate-limited).
- Commands run: Playground `build`, `deploy`, `test`; on-chain checks via devnet JSON-RPC (getAccountInfo, getTransaction, getMinimumBalanceForRentExemption).
- Result: program `FARGzwRUNjGXKMfq5FRwNGr5rZJngJg3nDhvh1rTiFss` deployed (tx 5P4dr8UAHhY9jz3GLweCekpgkdWs1cQG22naYkqG3Mr72KvxsgvHU2f3jDF2YyGbaT3GScpPf3SSwdAo7jkYyTKv, upgrade authority 7yAwBDhFs8TdMurdwJsq4AB41tX2H9PULpxeAnf87zyZ). Tests: 6 passing. Balance movements confirmed on chain to the lamport (details and links in onchain/DEPLOYMENTS.md). IDL exported (pre-0.30 format, consistent with Anchor 0.29). Wallet and program keypairs backed up in .local/ (gitignored, mode 600).
- Limitations / deviations: the first test runs failed because two test titles contained words the Playground runtime blocks ("document", "top"); titles renamed in commit 1747b25. A second run failed because the program had not been deployed yet; after `deploy` the suite passed. Devnet rent is 5,080 lamports per byte (including overhead) on this date, lower than the commonly quoted mainnet figure, so rent is always read at runtime.
- Commit(s): docs: record the Playground spike deployment and results

### 2026-10-08 13:30 BRT — Spec update: minimum case amount and early wasm check
- Author: Clarkson Luiz Buriche Bartalini
- Decision: open_case must reject any `amount` below the rent-exempt minimum of a zero-data account, read from the Rent sysvar at execution time (new error AmountBelowRentExempt). Reason: the spike showed that a payout leaving a new account below that minimum makes the whole transaction fail, which would block a case at its final step. Devnet minimum on this date: 650,240 lamports.
- Decision: move a first wasm32-unknown-unknown compile check of coorre-model to Friday 2026-10-09 (target only; the rest of the wasm toolchain stays on Sunday), to catch problems with the new ed25519-dalek 3 / curve25519-dalek 5 versions early.
- Files: docs/spec/SPEC.md (sections 5, 10, 12), docs/SECURITY.md.
- Commit(s): docs: require a rent-safe minimum amount when opening a case

### 2026-10-08 14:05 BRT — Friday scope started early: program, model types, wasm check, engine
- Author: Clarkson Luiz Buriche Bartalini
- Program `coorre_anchor` (onchain/programs/coorre_anchor/src/lib.rs) and its Playground suite (onchain/tests/coorre_anchor.test.ts, 16 tests). Compiled locally with the exact Playground `legacy` toolchain: Rust 1.68.0 and the template's Cargo.lock (anchor-lang 0.29.0, solana-program 1.16.24), `cargo +1.68.0 check`, 0 errors, 0 warnings. TS tests syntax-checked with Node 24 `module.stripTypeScriptTypes` and screened for Playground-blocked words. Devnet deploy pending (human, Playground).
- Anchor 0.29 encodings verified against the deployed spike: account (`account:Vault`), event (`event:VaultDeposited`, `event:VaultWithdrawn`) and instruction (`global:open_vault`, `global:withdraw`) discriminators equal sha256(prefix:name)[0..8]; u64 args little-endian. Recorded in docs/decisions/ADR-001-shared-codes-and-encodings.md.
- coorre-model: transition credential types (spec section 3 member names), strict parsing (unknown members rejected), field validation, case_id/genesis helpers, shared state/actor-kind/role codes. case_id cross-checked against Python hashlib.
- WebAssembly check (moved from Sunday): `rustup target add wasm32-unknown-unknown`; coorre-model and coorre-engine build for wasm32 in release. A throwaway cdylib running W3C B.3 verify, re-sign and tamper checks inside WebAssembly under Node 24 returned all three checks passing; the module needs no host imports (354,790 bytes).
- coorre-engine: state machine mirroring the program's check order (CaseClosed, InvalidState, InvalidTransition, UnauthorizedActor, PrevHashMismatch, MandateExceeded, Overflow) with a CaseTracker replica of CaseRecord, and rule supplier-docs v1 (rules/supplier-docs-v1.json; rule hash 7320d1d6…fbdabd2f cross-checked with Python). SUP-002 inputs yield exactly the spec reasons ["environmental license expired", "amount exceeds autonomy limit"].
- Result: cargo fmt/clippy -D warnings clean; 84 tests passed (coorre-engine 18, coorre-model 58, W3C B.3 8), 0 failed.
- Limitations / deviations: Rust 1.68.0 toolchain installed only to mirror Playground for local checks; stable remains the default. An initial attempt with cargo 1.68 started cloning the full git registry index; it was stopped, the partial cache removed, and the check re-run with the sparse protocol.
- Commit(s): feat(engine): add the case state machine and the supplier-docs rule

### 2026-10-08 14:40 BRT — Bridge (Node) and CI for bridge and wasm
- Author: Clarkson Luiz Buriche Bartalini
- Environment: Node v24.21.0, npm 11.19.0.
- Work: bridge/anchor.mjs (open-case, anchor-transition, fetch-account) and bridge/lib.mjs. Transactions are built with @solana/web3.js only, using the Anchor 0.29 encodings verified on devnet (ADR-001); @coral-xyz/anchor is not needed. Devnet genesis-hash guard (EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG, read from api.devnet.solana.com; mainnet and testnet hashes checked too), optional fallback RPC, one retry on blockhash expiry after a signature-status check, strict input parsing, private key-file check, program error names parsed from logs.
- Dependencies: @solana/web3.js 1.99.0 pinned (latest 1.x, published 2026-09-08). npm audit reported uuid and stream-json advisories through jayson; uuid overridden to 11.1.1 (CommonJS v4 export verified); stream-json has no compatible fix and is shown unreachable by a runtime module trace, now enforced by bridge/test/deps.test.mjs. Install scripts disabled via bridge/.npmrc. Details in docs/SECURITY.md.
- CI: new `bridge` job (actions/setup-node pinned to v7.0.0 commit 820762786026740c76f36085b0efc47a31fe5020; v7.1.0 was skipped because it was published the same day), `npm ci`, `npm test`, `npm audit --audit-level=high`; `offchain` job now also builds coorre-model and coorre-engine for wasm32-unknown-unknown.
- Result: bridge 17 tests passed (offline: encodings against devnet-observed bytes, PDAs, account order, CaseRecord decoding, error parsing, input validation, network guard with a local fake RPC, RPC fallback, key-file checks, dependency guards); clean reinstall with `npm ci` reproduces the same result.
- Limitations / deviations: live bridge calls against coorre_anchor wait for the program deploy on devnet.
- Commit(s): feat(bridge): add the devnet bridge with network and key guards
