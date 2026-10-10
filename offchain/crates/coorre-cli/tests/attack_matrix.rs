#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test-only crate")]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use coorre_cli::files::{load_bundle, read_artifacts, verify_bundle};
use coorre_cli::snapshot::load_recorded_accounts;
use coorre_engine::{CaseTracker, EngineError, RoleKeys};
use coorre_model::accounts::CaseRecordAccount;
use coorre_model::eddsa_jcs_2022::{ProofOptions, evidence_hash, sign_document};
use coorre_model::{CaseState, Ed25519Keypair};
use coorre_verify::{
    AccountSnapshot, AuditBundle, COORRE_DEVNET_PROGRAM_ID, Report, SOLANA_DEVNET_NETWORK_ID,
    Status,
};
use serde_json::{Value, json};

struct Case {
    bundle: AuditBundle,
    files: BTreeMap<String, Vec<u8>>,
}

fn repository() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn accounts() -> BTreeMap<String, AccountSnapshot> {
    load_recorded_accounts(&repository().join("docs/evidence/devnet-snapshot/accounts.json"))
        .unwrap()
        .accounts
}

fn case(relative: &str) -> Case {
    let dir = repository().join(relative);
    let bundle = load_bundle(&dir.join("bundle.json")).unwrap();
    let files = read_artifacts(&dir.join("artifacts"), &bundle).unwrap();
    Case { bundle, files }
}

fn sup_001() -> Case {
    case("web/verifier/samples/SUP-001")
}

fn sup_002() -> Case {
    case("web/verifier/samples/SUP-002")
}

fn mil_002() -> Case {
    case("onchain/devnet-bundles/2026-10-10/MIL-002")
}

fn run(case: &Case, accounts: &BTreeMap<String, AccountSnapshot>) -> Report {
    verify_bundle(
        &case.bundle,
        &case.files,
        accounts,
        COORRE_DEVNET_PROGRAM_ID,
        SOLANA_DEVNET_NETWORK_ID,
    )
}

fn failing(report: &Report) -> Vec<u8> {
    report
        .checks
        .iter()
        .filter(|c| c.status == Status::Fail)
        .map(|c| c.id)
        .collect()
}

fn record(attack: &str, report: &Report) -> Vec<u8> {
    let failed = failing(report);
    println!("ATTACK {attack}");
    println!(
        "  result: {}/7 checks passed, failing {:?}",
        report.passed_count(),
        failed
    );
    for check in report.checks.iter().filter(|c| c.status == Status::Fail) {
        println!(
            "  [FAIL] {} {}: {}",
            check.id,
            check.name,
            check.details.first().map(String::as_str).unwrap_or("")
        );
    }
    failed
}

fn outside_key() -> Ed25519Keypair {
    Ed25519Keypair::from_seed(&[0x5a; 32])
}

fn resign(document: &Value, signer: &Ed25519Keypair, edit: impl FnOnce(&mut Value)) -> Value {
    let mut unsecured = document.clone();
    unsecured.as_object_mut().unwrap().remove("proof");
    unsecured["issuer"] = json!(signer.did());
    unsecured["credentialSubject"]["actor"]["id"] = json!(signer.did());
    edit(&mut unsecured);
    let created = unsecured["validFrom"].as_str().unwrap().to_owned();
    sign_document(
        &unsecured,
        &ProofOptions::assertion(created, signer.verification_method()),
        signer,
    )
    .unwrap()
}

#[test]
fn baseline_the_untouched_cases_pass_all_seven_checks() {
    let accounts = accounts();
    for c in [sup_001(), sup_002(), mil_002()] {
        assert_eq!(failing(&run(&c, &accounts)), Vec::<u8>::new());
    }
}

#[test]
fn a01_one_changed_byte_in_a_submitted_document() {
    let mut c = sup_001();
    let name = c.files.keys().next().unwrap().clone();
    c.files.get_mut(&name).unwrap()[10] ^= 0x01;
    let report = run(&c, &accounts());
    assert_eq!(
        record("A01 one byte of a SUP-001 document flipped", &report),
        [1, 7]
    );
}

#[test]
fn a02_a_credential_moved_from_another_case() {
    let other = sup_002();
    let mut c = sup_001();
    c.bundle.evidence[0].document = other.bundle.evidence[0].document.clone();
    let report = run(&c, &accounts());
    assert_eq!(
        record(
            "A02 SUP-002's SUBMITTED credential placed in SUP-001 (anchor address kept)",
            &report
        ),
        [1, 2, 5, 6]
    );
}

#[test]
fn a03_a_credential_moved_with_its_own_anchor_from_another_case() {
    let other = sup_002();
    let mut c = sup_001();
    c.bundle.evidence[0] = other.bundle.evidence[0].clone();
    let report = run(&c, &accounts());
    assert_eq!(
        record(
            "A03 SUP-002's SUBMITTED credential and its anchor placed in SUP-001",
            &report
        ),
        [1, 2, 5, 6]
    );
}

#[test]
fn a04_an_anchor_of_another_case() {
    let other = sup_002();
    let mut c = sup_001();
    c.bundle.evidence[2].anchor_account = other.bundle.evidence[2].anchor_account.clone();
    let report = run(&c, &accounts());
    assert_eq!(
        record(
            "A04 SUP-001 evidence 3 pointed at SUP-002's evidence 3 anchor",
            &report
        ),
        [6]
    );
}

