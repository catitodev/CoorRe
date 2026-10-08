# CoorRe Verifier (browser)

A static page that verifies a CoorRe audit bundle with the same Rust code as
`coorre verify`, compiled to WebAssembly (`coorre-verify` with the `wasm` feature).

- Evidence, signatures, hashes, the hash chain and the comparison with the on-chain
  accounts are computed in the browser.
- The only network request is one `getMultipleAccounts` call to the chosen Solana RPC,
  carrying the public account addresses listed in the bundle.
- The expected program id is a setting of the page (default: the CoorRe devnet
  deployment), never a value read from the bundle (docs/decisions/ADR-002).
- Bundle content is untrusted: it is rendered as text only, links point only to the
  Solana Explorer after base58 validation, and a strict Content-Security-Policy allows
  scripts from the page itself only.

`samples/` holds the SUP-001 and SUP-002 bundles and artifacts from the devnet demo of
2026-10-08 (synthetic data), so the page can be tried without any files.

## Build

```
WASM_BINDGEN=/path/to/wasm-bindgen scripts/build-verifier
```

The wasm-bindgen CLI must match the version pinned in
`offchain/crates/coorre-verify/Cargo.toml` (0.2.128); CI downloads the official
release and checks its SHA-256. The output goes to `web/verifier/pkg/` (not committed).

## Test

```
cd web/verifier && npm test
```

Runs the real WebAssembly build against recorded devnet RPC answers
(`test/fixtures`): both samples pass 7/7, one changed byte fails checks 1 and 7, another
expected program fails check 6, missing files are reported, only public addresses are
sent, and the page never builds HTML from data.

## Publish

`.github/workflows/pages.yml` builds, tests and deploys the page to GitHub Pages. It
runs only when started by hand (workflow_dispatch).
