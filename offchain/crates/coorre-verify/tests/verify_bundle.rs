#![allow(
    clippy::unwrap_used,
    reason = "test-only crate; fixtures are built in place"
)]

use std::collections::BTreeMap;

use coorre_engine::rule::{rule_document, rule_hash};
use coorre_model::accounts::{CaseRecordAccount, EvidenceAnchorAccount, pubkey_to_base58};
use coorre_model::eddsa_jcs_2022::{ProofOptions, evidence_hash, sign_document};
use coorre_model::evidence::{
    COORRE_CONTEXT, TRANSITION_TYPE, VC_CONTEXT_V2, VC_TYPE, case_id, genesis_previous_evidence,
};
use coorre_model::hash::{sha256, to_hex, to_prefixed};
use coorre_model::{
    Actor, ActorKind, ArtifactRef, Autonomy, CaseState, Ed25519Keypair, EvidenceDocument, Mandate,
    RuleRef, TransitionSubject,
};
use coorre_verify::{
    AccountSnapshot, AuditBundle, BUNDLE_FORMAT, BundleEvidence, Inputs, Report, Status, verify,
};
use serde_json::{Value, json};

const PROGRAM: &str = "9esN1A8K1SASLg17ob81dbSdB4VX8ozc6tBLmJ247Wv";
const OTHER_PROGRAM: &str = "11111111111111111111111111111111";
const CASE_REF: &str = "urn:coorre:case:TEST-001";
const AMOUNT: u64 = 50_000_000;
const LIMIT: u64 = 100_000_000;
const ANCHOR_DAY_NOON: i64 = 1_791_547_200;

type Hook<'a> = &'a dyn Fn(usize, &mut EvidenceDocument, &mut ProofOptions);

fn no_hook(_: usize, _: &mut EvidenceDocument, _: &mut ProofOptions) {}

struct Fixture {
    bundle: AuditBundle,
    artifacts: BTreeMap<String, Vec<u8>>,
    accounts: BTreeMap<String, AccountSnapshot>,
}

fn key(seed: u8) -> Ed25519Keypair {
    Ed25519Keypair::from_seed(&[seed; 32])
}

fn address(seed: u8) -> String {
    pubkey_to_base58(&key(seed).public_key())
}

struct Step<'a> {
    signer: &'a Ed25519Keypair,
    n: u8,
    from: CaseState,
    to: CaseState,
    kind: ActorKind,
    autonomy: Autonomy,
    artifacts: Vec<ArtifactRef>,
    payload: Value,
}

fn document(step: &Step, previous: String, signed_on: &str, hook: Hook) -> Value {
    let Step {
        signer,
        n,
        from,
        to,
        kind,
        autonomy,
        ..
    } = *step;
    let artifacts = step.artifacts.clone();
    let payload = step.payload.as_object().unwrap().clone();
    let doc = EvidenceDocument {
        context: vec![VC_CONTEXT_V2.to_owned(), COORRE_CONTEXT.to_owned()],
        id: format!("urn:uuid:00000000-0000-4000-8000-00000000000{n}"),
        types: vec![VC_TYPE.to_owned(), TRANSITION_TYPE.to_owned()],
        issuer: signer.did(),
        valid_from: format!("{signed_on}T12:0{n}:00Z"),
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
                id: "supplier-docs".to_owned(),
                version: "1".to_owned(),
                hash: to_prefixed(&rule_hash().unwrap()),
            },
            artifacts,
            payload,
            previous_evidence: previous,
        },
    };
    let mut doc = doc;
    let mut options = ProofOptions::assertion(doc.valid_from.clone(), signer.verification_method());
    hook(usize::from(n) - 1, &mut doc, &mut options);
    sign_document(&doc.to_value().unwrap(), &options, signer).unwrap()
}

struct Scenario {
    license_until: &'static str,
    final_state: CaseState,
    evaluation_date: &'static str,
    recommendation: &'static str,
    findings: Vec<&'static str>,
    reasons: Vec<&'static str>,
    signed_on: &'static str,
    anchor_delay_seconds: i64,
    approved: bool,
}

