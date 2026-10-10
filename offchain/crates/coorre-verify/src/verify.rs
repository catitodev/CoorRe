use std::collections::{BTreeMap, BTreeSet};

use coorre_engine::rule::evaluation_date_is_credible;
use coorre_engine::{CaseTracker, Decision, RoleKeys, RuleId, required_role};
use coorre_model::accounts::{
    CaseRecordAccount, EvidenceAnchorAccount, pubkey_from_base58, pubkey_to_base58,
};
use coorre_model::eddsa_jcs_2022::{
    PROOF_PURPOSE_ASSERTION, VerifiedProof, evidence_hash, verify_proof,
};
use coorre_model::evidence::{case_id, genesis_previous_evidence, is_safe_artifact_name};
use coorre_model::hash::{sha256, to_hex, to_prefixed};
use coorre_model::{CaseState, EvidenceDocument, did_key, jcs};

use serde_json::Value;

use crate::bundle::AuditBundle;
use crate::report::{CaseSummary, CheckResult, Report, Status, TimelineEntry};

pub const SOLANA_DEVNET_NETWORK_ID: &str = "solana:devnet";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountSnapshot {
    pub owner: String,
    pub data: Vec<u8>,
}

pub struct Inputs<'a> {
    pub bundle: &'a AuditBundle,
    pub artifacts: &'a BTreeMap<String, Vec<u8>>,
    pub accounts: &'a BTreeMap<String, AccountSnapshot>,
    pub expected_program_id: &'a str,
    pub expected_network_id: &'a str,
}

struct Entry {
    document: Option<EvidenceDocument>,
    hash: Option<[u8; 32]>,
    proof: Option<VerifiedProof>,
    anchor: Option<EvidenceAnchorAccount>,
    errors: Vec<String>,
}

fn short(hash: &[u8; 32]) -> String {
    format!("sha256:{}…", &to_hex(hash)[..12])
}

fn account<'a>(inputs: &'a Inputs, address: &str) -> Result<&'a AccountSnapshot, String> {
    inputs
        .accounts
        .get(address)
        .ok_or_else(|| format!("account {address} was not provided"))
}

fn owned<'a>(inputs: &'a Inputs, address: &str) -> Result<&'a AccountSnapshot, String> {
    let snapshot = account(inputs, address)?;
    if snapshot.owner != inputs.expected_program_id {
        return Err(format!(
            "account {address} is owned by {}, not by program {}",
            snapshot.owner, inputs.expected_program_id
        ));
    }
    Ok(snapshot)
}

fn finish(id: u8, name: &'static str, failures: Vec<String>, passed: Vec<String>) -> CheckResult {
    if failures.is_empty() {
        CheckResult {
            id,
            name,
            status: Status::Pass,
            details: passed,
        }
    } else {
        CheckResult {
            id,
            name,
            status: Status::Fail,
            details: failures,
        }
    }
}

pub fn verify(inputs: &Inputs) -> Report {
    let bundle = inputs.bundle;
    let record = owned(inputs, &bundle.case_record)
        .and_then(|a| CaseRecordAccount::decode(&a.data).map_err(|e| e.to_string()));

    let entries: Vec<Entry> = bundle
        .evidence
        .iter()
        .map(|e| {
            let mut errors = Vec::new();
            let document = EvidenceDocument::from_secured(&e.document)
                .map_err(|err| errors.push(err.to_string()))
                .ok();
            let hash = evidence_hash(&e.document)
                .map_err(|err| errors.push(err.to_string()))
                .ok();
            let proof = verify_proof(&e.document).ok();
            let anchor = owned(inputs, &e.anchor_account)
                .and_then(|a| EvidenceAnchorAccount::decode(&a.data).map_err(|err| err.to_string()))
                .ok();
            Entry {
                document,
                hash,
                proof,
                anchor,
                errors,
            }
        })
        .collect();

    let checks = vec![
        check_artifacts(inputs, &entries),
        check_evidence(bundle, &entries),
        check_proofs(bundle),
        check_signers(&record, &entries),
        check_chain(bundle, &record, &entries),
        check_onchain(inputs, &record, &entries),
        check_decisions(inputs, &entries),
    ];

    Report {
        summary: summary(inputs, &record),
        timeline: timeline(bundle, &entries),
        checks,
    }
}

