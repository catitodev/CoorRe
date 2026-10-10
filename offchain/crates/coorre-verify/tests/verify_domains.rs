#![allow(
    clippy::unwrap_used,
    reason = "test-only crate; fixtures are built in place"
)]

use std::collections::BTreeMap;
use std::path::Path;

use coorre_engine::{Decision, RuleId};
use coorre_model::accounts::{CaseRecordAccount, EvidenceAnchorAccount, pubkey_to_base58};
use coorre_model::eddsa_jcs_2022::{ProofOptions, evidence_hash, sign_document};
use coorre_model::evidence::{
    COORRE_CONTEXT, TRANSITION_TYPE, VC_CONTEXT_V2, VC_TYPE, case_id, genesis_previous_evidence,
};
use coorre_model::hash::{from_prefixed, sha256, to_hex, to_prefixed};
use coorre_model::{
    Actor, ActorKind, ArtifactRef, Autonomy, CaseState, Ed25519Keypair, EvidenceDocument, Mandate,
    RuleRef, TransitionSubject, jcs,
};
use coorre_verify::{
    AccountSnapshot, AuditBundle, BUNDLE_FORMAT, BundleEvidence, Inputs, Report, Status, verify,
};
use serde_json::{Value, json};

const PROGRAM: &str = "9esN1A8K1SASLg17ob81dbSdB4VX8ozc6tBLmJ247Wv";
const CASE_REF: &str = "urn:coorre:case:DOMAIN-TEST";
const AMOUNT: u64 = 20_000_000;
const LIMIT: u64 = 30_000_000;
const EVALUATION_DATE: &str = "2026-10-09";

const DOMAIN_CASES: [(RuleId, &str); 1] = [(RuleId::AgentPurchase, "AGT-002")];

fn key(seed: u8) -> Ed25519Keypair {
    Ed25519Keypair::from_seed(&[seed; 32])
}

fn address(seed: u8) -> String {
    pubkey_to_base58(&key(seed).public_key())
}

struct Recorded {
    rule_document: Value,
    rule_id: String,
    rule_version: String,
    final_state: CaseState,
    reasons: Vec<String>,
}

impl Recorded {
    fn faithful(rule: RuleId, decision: &Decision) -> Self {
        Self {
            rule_document: rule.document().unwrap(),
            rule_id: rule.id().to_owned(),
            rule_version: rule.version().to_owned(),
            final_state: decision.to_state(),
            reasons: decision.reasons().to_vec(),
        }
    }
}

struct Fixture {
    bundle: AuditBundle,
    artifacts: BTreeMap<String, Vec<u8>>,
    accounts: BTreeMap<String, AccountSnapshot>,
}

fn case_files(case: &str) -> BTreeMap<String, Vec<u8>> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../demo/fixtures")
        .join(case);
    std::fs::read_dir(&dir)
        .unwrap()
        .map(|entry| {
            let path = entry.unwrap().path();
            (
                path.file_name().unwrap().to_str().unwrap().to_owned(),
                std::fs::read(&path).unwrap(),
            )
        })
        .collect()
}

fn decision_of(rule: RuleId, files: &BTreeMap<String, Vec<u8>>) -> Decision {
    let refs: Vec<&[u8]> = files.values().map(Vec::as_slice).collect();
    rule.evaluate(EVALUATION_DATE, AMOUNT, LIMIT, &refs)
        .unwrap()
}