impl Scenario {
    fn valid() -> Self {
        Self {
            license_until: "2027-05-31",
            final_state: CaseState::AutoApproved,
            evaluation_date: "2026-10-09",
            recommendation: "auto_approve",
            findings: vec![],
            reasons: vec![],
            signed_on: "2026-10-09",
            anchor_delay_seconds: 2,
            approved: false,
        }
    }

    fn expired_license_escalated() -> Self {
        Self {
            license_until: "2026-09-30",
            final_state: CaseState::Escalated,
            evaluation_date: "2026-10-09",
            recommendation: "escalate",
            findings: vec!["environmental license expired"],
            reasons: vec!["environmental license expired"],
            signed_on: "2026-10-09",
            anchor_delay_seconds: 2,
            approved: false,
        }
    }
}

fn document_file(kind: &str, until: &str) -> Vec<u8> {
    format!(
        r#"{{"synthetic":true,"kind":"{kind}","supplier":"Demo Supplier","issuer":"Demo Registry","number":"N-1","valid_from":"2025-01-01","valid_until":"{until}"}}"#
    )
    .into_bytes()
}

fn fixture() -> Fixture {
    fixture_with(&Scenario::valid())
}

fn fixture_with(scenario: &Scenario) -> Fixture {
    fixture_hooked(scenario, &no_hook)
}

fn fixture_hooked(scenario: &Scenario, hook: Hook) -> Fixture {
    let (creator, submitter, agent, rule_engine, approver) =
        (key(1), key(2), key(3), key(4), key(5));
    let case_record = address(50);
    let files = [
        (
            "tax-certificate.json",
            document_file("tax_certificate", "2027-12-31"),
        ),
        (
            "environmental-license.json",
            document_file("environmental_license", scenario.license_until),
        ),
    ];
    let refs: Vec<ArtifactRef> = files
        .iter()
        .map(|(name, bytes)| ArtifactRef {
            name: (*name).to_owned(),
            media_type: "application/json".to_owned(),
            digest_sha256: to_hex(&sha256(bytes)),
        })
        .collect();

    let mut steps = vec![
        Step {
            signer: &submitter,
            n: 1,
            from: CaseState::Open,
            to: CaseState::Submitted,
            kind: ActorKind::Human,
            autonomy: Autonomy::Escalate,
            artifacts: refs.clone(),
            payload: json!({}),
        },
        Step {
            signer: &agent,
            n: 2,
            from: CaseState::Submitted,
            to: CaseState::AgentReviewed,
            kind: ActorKind::Agent,
            autonomy: Autonomy::Recommend,
            artifacts: vec![],
            payload: json!({
                "recommendation": scenario.recommendation,
                "findings": scenario.findings,
                "evaluation_date": scenario.evaluation_date,
            }),
        },
        Step {
            signer: &rule_engine,
            n: 3,
            from: CaseState::AgentReviewed,
            to: scenario.final_state,
            kind: ActorKind::System,
            autonomy: Autonomy::Autonomous,
            artifacts: vec![],
            payload: json!({
                "decision": scenario.final_state.name(),
                "reasons": scenario.reasons,
                "evaluation_date": scenario.evaluation_date,
            }),
        },
    ];
    if scenario.approved {
        steps.push(Step {
            signer: &approver,
            n: 4,
            from: CaseState::Escalated,
            to: CaseState::Approved,
            kind: ActorKind::Human,
            autonomy: Autonomy::Autonomous,
            artifacts: vec![],
            payload: json!({ "decision": "APPROVED", "justification": "checked by hand" }),
        });
    }
    let final_state = steps.last().unwrap().to;
    let mut previous = genesis_previous_evidence(CASE_REF);
    let mut evidence = Vec::new();
    let mut accounts = BTreeMap::new();
    let mut last_hash = [0u8; 32];
    for (i, step) in steps.iter().enumerate() {
        let doc = document(step, previous.clone(), scenario.signed_on, hook);
        let hash = evidence_hash(&doc).unwrap();
        let cited_rule = EvidenceDocument::from_secured(&doc)
            .unwrap()
            .rule_hash()
            .unwrap();
        let anchor_account = address(60 + i as u8);
        let anchor = EvidenceAnchorAccount {
            evidence_hash: hash,
            case_record: key(50).public_key(),
            prev_hash: coorre_model::hash::from_prefixed(&previous).unwrap(),
            from_state: step.from.code(),
            to_state: step.to.code(),
            actor: step.signer.public_key(),
            actor_kind: step.kind.code(),
            rule_hash: cited_rule,
            slot: 1000 + i as u64,
            unix_ts: ANCHOR_DAY_NOON + 60 * (i as i64 + 1) + scenario.anchor_delay_seconds,
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
            document: doc,
            receipt: None,
        });
        previous = to_prefixed(&hash);
        last_hash = hash;
    }
    let record = CaseRecordAccount {
        case_id: case_id(CASE_REF),
        creator: creator.public_key(),
        submitter: submitter.public_key(),
        agent: agent.public_key(),
        rule_engine: rule_engine.public_key(),
        approver: approver.public_key(),
        amount: AMOUNT,
        autonomy_limit: LIMIT,
        state: final_state.code(),
        last_evidence_hash: last_hash,
        transition_count: u32::try_from(steps.len()).unwrap(),
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
            rules: vec![rule_document().unwrap()],
            artifacts: refs,
        },
        artifacts: files.into_iter().map(|(n, b)| (n.to_owned(), b)).collect(),
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