fn check_artifacts(inputs: &Inputs, entries: &[Entry]) -> CheckResult {
    let mut failures = Vec::new();
    let mut declared: BTreeMap<String, String> = BTreeMap::new();
    let mut declare = |name: &str, digest: &str, failures: &mut Vec<String>| {
        if let Some(previous) = declared.insert(name.to_owned(), digest.to_owned())
            && previous != digest
        {
            failures.push(format!("{name} is declared with two different digests"));
        }
    };
    for artifact in &inputs.bundle.artifacts {
        declare(&artifact.name, &artifact.digest_sha256, &mut failures);
    }
    for entry in entries {
        for artifact in entry
            .document
            .iter()
            .flat_map(|d| &d.credential_subject.artifacts)
        {
            declare(&artifact.name, &artifact.digest_sha256, &mut failures);
        }
    }
    let mut passed = Vec::new();
    for (name, digest) in &declared {
        if !is_safe_artifact_name(name) {
            failures.push(format!("{name}: unsafe artifact name"));
            continue;
        }
        match inputs.artifacts.get(name) {
            None => failures.push(format!("{name}: file not provided")),
            Some(bytes) => {
                let actual = to_hex(&sha256(bytes));
                if &actual == digest {
                    passed.push(format!("{name}: sha256 {}… matches", &digest[..12]));
                } else {
                    failures.push(format!(
                        "{name}: sha256 of the file is {actual}, evidence declares {digest}"
                    ));
                }
            }
        }
    }
    if declared.is_empty() {
        passed.push("no artifacts declared".to_owned());
    }
    finish(1, "Artifact digests match", failures, passed)
}

fn check_evidence(bundle: &AuditBundle, entries: &[Entry]) -> CheckResult {
    let mut failures = Vec::new();
    let mut passed = Vec::new();
    if entries.is_empty() {
        failures.push("the bundle contains no evidence".to_owned());
    }
    for (i, entry) in entries.iter().enumerate() {
        let n = i + 1;
        for error in &entry.errors {
            failures.push(format!("evidence {n}: {error}"));
        }
        let (Some(doc), Some(hash)) = (&entry.document, &entry.hash) else {
            continue;
        };
        let subject = &doc.credential_subject;
        if subject.case != bundle.case_ref {
            failures.push(format!(
                "evidence {n}: belongs to case {}, not {}",
                subject.case, bundle.case_ref
            ));
        }
        let rule = bundle.rules.iter().find(|r| {
            r.get("id").and_then(|v| v.as_str()) == Some(subject.rule.id.as_str())
                && r.get("version").and_then(|v| v.as_str()) == Some(subject.rule.version.as_str())
        });
        match rule.map(jcs::hash) {
            None => failures.push(format!(
                "evidence {n}: rule {} v{} is not included in the bundle",
                subject.rule.id, subject.rule.version
            )),
            Some(Err(e)) => {
                failures.push(format!("evidence {n}: rule document cannot be hashed: {e}"))
            }
            Some(Ok(rule_hash)) => {
                if to_prefixed(&rule_hash) != subject.rule.hash {
                    failures.push(format!(
                        "evidence {n}: rule hash does not match the included rule document"
                    ));
                }
            }
        }
        passed.push(format!(
            "evidence {n}: {} -> {} hashes to {}",
            subject.from_state.name(),
            subject.to_state.name(),
            short(hash)
        ));
    }
    finish(
        2,
        "Evidence hash recomputed (JCS + SHA-256)",
        failures,
        passed,
    )
}

fn check_proofs(bundle: &AuditBundle) -> CheckResult {
    let mut failures = Vec::new();
    let mut passed = Vec::new();
    for (i, evidence) in bundle.evidence.iter().enumerate() {
        let n = i + 1;
        match verify_proof(&evidence.document) {
            Ok(proof) if proof.proof_purpose == PROOF_PURPOSE_ASSERTION => {
                passed.push(format!(
                    "evidence {n}: eddsa-jcs-2022 proof valid ({})",
                    proof.did
                ));
            }
            Ok(proof) => failures.push(format!(
                "evidence {n}: unexpected proof purpose {}",
                proof.proof_purpose
            )),
            Err(e) => failures.push(format!("evidence {n}: {e}")),
        }
    }
    if bundle.evidence.is_empty() {
        failures.push("the bundle contains no evidence".to_owned());
    }
    finish(3, "Ed25519 eddsa-jcs-2022 proof valid", failures, passed)
}

