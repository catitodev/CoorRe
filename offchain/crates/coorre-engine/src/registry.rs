use coorre_model::jcs;
use serde_json::{Map, Value, json};

use crate::error::{EngineError, Result};
use crate::rule::{self, Decision, DocumentArtifact, SupplierDocsInput};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RuleId {
    SupplierDocs,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedArtifact {
    pub synthetic: bool,
    pub kind: String,
    pub summary: Map<String, Value>,
}

impl RuleId {
    pub const ALL: [RuleId; 1] = [RuleId::SupplierDocs];

    pub fn id(self) -> &'static str {
        match self {
            RuleId::SupplierDocs => rule::RULE_ID,
        }
    }

    pub fn version(self) -> &'static str {
        match self {
            RuleId::SupplierDocs => rule::RULE_VERSION,
        }
    }

    pub fn find(id: &str, version: &str) -> Option<RuleId> {
        RuleId::ALL
            .into_iter()
            .find(|rule| rule.id() == id && rule.version() == version)
    }

    pub fn document(self) -> Result<Value> {
        match self {
            RuleId::SupplierDocs => rule::rule_document(),
        }
    }

    pub fn hash(self) -> Result<[u8; 32]> {
        jcs::hash(&self.document()?).map_err(|e| EngineError::RuleDefinition(e.to_string()))
    }

    pub fn parse_artifact(self, bytes: &[u8]) -> Result<ParsedArtifact> {
        match self {
            RuleId::SupplierDocs => {
                let document = DocumentArtifact::parse(bytes)?;
                let Value::Object(summary) = json!({
                    "kind": document.kind,
                    "number": document.number,
                    "valid_from": document.valid_from,
                    "valid_until": document.valid_until,
                }) else {
                    return Err(EngineError::InvalidRuleInput(
                        "document summary is not an object".to_owned(),
                    ));
                };
                let kind = summary
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                Ok(ParsedArtifact {
                    synthetic: document.synthetic,
                    kind,
                    summary,
                })
            }
        }
    }

    pub fn evaluate(
        self,
        evaluation_date: &str,
        amount_lamports: u64,
        autonomy_limit_lamports: u64,
        documents: &[&[u8]],
    ) -> Result<Decision> {
        match self {
            RuleId::SupplierDocs => rule::evaluate(&SupplierDocsInput {
                evaluation_date: evaluation_date.to_owned(),
                amount_lamports,
                autonomy_limit_lamports,
                documents: documents
                    .iter()
                    .map(|bytes| rule::submitted_document(bytes))
                    .collect::<Result<_>>()?,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use coorre_model::hash;

    const SUPPLIER_DOCS_FILE_SHA256: &str =
        "3451c77e299d096c62149896c193fe08ff80321ca588118c31efbdfc83bf2be1";
    const SUPPLIER_DOCS_RULE_HASH: &str =
        "7320d1d698663198cb21f5f5cce3e6d0064b8300a1042ebf13fc8934fbdabd2f";

    fn fixture(path: &str) -> Vec<u8> {
        let full = format!(
            "{}/../../../demo/fixtures/{path}",
            env!("CARGO_MANIFEST_DIR")
        );
        std::fs::read(&full).unwrap_or_else(|e| panic!("{full}: {e}"))
    }

    #[test]
    fn supplier_docs_v1_bytes_and_hash_are_the_committed_ones() {
        let bytes = include_bytes!("../rules/supplier-docs-v1.json");
        assert_eq!(
            hash::to_hex(&hash::sha256(bytes)),
            SUPPLIER_DOCS_FILE_SHA256
        );
        assert_eq!(
            hash::to_hex(&RuleId::SupplierDocs.hash().unwrap()),
            SUPPLIER_DOCS_RULE_HASH
        );
        assert_eq!(
            RuleId::SupplierDocs.hash().unwrap(),
            rule::rule_hash().unwrap()
        );
        assert_eq!(
            RuleId::SupplierDocs.document().unwrap(),
            rule::rule_document().unwrap()
        );
    }

    #[test]
    fn rules_are_found_only_by_their_exact_id_and_version() {
        assert_eq!(
            RuleId::find("supplier-docs", "1"),
            Some(RuleId::SupplierDocs)
        );
        assert_eq!(RuleId::find("supplier-docs", "2"), None);
        assert_eq!(RuleId::find("Supplier-Docs", "1"), None);
        assert_eq!(RuleId::find("other-rule", "1"), None);
        for rule in RuleId::ALL {
            assert_eq!(RuleId::find(rule.id(), rule.version()), Some(rule));
            let document = rule.document().unwrap();
            assert_eq!(document["id"], rule.id());
            assert_eq!(document["version"], rule.version());
        }
    }

    #[test]
    fn rule_hashes_are_distinct() {
        let hashes: std::collections::BTreeSet<_> =
            RuleId::ALL.iter().map(|r| r.hash().unwrap()).collect();
        assert_eq!(hashes.len(), RuleId::ALL.len());
    }

    #[test]
    fn supplier_docs_decisions_on_the_committed_fixtures_are_unchanged() {
        let case = |id: &str| {
            [
                fixture(&format!("{id}/tax-certificate.json")),
                fixture(&format!("{id}/environmental-license.json")),
            ]
        };
        let run = |id: &str, amount: u64, limit: u64| {
            let files = case(id);
            let refs: Vec<&[u8]> = files.iter().map(Vec::as_slice).collect();
            RuleId::SupplierDocs
                .evaluate("2026-10-09", amount, limit, &refs)
                .unwrap()
        };
        assert_eq!(
            run("SUP-001", 50_000_000, 100_000_000),
            Decision::AutoApproved
        );
        for id in ["SUP-002", "SUP-003"] {
            assert_eq!(
                run(id, 200_000_000, 100_000_000).reasons(),
                [
                    "environmental license expired",
                    "amount exceeds autonomy limit"
                ]
            );
        }
        let files = case("SUP-002");
        let submitted: Vec<_> = files
            .iter()
            .map(|b| rule::submitted_document(b).unwrap())
            .collect();
        let direct = rule::evaluate(&SupplierDocsInput {
            evaluation_date: "2026-10-09".to_owned(),
            amount_lamports: 200_000_000,
            autonomy_limit_lamports: 100_000_000,
            documents: submitted,
        })
        .unwrap();
        assert_eq!(direct, run("SUP-002", 200_000_000, 100_000_000));
    }

    #[test]
    fn supplier_docs_artifact_summary_matches_the_submitted_payload() {
        let bytes = fixture("SUP-002/environmental-license.json");
        let parsed = RuleId::SupplierDocs.parse_artifact(&bytes).unwrap();
        assert!(parsed.synthetic);
        assert_eq!(parsed.kind, "environmental_license");
        assert_eq!(
            Value::Object(parsed.summary),
            json!({
                "kind": "environmental_license",
                "number": "EL-2024-0042",
                "valid_from": "2024-01-01",
                "valid_until": "2026-09-30"
            })
        );
        assert!(RuleId::SupplierDocs.parse_artifact(b"{}").is_err());
    }
}
