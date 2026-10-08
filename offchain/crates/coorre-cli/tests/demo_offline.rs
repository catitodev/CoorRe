#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test-only crate")]

use std::path::{Path, PathBuf};
use std::process::Command;

use coorre_anchor::memory::{MEMORY_NETWORK_ID, MEMORY_PROGRAM_ID, MemoryAnchorer};
use coorre_cli::demo::{DemoContext, run_case};
use coorre_cli::env::FixedEnvironment;
use coorre_cli::files::{fetch_accounts, load_bundle, read_artifacts, verify_bundle};
use coorre_cli::fixtures::load_cases;
use coorre_cli::keys::DemoKeys;
use coorre_model::{CaseState, Ed25519Keypair};

const SEEDS: [[u8; 32]; 5] = [[31; 32], [32; 32], [33; 32], [34; 32], [35; 32]];

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../demo/fixtures")
}

fn scratch(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn the_three_spec_cases_run_and_verify_offline() {
    let keys = DemoKeys::from_seeds(SEEDS);
    let mut anchorer = MemoryAnchorer::new(keys.creator, keys.role_keys(), 650_240);
    let mut env = FixedEnvironment::new("2026-10-09", "20261009T120000Z");
    let mut out = Vec::new();
    let out_dir = scratch("demo-offline");
    let cases = load_cases(&fixtures()).unwrap();
    assert_eq!(
        cases.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
        ["SUP-001", "SUP-002", "SUP-003"]
    );

    let mut outcomes = Vec::new();
    for spec in &cases {
        let mut ctx = DemoContext {
            anchorer: &mut anchorer,
            keys: &keys,
            env: &mut env,
            out: &mut out,
            fixtures_dir: &fixtures(),
            out_dir: &out_dir,
        };
        outcomes.push(run_case(&mut ctx, spec).unwrap());
    }
    let log = String::from_utf8(out).unwrap();

    let expected = [
        (CaseState::AutoApproved, None),
        (CaseState::Approved, Some("MandateExceeded")),
        (CaseState::Rejected, Some("MandateExceeded")),
    ];
    for (outcome, (state, rogue)) in outcomes.iter().zip(expected) {
        assert_eq!(outcome.final_state, state, "{}", outcome.case_ref);
        assert!(outcome.report.passed(), "{:#?}", outcome.report.checks);
        assert_eq!(outcome.report.passed_count(), 6);
        assert!(outcome.tamper_detected, "{}", outcome.case_ref);
        assert_eq!(outcome.rogue_rejected_with.as_deref(), rogue);
    }
    assert_eq!(
        outcomes[0].case_ref,
        "urn:coorre:case:SUP-001-20261009T120000Z"
    );
    assert!(log.contains("ROGUE ATTEMPT"));
    assert!(log.contains("environmental license expired; amount exceeds autonomy limit"));

    assert_eq!(
        anchorer.balance_change(&keys.submitter.public_key()),
        250_000_000
    );
    assert_eq!(anchorer.balance_change(&keys.creator), -250_000_000);

    for outcome in &outcomes {
        let bundle = load_bundle(&outcome.bundle_path).unwrap();
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
        let wrong_program = verify_bundle(
            &bundle,
            &files,
            &accounts,
            "9esN1A8K1SASLg17ob81dbSdB4VX8ozc6tBLmJ247Wv",
            MEMORY_NETWORK_ID,
        );
        assert!(!wrong_program.passed());
    }
    let attempt = outcomes[1]
        .bundle_path
        .parent()
        .unwrap()
        .join("attempts/rogue-auto-approved.json");
    let attempt: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(attempt).unwrap()).unwrap();
    assert_eq!(attempt["rejected_with"], "MandateExceeded");
    assert_eq!(attempt["anchored"], false);
}

fn write_key(dir: &Path, role: &str, seed: [u8; 32]) {
    let keypair = Ed25519Keypair::from_seed(&seed);
    let mut bytes = seed.to_vec();
    bytes.extend_from_slice(&keypair.public_key());
    let path = dir.join(format!("{role}.json"));
    std::fs::write(&path, serde_json::to_string(&bytes).unwrap()).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
}

#[test]
fn the_coorre_binary_runs_the_demo_offline() {
    let root = scratch("binary-offline");
    let keys = root.join("keys");
    std::fs::create_dir_all(&keys).unwrap();
    for (role, seed) in ["creator", "submitter", "agent", "rule_engine", "approver"]
        .iter()
        .zip(SEEDS)
    {
        write_key(&keys, role, seed);
    }
    let output = Command::new(env!("CARGO_BIN_EXE_coorre"))
        .args(["demo", "run", "--offline"])
        .arg("--fixtures")
        .arg(fixtures())
        .arg("--out")
        .arg(root.join("out"))
        .arg("--keys")
        .arg(&keys)
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "{stdout}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(stdout.matches("6/6 checks passed").count(), 2, "{stdout}");
    assert!(stdout.contains("rejected on-chain: MandateExceeded"));
    assert!(stdout.contains("Offline mode"));
    assert!(
        !stdout.contains("SUP-003"),
        "SUP-003 is not part of the demo run"
    );
}

#[test]
fn the_binary_refuses_key_files_readable_by_others() {
    let root = scratch("binary-insecure-keys");
    let keys = root.join("keys");
    std::fs::create_dir_all(&keys).unwrap();
    for (role, seed) in ["creator", "submitter", "agent", "rule_engine", "approver"]
        .iter()
        .zip(SEEDS)
    {
        write_key(&keys, role, seed);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            keys.join("agent.json"),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_coorre"))
            .args(["demo", "run", "--offline", "--keys"])
            .arg(&keys)
            .arg("--fixtures")
            .arg(fixtures())
            .arg("--out")
            .arg(root.join("out"))
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(String::from_utf8_lossy(&output.stderr).contains("chmod 600"));
    }
}
