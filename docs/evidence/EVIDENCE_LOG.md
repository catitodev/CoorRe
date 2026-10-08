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
