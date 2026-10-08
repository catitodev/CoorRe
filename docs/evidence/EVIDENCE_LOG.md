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

### 2026-10-08 14:50 BRT — coorre_anchor deployed to devnet and tested in Playground
- Author: Clarkson Luiz Buriche Bartalini
- Environment: Solana Playground (default `legacy` template: anchor-lang 0.29.0, Rust 1.68.0, Solana 1.17.25).
- Result: program `9esN1A8K1SASLg17ob81dbSdB4VX8ozc6tBLmJ247Wv` deployed (tx 2ku5UxeTyM1qrVcKhB3s68pDVh2cZyyTpFXuhF8orWjzvswoCguiN5AjoLAAvbxLbG6yRBDHvxgAFYKzcsq7JJxY, upgrade authority 7yAwBDhFs8TdMurdwJsq4AB41tX2H9PULpxeAnf87zyZ), verified on chain (executable, ProgramData 261,301 bytes). Playground suite: 17 passing; 33 program transactions after the run, none failed. Exported IDL matches ADR-001 (account order, fields, events, error codes 6000–6009); a new bridge test (bridge/test/idl.test.mjs) now enforces that. Creator demo key funded with 1 SOL from the Playground wallet (tx 2Ns83yw1MnJcTM9ebqpDQqw9sdZLVXQTeaZF86jgRsGHEZ5qw6qcvzLqwijSgzRmWwPruNRKhEsev6xi3scycGtA).
- Limitations / deviations: the first test run failed because `deploy` had not been executed yet, and it showed only 13 tests: a `for...of` over `Array.entries()` registered nothing after Playground's ES5 transpile (fixed in 0f82355). The deploy itself hit public RPC rate limits and took 6m40s.
- Commit(s): docs: record the coorre_anchor deployment and its test run

### 2026-10-08 15:20 BRT — Playground preflight (prevents the issues above from recurring)
- Author: Clarkson Luiz Buriche Bartalini
- Work: `scripts/playground-preflight` (tools/playground-preflight). Reads the official Playground sources live (js-runtime.ts, supported-packages.json, client/package.json, server templates and the legacy Cargo.lock) and compares them with a pinned reference (Playground commit 3fb888f, 2026-10-08). For each test file it reproduces Playground's handling: blocked-word substring check, `describe` requirement, globals actually provided, the exact code wrapper and ES5 transpile with TypeScript 5.0.4, and counts tests that register versus `it()` call sites. Programs are checked with `cargo check` on Rust 1.68.0 using the template's own Cargo.lock, warnings as errors, confirming anchor-lang 0.29.0 and solana-program 1.16.24.
- Result: all checks PASS for the current repository; 12 regression tests pass; run against the historical files it FAILS both as expected (spike test from a3c3ee4: blocked words "document" line 123 and "top" line 54; coorre_anchor test from dd057f8: 14 it() call sites but 13 registered). New CI job runs it on every push, so a change in Playground itself fails CI until reviewed.
- Dependency: typescript 5.0.4 (pinned to the version Playground uses), tooling only, install scripts disabled; npm audit: 0 vulnerabilities.
- Commit(s): feat(tools): add the Playground preflight and run it in CI

