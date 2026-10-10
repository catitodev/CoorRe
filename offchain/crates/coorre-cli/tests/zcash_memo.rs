#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test-only crate")]

use std::path::{Path, PathBuf};

use coorre_cli::files::load_bundle;
use coorre_cli::zcash_memo::{
    check, decode_binary_hex, encode_binary_hex, encode_text, parse_text, release_decision,
};
use coorre_verify::AuditBundle;

fn repository() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn recorded() -> Vec<(String, AuditBundle)> {
    let root = repository();
    let mut parents = vec![root.join("web/verifier/samples")];
    for run in std::fs::read_dir(root.join("onchain/devnet-bundles")).unwrap() {
        let run = run.unwrap().path();
        if run.is_dir() {
            parents.push(run);
        }
    }
    let mut cases: Vec<(String, AuditBundle)> = parents
        .iter()
        .flat_map(|p| std::fs::read_dir(p).unwrap())
        .map(|e| e.unwrap().path())
        .filter(|p| p.join("bundle.json").is_file())
        .map(|p| {
            (
                p.file_name().unwrap().to_str().unwrap().to_owned(),
                load_bundle(&p.join("bundle.json")).unwrap(),
            )
        })
        .collect();
    cases.sort_by(|a, b| a.0.cmp(&b.0));
    cases
}

#[test]
fn every_released_case_yields_a_memo_that_matches_only_its_own_decision() {
    let cases = recorded();
    assert_eq!(cases.len(), 10);
    let mut released = Vec::new();
    for (id, bundle) in &cases {
        match release_decision(bundle) {
            Ok(decision) => released.push((id.clone(), decision.memo)),
            Err(e) => assert!(["MIL-002", "SRV-002"].contains(&id.as_str()), "{id}: {e}"),
        }
    }
    let ids: Vec<&str> = released.iter().map(|(id, _)| id.as_str()).collect();
    assert_eq!(
        ids,
        [
            "AGT-001", "AGT-002", "MIL-001", "PES-001", "PES-002", "SRV-001", "SUP-001", "SUP-002"
        ]
    );
    for (id, memo) in &released {
        let from_text = parse_text(&encode_text(memo)).unwrap();
        let from_binary = decode_binary_hex(&encode_binary_hex(memo)).unwrap();
        assert_eq!(&from_text, memo);
        assert_eq!(&from_binary, memo);
        for (other, bundle) in &cases {
            assert_eq!(check(memo, bundle).is_ok(), other == id, "{id} vs {other}");
        }
    }
}

#[test]
fn a_memo_with_a_changed_hash_or_state_does_not_match() {
    let (_, bundle) = recorded()
        .into_iter()
        .find(|(id, _)| id == "SUP-002")
        .unwrap();
    let memo = release_decision(&bundle).unwrap().memo;
    let mut other_evidence = memo;
    other_evidence.evidence_hash[0] ^= 1;
    let mut other_rule = memo;
    other_rule.rule_hash[31] ^= 1;
    let mut other_state = memo;
    other_state.state = coorre_model::CaseState::AutoApproved;
    for bad in [other_evidence, other_rule, other_state] {
        assert!(check(&bad, &bundle).is_err());
    }
    assert!(check(&memo, &bundle).is_ok());
}
