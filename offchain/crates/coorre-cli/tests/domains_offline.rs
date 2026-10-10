#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test-only crate")]

use std::path::{Path, PathBuf};

use coorre_anchor::memory::{MEMORY_NETWORK_ID, MEMORY_PROGRAM_ID, MemoryAnchorer};
use coorre_cli::demo::{DemoContext, run_case};
use coorre_cli::env::FixedEnvironment;
use coorre_cli::files::{fetch_accounts, load_bundle, read_artifacts, verify_bundle};
use coorre_cli::fixtures::load_cases;
use coorre_cli::keys::DemoKeys;
use coorre_model::CaseState;
use coorre_verify::Status;

const SEEDS: [[u8; 32]; 5] = [[41; 32], [42; 32], [43; 32], [44; 32], [45; 32]];

struct Expected {
    id: &'static str,
    rule: &'static str,
    final_state: CaseState,
    rogue: Option<&'static str>,
    log_line: &'static str,
}

const EXPECTED: [Expected; 4] = [
    Expected {
        id: "AGT-001",
        rule: "agent-purchase",
        final_state: CaseState::AutoApproved,
        rogue: None,
        log_line: "within the mandate: escrow released to the payee",
    },
    Expected {
        id: "AGT-002",
        rule: "agent-purchase",
        final_state: CaseState::Approved,
        rogue: Some("MandateExceeded"),
        log_line: "escalated to the human approver: supplier registration expired; amount exceeds autonomy limit",
    },
    Expected {
        id: "PES-001",
        rule: "ecosystem-services-payment",
        final_state: CaseState::AutoApproved,
        rogue: None,
        log_line: "within the mandate: escrow released to the payee",
    },
    Expected {
        id: "PES-002",
        rule: "ecosystem-services-payment",
        final_state: CaseState::Approved,
        rogue: Some("MandateExceeded"),
        log_line: "escalated to the human approver: verified area below committed area; amount exceeds autonomy limit",
    },
];

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../demo/fixtures")
}

fn scratch(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn failing(report: &coorre_verify::Report) -> Vec<u8> {
    report
        .checks
        .iter()
        .filter(|c| c.status == Status::Fail)
        .map(|c| c.id)
        .collect()
}

#[test]
fn every_domain_case_runs_offline_and_verifies_seven_of_seven() {
    let keys = DemoKeys::from_seeds(SEEDS);
    let mut anchorer = MemoryAnchorer::new(keys.creator, keys.role_keys(), 650_240);
    let mut env = FixedEnvironment::new("2026-10-09", "20261009T120000Z");
    let out_dir = scratch("domains-offline");
    let cases: Vec<_> = load_cases(&fixtures())
        .unwrap()
        .into_iter()
        .filter(|c| !c.id.starts_with("SUP-"))
        .collect();
    assert_eq!(
        cases.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
        EXPECTED.iter().map(|e| e.id).collect::<Vec<_>>()
    );

    let mut released = 0u64;
    for (spec, expected) in cases.iter().zip(&EXPECTED) {
        assert!(!spec.demo, "{} must not run in the default demo", spec.id);
        assert_eq!(spec.rule_id().unwrap().id(), expected.rule);
        let mut out = Vec::new();
        let outcome = {
            let mut ctx = DemoContext {
                anchorer: &mut anchorer,
                keys: &keys,
                env: &mut env,
                out: &mut out,
                fixtures_dir: &fixtures(),
                out_dir: &out_dir,
            };
            run_case(&mut ctx, spec).unwrap()
        };
        let log = String::from_utf8(out).unwrap();
        assert_eq!(outcome.final_state, expected.final_state, "{}", spec.id);
        assert_eq!(
            outcome.rogue_rejected_with.as_deref(),
            expected.rogue,
            "{}",
            spec.id
        );
        assert_eq!(
            outcome.report.passed_count(),
            7,
            "{:#?}",
            outcome.report.checks
        );
        assert!(outcome.tamper_detected, "{}", spec.id);
        assert!(log.contains(expected.log_line), "{log}");
        assert!(log.contains("payee submitted its documents"), "{log}");
        if matches!(
            expected.final_state,
            CaseState::AutoApproved | CaseState::Approved
        ) {
            released += spec.amount().unwrap();
        }

        let bundle = load_bundle(&outcome.bundle_path).unwrap();
        assert_eq!(bundle.rules.len(), 1);
        assert_eq!(bundle.rules[0]["id"], expected.rule);
        let files = read_artifacts(&outcome.artifacts_dir, &bundle).unwrap();
        let accounts = fetch_accounts(&mut anchorer, &bundle).unwrap();
        let again = verify_bundle(
            &bundle,
            &files,
            &accounts,
            MEMORY_PROGRAM_ID,
            MEMORY_NETWORK_ID,
        );
        assert!(again.passed(), "{:#?}", again.checks);
        for name in files.keys() {
            let mut tampered = files.clone();
            tampered.get_mut(name).unwrap()[10] ^= 0x01;
            let report = verify_bundle(
                &bundle,
                &tampered,
                &accounts,
                MEMORY_PROGRAM_ID,
                MEMORY_NETWORK_ID,
            );
            assert_eq!(failing(&report), [1, 7], "{} {name}", spec.id);
        }
    }
    assert_eq!(
        anchorer.balance_change(&keys.submitter.public_key()),
        i128::from(released)
    );
}