#[test]
fn a_valid_bundle_passes_all_seven_checks() {
    let report = run(&fixture());
    assert!(report.passed(), "{:#?}", report.checks);
    assert_eq!(
        report.checks.iter().map(|c| c.id).collect::<Vec<_>>(),
        [1, 2, 3, 4, 5, 6, 7]
    );
    assert_eq!(report.passed_count(), 7);
    assert_eq!(report.timeline.len(), 3);
    assert_eq!(report.summary.final_state.as_deref(), Some("AUTO_APPROVED"));
    assert_eq!(report.summary.submitter, Some(address(2)));
}

#[test]
fn one_changed_byte_in_an_artifact_fails_check_1_and_the_decision_is_no_longer_reproducible() {
    let mut f = fixture();
    f.artifacts.get_mut("environmental-license.json").unwrap()[0] ^= 0x01;
    assert_eq!(failing(&run(&f)), [1, 7]);
}

#[test]
fn a_missing_artifact_fails_check_1_and_check_7() {
    let mut f = fixture();
    f.artifacts.remove("tax-certificate.json");
    assert_eq!(failing(&run(&f)), [1, 7]);
}

#[test]
fn a_valid_signature_from_a_non_role_key_fails_check_4() {
    let mut f = fixture();
    let outsider = key(99);
    let original: EvidenceDocument =
        EvidenceDocument::from_secured(&f.bundle.evidence[1].document).unwrap();
    let mut forged = original.clone();
    forged.issuer = outsider.did();
    forged.credential_subject.actor.id = outsider.did();
    let options =
        ProofOptions::assertion(forged.valid_from.clone(), outsider.verification_method());
    f.bundle.evidence[1].document =
        sign_document(&forged.to_value().unwrap(), &options, &outsider).unwrap();
    let report = run(&f);
    assert!(failing(&report).contains(&4), "{:#?}", report.checks);
    assert_eq!(
        report.checks[2].status,
        Status::Pass,
        "the forged proof itself is valid"
    );
}

#[test]
fn an_account_with_the_wrong_owner_fails_check_6() {
    let mut f = fixture();
    let anchor = f.bundle.evidence[0].anchor_account.clone();
    f.accounts.get_mut(&anchor).unwrap().owner = OTHER_PROGRAM.to_owned();
    let report = run(&f);
    assert!(failing(&report).contains(&6), "{:#?}", report.checks);
}