### 2026-10-08 16:20 BRT — Full audit: comments removed, facts re-verified, gaps closed
- Author: Clarkson Luiz Buriche Bartalini
- Code comments removed from every Rust, JS/TS, shell and YAML file (shebangs kept). Removal was syntax-aware (TypeScript AST for JS/TS, a Rust lexer that respects strings, raw strings, chars and lifetimes); the diff was checked to contain only comment lines and trailing comments. Test-vector provenance moved into constant names (`RFC8032_TEST1_*`, `FIPS180_SHA256_ABC_HEX`, `RFC8785_SEC_3_2_*`, `W3C_B3_*`, `EXnn_*` for W3C examples) and the vectors' README files; action versions moved into CI step names.
- Re-run after the change: Rust fmt/clippy -D warnings clean, 84 tests passed, wasm32 build OK; bridge 22 tests passed; preflight 12 regression tests passed and the full preflight (live Playground reference, both test files, both programs on Rust 1.68.0) passed.
- Secrets and traces: no `.local`/key files ever tracked; no 64-byte key arrays, PEM blocks or secret assignments in the full git history; all 14 commits authored by Clarkson Luiz Buriche Bartalini <catitodev@gmail.com>; the only matches for tool-related words are Cargo's standard lockfile header and the Apache-2.0 license text. The five long base58 strings in the repository are finalized devnet transaction signatures (checked with getSignatureStatuses); the sixth is the W3C published proofValue.
- Dependencies re-checked against official sources: every crate in offchain/Cargo.lock matched against the RustSec advisory database (1,275 advisories); four crates have advisories and none apply (curve25519-dalek 5.0.0 vs RUSTSEC-2024-0344 patched >= 4.1.3; ed25519-dalek 3.0.0 vs RUSTSEC-2022-0093 patched >= 2; sha2 0.11.0 vs RUSTSEC-2021-0100 patched >= 0.9.8; time 0.3.55 vs RUSTSEC-2020-0071 (0.1/<0.2.23) and RUSTSEC-2026-0009 (<0.3.47, RFC 2822 parsing only)). Every @solana/web3.js API the bridge calls exists in the installed 1.99.0; its built-in HTTP 429 retry (4 retries, 0.5–4 s backoff, messages on stderr) was read in the installed source. GitHub Actions commit pins re-checked against their tags.
- Gaps closed: SPEC section 11 now lists tools/ and scripts/; DEPLOYMENTS notes that post-deploy source changes are declare_id and comment removal only.
- Correction to the 14:05 entry: it said the Playground suite had 16 tests. The file at commit dd057f8 had 14 `it()` call sites, of which 13 registered in Playground (ES5 transpile issue, fixed in 0f82355; 17 tests since then).
- Commit(s): chore: remove code comments and record the full audit

### 2026-10-08 16:35 BRT — Bridge smoke test against coorre_anchor on devnet
- Author: Clarkson Luiz Buriche Bartalini
- Commands run: `node bridge/anchor.mjs open-case|anchor-transition|fetch-account --input <file>` with COORRE_PROGRAM_ID=9esN1A8K1SASLg17ob81dbSdB4VX8ozc6tBLmJ247Wv and the demo keys in .local/keys (inputs kept in out/, gitignored).
- Result: case `urn:coorre:case:BRIDGE-SMOKE-20261008` opened and taken through SUBMITTED, AGENT_REVIEWED and AUTO_APPROVED; an AUTO_APPROVED attempt signed by the agent key was rejected in simulation with UnauthorizedActor (6002) and reported by name with exit code 1. On-chain state verified with an independent decoder: final state 3, payout exactly 1,000,000 lamports to the submitter, escrow back to its rent-exempt minimum, three EvidenceAnchors with the expected fields. Accounts and transactions listed in onchain/DEPLOYMENTS.md.
- Limitations / deviations: evidence hashes in this smoke test are labelled placeholders (`bridge-smoke:<case_ref>:<step>`); signed credentials come with the CLI demo.
- Commit(s): docs: record the bridge smoke test on devnet

