#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test-only crate")]

use std::path::{Path, PathBuf};

use coorre_cli::files::{load_bundle, read_artifacts, verify_bundle};
use coorre_cli::snapshot::load_recorded_accounts;
use coorre_verify::{COORRE_DEVNET_PROGRAM_ID, SOLANA_DEVNET_NETWORK_ID, Status};

fn live_runs() -> Vec<PathBuf> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../onchain/live-runs");
    let mut dirs = Vec::new();
    for run in std::fs::read_dir(&root).unwrap() {
        let run = run.unwrap().path();
        if !run.is_dir() {
            continue;
        }
        for case in std::fs::read_dir(&run).unwrap() {
            let case = case.unwrap().path();
            if case.is_dir() {
                dirs.push(case);
            }
        }
    }
    dirs.sort();
    dirs
}

#[test]
fn every_live_run_verifies_seven_of_seven_from_its_own_recorded_accounts() {
    let dirs = live_runs();
    assert!(!dirs.is_empty(), "no live run recorded");
    for dir in dirs {
        for name in ["bundle.json", "accounts.json", "artifacts"] {
            assert!(dir.join(name).exists(), "{} lacks {name}", dir.display());
        }
        let snapshot = load_recorded_accounts(&dir.join("accounts.json")).unwrap();
        snapshot
            .ensure_source(SOLANA_DEVNET_NETWORK_ID, COORRE_DEVNET_PROGRAM_ID)
            .unwrap();
        assert!(
            snapshot.network_id.is_some() && snapshot.program_id.is_some(),
            "{}: accounts.json must record its network and program",
            dir.display()
        );
        let bundle = load_bundle(&dir.join("bundle.json")).unwrap();
        let files = read_artifacts(&dir.join("artifacts"), &bundle).unwrap();
        let report = verify_bundle(
            &bundle,
            &files,
            &snapshot.accounts,
            COORRE_DEVNET_PROGRAM_ID,
            SOLANA_DEVNET_NETWORK_ID,
        );
        assert_eq!(report.checks.len(), 7);
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
        let mut tampered = files.clone();
        let first = tampered.keys().next().unwrap().clone();
        tampered.get_mut(&first).unwrap()[10] ^= 0x01;
        let report = verify_bundle(
            &bundle,
            &tampered,
            &snapshot.accounts,
            COORRE_DEVNET_PROGRAM_ID,
            SOLANA_DEVNET_NETWORK_ID,
        );
        let failing: Vec<u8> = report
            .checks
            .iter()
            .filter(|c| c.status == Status::Fail)
            .map(|c| c.id)
            .collect();
        assert_eq!(failing, vec![1, 7], "{}", dir.display());
    }
}
