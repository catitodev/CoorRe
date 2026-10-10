# Devnet snapshot of the recorded cases

Solana devnet is the hackathon environment and can be reset at any time. This folder keeps the on-chain side of the ten recorded cases so they can still be verified after a reset, without any network access.

| File | Content |
|---|---|
| `accounts.json` | The raw `getMultipleAccounts` request and response (base64 account data, finalized commitment) for the 45 program accounts of the ten cases: one CaseRecord, which also holds the escrow, and one EvidenceAnchor per transition. |
| `signatures.json` | The raw `getSignatureStatuses` request and response (`searchTransactionHistory: true`) for the 45 transactions that opened the cases and anchored each transition. |

Both files record the RPC endpoint, the devnet genesis hash checked before reading, the slot of the response and the capture time in UTC.

| Capture | Value |
|---|---|
| Captured at (UTC) | 2026-10-10T22:09:47.746Z |
| Accounts slot | 509686323 |
| Signature statuses slot | 509686326 |
| RPC | https://api.devnet.solana.com |
| Genesis hash | EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG (devnet) |
| Program | 9esN1A8K1SASLg17ob81dbSdB4VX8ozc6tBLmJ247Wv |
| Cases | SUP-001, SUP-002, AGT-002, PES-002 (`web/verifier/samples/`); AGT-001, MIL-001, MIL-002, PES-001, SRV-001, SRV-002 (`onchain/devnet-bundles/2026-10-10/`) |
| Result | 45 of 45 accounts present and owned by the program; 45 of 45 transactions finalized without error |

## Verify a case offline

```bash
offchain/target/debug/coorre verify --bundle web/verifier/samples/SUP-002/bundle.json --artifacts web/verifier/samples/SUP-002/artifacts --accounts docs/evidence/devnet-snapshot/accounts.json
```

With `--accounts`, the verifier reads the accounts from the file and makes no network call. All ten cases pass 7 of 7 checks this way, and `offchain/crates/coorre-cli/tests/devnet_snapshot.rs` checks it on every test run.

## What the snapshot proves and what it does not

The snapshot is a recording made by the CoorRe team. Offline verification proves that the evidence, the signatures, the documents and the recorded accounts agree with each other. It does not prove by itself that the accounts were on chain. That is checked independently through the transaction signatures and slots in `signatures.json`, against devnet while it lasts or against any archive of it. The accounts recorded earlier for the browser tests (`web/verifier/test/fixtures/`, slot 508927881) match this snapshot byte for byte.

## Capture again

```bash
scripts/capture-devnet-snapshot
```

The script only reads (`getGenesisHash`, `getMultipleAccounts`, `getSignatureStatuses`), refuses any RPC that does not report the devnet genesis hash, and exits non-zero if an account is missing, is owned by another program, or a transaction is not finalized.
