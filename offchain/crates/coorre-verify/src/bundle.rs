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