#[test]
fn a_bundle_naming_another_program_fails_check_6() {
    let mut f = fixture();
    f.bundle.program_id = OTHER_PROGRAM.to_owned();
    for snapshot in f.accounts.values_mut() {
        snapshot.owner = OTHER_PROGRAM.to_owned();
    }
    let report = verify(&Inputs {
        bundle: &f.bundle,
        artifacts: &f.artifacts,
        accounts: &f.accounts,
        expected_program_id: PROGRAM,
        expected_network_id: "solana:devnet",
    });
    assert!(failing(&report).contains(&6));
    assert!(!report.passed());
}

#[test]
fn editing_a_signed_document_fails_proof_and_on_chain_checks() {
    let mut f = fixture();
    f.bundle.evidence[0].document["credentialSubject"]["payload"] = json!({"note": "edited"});
    let report = run(&f);
    let failed = failing(&report);
    assert!(failed.contains(&3) && failed.contains(&6), "{failed:?}");
}

#[test]
fn reordered_evidence_fails_the_hash_chain() {
    let mut f = fixture();
    f.bundle.evidence.swap(0, 1);
    assert!(failing(&run(&f)).contains(&5));
}

#[test]
fn a_missing_rule_document_fails_check_2() {
    let mut f = fixture();
    f.bundle.rules.clear();
    assert_eq!(failing(&run(&f)), [2]);
}

#[test]
fn an_unsafe_artifact_name_in_the_bundle_fails_check_1() {
    let mut f = fixture();
    f.bundle.artifacts[0].name = "../../.local/keys/creator.json".to_owned();
    assert!(failing(&run(&f)).contains(&1));
}

#[test]
fn a_missing_on_chain_account_fails_checks_4_and_6() {
    let mut f = fixture();
    let anchor = f.bundle.evidence[2].anchor_account.clone();
    f.accounts.remove(&anchor);
    let failed = failing(&run(&f));
    assert!(failed.contains(&4) && failed.contains(&6), "{failed:?}");
}

#[test]
fn bundle_json_round_trip_and_strict_parsing() {
    let f = fixture();
    let text = f.bundle.to_json_pretty().unwrap();
    assert_eq!(AuditBundle::from_json(&text).unwrap(), f.bundle);
    assert!(AuditBundle::from_json(&text.replacen("coorre-audit-bundle/1", "other/9", 1)).is_err());
    let mut value: Value = serde_json::from_str(&text).unwrap();
    value["unexpected"] = json!(true);
    assert!(AuditBundle::from_json(&value.to_string()).is_err());
}

fn first_detail(report: &Report, id: u8) -> String {
    report
        .checks
        .iter()
        .find(|c| c.id == id)
        .unwrap()
        .details
        .join(" | ")
}

#[test]
fn an_escalation_with_the_right_reasons_passes_check_7() {
    let f = fixture_with(&Scenario::expired_license_escalated());
    let report = run(&f);
    assert!(report.passed(), "{:#?}", report.checks);
    assert!(first_detail(&report, 7).contains("ESCALATED reproduced"));
}

#[test]
fn a_compromised_rule_engine_approving_an_expired_license_passes_1_to_6_and_fails_7() {
    let mut scenario = Scenario::expired_license_escalated();
    scenario.final_state = CaseState::AutoApproved;
    scenario.recommendation = "auto_approve";
    scenario.findings = vec![];
    scenario.reasons = vec![];
    let report = run(&fixture_with(&scenario));
    assert_eq!(failing(&report), [7], "{:#?}", report.checks);
    let detail = first_detail(&report, 7);
    assert!(
        detail.contains("the rule gives ESCALATED but AUTO_APPROVED was recorded"),
        "{detail}"
    );
    assert!(detail.contains("environmental license expired"), "{detail}");
}

#[test]
fn wrong_reasons_fail_check_7() {
    let mut scenario = Scenario::expired_license_escalated();
    scenario.reasons = vec!["amount exceeds autonomy limit"];
    let report = run(&fixture_with(&scenario));
    assert_eq!(failing(&report), [7], "{:#?}", report.checks);
}

