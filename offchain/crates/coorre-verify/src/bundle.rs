use coorre_model::accounts::pubkey_from_base58;
use coorre_model::evidence::is_case_ref;
use coorre_model::{ArtifactRef, ModelError, jcs};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const BUNDLE_FORMAT: &str = "coorre-audit-bundle/1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub network_id: String,
    pub program_id: String,
    pub account: String,
    pub tx_signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BundleEvidence {
    pub anchor_account: String,
    pub document: Value,
    pub receipt: Option<Receipt>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuditBundle {
    pub format: String,
    pub case_ref: String,
    pub network_id: String,
    pub program_id: String,
    pub case_record: String,
    pub open_receipt: Option<Receipt>,
    pub evidence: Vec<BundleEvidence>,
    pub rules: Vec<Value>,
    pub artifacts: Vec<ArtifactRef>,
}

impl AuditBundle {
    pub fn from_json(text: &str) -> Result<Self, ModelError> {
        let value = jcs::parse(text)?;
        let bundle: Self = serde_json::from_value(value)
            .map_err(|e| ModelError::InvalidEvidence(format!("audit bundle: {e}")))?;
        if bundle.format != BUNDLE_FORMAT {
            return Err(ModelError::InvalidEvidence(format!(
                "unsupported bundle format `{}`",
                bundle.format
            )));
        }
        if !is_case_ref(&bundle.case_ref) {
            return Err(ModelError::InvalidEvidence(format!(
                "audit bundle: case_ref {:?} is not a urn:coorre:case: reference",
                bundle.case_ref
            )));
        }
        pubkey_from_base58(&bundle.case_record).map_err(|e| {
            ModelError::InvalidEvidence(format!(
                "audit bundle: case_record {:?}: {e}",
                bundle.case_record
            ))
        })?;
        for (i, evidence) in bundle.evidence.iter().enumerate() {
            pubkey_from_base58(&evidence.anchor_account).map_err(|e| {
                ModelError::InvalidEvidence(format!(
                    "audit bundle: evidence {} anchor_account {:?}: {e}",
                    i + 1,
                    evidence.anchor_account
                ))
            })?;
        }
        Ok(bundle)
    }

    pub fn required_accounts(&self) -> Vec<String> {
        let mut addresses = vec![self.case_record.clone()];
        for evidence in &self.evidence {
            if !addresses.contains(&evidence.anchor_account) {
                addresses.push(evidence.anchor_account.clone());
            }
        }
        addresses
    }

    pub fn declared_artifact_names(&self) -> Vec<String> {
        let in_documents = self.evidence.iter().flat_map(|e| {
            e.document
                .pointer("/credentialSubject/artifacts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|a| a.get("name").and_then(Value::as_str).map(str::to_owned))
        });
        let mut names: Vec<String> = self
            .artifacts
            .iter()
            .map(|a| a.name.clone())
            .chain(in_documents)
            .collect();
        names.sort();
        names.dedup();
        names
    }

    pub fn to_json_pretty(&self) -> Result<String, ModelError> {
        serde_json::to_string_pretty(self).map_err(|e| ModelError::InvalidEvidence(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "tests")]

    use super::*;
    use serde_json::json;

    const RECORD: &str = "4tkhyE96rDPd3hCZvxge8i5sYNGmkH4SAsdK5SgJFeQz";
    const ANCHOR_A: &str = "11111111111111111111111111111111";
    const ANCHOR_B: &str = "SysvarC1ock11111111111111111111111111111111";

    fn artifact(name: &str) -> ArtifactRef {
        ArtifactRef {
            name: name.to_owned(),
            media_type: "application/json".to_owned(),
            digest_sha256: "00".repeat(32),
        }
    }

    fn evidence(anchor: &str, artifacts: Value) -> BundleEvidence {
        BundleEvidence {
            anchor_account: anchor.to_owned(),
            document: json!({ "credentialSubject": { "artifacts": artifacts } }),
            receipt: None,
        }
    }

    fn bundle() -> AuditBundle {
        AuditBundle {
            format: BUNDLE_FORMAT.to_owned(),
            case_ref: "urn:coorre:case:TEST-001".to_owned(),
            network_id: "solana:devnet".to_owned(),
            program_id: "P".to_owned(),
            case_record: RECORD.to_owned(),
            open_receipt: None,
            evidence: vec![
                evidence(
                    ANCHOR_A,
                    json!([{ "name": "b.json" }, { "name": "a.json" }]),
                ),
                evidence(ANCHOR_B, json!([])),
                evidence(ANCHOR_A, json!([{ "name": 7 }, { "other": "x" }])),
            ],
            rules: vec![],
            artifacts: vec![artifact("c.json"), artifact("a.json")],
        }
    }

    #[test]
    fn required_accounts_lists_the_record_first_then_each_anchor_once_in_order() {
        assert_eq!(bundle().required_accounts(), [RECORD, ANCHOR_A, ANCHOR_B]);
        let mut empty = bundle();
        empty.evidence.clear();
        assert_eq!(empty.required_accounts(), [RECORD]);
    }

    #[test]
    fn declared_artifact_names_merges_bundle_and_documents_sorted_without_duplicates() {
        assert_eq!(
            bundle().declared_artifact_names(),
            ["a.json", "b.json", "c.json"]
        );
        let mut none = bundle();
        none.artifacts.clear();
        none.evidence.clear();
        assert!(none.declared_artifact_names().is_empty());
    }

    #[test]
    fn from_json_round_trips_the_pretty_output() {
        let original = bundle();
        let text = original.to_json_pretty().unwrap();
        assert_eq!(AuditBundle::from_json(&text).unwrap(), original);
    }

    #[test]
    fn from_json_rejects_another_format_and_unknown_fields() {
        let mut value = serde_json::to_value(bundle()).unwrap();
        value["format"] = json!("other/9");
        assert!(AuditBundle::from_json(&value.to_string()).is_err());
        let mut value = serde_json::to_value(bundle()).unwrap();
        value["unexpected"] = json!(true);
        assert!(AuditBundle::from_json(&value.to_string()).is_err());
    }

    #[test]
    fn from_json_rejects_an_invalid_case_ref() {
        for bad in [
            "urn:coorre:case:TEST\u{1b}[2J",
            "urn:other:TEST",
            "urn:coorre:case:",
            "",
        ] {
            let mut b = bundle();
            b.case_ref = bad.to_owned();
            let error = AuditBundle::from_json(&b.to_json_pretty().unwrap()).unwrap_err();
            assert!(error.to_string().contains("case_ref"), "{bad:?}: {error}");
            assert!(!error.to_string().contains('\u{1b}'), "{error}");
        }
    }

    #[test]
    fn from_json_rejects_a_non_canonical_case_record_or_anchor_account() {
        let mut b = bundle();
        b.case_record = "not-base58\u{1b}".to_owned();
        let error = AuditBundle::from_json(&b.to_json_pretty().unwrap()).unwrap_err();
        assert!(error.to_string().contains("case_record"), "{error}");
        assert!(!error.to_string().contains('\u{1b}'), "{error}");
        let mut b = bundle();
        b.evidence[1].anchor_account = format!("1{ANCHOR_A}");
        let error = AuditBundle::from_json(&b.to_json_pretty().unwrap()).unwrap_err();
        assert!(
            error.to_string().contains("evidence 2 anchor_account"),
            "{error}"
        );
    }
}
