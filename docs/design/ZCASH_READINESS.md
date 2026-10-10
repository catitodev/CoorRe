# Zcash readiness (roadmap)

Status: roadmap. There is no Zcash integration in CoorRe: no network code, no keys and no dependency, and no Zcash transaction has been sent. What exists today is offline: the CLI prepares the memo for a released decision and checks a memo against an audit bundle (see [Ready today](#ready-today-offline)). This document describes how a private payment network could fit the existing evidence model.

Sources read on 2026-10-10: [ZIP 302, Standardized Memo Field Format](https://zips.z.cash/zip-0302) (status Draft), [ZIP 316, Unified Addresses and Unified Viewing Keys](https://zips.z.cash/zip-0316) (revision 0 Active), and the [zcashd documentation on memos](https://zcash.readthedocs.io/en/latest/rtd_pages/memos.html).

## Why

On Solana every CoorRe payment is public: the payee key, the creator key and the amount are in the case record and in the transfers. Some processes cannot expose them, for example payments to individuals or commercially sensitive contracts. Shielded Zcash payments hide the sender, the recipient and the amount, and they carry an encrypted 512-byte memo.

## Memo payload

ZIP 302 fixes the memo at 512 bytes. A first byte of `0xFF` marks arbitrary data and leaves the other 511 bytes unconstrained. CoorRe would use that form:

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | `0xFF` (ZIP 302 arbitrary data) |
| 1 | 4 | `CRE1`: CoorRe memo, layout version 1 |
| 5 | 1 | Kind: `1` = payment for a decided case |
| 6 | 32 | case_id = sha256(case_ref), the value already used as the genesis of the hash chain |
| 38 | 32 | Hash of the evidence that decided the payment (AUTO_APPROVED or APPROVED) |
| 70 | 32 | Rule hash named in that evidence |
| 102 | 1 | Final state code |
| 103 | 409 | Zero bytes |

The payload uses 103 of 512 bytes. It holds hashes only: no document, no name and no amount in clear.

Mobile wallets accept text in the memo field, not raw bytes. The same fields therefore have a text form, valid ZIP 302 text (first byte below `0xF5`, UTF-8), 237 bytes long:

```
coorre/1 case=<64 hex> evidence=<64 hex> rule=<64 hex> state=<AUTO_APPROVED|APPROVED>
```

## What would be private and what would stay public

| Data | Where it lives | Visibility |
|---|---|---|
| Sender, recipient, amount of the payment | Zcash shielded transaction | Private: visible to the sender, the recipient and whoever they give a viewing key |
| Memo (case_id, evidence hash, rule hash) | Zcash shielded transaction | Private, encrypted with the payment |
| That a Zcash transaction happened, its fee and time | Zcash chain | Public |
| Evidence hashes, the hash chain, role keys, states and the rule hash of each step | The anchoring network (Solana today) | Public |
| Credentials and documents | The audit bundle | Whoever holds the bundle |

The public trail still proves who decided what, under which rule, and that the decision was anchored. The payment that follows it is private. An auditor given a viewing key (ZIP 316 defines full and incoming viewing keys) confirms that a shielded payment carries the case_id and the evidence hash of an anchored decision. That is the permissioned verification mode on the roadmap.

## Ready today (offline)

`coorre zcash-memo` reads an audit bundle, finds the decision that releases the payment (AUTO_APPROVED or APPROVED) and prints both memo forms. It makes no network call and creates no transaction. With `--check`, it takes a memo read from a payment, in either form, and reports whether it points to the released decision of that bundle.

```bash
offchain/target/debug/coorre zcash-memo --bundle web/verifier/samples/SUP-002/bundle.json
```

Run on 2026-10-10 inside an isolated network namespace:

```
  case        urn:coorre:case:SUP-002-20261008T193251Z
  decision    APPROVED (evidence 4)
  text memo   (ZIP 302 text, for a wallet's memo field)
coorre/1 case=b5acb4ac0ab259ca440536b6a2905c6cd757b9af64cf25bf66db16c05e2fa0da evidence=67a02cbbaba0f9dd0fc449399554f4258ace00aea0c14ba5e4a76f51e84d295e rule=7320d1d698663198cb21f5f5cce3e6d0064b8300a1042ebf13fc8934fbdabd2f state=APPROVED
```

The evidence hash is the one anchored on devnet for SUP-002's approver step (`coorre verify` reports `sha256:67a02cbbaba0…` for evidence 4). Checking that memo against SUP-002 prints `MATCH`; against SUP-001 it prints `NO MATCH the memo names another case`; a rejected case (MIL-002) has no memo to prepare. `offchain/crates/coorre-cli/tests/zcash_memo.rs` checks, for the ten recorded cases, that each of the eight released decisions yields a memo that matches its own bundle and no other.

## Runbook for a first shielded payment (not executed)

To be run when the project moves to Zcash mainnet, by the payer and the payee on their own devices. Network state on 2026-10-10: Zcash testnet activated NU7 on 2026-10-04 and released wallets fail on it ([zingolib issue 2859](https://github.com/zingolabs/zingolib/issues/2859)); mainnet NU7 is planned for 2026-11-05. Check both again before running.

1. Both install the current Zodl wallet from the official store listing linked at [zodl.com](https://zodl.com/), each creating a new wallet used only for this purpose.
2. The payee shares a shielded receiving address with the payer.
3. The operator runs `coorre verify` on the case (7/7) and `coorre zcash-memo --bundle <bundle>`, and sends the text memo to the payer.
4. The payer sends a shielded payment of the decided amount to that address and pastes the text memo, unchanged, in the memo field. The current fee is read from ZIP 317 and the wallet at that moment.
5. The payee opens the received payment, copies the memo, and the operator runs `coorre zcash-memo --bundle <bundle> --check "<memo>"`, which must print `MATCH`.
6. The payee exports the wallet's viewing key (Zodl: Advanced Settings, viewing key export, since version 3.4.1) for the auditor. The transaction id, the viewing key and the check output are recorded in `docs/evidence/` with the date.

## Open problems

- **The amount is public today.** The case record and every credential hold the amount and the autonomy limit in clear. Private amounts need commitments on the anchor and a proof that the committed amount is within the limit before the program can enforce `MandateExceeded`.
- **Zcash does not run the CoorRe program.** The release would be sent by a holder of the shielded funds after the decision is anchored. Unlike the Solana escrow, nothing on Zcash refuses a payment without an anchored decision. A verifier can detect a payment that has no matching decision, but cannot prevent it.
- **Memo integrity.** The memo is set by the sender. It links a payment to a decision; it does not prove the sender acted on that decision rather than copying its hashes.

## Where a private network fits the anchoring interface

- **Anchoring and settlement are one call today.** `anchor_transition` on Solana records the step and moves the escrow ([onchain/programs/coorre_anchor/src/lib.rs](../../onchain/programs/coorre_anchor/src/lib.rs)). A private network needs settlement split from anchoring: the `Anchorer` trait ([coorre-anchor/src/lib.rs](../../offchain/crates/coorre-anchor/src/lib.rs)) keeps recording evidence, and a separate settlement interface sends the payment once the decision is anchored.
- **Receipts are network-tagged.** A Zcash payment receipt would carry a `network_id` such as `zcash:testnet` and the transaction id, like the Solana receipts in the bundle ([coorre-verify/src/bundle.rs](../../offchain/crates/coorre-verify/src/bundle.rs)). Receipts stay hints; the verifier does not trust them.
- **The payment is checked by a new step in the verifier.** It would read a payment disclosure produced with a viewing key and match its memo against the anchored evidence. It runs only where a viewing key was shared, so it belongs to the permissioned mode, not to the seven public checks.
