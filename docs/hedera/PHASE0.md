# CoorRe on Hedera — network primitives

What the Hedera network does for the primitives CoorRe depends on, measured on a local Solo network in GitHub Actions. The probes are in [hedera/probes/run.mjs](../../hedera/probes/run.mjs) and run with every change to `hedera/`.

## Tooling and versions (checked 2026-10-25)

| Tool | Version | Source |
|---|---|---|
| Solo | 0.94.0 | npm `@hiero-ledger/solo`, [hiero-ledger/solo](https://github.com/hiero-ledger/solo/releases) |
| Hiero SDK | `@hiero-ledger/sdk` 2.90.1 | npm |
| Hardhat | 3.21.0 (dev only; telemetry disabled) | npm |
| Solidity | 0.8.28+commit.7893614a, optimizer 200, viaIR, evmVersion paris | Hardhat build |
| Node | 24 in CI; Solo needs ≥ 22 | Solo quickstart |
| Consensus node | v0.78.1 latest release; default `contracts.evm.version` v0.70 | hiero-consensus-node `ContractsConfig.java` |
| Mirror node | v0.165.1 latest release | hiero-mirror-node `rest/api/v1/openapi.yml` |

Solo's single-node minimum is 12 GB of RAM, 4 cores and 20 GB of free disk ([System Readiness](https://solo.hiero.org/docs/simple-solo-setup/system-readiness/)), so Solo runs on GitHub-hosted runners for public repositories (4 CPUs, 16 GB of RAM; [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)) after freeing disk. One run deploys consensus node 0.77.2, mirror node 0.163.0, relay 0.80.1 and block node 0.44.2 in about 3.5 minutes.

### Official sources that disagree

- Solo endpoints: one page gives `127.0.0.1:38081` as mirror gRPC, another as mirror REST; the probes show it serves REST (`/api/v1`).
- Block timestamp: HIP-415 (Final) defines it as the consensus timestamp of the block's first record; HIP-1056 Block Streams (Approved) as the timestamp of its first round. Probe P2 measures what a contract sees.
- The EVM versioning table in hiero-consensus-node maps versions up to v0.51 (Cancun); the v0.70 default is not in it.
- Contract verification: Hedera's documentation now directs to Sourcify (`https://sourcify.dev/server`, chain 296 for testnet); the earlier `server-verify.hashscan.io` endpoints are deprecated and forwarded.

## Results

Run: GitHub Actions run [40326559898](https://github.com/catitodev/CoorRe/actions/runs/40326559898) on branch `hedera-engine`.

| Probe | Question | Result | Status |
|---|---|---|---|
| P0 | Relay chain id | `0x12a` (298) | verified |
| P1 | `msg.sender` when a contract set as financial manager calls a period escrow's `approve`/`reject` | The escrow sees the calling contract; a direct call by the admin reverts with `NotFinancialManager` | verified |
| P2 | `block.timestamp` against consensus time | The whole second of the block's first record (HIP-415); one block may hold several records | verified |
| P3 | HCS message fields | `sequence_number`, `running_hash` (48 bytes), `running_hash_version` 3, `consensus_timestamp`, `payer_account_id`, `chunk_info` match the receipt and the record; 1024 bytes pass, 1025 return `MESSAGE_SIZE_TOO_LARGE`; the SDK receipt leaves `topicRunningHashVersion` empty | verified |
| P4 | Topic keys | Without the submit key: `INVALID_SIGNATURE`; 2-of-3 admin key: one signature refused, two accepted; no admin key: update and delete `UNAUTHORIZED` | verified |
| P5 | `msg.value` for 1 HBAR through `setPayableAmount` | 100000000: tinybar | verified |
| P6 | Bytecode built with paris and viaIR | Deploys and runs | verified |
| P7 | `msg.sender` by key type | ED25519 account: its long-zero address; ECDSA account: its key alias; `tx.origin` equals the sender | verified |

## Wallets through the relay

Verified by the host integration on Solo (`hedera/integration/run.mjs`):

- the fee ethers estimates (142 wei) is below the relay's minimum gas price (710000000000 weibar); price relay transactions with `eth_gasPrice`;
- native transactions do not advance an account's EVM nonce, and the Mirror Node shows them in EVM form with nonce 0; ethers' `wait()` can report a replacement when the same account also uses the SDK, so wait for the receipt by the transaction's own hash.

## Testnet notes

- `ContractCreateFlow` appends bytecode in 4096-byte chunks with a default cap of 5 HBAR, below the testnet fee table for that size; the testnet SDK configuration caps fees at 20 HBAR (the network charges the computed fee).
- `ContractCreateFlow` stores a string as its hex text, which is what the network reads, and a `Uint8Array` as raw bytes; every deploy requires hex text.
- `AccountBalanceQuery` is deprecated on current networks; balances are read from the Mirror Node.

## Golden vectors shared with the engine

- `offchain/crates/coorre-model/tests/vectors/rfc8785` (JCS) and the SUP-001 `case_id`, recomputed in JavaScript by `hedera/test/canonical.test.mjs`;
- the five rule hashes recorded in the devnet bundles, recomputed in JavaScript from the rule registry;
- `offchain/crates/coorre-model/tests/vectors/w3c-vc-di-eddsa-b3` for the decision credential.