fn role_keys(record: &CaseRecordAccount) -> RoleKeys {
    RoleKeys {
        submitter: record.submitter,
        agent: record.agent,
        rule_engine: record.rule_engine,
        approver: record.approver,
    }
}

fn check_signers(record: &Result<CaseRecordAccount, String>, entries: &[Entry]) -> CheckResult {
    let mut failures = Vec::new();
    let mut passed = Vec::new();
    let record = match record {
        Ok(r) => r,
        Err(e) => {
            return finish(
                4,
                "Signer bound to the on-chain role key",
                vec![format!("case record: {e}")],
                vec![],
            );
        }
    };
    let roles = role_keys(record);
    for (i, entry) in entries.iter().enumerate() {
        let n = i + 1;
        let Some(doc) = &entry.document else {
            failures.push(format!("evidence {n}: document is invalid"));
            continue;
        };
        let issuer = match did_key::public_key_from_did(&doc.issuer) {
            Ok(k) => k,
            Err(e) => {
                failures.push(format!("evidence {n}: issuer: {e}"));
                continue;
            }
        };
        let subject = &doc.credential_subject;
        let mut ok = true;
        match &entry.proof {
            Some(proof) if proof.public_key == issuer => {}
            Some(_) => {
                failures.push(format!(
                    "evidence {n}: proof key differs from the issuer did:key"
                ));
                ok = false;
            }
            None => {
                failures.push(format!("evidence {n}: no valid proof to bind"));
                ok = false;
            }
        }
        let Some(role) = required_role(subject.from_state, subject.to_state) else {
            failures.push(format!(
                "evidence {n}: {} -> {} is not an allowed transition",
                subject.from_state.name(),
                subject.to_state.name()
            ));
            continue;
        };
        if roles.key(role) != issuer {
            failures.push(format!(
                "evidence {n}: signed by {} but the on-chain {} key is {}",
                pubkey_to_base58(&issuer),
                role.name(),
                pubkey_to_base58(&roles.key(role))
            ));
            ok = false;
        }
        if subject.actor.kind != role.actor_kind() {
            failures.push(format!(
                "evidence {n}: actor kind {} does not match role {}",
                subject.actor.kind.name(),
                role.name()
            ));
            ok = false;
        }
        match &entry.anchor {
            Some(anchor)
                if anchor.actor == issuer && anchor.actor_kind == role.actor_kind().code() => {}
            Some(_) => {
                failures.push(format!(
                    "evidence {n}: on-chain anchor records a different actor"
                ));
                ok = false;
            }
            None => {
                failures.push(format!("evidence {n}: on-chain anchor unavailable"));
                ok = false;
            }
        }
        if ok {
            passed.push(format!(
                "evidence {n}: {} key {} signed and anchored it",
                role.name(),
                pubkey_to_base58(&issuer)
            ));
        }
    }
    finish(4, "Signer bound to the on-chain role key", failures, passed)
}

fn check_chain(
    bundle: &AuditBundle,
    record: &Result<CaseRecordAccount, String>,
    entries: &[Entry],
) -> CheckResult {
    let mut failures = Vec::new();
    let mut expected_prev = genesis_previous_evidence(&bundle.case_ref);
    let mut expected_from = CaseState::Open;
    let mut tracker = record.as_ref().ok().and_then(|r| {
        CaseTracker::open(r.case_id, role_keys(r), r.amount, r.autonomy_limit, 0).ok()
    });
    if tracker.is_none() {
        failures.push("case record unavailable: transitions cannot be replayed".to_owned());
    }
    for (i, entry) in entries.iter().enumerate() {
        let n = i + 1;
        let (Some(doc), Some(hash)) = (&entry.document, &entry.hash) else {
            failures.push(format!("evidence {n}: chain broken by an invalid document"));
            break;
        };
        let subject = &doc.credential_subject;
        if subject.previous_evidence != expected_prev {
            failures.push(format!(
                "evidence {n}: previousEvidence does not point to evidence {}",
                i
            ));
        }
        if subject.from_state != expected_from {
            failures.push(format!(
                "evidence {n}: starts from {} but the case was in {}",
                subject.from_state.name(),
                expected_from.name()
            ));
        }
        if let (Some(t), Ok(issuer), Ok(prev)) = (
            tracker.as_mut(),
            did_key::public_key_from_did(&doc.issuer),
            doc.previous_evidence_hash(),
        ) && let Err(e) = t.apply(subject.to_state.code(), issuer, prev, *hash)
        {
            failures.push(format!("evidence {n}: replay rejected: {e}"));
        }
        expected_prev = to_prefixed(hash);
        expected_from = subject.to_state;
    }
    let passed = vec![format!(
        "{} transitions chained from genesis {} to {}",
        entries.len(),
        &genesis_previous_evidence(&bundle.case_ref)[..19],
        expected_from.name()
    )];
    finish(5, "Hash chain continuous from genesis", failures, passed)
}

