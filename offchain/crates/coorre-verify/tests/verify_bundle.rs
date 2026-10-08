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
use serde_json::{Map, Value, json};

const PROGRAM: &str = "9esN1A8K1SASLg17ob81dbSdB4VX8ozc6tBLmJ247Wv";
const OTHER_PROGRAM: &str = "11111111111111111111111111111111";
const CASE_REF: &str = "urn:coorre:case:TEST-001";
const AMOUNT: u64 = 50_000_000;
const LIMIT: u64 = 100_000_000;

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
}

fn document(step: &Step, previous: String) -> Value {
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
    let doc = EvidenceDocument {
        context: vec![VC_CONTEXT_V2.to_owned(), COORRE_CONTEXT.to_owned()],
        id: format!("urn:uuid:00000000-0000-4000-8000-00000000000{n}"),
        types: vec![VC_TYPE.to_owned(), TRANSITION_TYPE.to_owned()],
        issuer: signer.did(),
        valid_from: format!("2026-10-09T12:0{n}:00Z"),
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
            payload: Map::new(),
            previous_evidence: previous,
        },
    };
    let options = ProofOptions::assertion(doc.valid_from.clone(), signer.verification_method());
    sign_document(&doc.to_value().unwrap(), &options, signer).unwrap()
}

fn fixture() -> Fixture {
    let (creator, submitter, agent, rule_engine, approver) =
        (key(1), key(2), key(3), key(4), key(5));
    let case_record = address(50);
    let files = [
        (
            "tax-certificate.json",
            b"{\"kind\":\"tax_certificate\"}".to_vec(),
        ),
        (
            "environmental-license.json",
            b"{\"kind\":\"environmental_license\"}".to_vec(),
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

    let steps = [
        Step {
            signer: &submitter,
            n: 1,
            from: CaseState::Open,
            to: CaseState::Submitted,
            kind: ActorKind::Human,
            autonomy: Autonomy::Escalate,
            artifacts: refs.clone(),
        },
        Step {
            signer: &agent,
            n: 2,
            from: CaseState::Submitted,
            to: CaseState::AgentReviewed,
            kind: ActorKind::Agent,
            autonomy: Autonomy::Recommend,
            artifacts: vec![],
        },
        Step {
            signer: &rule_engine,
            n: 3,
            from: CaseState::AgentReviewed,
            to: CaseState::AutoApproved,
            kind: ActorKind::System,
            autonomy: Autonomy::Autonomous,
            artifacts: vec![],
        },
    ];
    let mut previous = genesis_previous_evidence(CASE_REF);
    let mut evidence = Vec::new();
    let mut accounts = BTreeMap::new();
    let mut last_hash = [0u8; 32];
    for (i, step) in steps.iter().enumerate() {
        let doc = document(step, previous.clone());
        let hash = evidence_hash(&doc).unwrap();
        let anchor_account = address(60 + i as u8);
        let anchor = EvidenceAnchorAccount {
            evidence_hash: hash,
            case_record: key(50).public_key(),
            prev_hash: coorre_model::hash::from_prefixed(&previous).unwrap(),
            from_state: step.from.code(),
            to_state: step.to.code(),
            actor: step.signer.public_key(),
            actor_kind: step.kind.code(),
            rule_hash: rule_hash().unwrap(),
            slot: 1000 + i as u64,
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
        state: CaseState::AutoApproved.code(),
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
fn a_valid_bundle_passes_all_six_checks() {
    let report = run(&fixture());
    assert!(report.passed(), "{:#?}", report.checks);
    assert_eq!(
        report.checks.iter().map(|c| c.id).collect::<Vec<_>>(),
        [1, 2, 3, 4, 5, 6]
    );
    assert_eq!(report.passed_count(), 6);
    assert_eq!(report.timeline.len(), 3);
    assert_eq!(report.summary.final_state.as_deref(), Some("AUTO_APPROVED"));
    assert_eq!(report.summary.submitter, Some(address(2)));
}

#[test]
fn one_changed_byte_in_an_artifact_fails_check_1() {
    let mut f = fixture();
    f.artifacts.get_mut("environmental-license.json").unwrap()[0] ^= 0x01;
    assert_eq!(failing(&run(&f)), [1]);
}

#[test]
fn a_missing_artifact_fails_check_1() {
    let mut f = fixture();
    f.artifacts.remove("tax-certificate.json");
    assert_eq!(failing(&run(&f)), [1]);
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
