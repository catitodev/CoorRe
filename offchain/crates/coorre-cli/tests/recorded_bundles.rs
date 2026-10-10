#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test-only crate")]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use coorre_cli::files::{load_bundle, read_artifacts, verify_bundle};
use coorre_verify::{COORRE_DEVNET_PROGRAM_ID, SOLANA_DEVNET_NETWORK_ID, Status};

const OFFLINE_CHECKS: [u8; 4] = [1, 2, 3, 7];

fn repository() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn bundle_dirs(parent: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(parent)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.join("bundle.json").is_file())
        .collect();
    dirs.sort();
    dirs
}

fn recorded() -> Vec<PathBuf> {
    let root = repository();
    let mut dirs = bundle_dirs(&root.join("web/verifier/samples"));
    for run in std::fs::read_dir(root.join("onchain/devnet-bundles")).unwrap() {
        let run = run.unwrap().path();
        if run.is_dir() {
            dirs.extend(bundle_dirs(&run));
        }
    }
    dirs
}

#[test]
fn every_recorded_devnet_bundle_is_present() {
    let names: Vec<String> = recorded()
        .iter()
        .map(|d| d.file_name().unwrap().to_str().unwrap().to_owned())
        .collect();
    let mut sorted = names.clone();
    sorted.sort();
    assert_eq!(
        sorted,
        [
            "AGT-001", "AGT-002", "MIL-001", "MIL-002", "PES-001", "PES-002", "SRV-001", "SRV-002",
            "SUP-001", "SUP-002"
        ]
    );
}

#[test]
fn recorded_devnet_bundles_pass_every_check_that_needs_no_chain() {
    for dir in recorded() {
        let bundle = load_bundle(&dir.join("bundle.json")).unwrap();
        assert_eq!(
            bundle.network_id,
            SOLANA_DEVNET_NETWORK_ID,
            "{}",
            dir.display()
        );
        assert_eq!(
            bundle.program_id,
            COORRE_DEVNET_PROGRAM_ID,
            "{}",
            dir.display()
        );
        let case = dir.file_name().unwrap().to_str().unwrap();
        assert!(
            bundle
                .case_ref
                .starts_with(&format!("urn:coorre:case:{case}-")),
            "{}",
            bundle.case_ref
        );
        let files = read_artifacts(&dir.join("artifacts"), &bundle).unwrap();
        assert_eq!(files.len(), bundle.artifacts.len(), "{}", dir.display());
        let report = verify_bundle(
            &bundle,
            &files,
            &BTreeMap::new(),
            COORRE_DEVNET_PROGRAM_ID,
            SOLANA_DEVNET_NETWORK_ID,
        );
        for check in report
            .checks
            .iter()
            .filter(|c| OFFLINE_CHECKS.contains(&c.id))
        {
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
            &BTreeMap::new(),
            COORRE_DEVNET_PROGRAM_ID,
            SOLANA_DEVNET_NETWORK_ID,
        );
        let failing: Vec<u8> = report
            .checks
            .iter()
            .filter(|c| OFFLINE_CHECKS.contains(&c.id) && c.status == Status::Fail)
            .map(|c| c.id)
            .collect();
        assert_eq!(failing, [1, 7], "{}", dir.display());
    }
}
