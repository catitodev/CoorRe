use coorre_model::jcs;
use serde_json::{Map, Value, json};

use crate::agent_purchase;
use crate::ecosystem_services;
use crate::error::{EngineError, Result};
use crate::rule::{self, Decision, DocumentArtifact, SupplierDocsInput};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RuleId {
    SupplierDocs,
    AgentPurchase,
    EcosystemServicesPayment,
}

fn parse_rule_document(source: &str, id: &str, version: &str) -> Result<Value> {
    let value = jcs::parse(source).map_err(|e| EngineError::RuleDefinition(e.to_string()))?;
    if value["id"] != id || value["version"] != version {
        return Err(EngineError::RuleDefinition(
            "id/version mismatch".to_owned(),
        ));
    }
    Ok(value)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedArtifact {
    pub synthetic: bool,
    pub kind: String,
    pub summary: Map<String, Value>,
}

impl RuleId {
    pub const ALL: [RuleId; 3] = [
        RuleId::SupplierDocs,
        RuleId::AgentPurchase,
        RuleId::EcosystemServicesPayment,
    ];

    pub fn id(self) -> &'static str {
        match self {
            RuleId::SupplierDocs => rule::RULE_ID,
            RuleId::AgentPurchase => agent_purchase::RULE_ID,
            RuleId::EcosystemServicesPayment => ecosystem_services::RULE_ID,
        }
    }

    pub fn version(self) -> &'static str {
        match self {
            RuleId::SupplierDocs => rule::RULE_VERSION,
            RuleId::AgentPurchase => agent_purchase::RULE_VERSION,
            RuleId::EcosystemServicesPayment => ecosystem_services::RULE_VERSION,
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
            RuleId::AgentPurchase => parse_rule_document(
                agent_purchase::RULE_DOCUMENT,
                agent_purchase::RULE_ID,
                agent_purchase::RULE_VERSION,
            ),
            RuleId::EcosystemServicesPayment => parse_rule_document(
                ecosystem_services::RULE_DOCUMENT,
                ecosystem_services::RULE_ID,
                ecosystem_services::RULE_VERSION,
            ),
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
            RuleId::AgentPurchase => agent_purchase::parse_artifact(bytes),
            RuleId::EcosystemServicesPayment => ecosystem_services::parse_artifact(bytes),
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
            RuleId::AgentPurchase => agent_purchase::evaluate(
                evaluation_date,
                amount_lamports,
                autonomy_limit_lamports,
                documents,
            ),
            RuleId::EcosystemServicesPayment => ecosystem_services::evaluate(
                evaluation_date,
                amount_lamports,
                autonomy_limit_lamports,
                documents,
            ),
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

    const PINNED_RULE_HASHES: [(RuleId, &str); 3] = [
        (RuleId::SupplierDocs, SUPPLIER_DOCS_RULE_HASH),
        (
            RuleId::AgentPurchase,
            "3d77e718e5ee0b6a66448c960024fe1dadff3950364eed67e2401d23eecc91b2",
        ),
        (
            RuleId::EcosystemServicesPayment,
            "eb9e053a54cf94256949e7bb134390e68efb86fa4be4434f1b0c24d34d4307c9",
        ),
    ];

    #[test]
    fn every_rule_hash_matches_an_independent_computation() {
        assert_eq!(PINNED_RULE_HASHES.len(), RuleId::ALL.len());
        for (rule, expected) in PINNED_RULE_HASHES {
            assert_eq!(hash::to_hex(&rule.hash().unwrap()), expected, "{rule:?}");
        }
    }

    fn evaluate_case(rule: RuleId, files: &[&str], amount: u64, limit: u64) -> Decision {
        let bytes: Vec<Vec<u8>> = files.iter().map(|f| fixture(f)).collect();
        let refs: Vec<&[u8]> = bytes.iter().map(Vec::as_slice).collect();
        for (file, b) in files.iter().zip(&refs) {
            let parsed = rule.parse_artifact(b).unwrap();
            assert!(parsed.synthetic, "{file}");
        }
        rule.evaluate("2026-10-09", amount, limit, &refs).unwrap()
    }

    #[test]
    fn agent_purchase_fixtures_give_the_documented_decisions() {
        let files = |id: &str| {
            [
                format!("{id}/purchase-request.json"),
                format!("{id}/supplier-quote.json"),
                format!("{id}/supplier-registration.json"),
            ]
        };
        let agt_001 = files("AGT-001");
        let agt_001: Vec<&str> = agt_001.iter().map(String::as_str).collect();
        assert_eq!(
            evaluate_case(RuleId::AgentPurchase, &agt_001, 20_000_000, 30_000_000),
            Decision::AutoApproved
        );
        let agt_002 = files("AGT-002");
        let agt_002: Vec<&str> = agt_002.iter().map(String::as_str).collect();
        assert_eq!(
            evaluate_case(RuleId::AgentPurchase, &agt_002, 40_000_000, 30_000_000).reasons(),
            [
                "supplier registration expired",
                "amount exceeds autonomy limit"
            ]
        );
        assert!(
            RuleId::SupplierDocs
                .parse_artifact(&fixture("AGT-001/purchase-request.json"))
                .is_err()
        );
        assert!(
            RuleId::AgentPurchase
                .parse_artifact(&fixture("SUP-001/tax-certificate.json"))
                .is_err()
        );
    }

    #[test]
    fn ecosystem_services_fixtures_give_the_documented_decisions() {
        assert_eq!(
            evaluate_case(
                RuleId::EcosystemServicesPayment,
                &[
                    "PES-001/pes-contract.json",
                    "PES-001/monitoring-report.json"
                ],
                20_000_000,
                30_000_000
            ),
            Decision::AutoApproved
        );
        assert_eq!(
            evaluate_case(
                RuleId::EcosystemServicesPayment,
                &[
                    "PES-002/pes-contract.json",
                    "PES-002/monitoring-report.json"
                ],
                40_000_000,
                30_000_000
            )
            .reasons(),
            [
                "verified area below committed area",
                "amount exceeds autonomy limit"
            ]
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