### 2026-10-08 17:05 BRT — On-chain account codec and coorre-verify
- Author: Clarkson Luiz Buriche Bartalini
- coorre-model::accounts: CaseRecord (254 bytes) and EvidenceAnchor (188 bytes) decode/encode with Anchor discriminators. Tested against the real account bytes of the bridge smoke case read from devnet (tests/vectors/devnet-bridge-smoke): every field matches the case and re-encoding reproduces the on-chain bytes exactly.
- coorre-verify: the six checks of spec section 8 over (bundle, artifact bytes, account snapshots, expected program id), pure and building for wasm32. Security decisions in ADR-002: the expected program id never comes from the bundle; addresses and receipts are hints only. Artifact names are restricted to block path traversal when files are read by name.
- Dependency choices checked on crates.io and RustSec for the CLI step: clap 4.6.7, anyhow 1.0.104 (RUSTSEC-2026-0190 affects < 1.0.103), uuid 1.26.1 (1.27.0 skipped: 6 days old and needs Rust 1.89, above the workspace's 1.88). time `now_utc` needs feature `std`, enabled through `formatting` in the CLI only (read in the time 0.3.55 source).
- Bridge: `fetch-account` now returns `data_hex`, so the Rust side needs no base64 crate.
- Result: workspace tests 18 + 66 + 8 + 12 passed (verifier tests include the spec's mandatory cases: a valid signature from a non-role key fails check 4, an account with the wrong owner fails check 6, one changed artifact byte fails check 1); bridge 22 passed; clippy -D warnings clean.
- Commit(s): feat(verify): add the account codec and the six-check verifier

### 2026-10-08 17:40 BRT — coorre-anchor, coorre CLI and the first full demo on devnet
- Author: Clarkson Luiz Buriche Bartalini
- coorre-anchor: `Anchorer` trait; `BridgeAnchorer` spawns `node bridge/anchor.mjs` without a shell, with a cleared environment (PATH and COORRE_* only), inputs written to files; program rejections come back by name. `MemoryAnchorer` replays the program's rules through coorre-engine and writes accounts in the real layout, identified as `memory:simulated` so its bundles never pass as devnet ones (the verifier now takes the expected network as an input, like the program id).
- coorre CLI: `coorre demo run` (narrated, Explorer links, bundles and artifacts under out/, rejected attempts kept under attempts/, verification and a one-byte tamper test at the end of each case) and `coorre verify --bundle --artifacts` (fetches accounts through the bridge, exit 1 on any FAIL, `--json`). Demo fixtures are synthetic (demo/fixtures); actor autonomy choices and per-run case references in ADR-003.
- Library facts checked in source before use: clap `env` is a separate feature (enabled); uuid resolved to 1.26.1 under the Rust 1.88 MSRV; time `with_hms_nano`, `assume_utc`, `replace_nanosecond`, `From<Month> for u8` and `Date` Display. An import of a non-existent `time` module written in a first draft was caught and removed before compiling.
- Tests: 118 Rust tests pass (offline end-to-end for SUP-001, SUP-002 with the MandateExceeded attempt, SUP-003 with refund; the `coorre` binary run offline; refusal of a key file with mode 644); clippy -D warnings clean.
- Devnet run (details and transaction links in onchain/DEPLOYMENTS.md): SUP-001 AUTO_APPROVED and released; SUP-002 rogue AUTO_APPROVED rejected with MandateExceeded, then ESCALATED and APPROVED by the approver key and released; 6/6 PASS for both at the end of the demo and again with a separate `coorre verify`; one byte flipped in a copy of an artifact makes check 1 FAIL with exit code 1. On-chain balances: submitter +250,000,000 lamports exactly, case records back to rent minimum, creator spent 0.26519808 SOL.
- Limitations / deviations: the rogue-attempt file of this run stores the error name only; the CLI now also stores the error code and the full program message, which the next run will include.
- Commit(s): feat(cli): add coorre demo run and coorre verify with the bridge anchorer

### 2026-10-08 18:20 BRT — Browser verifier (WebAssembly)
- Author: Clarkson Luiz Buriche Bartalini
- Sources checked before use: wasm-bindgen on crates.io (0.2.129 published 13 days earlier was skipped; 0.2.128 of 2026-09-04 pinned exactly); official CLI release `wasm-bindgen-0.2.128-x86_64-unknown-linux-musl.tar.gz` from github.com/wasm-bindgen/wasm-bindgen, SHA-256 b51f0208fdff83515a787bd8ab9ac5865ed84dabb66d0c709957bb59793c645f matched the published checksum; `JsError` conversion and `initSync({ module })` read in the crate and generated sources; devnet RPC CORS answers checked with an Origin header (allows the page origin and `content-type`); `getMultipleAccounts` response shape checked on devnet; GitHub Pages actions resolved to commit SHAs (configure-pages v6.0.0, upload-pages-artifact v5.0.0, deploy-pages v5.0.1) and the workflow mirrors GitHub's official static-site starter.
- Work: `coorre-verify` feature `wasm` (`BundleVerifier` binding; the same Rust verification as the CLI); bundle helpers `required_accounts` and `declared_artifact_names` moved into coorre-verify and reused by the CLI; timeline entries now carry the transition payload (decision, reasons, justification); `scripts/build-verifier`; static page web/verifier (no framework, strict CSP, text-only rendering) with the two devnet samples; CI job `web-verifier`; manual Pages workflow.
- Result: page tested in a real browser against devnet: SUP-001 and SUP-002 6/6; with the tamper option, check 1 FAILS and the other five pass; no console errors; no horizontal overflow at 375 px. Node tests with the real WebAssembly build and recorded RPC answers: 10 passed. Rust: clippy -D warnings clean for native and wasm32 with the feature; all workspace tests pass. Two display defects found in the browser test were fixed before commit (empty notes printed as "null"; role names shown in Rust debug form).
- Limitations / deviations: publishing to GitHub Pages is prepared but not run; it publishes a public website and waits for explicit approval.
- Commit(s): feat(web): add the WebAssembly verifier page and its CI

### 2026-10-08 20:10 BRT — Verification check 7: automated decisions reproduced (ADR-004)
- Author: Clarkson Luiz Buriche Bartalini
- Gap found in review: the chain enforces the amount against the mandate but cannot see documents, and checks 1 to 6 prove integrity, authorship and anchoring only. A holder of the rule-engine key could anchor AUTO_APPROVED for a case with an expired license, within the limit, and all six checks would pass.
- Work: coorre-engine now owns the document format (`DocumentArtifact`) and `evaluation_date_is_credible`; coorre-verify check 7 re-runs supplier-docs v1 for every rule-engine decision over the documents of the SUBMITTED evidence, the mandate in the evidence and the payload's evaluation_date, and compares state, decision and reasons. The agent's recommendation is compared and reported as informational. Only the rule the verifier ships can run (id, version and hash must match). The evaluation date must be the UTC signing day or the day before, so it cannot be backdated. SPEC sections 7 to 10, SECURITY and ADR-004 updated. The CLI reuses the engine's document type.
- Result: 128 Rust tests pass (verifier 20, engine 20). New cases: escalation with right reasons passes; compromised rule engine approving an expired license within the limit passes checks 1 to 6 and fails 7 (built with real signatures and the real account layout, not executed live); wrong reasons fail; backdated evaluation date fails; missing evaluation date or document fails; unsupported rule fails; agent disagreement is noted without failing; case without automated decisions passes with a note. The two recorded devnet cases verify 7/7 with `coorre verify`; the offline demo of the three cases passes 7/7 each. Browser (real WebAssembly, live devnet accounts): both samples 7/7; with one byte flipped in a document, checks 1 and 7 fail (5/7), no console errors. Web tests 10 pass.
- Limitations / deviations: the forged-decision scenario is covered by tests, not by a transaction on devnet. Tampering with a document now fails two checks instead of one; the spec text ("check 1 FAILS") still holds.
- Commit(s): feat(verify): add check 7, automated decisions reproduced from the rule

### 2026-10-08 20:40 BRT — Full audit after check 7
- Author: Clarkson Luiz Buriche Bartalini
- Scans: no comments left in Rust, JS/TS, shell, YAML, HTML or CSS (the one `//` hit is inside a test fixture string); no key-like files tracked, no 64-byte key arrays, PEM blocks or secret assignments in the full history; no AI-tool files tracked and no tool-related words in any diff (only Cargo's lockfile header and the Apache text); all 20 commits authored and committed by Clarkson Luiz Buriche Bartalini <catitodev@gmail.com>; key files mode 600 in a 700 folder.
- Dependencies: all 79 locked crates matched against RustSec (1,275 advisories). Fifteen advisories touch our crates and none applies: anstream 1.0.0 (patched >= 0.6.8), anyhow 1.0.104 (>= 1.0.103), bumpalo 3.20.3 (>= 3.11.1), curve25519-dalek 5.0.0 (>= 4.1.3), ed25519-dalek 3.0.0 (>= 2), futures-task 0.3.34 (>= 0.3.6), futures-util 0.3.34 (>= 0.3.7), once_cell 1.21.4 (>= 1.0.1), sha2 0.11.0 (>= 0.9.8), slab 0.4.12 (>= 0.4.11), time 0.3.55 (0.1 and < 0.3.47 only). npm: the verifier page has no dependencies, the preflight tool reports 0 vulnerabilities, the bridge keeps the documented, unreachable stream-json advisories and no high or critical ones.
- Coherence fixes: SPEC section 2 said "rogue agent" although only the rule-engine key can reach MandateExceeded (the agent key is rejected earlier with UnauthorizedActor); SPEC section 9 said getAccountInfo while the page uses one getMultipleAccounts call. The assembly the Pages workflow performs was reproduced in a scratch folder and every file the page references is present.
- Checks re-run from scratch: fmt, clippy -D warnings, 128 Rust tests, wasm32 release build, bridge 22, preflight tool 12, page 10, Playground preflight (live reference, both test files, both programs on Rust 1.68.0). Devnet re-read: program 9esN1A8K…Wv executable, upgrade authority 7yAwBDhF…87zyZ unchanged.
- Commit(s): docs: align the spec with the build and record the full audit
