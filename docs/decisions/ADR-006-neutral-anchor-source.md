# ADR-006: A neutral anchor source in the verifier

- Status: proposed
- Date: 2026-10-25
- Amends: ADR-002 (trust anchors per source)

## Context
The anchoring interface writes in neutral terms: `open_case` and `anchor_transition` take hashes, keys and amounts and return a receipt with a `network_id` (`offchain/crates/coorre-anchor/src/lib.rs:12-67`). The read side and the verifier are shaped by Solana:

- `AccountSnapshot { owner, data }` carries raw account bytes (`coorre-verify/src/verify.rs:23`);
- `owned` requires `owner == expected_program_id` (`verify.rs:55-60`);
- checks 4, 5 and 6 decode Anchor layouts with discriminators (`coorre-model/src/accounts.rs:7`, `70-83`, `98`, `140`) and compare them with the recomputed values (`verify.rs:269`, `362`, `416-546`);
- the WebAssembly verifier takes the expected program id from the page, never from the bundle (`coorre-verify/src/wasm.rs:71`, `web/verifier/app.js:477-478`).

Checks 1, 2, 3 and 7 (artifact digests, evidence hashes, proofs, reproduced decisions) do not depend on where the anchor lives. CoorRe on Hedera ([docs/hedera/SPEC.md](../hedera/SPEC.md)) and the Web2 witness log ([WEB2_MODE.md](../design/WEB2_MODE.md)) need the same verifier to read a second source.

## Decision
- The verifier compares the evidence with a neutral **anchor record**: case id, role or delegate bindings, amount and limit when present, state, and for each step the evidence hash, previous hash, states, actor, rule hash and time.
- Each source turns its own data into that record and proves where it came from:
  - **Solana accounts**: exactly today's decoding, owner and discriminator checks. The ten devnet bundles in `onchain/devnet-bundles/2026-10-10` and `web/verifier/samples` must keep verifying 7 of 7, with the same check names and details.
  - **Hedera**: the CoorRe contract's results and logs and the CoorRe topic's messages, read from the Mirror Node.
  - **Web2 witness log**: later, per WEB2_MODE.md.
- Trust anchors stay outside the bundle and ship with the verifier, one set per source: the program id for Solana; chain id, CoorRe contract address, escrow address and topic id for Hedera.
- `coorre-audit-bundle/1` keeps reading every existing bundle. Hedera enters as an additive variant; a Solana bundle never needs a new field.
- No change to `coorre-model` hashing, JCS or eddsa-jcs-2022.

## Consequences
- The change touches the shared core (`coorre-verify`, `coorre-anchor`), not the Solana program or the bridge. The Solana regression is the gate: the existing Rust tests (218) and web tests (45) pass unchanged, and the ten bundles verify 7 of 7.
- Phase 2 builds the Hedera source and its tests; the Solana source is the current code moved behind the record, with no behavior change.
