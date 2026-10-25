# CoorRe on Hedera — phase 0 (reading and feasibility)

Done when: the Hedera primitives are tested on a Solo network or marked "not verified" with the reason; the W.A.T.A. state is checked with file:line; the Solana map and its golden vectors are identified; the pinned fixture and the drift check pass; docs/APPLICATIONS.md exists. Nothing in onchain/, bridge/, the README or main changes.

## 1. Tooling and versions (checked 2026-10-25)

| Tool | Version | Source |
|---|---|---|
| Solo | 0.94.0 (released 2026-10-20) | npm `@hiero-ledger/solo`, [github.com/hiero-ledger/solo](https://github.com/hiero-ledger/solo/releases) |
| Hiero SDK (CoorRe on Hedera) | `@hiero-ledger/sdk` 2.90.1 | npm |
| Hashgraph SDK (W.A.T.A.) | `@hashgraph/sdk` 2.81.0 | npm |
| Solidity compiler | `solc` 0.8.28 (0.8.28+commit.7893614a) | npm; the version W.A.T.A. pins |
| Hardhat | 3.21.0 on npm; not installed, the choice against Foundry belongs to phase 1 | npm |
| Node | 24.21.0 locally, 24 in CI; Solo needs ≥ 22 | `node --version`, Solo quickstart |
| Consensus node | v0.78.1 latest release; default `contracts.evm.version` v0.70 | hiero-consensus-node `ContractsConfig.java` at v0.78.1 |
| Mirror node | v0.165.1 latest release | hiero-mirror-node, `rest/api/v1/openapi.yml` |

Two transitive packages are overridden to patched versions: `ws` 8.21.3 (GHSA-58qx-3vcg-4xpx, GHSA-96hv-2xvq-fx4p; pulled by ethers through the SDK) and `tmp` 0.2.7 (GHSA-52f5-9888-hmc6, GHSA-ph9p-34f9-6g65; pulled by solc, used only by its SMT solver path). `npm audit` reports 0 vulnerabilities.

### Where Solo runs

Solo's single-node minimum is 12 GB of RAM (16 GB recommended), 4 cores and 20 GB of free disk ([System Readiness](https://solo.hiero.org/docs/simple-solo-setup/system-readiness/)). The development machine has 5.5 GiB of RAM and no Docker, so Solo runs in GitHub Actions: standard runners for public repositories have 4 CPUs, 16 GB of RAM and a 14 GB SSD ([GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)). The workflow frees disk before deploying. Day-to-day contract tests will run in memory (phase 1 picks the tool); testnet is used only for the public demonstration, with explicit approval.

`.github/workflows/hedera-solo.yml` runs on demand and on pushes to the `coorre-hedera` branch that touch `hedera/`. GitHub dispatches a workflow by hand only when its file exists on the default branch, and main stays untouched.

### Official sources that disagree

- Solo endpoints: [Using Solo with Hiero SDKs](https://solo.hiero.org/docs/using-solo/using-solo-with-hiero-sdks/) gives `127.0.0.1:38081` as mirror gRPC; [Service Endpoints](https://solo.hiero.org/docs/using-solo/endpoints/) gives `http://localhost:38081` as mirror REST. The probes use REST on 38081 and the workflow prints `solo deployment config ports`.
- Block timestamp: HIP-415 (Final, v0.26.0) defines it as the consensus timestamp of the first transaction of the record file; HIP-1056 Block Streams (Approved) defines a block's timestamp as the timestamp of its first round. Probe P2 measures what the contract sees.
- `msg.value`: [HBAR decimals](https://docs.hedera.com/evm/differences/hbar-decimals.md) says that in the JSON-RPC relay `msg.value` has 18 decimals and that 1 tinybar = 10^10 weibar, without stating the unit inside the contract. Probes P5 measure it.
- The EVM versioning table in hiero-consensus-node maps versions up to v0.51 (Cancun); the v0.70 default is not in the table.

The pages on docs.hedera.com embed an "Agent Instructions" block; it is not a technical source and was ignored.

## 2. W.A.T.A. state (vivipolli/wata@1462dfeb3d492893331dc5c0b0eae15d91ec807c, read through the GitHub API)

No clone. The repository has no LICENSE file; `PESEscrowV3.sol` and `OracleManager.sol` carry `SPDX-License-Identifier: MIT`. Nothing from it is committed here: [hedera/reference/wata.lock.json](../../hedera/reference/wata.lock.json) keeps the commit and the sha256 of seven files.

| Claim | Where |
|---|---|
| Modes AUTO and HYBRID; states None, PendingApproval, Approved, Released, Rejected, InReview, ClosedNoPay | `contracts/contracts/PESEscrowV3.sol:19-20` |
| `submitBatch` only by an oracle of OracleManager; audit hash single use; AUTO approves at once; HYBRID sets `approvalDeadline = block.timestamp + approvalWindow` | `PESEscrowV3.sol:192-228` (oracle 199, reuse 203, AUTO 219-221, deadline 224) |
| `approve` only financialManager, `whenNotPaused`, `SameAccount`, `block.timestamp > approvalDeadline` reverts | `PESEscrowV3.sol:231-241` |
| `reject` only financialManager, without `whenNotPaused` | `PESEscrowV3.sol:243-249` |
| `expire` public, moves PendingApproval to InReview when `block.timestamp > approvalDeadline` | `PESEscrowV3.sol:252-259` |
| At `block.timestamp == approvalDeadline`, `approve` still passes and `expire` reverts | `PESEscrowV3.sol:236`, `256` |
| `closeNoPay` only admin, from Rejected or InReview | `PESEscrowV3.sol:261-267` |
| `release` callable by anyone, pays the producer | `PESEscrowV3.sol:270-284` |
| Admin in two steps; `setFinancialManager` and `setApprovalWindow` only admin, at any time | `PESEscrowV3.sol:334-357` |
| Native unit flagged "MUST be verified on the target network" | `PESEscrowV3.sol:14-16` |
| `POST /api/payments/approval-call/:agreementId` (MANAGER) returns callData; the deadline check uses the server clock `Date.now()` | `backend/src/routes/payments.ts:514-560` (540) |
| HCS topic created without submitKey and without adminKey; id kept in memory and in `process.env` | `backend/src/services/hcs.ts:59-69` |
| Local cycle with a 2-of-3 threshold admin and a msg.value unit check | `backend/src/scripts/localEscrowCycle.ts:89-97`, `121-136`, `187-188` |
| `deployment.json` points to the 2025-09-25 PESContract, no V3 address | `contracts/deployment.json` |

### Reproducible fixture

`node hedera/scripts/wata-fetch` downloads the pinned files into `hedera/.cache/` (ignored) and checks their hashes. `node hedera/probes/compile.mjs` compiles them with the W.A.T.A. settings read from their build info: solc 0.8.28, optimizer 200 runs, viaIR, evmVersion paris. The bytecode is byte-identical to the artifacts W.A.T.A. committed at the same commit:

| Contract | Bytecode sha256 |
|---|---|
| PESEscrowV3 | `14906b31073e4404147d0a918c95f85e2d63ec3f1d15d8071cb8cb1c0c352c51` |
| OracleManager | `137dde29716320bdf11bac8b03505bbcc757e72fbf14a7e817015c505d47f047` |

The compiler refuses to write a build whose bytecode differs. `node hedera/scripts/wata-drift-check` compares the pinned hashes with upstream HEAD, read only.

## 3. CoorRe on Solana and the shared core (read only)

| Concept | Solana program | Shared core |
|---|---|---|
| States OPEN → SUBMITTED → AGENT_REVIEWED → AUTO_APPROVED or ESCALATED → APPROVED or REJECTED | `onchain/programs/coorre_anchor/src/lib.rs:6-22` | `coorre-engine/src/machine.rs` |
| Role required for each transition (submitter, agent, rule_engine, approver) | `lib.rs:57-66` | `machine.rs:5` (`required_role`) |
| Four distinct role keys | `lib.rs:82-87` (`RolesNotDistinct`) | `machine.rs:64` (`ensure_distinct`) |
| Signer must be the role key | `lib.rs:141` (`UnauthorizedActor`) | `machine.rs:168` |
| Previous-hash chain, genesis = case_id | `lib.rs:142-147` (`PrevHashMismatch`) | `machine.rs:146` |
| Autonomy limit on AUTO_APPROVED | `lib.rs:148-150` (`MandateExceeded`) | `machine.rs:174` |
| Payout on AUTO_APPROVED or APPROVED, refund on REJECTED | `lib.rs:186-206` | `machine.rs:22` (`payout_for`) |
| Time recorded per transition: `slot`, `unix_ts` | `lib.rs:161-162` | — |
| case_id = SHA-256(case_ref) | — | `coorre-model/src/evidence.rs:302` |
| Anchoring interface | — | `coorre-anchor/src/lib.rs:57-67` (`Anchorer`) |
| Solana-shaped reads in the verifier | — | `coorre-verify/src/verify.rs:23` (`AccountSnapshot { owner, data }`), `55-60` (owner = program), `269`, `362`, `416-427` |

Golden vectors that Hedera tests can consume:

- `offchain/crates/coorre-model/tests/vectors/rfc8785` (JCS canonicalization)
- `offchain/crates/coorre-model/tests/vectors/w3c-vc-di-eddsa-b3` (eddsa-jcs-2022 proof)
- `offchain/crates/coorre-model/tests/vectors/devnet-bridge-smoke` (raw Solana account bytes; Solana-specific, the reference for the neutral anchor record)
- Ten devnet audit bundles: `onchain/devnet-bundles/2026-10-10/*` and `web/verifier/samples/*`, which verify 7 of 7 and must keep doing so after the core changes.

Solana keys and evidence signatures are Ed25519 (`did:key`). On Hedera an ED25519 account can sign native transactions; probe P7 checks which `msg.sender` a contract sees for it, which decides whether the same role keys can sign on both networks.

## 4. Hedera primitives

Run: GitHub Actions run [40244576988](https://github.com/catitodev/CoorRe/actions/runs/40244576988) on commit 3cfdea0, 2026-10-25 23:30 UTC; report in its `hedera-probe-report` artifact. Runner: 4 cores, 15 GiB of RAM, 106 GB free after cleanup (the root disk is 145 GB, so the 14 GB SSD figure did not limit Solo). `solo one-shot single deploy` took about 3.5 minutes and deployed consensus node 0.77.2, mirror node 0.163.0, JSON-RPC relay 0.80.1, block node 0.44.2 and explorer 26.2.0 (Solo chart 0.67.0). The default endpoints answered: consensus gRPC `127.0.0.1:35211` (node 0.0.3), mirror REST `http://localhost:38081/api/v1`, relay `http://localhost:37546`. That settles the endpoint contradiction above: 38081 serves REST.

| Probe | Question | Result | Status |
|---|---|---|---|
| P0 | Relay chain id | `0x12a` (298) | verified |
| P1 | `msg.sender` when a contract set as financialManager calls `PESEscrowV3.approve`/`reject` | The escrow sees the calling contract: `approve` through the probe succeeds, the period becomes Approved, `PeriodApproved.approver` is the probe's address; `reject` through the probe leaves the period Rejected; a direct `approve` by the admin reverts with `NotFinancialManager` (selector `0x38bf5ffc`) | verified |
| P2 | `block.timestamp` against consensus time | In 4 of 4 calls the contract saw the whole second of the block's first record (`/api/v1/blocks/{n}` `timestamp.from`), matching HIP-415; in the same 4 calls it was also the second of the calling transaction. One block held several records (from …004.229, call at …004.613). A block that starts in one second and holds a call in the next was not observed | verified for what was observed |
| P3 | HCS message fields | The mirror returns `sequence_number`, `running_hash` (base64, 48 bytes), `running_hash_version` 3, `consensus_timestamp`, `payer_account_id`, `chunk_info`, `message`; sequence, running hash and consensus timestamp equal the receipt and the record. 1024 bytes in one chunk: SUCCESS; 1025 bytes in one chunk: `MESSAGE_SIZE_TOO_LARGE`. The SDK receipt left `topicRunningHashVersion` empty | verified |
| P4 | Topic keys | Message without the submitKey: `INVALID_SIGNATURE`; with it: SUCCESS. Admin key 2-of-3: update with one signature `INVALID_SIGNATURE`, with two SUCCESS. Topic created without adminKey: update and delete `UNAUTHORIZED` (immutable). The mirror shows the threshold admin key as `ProtobufEncoded` | verified |
| P5-sdk | `msg.value` for 1 HBAR sent with `setPayableAmount` | 100000000: tinybar | verified |
| P5-deposit | `PESEscrowV3.deposit` with 2 HBAR through the SDK | `deposited` = 200000000: tinybar | verified |
| P5-jsonrpc | `msg.value` for a value sent with `eth_sendRawTransaction` | Signing a raw Ethereum transaction needs a library outside the approved dependencies | not verified |
| P6 | W.A.T.A. bytecode (paris) on this network | Deploys and runs (`createAgreement`, `deposit`, `submitBatch`) | verified |
| P7 | `msg.sender` for each key type through `ContractExecuteTransaction` | ED25519 account 0.0.2: long-zero address `0x…02` (mirror `evm_address` the same); ECDSA account 0.0.1004: its key alias `0x927e…4d0e`; `tx.origin` equals the sender | verified |

Not evaluated in this phase: recomputing the HCS running hash from its inputs (version 3), the system contracts (HTS 0x167, Exchange Rate 0x168, PRNG 0x169, Account Service 0x16a, Schedule 0x16b), the Hedera CLI, Contract Builder and Agent Kit. Phase 1 decides which of them the case needs and records why the rest are left out.

## 5. Open points for phase 1

1. **Path A is technically possible.** A CoorRe contract can act as the W.A.T.A. financialManager without any change to PESEscrowV3 (P1). It only enforces a mandate if the admin cannot swap it out at will: `setFinancialManager` is admin-only and has no delay (`PESEscrowV3.sol:347-351`). Admin governance is the decision that gives path A its meaning.
2. **The same Ed25519 role keys can work on both networks.** An ED25519 Hedera account calls a contract as its long-zero address (P7), so a CoorRe role key can be the key of a Hedera account. The binding differs from Solana: there the program compares the signer's public key; on Hedera the contract sees an account address, and the link between key and account is proven through the account's key (mirror `/api/v1/accounts/{id}`). This goes into the Solana ↔ Hedera divergence table.
3. **Clocks.** `block.timestamp` follows HIP-415 in this Solo build (P2). Still to test in phase 2: a decision exactly at `approvalDeadline` (`approve` passes, `expire` reverts) and a call whose block started in the previous second. W.A.T.A.'s approval-call route checks the deadline against the server clock (`payments.ts:540`), a third clock for the threat model.
4. **HCS log.** Messages up to 1024 bytes in one chunk (P3): a CoorRe entry carries hashes and a compact payload. The verifier reads `running_hash_version` from the mirror, since the SDK receipt leaves it empty. Recomputing the running hash needs the official definition; it is not verified yet.
5. **Topic keys.** A threshold submitKey and either a threshold adminKey or no adminKey both behave as documented (P4). Phase 1 chooses.
6. **`msg.value` through JSON-RPC (P5-jsonrpc).** `approve` and `reject` carry no value, so CoorRe's decision path does not depend on it; the deposit path belongs to W.A.T.A. Closing it would need `ethers` as a direct dependency (it is already present, pinned at 6.16.0, through the SDK). It stays open until you decide whether it is needed.
7. **Contract tool.** Hardhat 3 or Foundry, with the reason recorded.
8. **Solana tooling, outside this module.** The regular CI fails in the Playground preflight on this branch, and would fail the same way on main because the check reads the live upstream sources: upstream Solana Playground changed `server/src/templates/legacy.rs` on 2026-10-12, 13 and 15, and the parser no longer finds the template versions. The program, its tests and the four other jobs pass. Under the project rule this calls for a review of the upstream change and a dedicated commit to `tools/playground-preflight/reference.json`; it is left untouched here because the Solana module is out of scope.