#[test]
fn a_backdated_evaluation_date_fails_check_7() {
    let mut scenario = Scenario::valid();
    scenario.license_until = "2026-09-30";
    scenario.evaluation_date = "2026-09-01";
    let report = run(&fixture_with(&scenario));
    assert_eq!(failing(&report), [7], "{:#?}", report.checks);
    assert!(first_detail(&report, 7).contains("is not the signing day"));
}

#[test]
fn a_rule_engine_decision_without_an_evaluation_date_fails_only_check_7() {
    let f = fixture_hooked(&Scenario::valid(), &|i, doc, _| {
        if i == 2 {
            doc.credential_subject.payload.remove("evaluation_date");
        }
    });
    let report = run(&f);
    assert_eq!(failing(&report), [7], "{:#?}", report.checks);
    assert!(
        first_detail(&report, 7).contains(
            "evidence 3: decision cannot be reproduced: the payload has no evaluation_date"
        ),
        "{}",
        first_detail(&report, 7)
    );
}

#[test]
fn an_agent_step_without_an_evaluation_date_is_noted_but_does_not_fail() {
    let f = fixture_hooked(&Scenario::valid(), &|i, doc, _| {
        if i == 1 {
            doc.credential_subject.payload.remove("evaluation_date");
        }
    });
    let report = run(&f);
    assert!(report.passed(), "{:#?}", report.checks);
    assert!(
        first_detail(&report, 7).contains(
            "evidence 2: agent recommendation not compared (the payload has no evaluation_date)"
        ),
        "{}",
        first_detail(&report, 7)
    );
}

#[test]
fn a_signer_backdating_validfrom_and_evaluation_date_fails_checks_6_and_7() {
    let mut scenario = Scenario::valid();
    scenario.license_until = "2026-09-30";
    scenario.evaluation_date = "2026-09-01";
    scenario.signed_on = "2026-09-01";
    let report = run(&fixture_with(&scenario));
    assert_eq!(failing(&report), [6, 7], "{:#?}", report.checks);
    let detail = first_detail(&report, 7);
    assert!(
        detail.contains(
            "evidence 3: decision cannot be reproduced: evaluation date 2026-09-01 is not the anchoring day (2026-10-09, on-chain clock) or the day before"
        ),
        "{detail}"
    );
    let detail = first_detail(&report, 6);
    for n in 1..=3 {
        assert!(
            detail.contains(&format!(
                "evidence {n}: validFrom 2026-09-01T12:0{n}:00Z is more than 300 s away from the on-chain anchoring time"
            )),
            "{detail}"
        );
    }
}

#[test]
fn an_approver_backdating_validfrom_fails_check_6() {
    let mut scenario = Scenario::expired_license_escalated();
    scenario.approved = true;
    let honest = run(&fixture_with(&scenario));
    assert!(honest.passed(), "{:#?}", honest.checks);
    let f = fixture_hooked(&scenario, &|i, doc, options| {
        if i == 3 {
            doc.valid_from = "2026-09-01T12:04:00Z".to_owned();
            options.created = doc.valid_from.clone();
        }
    });
    let report = run(&f);
    assert_eq!(failing(&report), [6], "{:#?}", report.checks);
    assert!(
        first_detail(&report, 6).contains(
            "evidence 4: validFrom 2026-09-01T12:04:00Z is more than 300 s away from the on-chain anchoring time"
        ),
        "{}",
        first_detail(&report, 6)
    );
}

#[test]
fn a_validfrom_far_from_the_on_chain_clock_fails_check_6() {
    let mut scenario = Scenario::valid();
    scenario.anchor_delay_seconds = 301;
    let report = run(&fixture_with(&scenario));
    assert_eq!(failing(&report), [6], "{:#?}", report.checks);
    assert!(
        first_detail(&report, 6).contains(
            "evidence 1: validFrom 2026-10-09T12:01:00Z is more than 300 s away from the on-chain anchoring time"
        ),
        "{}",
        first_detail(&report, 6)
    );
    scenario.anchor_delay_seconds = -301;
    assert_eq!(failing(&run(&fixture_with(&scenario))), [6]);
}

