# Playground preflight

Run this before pasting any program or test into Solana Playground:

```
scripts/playground-preflight
```

It reproduces what Playground does with our code, using facts read from the official
repository (https://github.com/solana-playground/solana-playground), and exits non-zero
on anything that would break there.

| Check | What it catches |
|---|---|
| Official reference | Reads the live Playground sources and compares them with `reference.json`: test transpile target and wrapper, blocked words, globals, TypeScript version, default template, Rust/Solana versions, `anchor-lang` line and the template `Cargo.lock` hash. Any change fails until the pin is reviewed. |
| Test files (`onchain/tests/*.ts`, `spike/*.test.ts`) | Blocked words anywhere (Playground does a plain substring check, comments included); missing `describe`; names Playground does not provide; ES5 transpile errors with TypeScript 5.0.4; and the number of tests that actually register after the ES5 transpile versus the `it()` calls written in the file. |
| Programs (`onchain/programs/*/src/lib.rs`, `spike/*.rs`) | `cargo check` with Playground's Rust (1.68.0) and the template's own `Cargo.lock`, with warnings as errors, confirming the same `anchor-lang` and `solana-program` versions Playground builds with. |

Options: `--offline` skips the live comparison (reported as WARN), `--skip-programs`
skips the Rust build, `--print-live` prints the live reference for review.

## When Playground changes

The check fails with the exact fields that changed. Review the upstream change, then
update `reference.json` (and `playground-legacy.Cargo.lock` with its sha256 if the
template lockfile changed) in a dedicated commit, and re-run the preflight.

`npm test` in this folder runs regression cases for every problem that reached
Playground before this tool existed.
