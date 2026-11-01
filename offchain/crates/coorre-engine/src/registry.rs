use coorre_model::jcs;
use serde_json::{Map, Value, json};

use crate::agent_purchase;
use crate::documents::RuleVersion;
use crate::ecosystem_services;
use crate::error::{EngineError, Result};
use crate::milestone;
use crate::rule::{self, Decision, DocumentArtifact, SupplierDocsInput};
use crate::service_delivery;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RuleId {
    SupplierDocs,
    AgentPurchase,
    AgentPurchaseV2,
    EcosystemServicesPayment,
    MilestonePayment,
    MilestonePaymentV2,
    ServiceDelivery,
    ServiceDeliveryV2,
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
    pub const ALL: [RuleId; 8] = [
        RuleId::SupplierDocs,
        RuleId::AgentPurchase,
        RuleId::AgentPurchaseV2,
        RuleId::EcosystemServicesPayment,
        RuleId::MilestonePayment,
        RuleId::MilestonePaymentV2,
        RuleId::ServiceDelivery,
        RuleId::ServiceDeliveryV2,
    ];

    pub fn id(self) -> &'static str {
        match self {
            RuleId::SupplierDocs => rule::RULE_ID,
            RuleId::AgentPurchase | RuleId::AgentPurchaseV2 => agent_purchase::RULE_ID,
            RuleId::ServiceDelivery | RuleId::ServiceDeliveryV2 => service_delivery::RULE_ID,
            RuleId::MilestonePayment | RuleId::MilestonePaymentV2 => milestone::RULE_ID,
            RuleId::EcosystemServicesPayment => ecosystem_services::RULE_ID,
        }
    }

    fn rule_version(self) -> RuleVersion {
        match self {
            RuleId::SupplierDocs
            | RuleId::AgentPurchase
            | RuleId::EcosystemServicesPayment
            | RuleId::MilestonePayment
            | RuleId::ServiceDelivery => RuleVersion::V1,
            RuleId::AgentPurchaseV2 | RuleId::MilestonePaymentV2 | RuleId::ServiceDeliveryV2 => {
                RuleVersion::V2
            }
        }
    }

    pub fn version(self) -> &'static str {
        match self {
            RuleId::SupplierDocs => rule::RULE_VERSION,
            RuleId::EcosystemServicesPayment => ecosystem_services::RULE_VERSION,
            _ => self.rule_version().as_str(),
        }
    }

    pub fn find(id: &str, version: &str) -> Option<RuleId> {
        RuleId::ALL
            .into_iter()
            .find(|rule| rule.id() == id && rule.version() == version)
    }

    pub fn document(self) -> Result<Value> {
        let source = match self {
            RuleId::SupplierDocs => return rule::rule_document(),
            RuleId::AgentPurchase | RuleId::AgentPurchaseV2 => {
                agent_purchase::rule_document(self.rule_version())
            }
            RuleId::ServiceDelivery | RuleId::ServiceDeliveryV2 => {
                service_delivery::rule_document(self.rule_version())
            }
            RuleId::MilestonePayment | RuleId::MilestonePaymentV2 => {
                milestone::rule_document(self.rule_version())
            }
            RuleId::EcosystemServicesPayment => ecosystem_services::RULE_DOCUMENT,
        };
        parse_rule_document(source, self.id(), self.version())
    }

    pub fn hash(self) -> Result<[u8; 32]> {
        jcs::hash(&self.document()?).map_err(|e| EngineError::RuleDefinition(e.to_string()))
    }

    pub fn parse_artifact(self, bytes: &[u8]) -> Result<ParsedArtifact> {
        let version = self.rule_version();
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
            RuleId::AgentPurchase | RuleId::AgentPurchaseV2 => {
                agent_purchase::parse_artifact(version, bytes)
            }
            RuleId::ServiceDelivery | RuleId::ServiceDeliveryV2 => {
                service_delivery::parse_artifact(version, bytes)
            }
            RuleId::MilestonePayment | RuleId::MilestonePaymentV2 => {
                milestone::parse_artifact(version, bytes)
            }
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
        let version = self.rule_version();
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
            RuleId::AgentPurchase | RuleId::AgentPurchaseV2 => agent_purchase::evaluate(
                version,
                evaluation_date,
                amount_lamports,
                autonomy_limit_lamports,
                documents,
            ),
            RuleId::ServiceDelivery | RuleId::ServiceDeliveryV2 => service_delivery::evaluate(
                version,
                evaluation_date,
                amount_lamports,
                autonomy_limit_lamports,
                documents,
            ),
            RuleId::MilestonePayment | RuleId::MilestonePaymentV2 => milestone::evaluate(
                version,
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

    const PINNED_RULE_HASHES: [(RuleId, &str); 8] = [
        (RuleId::SupplierDocs, SUPPLIER_DOCS_RULE_HASH),
        (
            RuleId::AgentPurchase,
            "3d77e718e5ee0b6a66448c960024fe1dadff3950364eed67e2401d23eecc91b2",
        ),
        (
            RuleId::AgentPurchaseV2,
            "707c224f3ff8d0d0257dd23e075ac2cc8321752a09a9c390fee5a38149148f35",
        ),
        (
            RuleId::MilestonePaymentV2,
            "f7d08860c8e3d5bdcfd03bad0d7386e51824ee0c84887de61dca282e1d94e0c7",
        ),
        (
            RuleId::ServiceDeliveryV2,
            "9716660e20d2a88aee467e81020bd9630a2f2f9767d260964b9869dae67d05ab",
        ),
        (
            RuleId::EcosystemServicesPayment,
            "eb9e053a54cf94256949e7bb134390e68efb86fa4be4434f1b0c24d34d4307c9",
        ),
        (
            RuleId::MilestonePayment,
            "bb7edb9e6d965c6c508d1f3abcb56000811e7dbd4fe558145dddc874bc37ed85",
        ),
        (
            RuleId::ServiceDelivery,
            "c8ef062c4eb22745086f9ff84b143c5549b06aef0079aa3e52327a0a9928e21c",
        ),
    ];

    #[test]
    fn every_rule_hash_matches_an_independent_computation() {
        assert_eq!(PINNED_RULE_HASHES.len(), RuleId::ALL.len());
        for (rule, expected) in PINNED_RULE_HASHES {
            assert_eq!(hash::to_hex(&rule.hash().unwrap()), expected, "{rule:?}");
        }
    }

    const V1_RULE_FILES_SHA256: [(&str, &str); 4] = [
        (
            agent_purchase::RULE_DOCUMENT_V1,
            "2e6bbf7b855a3089a8aaca7befd3ddb170562eb19af01150d01ed4dce765a5c8",
        ),
        (
            ecosystem_services::RULE_DOCUMENT,
            "30b7df3f6de79d05c257e20278bdeb4a1048b30bbe92da1e1ec80681c1876ff6",
        ),
        (
            milestone::RULE_DOCUMENT_V1,
            "3304c2bb2ec2ac458af995396f7c6d31457c09f3a33f5e1a0fc1eb73a1dfe85b",
        ),
        (
            service_delivery::RULE_DOCUMENT_V1,
            "ec8e20aa46b18ee3de0df087a3b30180cb90f81e61daec3afc1768a03e7fade7",
        ),
    ];

    #[test]
    fn v1_rule_files_keep_their_committed_bytes() {
        for (source, expected) in V1_RULE_FILES_SHA256 {
            assert_eq!(hash::to_hex(&hash::sha256(source.as_bytes())), expected);
        }
    }

    #[test]
    fn v2_differs_from_v1_only_where_the_dates_are_checked() {
        for (v1, v2) in [
            (RuleId::AgentPurchase, RuleId::AgentPurchaseV2),
            (RuleId::MilestonePayment, RuleId::MilestonePaymentV2),
            (RuleId::ServiceDelivery, RuleId::ServiceDeliveryV2),
        ] {
            let (old, new) = (v1.document().unwrap(), v2.document().unwrap());
            assert_eq!(v1.id(), v2.id());
            assert_eq!((v1.version(), v2.version()), ("1", "2"));
            for field in [
                "requiredDocuments",
                "documentLabels",
                "dates",
                "notEvaluated",
                "mandate",
                "outcomes",
            ] {
                assert_eq!(old[field], new[field], "{v2:?} {field}");
            }
            assert!(
                new["dates"]
                    .as_str()
                    .unwrap()
                    .contains("comparisons are inclusive")
            );
            assert_ne!(old["conditions"], new["conditions"], "{v2:?}");
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
        let agt_002 = files("AGT-002");
        let agt_002: Vec<&str> = agt_002.iter().map(String::as_str).collect();
        for rule in [RuleId::AgentPurchase, RuleId::AgentPurchaseV2] {
            assert_eq!(
                evaluate_case(rule, &agt_001, 20_000_000, 30_000_000),
                Decision::AutoApproved
            );
            assert_eq!(
                evaluate_case(rule, &agt_002, 40_000_000, 30_000_000).reasons(),
                [
                    "supplier registration expired",
                    "amount exceeds autonomy limit"
                ]
            );
        }
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
    fn milestone_fixtures_give_the_documented_decisions() {
        let files = |id: &str| {
            [
                format!("{id}/funding-agreement.json"),
                format!("{id}/milestone-report.json"),
                format!("{id}/accountability-report.json"),
            ]
        };
        let mil_001 = files("MIL-001");
        let mil_001: Vec<&str> = mil_001.iter().map(String::as_str).collect();
        let mil_002 = files("MIL-002");
        let mil_002: Vec<&str> = mil_002.iter().map(String::as_str).collect();
        for rule in [RuleId::MilestonePayment, RuleId::MilestonePaymentV2] {
            assert_eq!(
                evaluate_case(rule, &mil_001, 20_000_000, 30_000_000),
                Decision::AutoApproved
            );
            assert_eq!(
                evaluate_case(rule, &mil_002, 20_000_000, 30_000_000).reasons(),
                ["open findings in the accountability report"]
            );
        }
    }

    #[test]
    fn service_delivery_fixtures_give_the_documented_decisions() {
        let files = |id: &str| {
            [
                format!("{id}/service-contract.json"),
                format!("{id}/acceptance-record.json"),
                format!("{id}/invoice.json"),
            ]
        };
        let srv_001 = files("SRV-001");
        let srv_001: Vec<&str> = srv_001.iter().map(String::as_str).collect();
        let srv_002 = files("SRV-002");
        let srv_002: Vec<&str> = srv_002.iter().map(String::as_str).collect();
        for rule in [RuleId::ServiceDelivery, RuleId::ServiceDeliveryV2] {
            assert_eq!(
                evaluate_case(rule, &srv_001, 20_000_000, 30_000_000),
                Decision::AutoApproved
            );
            assert_eq!(
                evaluate_case(rule, &srv_002, 20_000_000, 30_000_000).reasons(),
                ["invoice issued before acceptance"]
            );
        }
    }

    #[test]
    fn rules_are_found_only_by_their_exact_id_and_version() {
        assert_eq!(
            RuleId::find("supplier-docs", "1"),
            Some(RuleId::SupplierDocs)
        );
        assert_eq!(RuleId::find("supplier-docs", "2"), None);
        assert_eq!(
            RuleId::find("agent-purchase", "2"),
            Some(RuleId::AgentPurchaseV2)
        );
        assert_eq!(
            RuleId::find("milestone-payment", "2"),
            Some(RuleId::MilestonePaymentV2)
        );
        assert_eq!(
            RuleId::find("service-delivery", "2"),
            Some(RuleId::ServiceDeliveryV2)
        );
        assert_eq!(RuleId::find("ecosystem-services-payment", "2"), None);
        assert_eq!(RuleId::find("agent-purchase", "3"), None);
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

    const DEMO_HORIZON: (&str, &str) = ("2026-11-01", "2027-06-30");

    const DOMAIN_CASE_DECISIONS: [(&str, &str, &[&str]); 8] = [
        ("AGT-001", "2", &[]),
        (
            "AGT-002",
            "2",
            &[
                "supplier registration expired",
                "amount exceeds autonomy limit",
            ],
        ),
        ("PES-001", "1", &[]),
        (
            "PES-002",
            "1",
            &[
                "verified area below committed area",
                "amount exceeds autonomy limit",
            ],
        ),
        ("MIL-001", "2", &[]),
        (
            "MIL-002",
            "2",
            &["open findings in the accountability report"],
        ),
        ("SRV-001", "2", &[]),
        ("SRV-002", "2", &["invoice issued before acceptance"]),
    ];

    #[test]
    fn domain_cases_keep_their_documented_decision_every_day_of_the_demo_horizon() {
        let cases: Value =
            serde_json::from_slice(&fixture("cases.json")).unwrap_or_else(|e| panic!("{e}"));
        let cases = cases["cases"].as_array().unwrap();
        let first = rule::parse_date(DEMO_HORIZON.0).unwrap();
        let last = rule::parse_date(DEMO_HORIZON.1).unwrap();
        for (id, version, expected) in DOMAIN_CASE_DECISIONS {
            let case = cases.iter().find(|c| c["id"] == id).unwrap();
            let rule = RuleId::find(
                case["rule"]["id"].as_str().unwrap(),
                case["rule"]["version"].as_str().unwrap(),
            )
            .unwrap();
            assert_eq!(rule.version(), version, "{id}");
            let files: Vec<Vec<u8>> = case["documents"]
                .as_array()
                .unwrap()
                .iter()
                .map(|f| fixture(f.as_str().unwrap()))
                .collect();
            let refs: Vec<&[u8]> = files.iter().map(Vec::as_slice).collect();
            let lamports = |field: &str| case[field].as_str().unwrap().parse::<u64>().unwrap();
            let mut day = first;
            while day <= last {
                let decision = rule
                    .evaluate(
                        &day.to_string(),
                        lamports("amount_lamports"),
                        lamports("autonomy_limit_lamports"),
                        &refs,
                    )
                    .unwrap();
                assert_eq!(decision.reasons(), expected, "{id} on {day}");
                day = day.next_day().unwrap();
            }
        }
    }
}