fn check_onchain(
    inputs: &Inputs,
    record: &Result<CaseRecordAccount, String>,
    entries: &[Entry],
) -> CheckResult {
    let bundle = inputs.bundle;
    let mut failures = Vec::new();
    let mut passed = Vec::new();
    if bundle.program_id != inputs.expected_program_id {
        failures.push(format!(
            "bundle names program {}, expected {}",
            bundle.program_id, inputs.expected_program_id
        ));
    }
    if bundle.network_id != inputs.expected_network_id {
        failures.push(format!(
            "bundle network is {}, expected {}",
            bundle.network_id, inputs.expected_network_id
        ));
    }
    let case_record_key = pubkey_from_base58(&bundle.case_record).map_err(|e| e.to_string());
    if let Err(e) = &case_record_key {
        failures.push(format!("case record address: {e}"));
    }
    match record {
        Err(e) => failures.push(format!("case record: {e}")),
        Ok(r) => {
            if r.case_id != case_id(&bundle.case_ref) {
                failures.push("case record holds a different case_id".to_owned());
            }
            if r.transition_count as usize != entries.len() {
                failures.push(format!(
                    "case record has {} transitions, bundle has {}",
                    r.transition_count,
                    entries.len()
                ));
            }
            if let Some(Some(last)) = entries.last().map(|e| e.document.as_ref().zip(e.hash)) {
                let (doc, hash) = last;
                if r.state != doc.credential_subject.to_state.code() {
                    failures.push(format!(
                        "case record state is {}, last evidence ends in {}",
                        r.state,
                        doc.credential_subject.to_state.name()
                    ));
                }
                if r.last_evidence_hash != hash {
                    failures.push(
                        "case record last_evidence_hash differs from the last evidence".to_owned(),
                    );
                }
            }
            for (i, doc) in entries
                .iter()
                .filter_map(|e| e.document.as_ref())
                .enumerate()
            {
                if doc.amount_lamports().ok() != Some(r.amount)
                    || doc.autonomy_limit_lamports().ok() != Some(r.autonomy_limit)
                {
                    failures.push(format!(
                        "evidence {}: mandate differs from the on-chain amount/limit",
                        i + 1
                    ));
                }
            }
            if failures.is_empty() {
                passed.push(format!(
                    "case record {} owned by the program: state {}, {} lamports, limit {}",
                    bundle.case_record,
                    CaseState::from_code(r.state)
                        .map(CaseState::name)
                        .unwrap_or("unknown"),
                    r.amount,
                    r.autonomy_limit
                ));
            }
        }
    }
    let mut seen = BTreeSet::new();
    for (i, (entry, evidence)) in entries.iter().zip(&bundle.evidence).enumerate() {
        let n = i + 1;
        if !seen.insert(evidence.anchor_account.as_str()) {
            failures.push(format!("evidence {n}: anchor account listed twice"));
        }
        let anchor = match owned(inputs, &evidence.anchor_account)
            .and_then(|a| EvidenceAnchorAccount::decode(&a.data).map_err(|e| e.to_string()))
        {
            Ok(a) => a,
            Err(e) => {
                failures.push(format!("evidence {n}: {e}"));
                continue;
            }
        };
        let (Some(doc), Some(hash)) = (&entry.document, &entry.hash) else {
            failures.push(format!("evidence {n}: document is invalid"));
            continue;
        };
        let subject = &doc.credential_subject;
        let mut mismatches = Vec::new();
        if anchor.evidence_hash != *hash {
            mismatches.push("evidence_hash");
        }
        if case_record_key.as_ref().ok() != Some(&anchor.case_record) {
            mismatches.push("case_record");
        }
        if doc.previous_evidence_hash().ok() != Some(anchor.prev_hash) {
            mismatches.push("prev_hash");
        }
        if anchor.from_state != subject.from_state.code()
            || anchor.to_state != subject.to_state.code()
        {
            mismatches.push("states");
        }
        if did_key::public_key_from_did(&doc.issuer).ok() != Some(anchor.actor) {
            mismatches.push("actor");
        }
        if doc.rule_hash().ok() != Some(anchor.rule_hash) {
            mismatches.push("rule_hash");
        }
        if mismatches.is_empty() {
            passed.push(format!(
                "evidence {n}: anchor {} matches (slot {})",
                evidence.anchor_account, anchor.slot
            ));
        } else {
            failures.push(format!(
                "evidence {n}: on-chain anchor differs in {}",
                mismatches.join(", ")
            ));
        }
    }
    finish(
        6,
        "On-chain match (owner, discriminator, content)",
        failures,
        passed,
    )
}