fn build(files: BTreeMap<String, Vec<u8>>, recorded: &Recorded, agent: &Decision) -> Fixture {
    let (creator, submitter, agent_key, rule_engine, approver) =
        (key(1), key(2), key(3), key(4), key(5));
    let rule_hash = jcs::hash(&recorded.rule_document).unwrap();
    let refs: Vec<ArtifactRef> = files
        .iter()
        .map(|(name, bytes)| ArtifactRef {
            name: name.clone(),
            media_type: "application/json".to_owned(),
            digest_sha256: to_hex(&sha256(bytes)),
        })
        .collect();
    let recommendation = match agent {
        Decision::AutoApproved => "auto_approve",
        Decision::Escalated { .. } => "escalate",
    };
    let steps = [
        (
            &submitter,
            CaseState::Open,
            CaseState::Submitted,
            ActorKind::Human,
            Autonomy::ExecuteWithApproval,
            refs.clone(),
            json!({}),
        ),
        (
            &agent_key,
            CaseState::Submitted,
            CaseState::AgentReviewed,
            ActorKind::Agent,
            Autonomy::Recommend,
            vec![],
            json!({
                "recommendation": recommendation,
                "findings": agent.reasons(),
                "evaluation_date": EVALUATION_DATE,
            }),
        ),
        (
            &rule_engine,
            CaseState::AgentReviewed,
            recorded.final_state,
            ActorKind::System,
            Autonomy::Autonomous,
            vec![],
            json!({
                "decision": recorded.final_state.name(),
                "reasons": recorded.reasons,
                "evaluation_date": EVALUATION_DATE,
            }),
        ),
    ];
    let mut previous = genesis_previous_evidence(CASE_REF);
    let mut evidence = Vec::new();
    let mut accounts = BTreeMap::new();
    let mut last_hash = [0u8; 32];
    for (i, (signer, from, to, kind, autonomy, artifacts, payload)) in steps.into_iter().enumerate()
    {
        let doc = EvidenceDocument {
            context: vec![VC_CONTEXT_V2.to_owned(), COORRE_CONTEXT.to_owned()],
            id: format!("urn:uuid:00000000-0000-4000-8000-00000000010{i}"),
            types: vec![VC_TYPE.to_owned(), TRANSITION_TYPE.to_owned()],
            issuer: signer.did(),
            valid_from: format!("{EVALUATION_DATE}T12:0{i}:00Z"),
            credential_subject: TransitionSubject {
                case: CASE_REF.to_owned(),
                from_state: from,
                to_state: to,
                actor: Actor {
                    id: signer.did(),
                    kind,
                    autonomy,
                },
                mandate: Mandate {
                    amount_lamports: AMOUNT.to_string(),
                    autonomy_limit_lamports: LIMIT.to_string(),
                },
                rule: RuleRef {
                    id: recorded.rule_id.clone(),
                    version: recorded.rule_version.clone(),
                    hash: to_prefixed(&rule_hash),
                },
                artifacts,
                payload: payload.as_object().unwrap().clone(),
                previous_evidence: previous.clone(),
            },
        };
        let options = ProofOptions::assertion(doc.valid_from.clone(), signer.verification_method());
        let secured = sign_document(&doc.to_value().unwrap(), &options, signer).unwrap();
        let hash = evidence_hash(&secured).unwrap();
        let anchor_account = address(70 + i as u8);
        let anchor = EvidenceAnchorAccount {
            evidence_hash: hash,
            case_record: key(51).public_key(),
            prev_hash: from_prefixed(&previous).unwrap(),
            from_state: from.code(),
            to_state: to.code(),
            actor: signer.public_key(),
            actor_kind: kind.code(),
            rule_hash,
            slot: 2000 + i as u64,
            unix_ts: 1_791_500_000 + i as i64,
            bump: 255,
        };
        accounts.insert(
            anchor_account.clone(),
            AccountSnapshot {
                owner: PROGRAM.to_owned(),
                data: anchor.encode(),
            },
        );
        evidence.push(BundleEvidence {
            anchor_account,
            document: secured,
            receipt: None,
        });
        previous = to_prefixed(&hash);
        last_hash = hash;
    }
    let case_record = address(51);
    let record = CaseRecordAccount {
        case_id: case_id(CASE_REF),
        creator: creator.public_key(),
        submitter: submitter.public_key(),
        agent: agent_key.public_key(),
        rule_engine: rule_engine.public_key(),
        approver: approver.public_key(),
        amount: AMOUNT,
        autonomy_limit: LIMIT,
        state: recorded.final_state.code(),
        last_evidence_hash: last_hash,
        transition_count: 3,
        bump: 254,
    };
    accounts.insert(
        case_record.clone(),
        AccountSnapshot {
            owner: PROGRAM.to_owned(),
            data: record.encode(),
        },
    );
    Fixture {
        bundle: AuditBundle {
            format: BUNDLE_FORMAT.to_owned(),
            case_ref: CASE_REF.to_owned(),
            network_id: "solana:devnet".to_owned(),
            program_id: PROGRAM.to_owned(),
            case_record,
            open_receipt: None,
            evidence,
            rules: vec![recorded.rule_document.clone()],
            artifacts: refs,
        },
        artifacts: files,
        accounts,
    }
}

fn run(f: &Fixture) -> Report {
    verify(&Inputs {
        bundle: &f.bundle,
        artifacts: &f.artifacts,
        accounts: &f.accounts,
        expected_program_id: PROGRAM,
        expected_network_id: "solana:devnet",
    })
}