#[test]
fn an_anchor_within_the_delay_of_the_signing_time_passes() {
    for delay in [300, -300, 0] {
        let mut scenario = Scenario::valid();
        scenario.anchor_delay_seconds = delay;
        let report = run(&fixture_with(&scenario));
        assert!(report.passed(), "{delay}: {:#?}", report.checks);
    }
}

#[test]
fn a_missing_anchor_of_a_rule_engine_decision_fails_check_7_too() {
    let mut f = fixture();
    let anchor = f.bundle.evidence[2].anchor_account.clone();
    f.accounts.remove(&anchor);
    let report = run(&f);
    assert_eq!(failing(&report), [4, 6, 7], "{:#?}", report.checks);
    assert!(
        first_detail(&report, 7).contains("on-chain anchor unavailable"),
        "{}",
        first_detail(&report, 7)
    );
}

#[test]
fn a_bundle_for_another_network_fails_check_6() {
    let mut f = fixture();
    f.bundle.network_id = "solana:mainnet-beta".to_owned();
    let report = run(&f);
    assert_eq!(failing(&report), [6], "{:#?}", report.checks);
    assert!(
        first_detail(&report, 6)
            .contains("bundle network is solana:mainnet-beta, expected solana:devnet")
    );
}

#[test]
fn a_proof_purpose_other_than_assertion_method_fails_check_3() {
    let f = fixture_hooked(&Scenario::valid(), &|i, _, options| {
        if i == 0 {
            options.proof_purpose = "authentication".to_owned();
        }
    });
    let report = run(&f);
    assert_eq!(failing(&report), [3], "{:#?}", report.checks);
    assert!(
        first_detail(&report, 3).contains("evidence 1: unexpected proof purpose authentication"),
        "{}",
        first_detail(&report, 3)
    );
}

#[test]
fn an_actor_kind_that_does_not_match_the_role_fails_check_4() {
    let f = fixture_hooked(&Scenario::valid(), &|i, doc, _| {
        if i == 1 {
            doc.credential_subject.actor.kind = ActorKind::Human;
        }
    });
    let report = run(&f);
    assert_eq!(failing(&report), [4], "{:#?}", report.checks);
    assert!(
        first_detail(&report, 4).contains("evidence 2: actor kind human does not match role agent"),
        "{}",
        first_detail(&report, 4)
    );
}

#[test]
fn an_anchor_account_listed_twice_fails_check_6() {
    let mut f = fixture();
    f.bundle.evidence[1].anchor_account = f.bundle.evidence[0].anchor_account.clone();
    let report = run(&f);
    assert!(failing(&report).contains(&6), "{:#?}", report.checks);
    assert!(
        first_detail(&report, 6).contains("evidence 2: anchor account listed twice"),
        "{}",
        first_detail(&report, 6)
    );
}

fn rewrite_record(f: &mut Fixture, change: impl Fn(&mut CaseRecordAccount)) {
    let snapshot = f.accounts.get_mut(&f.bundle.case_record).unwrap();
    let mut record = CaseRecordAccount::decode(&snapshot.data).unwrap();
    change(&mut record);
    snapshot.data = record.encode();
}

#[test]
fn a_case_record_holding_another_case_id_fails_check_6() {
    let mut f = fixture();
    rewrite_record(&mut f, |r| r.case_id = [9; 32]);
    let report = run(&f);
    assert!(failing(&report).contains(&6), "{:#?}", report.checks);
    assert!(
        first_detail(&report, 6).contains("case record holds a different case_id"),
        "{}",
        first_detail(&report, 6)
    );
}

#[test]
fn a_case_record_with_repeated_role_keys_reports_why_it_cannot_be_replayed() {
    let mut f = fixture();
    rewrite_record(&mut f, |r| r.agent = r.submitter);
    let report = run(&f);
    assert!(failing(&report).contains(&5), "{:#?}", report.checks);
    assert!(
        first_detail(&report, 5).contains("role keys must be pairwise distinct"),
        "{}",
        first_detail(&report, 5)
    );
}