fn submitted_documents<'a>(
    inputs: &'a Inputs,
    entries: &[Entry],
) -> Result<Vec<(&'a str, &'a [u8])>, String> {
    let submission = entries
        .iter()
        .filter_map(|e| e.document.as_ref())
        .find(|d| d.credential_subject.to_state == CaseState::Submitted)
        .ok_or("no SUBMITTED evidence lists the documents")?;
    let refs = &submission.credential_subject.artifacts;
    if refs.is_empty() {
        return Err("the SUBMITTED evidence lists no documents".to_owned());
    }
    refs.iter()
        .map(|artifact| {
            inputs
                .artifacts
                .get_key_value(&artifact.name)
                .map(|(name, bytes)| (name.as_str(), bytes.as_slice()))
                .ok_or_else(|| format!("{}: file not provided", artifact.name))
        })
        .collect()
}

fn reproduce(
    document: &EvidenceDocument,
    documents: &Result<Vec<(&str, &[u8])>, String>,
) -> Result<(Decision, String), String> {
    let subject = &document.credential_subject;
    let rule = RuleId::find(&subject.rule.id, &subject.rule.version).ok_or_else(|| {
        format!(
            "rule {} v{} is not one this verifier can run",
            subject.rule.id, subject.rule.version
        )
    })?;
    let known_hash = rule.hash().map_err(|e| e.to_string())?;
    if subject.rule.hash != to_prefixed(&known_hash) {
        return Err(format!(
            "the rule hash differs from the {} v{} this verifier runs",
            rule.id(),
            rule.version()
        ));
    }
    let evaluation_date = subject
        .payload
        .get("evaluation_date")
        .and_then(Value::as_str)
        .ok_or("the payload has no evaluation_date")?;
    if !evaluation_date_is_credible(evaluation_date, &document.valid_from)
        .map_err(|e| e.to_string())?
    {
        return Err(format!(
            "evaluation date {evaluation_date} is not the signing day ({}) or the day before",
            &document.valid_from[..10]
        ));
    }
    let documents = documents.clone()?;
    for (name, bytes) in &documents {
        rule.parse_artifact(bytes)
            .map_err(|e| format!("{name}: {e}"))?;
    }
    let bytes: Vec<&[u8]> = documents.iter().map(|(_, bytes)| *bytes).collect();
    let decision = rule
        .evaluate(
            evaluation_date,
            document.amount_lamports().map_err(|e| e.to_string())?,
            document
                .autonomy_limit_lamports()
                .map_err(|e| e.to_string())?,
            &bytes,
        )
        .map_err(|e| e.to_string())?;
    Ok((decision, evaluation_date.to_owned()))
}

fn string_list(payload: &serde_json::Map<String, Value>, key: &str) -> Option<Vec<String>> {
    payload
        .get(key)?
        .as_array()?
        .iter()
        .map(|v| v.as_str().map(str::to_owned))
        .collect()
}