#[test]
fn a05_a_link_removed_from_the_hash_chain() {
    let mut c = mil_002();
    c.bundle.evidence.remove(1);
    let report = run(&c, &accounts());
    assert_eq!(
        record(
            "A05 MIL-002 agent review removed (4 links become 3)",
            &report
        ),
        [5, 6]
    );
}

#[test]
fn a06_the_rule_document_changed() {
    let mut c = sup_001();
    c.bundle.rules[0]["validity"] = json!("any date");
    let report = run(&c, &accounts());
    assert_eq!(
        record(
            "A06 supplier-docs v1 rule in the SUP-001 bundle edited",
            &report
        ),
        [2]
    );
}

#[test]
fn a07_a_step_signed_by_a_key_that_does_not_hold_the_role() {
    let mut c = sup_002();
    let forged = resign(&c.bundle.evidence[3].document, &outside_key(), |_| {});
    c.bundle.evidence[3].document = forged;
    let report = run(&c, &accounts());
    assert_eq!(
        record(
            "A07 SUP-002 approver step re-signed by a key that is not the approver",
            &report
        ),
        [4, 5, 6]
    );
}

#[test]
fn a08_an_invalid_signature() {
    let mut c = sup_001();
    let proof = c.bundle.evidence[0].document["proof"]["proofValue"]
        .as_str()
        .unwrap()
        .to_owned();
    let last = if proof.ends_with('2') { "3" } else { "2" };
    let tampered = format!("{}{last}", &proof[..proof.len() - 1]);
    c.bundle.evidence[0].document["proof"]["proofValue"] = json!(tampered);
    let report = run(&c, &accounts());
    assert_eq!(
        record(
            "A08 last character of SUP-001 evidence 1 proofValue changed",
            &report
        ),
        [3, 4]
    );
}

#[test]
fn a09_a_credential_without_an_anchor() {
    let c = sup_001();
    let mut accounts = accounts();
    accounts.remove(&c.bundle.evidence[1].anchor_account);
    let report = run(&c, &accounts);
    assert_eq!(
        record(
            "A09 SUP-001 evidence 2 presented without its anchor account",
            &report
        ),
        [4, 6]
    );
}

#[test]
fn a10_an_auto_approval_above_the_mandate_presented_without_the_approver() {
    let mut c = sup_002();
    let forged = resign(&c.bundle.evidence[2].document, &outside_key(), |d| {
        let subject = &mut d["credentialSubject"];
        subject["toState"] = json!("AUTO_APPROVED");
        subject["payload"]["decision"] = json!("AUTO_APPROVED");
        subject["payload"]["reasons"] = json!([]);
    });
    c.bundle.evidence[2].document = forged;
    c.bundle.evidence.truncate(3);
    let report = run(&c, &accounts());
    assert_eq!(
        record(
            "A10 SUP-002 (0.2 SOL, limit 0.1 SOL) rewritten to AUTO_APPROVED, approver step dropped",
            &report
        ),
        [4, 5, 6, 7]
    );
}

fn replay_until_agent_review(c: &Case) -> (CaseTracker, RoleKeys) {
    let accounts = accounts();
    let r = CaseRecordAccount::decode(&accounts[&c.bundle.case_record].data).unwrap();
    let roles = RoleKeys {
        submitter: r.submitter,
        agent: r.agent,
        rule_engine: r.rule_engine,
        approver: r.approver,
    };
    let mut tracker = CaseTracker::open(r.case_id, roles, r.amount, r.autonomy_limit, 0).unwrap();
    let mut prev = r.case_id;
    for (e, actor) in c.bundle.evidence[..2].iter().zip([r.submitter, r.agent]) {
        let hash = evidence_hash(&e.document).unwrap();
        let to = e.document["credentialSubject"]["toState"].as_str().unwrap();
        let to = CaseState::ALL.into_iter().find(|s| s.name() == to).unwrap();
        tracker.apply(to.code(), actor, prev, hash).unwrap();
        prev = hash;
    }
    (tracker, roles)
}

#[test]
fn a11_the_real_rule_engine_key_cannot_auto_approve_above_the_mandate() {
    let c = sup_002();
    let (mut tracker, roles) = replay_until_agent_review(&c);
    let prev = evidence_hash(&c.bundle.evidence[1].document).unwrap();
    let result = tracker.apply(
        CaseState::AutoApproved.code(),
        roles.rule_engine,
        prev,
        [7; 32],
    );
    println!(
        "ATTACK A11 SUP-002 replayed with its on-chain role keys; rule_engine key takes AGENT_REVIEWED -> AUTO_APPROVED"
    );
    println!("  result: {result:?}");
    assert_eq!(result.unwrap_err(), EngineError::MandateExceeded);
}

#[test]
fn a12_only_the_approver_key_can_release_an_escalated_case() {
    let c = sup_002();
    let (mut tracker, roles) = replay_until_agent_review(&c);
    let prev = evidence_hash(&c.bundle.evidence[1].document).unwrap();
    let escalated = evidence_hash(&c.bundle.evidence[2].document).unwrap();
    tracker
        .apply(
            CaseState::Escalated.code(),
            roles.rule_engine,
            prev,
            escalated,
        )
        .unwrap();
    println!("ATTACK A12 SUP-002 ESCALATED -> APPROVED attempted by each non-approver role key");
    for (name, key) in [
        ("submitter", roles.submitter),
        ("agent", roles.agent),
        ("rule_engine", roles.rule_engine),
    ] {
        let result = tracker.apply(CaseState::Approved.code(), key, escalated, [8; 32]);
        println!("  {name}: {result:?}");
        assert_eq!(result.unwrap_err(), EngineError::UnauthorizedActor);
    }
}