fn failing(report: &Report) -> Vec<u8> {
    report
        .checks
        .iter()
        .filter(|c| c.status == Status::Fail)
        .map(|c| c.id)
        .collect()
}

fn detail(report: &Report, id: u8) -> String {
    report
        .checks
        .iter()
        .find(|c| c.id == id)
        .unwrap()
        .details
        .join(" | ")
}

#[test]
fn every_rule_in_the_registry_has_a_verifier_case() {
    let covered: Vec<RuleId> = DOMAIN_CASES.iter().map(|(rule, _)| *rule).collect();
    for rule in RuleId::ALL {
        assert!(
            rule == RuleId::SupplierDocs || covered.contains(&rule),
            "{rule:?} has no verifier case"
        );
    }
}

#[test]
fn a_faithful_decision_under_each_new_rule_passes_all_seven_checks() {
    for (rule, case) in DOMAIN_CASES {
        let files = case_files(case);
        let decision = decision_of(rule, &files);
        let report = run(&build(
            files,
            &Recorded::faithful(rule, &decision),
            &decision,
        ));
        assert!(report.passed(), "{case}: {:#?}", report.checks);
        assert!(
            detail(&report, 7).contains(&format!("{} reproduced", decision.to_state().name())),
            "{case}"
        );
    }
}

#[test]
fn a_decision_that_contradicts_each_new_rule_passes_checks_1_to_6_and_fails_7() {
    for (rule, case) in DOMAIN_CASES {
        let files = case_files(case);
        let decision = decision_of(rule, &files);
        assert!(
            matches!(decision, Decision::Escalated { .. }),
            "{case} must escalate under {rule:?} within the limit"
        );
        let mut forged = Recorded::faithful(rule, &decision);
        forged.final_state = CaseState::AutoApproved;
        forged.reasons = vec![];
        let report = run(&build(files, &forged, &Decision::AutoApproved));
        assert_eq!(failing(&report), [7], "{case}: {:#?}", report.checks);
        let text = detail(&report, 7);
        assert!(
            text.contains("the rule gives ESCALATED but AUTO_APPROVED was recorded"),
            "{text}"
        );
        assert!(text.contains(&decision.reasons()[0]), "{text}");
    }
}

#[test]
fn a_known_rule_with_a_different_hash_fails_only_check_7() {
    for (rule, case) in DOMAIN_CASES {
        let files = case_files(case);
        let decision = decision_of(rule, &files);
        let mut altered = Recorded::faithful(rule, &decision);
        altered.rule_document["description"] = json!("a rule document written by the auditee");
        let report = run(&build(files, &altered, &decision));
        assert_eq!(failing(&report), [7], "{case}: {:#?}", report.checks);
        assert!(
            detail(&report, 7).contains(&format!(
                "the rule hash differs from the {} v{} this verifier runs",
                rule.id(),
                rule.version()
            )),
            "{}",
            detail(&report, 7)
        );
    }
}

#[test]
fn an_unknown_rule_id_or_version_fails_only_check_7() {
    let (rule, case) = DOMAIN_CASES[0];
    for (id, version) in [("unknown-rule", "1"), (rule.id(), "2")] {
        let files = case_files(case);
        let decision = decision_of(rule, &files);
        let mut unknown = Recorded::faithful(rule, &decision);
        unknown.rule_id = id.to_owned();
        unknown.rule_version = version.to_owned();
        unknown.rule_document["id"] = json!(id);
        unknown.rule_document["version"] = json!(version);
        let report = run(&build(files, &unknown, &decision));
        assert_eq!(
            failing(&report),
            [7],
            "{id} v{version}: {:#?}",
            report.checks
        );
        assert!(
            detail(&report, 7).contains(&format!(
                "rule {id} v{version} is not one this verifier can run"
            )),
            "{}",
            detail(&report, 7)
        );
    }
}

#[test]
fn documents_of_one_domain_cannot_be_judged_under_another_rule() {
    let (rule, case) = DOMAIN_CASES[0];
    let files = case_files(case);
    let decision = decision_of(rule, &files);
    let mut swapped = Recorded::faithful(RuleId::SupplierDocs, &decision);
    swapped.final_state = decision.to_state();
    swapped.reasons = decision.reasons().to_vec();
    let report = run(&build(files, &swapped, &decision));
    assert_eq!(failing(&report), [7], "{:#?}", report.checks);
}