#[test]
fn the_mandate_failure_names_the_right_evidence_after_an_invalid_document() {
    let mut f = fixture_hooked(&Scenario::valid(), &|i, doc, _| {
        if i == 2 {
            doc.credential_subject.mandate.amount_lamports = (AMOUNT + 1).to_string();
        }
    });
    f.bundle.evidence[0].document["type"] = json!("not a credential");
    let report = run(&f);
    let detail = first_detail(&report, 6);
    assert!(
        detail.contains("evidence 3: mandate differs from the on-chain amount/limit"),
        "{detail}"
    );
    assert!(!detail.contains("evidence 2: mandate"), "{detail}");
}

#[test]
fn reasons_that_are_not_text_fail_check_7() {
    let f = fixture_hooked(&Scenario::valid(), &|i, doc, _| {
        if i == 2 {
            doc.credential_subject
                .payload
                .insert("reasons".to_owned(), json!([1]));
        }
    });
    let report = run(&f);
    assert_eq!(failing(&report), [7], "{:#?}", report.checks);
    assert!(
        first_detail(&report, 7).contains("the payload reasons holds a value that is not text"),
        "{}",
        first_detail(&report, 7)
    );
}

#[test]
fn missing_reasons_fail_check_7() {
    let f = fixture_hooked(&Scenario::valid(), &|i, doc, _| {
        if i == 2 {
            doc.credential_subject.payload.remove("reasons");
        }
    });
    let report = run(&f);
    assert_eq!(failing(&report), [7], "{:#?}", report.checks);
    assert!(first_detail(&report, 7).contains("the payload has no reasons"));
}

#[test]
fn an_evidence_citing_another_rule_than_the_submission_fails_check_2() {
    let other = coorre_engine::RuleId::MilestonePayment;
    let other_hash = to_prefixed(&other.hash().unwrap());
    let mut f = fixture_hooked(&Scenario::valid(), &|i, doc, _| {
        if i == 1 {
            doc.credential_subject.rule = RuleRef {
                id: other.id().to_owned(),
                version: other.version().to_owned(),
                hash: other_hash.clone(),
            };
        }
    });
    f.bundle.rules.push(other.document().unwrap());
    let report = run(&f);
    assert_eq!(failing(&report), [2], "{:#?}", report.checks);
    assert!(
        first_detail(&report, 2).contains(&format!(
            "evidence 2: cites rule {} v{} ({other_hash}) but the SUBMITTED evidence cites rule supplier-docs v1",
            other.id(),
            other.version()
        )),
        "{}",
        first_detail(&report, 2)
    );
}

#[test]
fn an_agent_that_disagrees_with_the_rule_is_noted_but_does_not_fail() {
    let mut scenario = Scenario::valid();
    scenario.recommendation = "escalate";
    scenario.findings = vec!["made-up concern"];
    let report = run(&fixture_with(&scenario));
    assert!(report.passed(), "{:#?}", report.checks);
    assert!(first_detail(&report, 7).contains("agent recommendation differs from the rule"));
}

#[test]
fn a_rule_the_verifier_cannot_run_fails_check_7() {
    let mut f = fixture();
    let evidence = &mut f.bundle.evidence[2];
    let mut doc = EvidenceDocument::from_secured(&evidence.document).unwrap();
    doc.credential_subject.rule.id = "other-rule".to_owned();
    let signer = key(4);
    let options = ProofOptions::assertion(doc.valid_from.clone(), signer.verification_method());
    evidence.document = sign_document(&doc.to_value().unwrap(), &options, &signer).unwrap();
    let failed = failing(&run(&f));
    assert!(failed.contains(&7), "{failed:?}");
}

#[test]
fn a_case_without_automated_decisions_has_nothing_to_reproduce() {
    let mut f = fixture();
    f.bundle.evidence.truncate(1);
    let report = run(&f);
    assert_eq!(report.checks[6].status, Status::Pass);
    assert!(first_detail(&report, 7).contains("no automated decision recorded yet"));
}
