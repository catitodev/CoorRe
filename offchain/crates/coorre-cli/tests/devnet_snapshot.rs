#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test-only crate")]

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use coorre_cli::files::{load_bundle, read_artifacts, verify_bundle};
use coorre_cli::snapshot::{accounts_from_rpc, load_recorded_accounts};
use coorre_verify::{COORRE_DEVNET_PROGRAM_ID, SOLANA_DEVNET_NETWORK_ID, Status};
use serde_json::Value;

fn repository() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn snapshot_dir() -> PathBuf {
    repository().join("docs/evidence/devnet-snapshot")
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn recorded() -> Vec<PathBuf> {
    let root = repository();
    let mut parents = vec![root.join("web/verifier/samples")];
    for run in std::fs::read_dir(root.join("onchain/devnet-bundles")).unwrap() {
        let run = run.unwrap().path();
        if run.is_dir() {
            parents.push(run);
        }
    }
    let mut dirs: Vec<PathBuf> = parents
        .iter()
        .flat_map(|p| std::fs::read_dir(p).unwrap())
        .map(|e| e.unwrap().path())
        .filter(|p| p.join("bundle.json").is_file())
        .collect();
    dirs.sort();
    dirs
}

#[test]
fn every_recorded_case_passes_all_seven_checks_from_the_devnet_snapshot() {
    let snapshot = load_recorded_accounts(&snapshot_dir().join("accounts.json")).unwrap();
    let dirs = recorded();
    assert_eq!(dirs.len(), 10);
    for dir in dirs {
        let bundle = load_bundle(&dir.join("bundle.json")).unwrap();
        let files = read_artifacts(&dir.join("artifacts"), &bundle).unwrap();
        let report = verify_bundle(
            &bundle,
            &files,
            &snapshot.accounts,
            COORRE_DEVNET_PROGRAM_ID,
            SOLANA_DEVNET_NETWORK_ID,
        );
        for check in &report.checks {
            assert_eq!(
                check.status,
                Status::Pass,
                "{} check {}: {:?}",
                dir.display(),
                check.id,
                check.details
            );
        }
        assert_eq!(report.checks.len(), 7);
    }
}

#[test]
fn the_snapshot_holds_exactly_the_accounts_of_the_recorded_bundles() {
    let raw = read_json(&snapshot_dir().join("accounts.json"));
    assert_eq!(raw["format"], "coorre-devnet-snapshot/1");
    assert_eq!(raw["network_id"], SOLANA_DEVNET_NETWORK_ID);
    assert_eq!(raw["program_id"], COORRE_DEVNET_PROGRAM_ID);
    assert_eq!(
        raw["genesis_hash"],
        "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
    );
    assert_eq!(raw["request"]["method"], "getMultipleAccounts");
    assert_eq!(raw["request"]["params"][0], raw["addresses"]);
    let snapshot = load_recorded_accounts(&snapshot_dir().join("accounts.json")).unwrap();
    assert_eq!(
        snapshot.slot,
        raw["response"]["result"]["context"]["slot"].as_u64()
    );
    let mut required = BTreeSet::new();
    for dir in recorded() {
        let bundle = load_bundle(&dir.join("bundle.json")).unwrap();
        required.extend(bundle.required_accounts());
    }
    let captured: BTreeSet<String> = snapshot.accounts.keys().cloned().collect();
    assert_eq!(captured, required);
    assert!(
        snapshot
            .accounts
            .values()
            .all(|a| a.owner == COORRE_DEVNET_PROGRAM_ID)
    );
}

#[test]
fn every_recorded_transaction_is_finalized_without_error_in_the_snapshot() {
    let raw = read_json(&snapshot_dir().join("signatures.json"));
    assert_eq!(raw["format"], "coorre-devnet-signatures/1");
    assert_eq!(raw["request"]["method"], "getSignatureStatuses");
    let signatures: Vec<&str> = raw["signatures"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap())
        .collect();
    assert_eq!(raw["request"]["params"][0], raw["signatures"]);
    let statuses = raw["response"]["result"]["value"].as_array().unwrap();
    assert_eq!(statuses.len(), signatures.len());
    for (signature, status) in signatures.iter().zip(statuses) {
        assert_eq!(status["confirmationStatus"], "finalized", "{signature}");
        assert!(status["err"].is_null(), "{signature}");
    }
    let mut expected = BTreeSet::new();
    for dir in recorded() {
        let bundle = load_bundle(&dir.join("bundle.json")).unwrap();
        expected.extend(bundle.open_receipt.map(|r| r.tx_signature));
        expected.extend(
            bundle
                .evidence
                .into_iter()
                .filter_map(|e| e.receipt.map(|r| r.tx_signature)),
        );
    }
    let listed: BTreeSet<String> = signatures.iter().map(|s| (*s).to_owned()).collect();
    assert_eq!(listed, expected);
}

#[test]
fn the_earlier_browser_recordings_match_the_snapshot_byte_for_byte() {
    let snapshot = load_recorded_accounts(&snapshot_dir().join("accounts.json")).unwrap();
    let fixtures = repository().join("web/verifier/test/fixtures");
    let mut compared = 0;
    for entry in std::fs::read_dir(fixtures).unwrap() {
        let path = entry.unwrap().path();
        let earlier = accounts_from_rpc(&read_json(&path)).unwrap();
        for (address, account) in &earlier.accounts {
            assert_eq!(
                snapshot.accounts.get(address),
                Some(account),
                "{} {address}",
                path.display()
            );
            compared += 1;
        }
    }
    assert_eq!(compared, 19);
}