fn check_decisions(inputs: &Inputs, entries: &[Entry]) -> CheckResult {
    let name = "Automated decisions reproduced from the rule";
    let mut failures = Vec::new();
    let mut passed = Vec::new();
    if entries.is_empty() {
        return finish(
            7,
            name,
            vec!["the bundle contains no evidence".to_owned()],
            vec![],
        );
    }
    let documents = submitted_documents(inputs, entries);
    let mut automated = 0;
    for (i, entry) in entries.iter().enumerate() {
        let n = i + 1;
        let Some(doc) = &entry.document else { continue };
        let subject = &doc.credential_subject;
        let is_agent = subject.from_state == CaseState::Submitted
            && subject.to_state == CaseState::AgentReviewed;
        let is_rule_engine = subject.from_state == CaseState::AgentReviewed
            && matches!(
                subject.to_state,
                CaseState::AutoApproved | CaseState::Escalated
            );
        if !is_agent && !is_rule_engine {
            continue;
        }
        automated += 1;
        let (decision, evaluated_on) = match reproduce(doc, &documents) {
            Ok(result) => result,
            Err(e) if is_agent => {
                passed.push(format!(
                    "evidence {n}: agent recommendation not compared ({e})"
                ));
                continue;
            }
            Err(e) => {
                failures.push(format!("evidence {n}: decision cannot be reproduced: {e}"));
                continue;
            }
        };
        let payload = &subject.payload;
        if is_agent {
            let expected = match decision {
                Decision::AutoApproved => "auto_approve",
                Decision::Escalated { .. } => "escalate",
            };
            if payload.get("recommendation").and_then(Value::as_str) == Some(expected)
                && string_list(payload, "findings").as_deref() == Some(decision.reasons())
            {
                passed.push(format!(
                    "evidence {n}: agent recommendation matches the rule ({expected})"
                ));
            } else {
                passed.push(format!(
                    "evidence {n}: agent recommendation differs from the rule, which gives {expected}; informational, the rule engine decides"
                ));
            }
            continue;
        }
        let mut differences = Vec::new();
        if decision.to_state() != subject.to_state {
            differences.push(format!(
                "the rule gives {} but {} was recorded",
                decision.to_state().name(),
                subject.to_state.name()
            ));
        }
        if payload.get("decision").and_then(Value::as_str) != Some(subject.to_state.name()) {
            differences.push("the payload decision does not match the state".to_owned());
        }
        let recorded = string_list(payload, "reasons").unwrap_or_default();
        if recorded != decision.reasons() {
            differences.push(format!(
                "reasons recorded [{}] but the rule gives [{}]",
                recorded.join("; "),
                decision.reasons().join("; ")
            ));
        }
        if differences.is_empty() {
            passed.push(format!(
                "evidence {n}: {} reproduced from the submitted documents on {evaluated_on}",
                subject.to_state.name()
            ));
        } else {
            failures.push(format!("evidence {n}: {}", differences.join("; ")));
        }
    }
    if automated == 0 {
        passed.push("no automated decision recorded yet".to_owned());
    }
    finish(7, name, failures, passed)
}

fn summary(inputs: &Inputs, record: &Result<CaseRecordAccount, String>) -> CaseSummary {
    let r = record.as_ref().ok();
    let key = |f: fn(&CaseRecordAccount) -> [u8; 32]| r.map(|r| pubkey_to_base58(&f(r)));
    CaseSummary {
        case_ref: inputs.bundle.case_ref.clone(),
        program_id: inputs.expected_program_id.to_owned(),
        case_record: inputs.bundle.case_record.clone(),
        creator: key(|r| r.creator),
        submitter: key(|r| r.submitter),
        agent: key(|r| r.agent),
        rule_engine: key(|r| r.rule_engine),
        approver: key(|r| r.approver),
        amount_lamports: r.map(|r| r.amount),
        autonomy_limit_lamports: r.map(|r| r.autonomy_limit),
        final_state: r
            .and_then(|r| CaseState::from_code(r.state))
            .map(|s| s.name().to_owned()),
    }
}

fn timeline(bundle: &AuditBundle, entries: &[Entry]) -> Vec<TimelineEntry> {
    entries
        .iter()
        .zip(&bundle.evidence)
        .filter_map(|(entry, evidence)| {
            let doc = entry.document.as_ref()?;
            let s = &doc.credential_subject;
            Some(TimelineEntry {
                from_state: s.from_state.name().to_owned(),
                to_state: s.to_state.name().to_owned(),
                actor_did: doc.issuer.clone(),
                actor_kind: s.actor.kind.name().to_owned(),
                autonomy: s.actor.autonomy.name().to_owned(),
                valid_from: doc.valid_from.clone(),
                evidence_hash: entry.hash.map(|h| to_prefixed(&h)).unwrap_or_default(),
                anchor_account: evidence.anchor_account.clone(),
                anchor_slot: entry.anchor.as_ref().map(|a| a.slot),
                anchor_unix_ts: entry.anchor.as_ref().map(|a| a.unix_ts),
                tx_signature: evidence.receipt.as_ref().map(|r| r.tx_signature.clone()),
                payload: Value::Object(s.payload.clone()),
            })
        })
        .collect()
}
