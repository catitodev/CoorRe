use coorre_model::{CaseState, hash, jcs};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::{Date, Month};

use crate::error::{EngineError, Result};

pub const RULE_ID: &str = "supplier-docs";
pub const RULE_VERSION: &str = "1";

const RULE_DOCUMENT: &str = include_str!("../rules/supplier-docs-v1.json");

pub fn rule_document() -> Result<Value> {
    let value =
        jcs::parse(RULE_DOCUMENT).map_err(|e| EngineError::RuleDefinition(e.to_string()))?;
    let matches_constants = value["id"] == RULE_ID && value["version"] == RULE_VERSION;
    if !matches_constants {
        return Err(EngineError::RuleDefinition(
            "id/version mismatch".to_owned(),
        ));
    }
    Ok(value)
}

pub fn rule_hash() -> Result<[u8; 32]> {
    jcs::hash(&rule_document()?).map_err(|e| EngineError::RuleDefinition(e.to_string()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentKind {
    TaxCertificate,
    EnvironmentalLicense,
}

impl DocumentKind {
    pub const REQUIRED: [DocumentKind; 2] = [
        DocumentKind::TaxCertificate,
        DocumentKind::EnvironmentalLicense,
    ];

    pub fn label(self) -> &'static str {
        match self {
            DocumentKind::TaxCertificate => "tax certificate",
            DocumentKind::EnvironmentalLicense => "environmental license",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubmittedDocument {
    pub kind: DocumentKind,
    pub valid_from: String,
    pub valid_until: String,
    pub digest_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DocumentArtifact {
    pub synthetic: bool,
    pub kind: DocumentKind,
    pub supplier: String,
    pub issuer: String,
    pub number: String,
    pub valid_from: String,
    pub valid_until: String,
}

impl DocumentArtifact {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let text = std::str::from_utf8(bytes)
            .map_err(|_| EngineError::InvalidRuleInput("document is not UTF-8".to_owned()))?;
        let value = jcs::parse(text).map_err(|e| EngineError::InvalidRuleInput(e.to_string()))?;
        serde_json::from_value(value)
            .map_err(|e| EngineError::InvalidRuleInput(format!("document format: {e}")))
    }

    pub fn submitted(&self, bytes: &[u8]) -> SubmittedDocument {
        SubmittedDocument {
            kind: self.kind,
            valid_from: self.valid_from.clone(),
            valid_until: self.valid_until.clone(),
            digest_sha256: hash::to_hex(&hash::sha256(bytes)),
        }
    }
}

pub fn submitted_document(bytes: &[u8]) -> Result<SubmittedDocument> {
    Ok(DocumentArtifact::parse(bytes)?.submitted(bytes))
}

pub const MAX_EVALUATION_AGE_DAYS: i32 = 1;

pub fn evaluation_date_is_credible(evaluation_date: &str, signed_at: &str) -> Result<bool> {
    let evaluated = parse_date(evaluation_date)?;
    let signed_date = signed_at
        .get(..10)
        .ok_or_else(|| EngineError::InvalidRuleInput(format!("invalid timestamp `{signed_at}`")))?;
    let signed = parse_date(signed_date)?;
    let age = signed.to_julian_day() - evaluated.to_julian_day();
    Ok((0..=MAX_EVALUATION_AGE_DAYS).contains(&age))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SupplierDocsInput {
    pub evaluation_date: String,
    pub amount_lamports: u64,
    pub autonomy_limit_lamports: u64,
    pub documents: Vec<SubmittedDocument>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    AutoApproved,
    Escalated { reasons: Vec<String> },
}

impl Decision {
    pub fn to_state(&self) -> CaseState {
        match self {
            Decision::AutoApproved => CaseState::AutoApproved,
            Decision::Escalated { .. } => CaseState::Escalated,
        }
    }

    pub fn reasons(&self) -> &[String] {
        match self {
            Decision::AutoApproved => &[],
            Decision::Escalated { reasons } => reasons,
        }
    }
}

pub fn evaluate(input: &SupplierDocsInput) -> Result<Decision> {
    let today = parse_date(&input.evaluation_date)?;
    let mut validated = Vec::with_capacity(input.documents.len());
    for document in &input.documents {
        let from = parse_date(&document.valid_from)?;
        let until = parse_date(&document.valid_until)?;
        if from > until {
            return Err(EngineError::InvalidRuleInput(format!(
                "{} valid_from is after valid_until",
                document.kind.label()
            )));
        }
        hash::from_hex(&document.digest_sha256)
            .map_err(|e| EngineError::InvalidRuleInput(e.to_string()))?;
        validated.push((document.kind, from, until));
    }

    let mut reasons = Vec::new();
    for kind in DocumentKind::REQUIRED {
        let matching: Vec<_> = validated.iter().filter(|(k, _, _)| *k == kind).collect();
        let label = kind.label();
        match matching.as_slice() {
            [] => reasons.push(format!("{label} missing")),
            [(_, from, until)] => {
                if today < *from {
                    reasons.push(format!("{label} not yet valid"));
                } else if today > *until {
                    reasons.push(format!("{label} expired"));
                }
            }
            _ => reasons.push(format!("{label} submitted more than once")),
        }
    }
    if input.amount_lamports > input.autonomy_limit_lamports {
        reasons.push("amount exceeds autonomy limit".to_owned());
    }

    Ok(if reasons.is_empty() {
        Decision::AutoApproved
    } else {
        Decision::Escalated { reasons }
    })
}

pub fn parse_date(text: &str) -> Result<Date> {
    let invalid = || EngineError::InvalidRuleInput(format!("invalid date `{text}`"));
    let bytes = text.as_bytes();
    let shape_ok = bytes.len() == 10
        && bytes.iter().enumerate().all(|(i, b)| match i {
            4 | 7 => *b == b'-',
            _ => b.is_ascii_digit(),
        });
    if !shape_ok {
        return Err(invalid());
    }
    let year: i32 = text[0..4].parse().map_err(|_| invalid())?;
    let month: u8 = text[5..7].parse().map_err(|_| invalid())?;
    let day: u8 = text[8..10].parse().map_err(|_| invalid())?;
    let month = Month::try_from(month).map_err(|_| invalid())?;
    Date::from_calendar_date(year, month, day).map_err(|_| invalid())
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIGEST: &str = "0000000000000000000000000000000000000000000000000000000000000000";

    fn doc(kind: DocumentKind, from: &str, until: &str) -> SubmittedDocument {
        SubmittedDocument {
            kind,
            valid_from: from.to_owned(),
            valid_until: until.to_owned(),
            digest_sha256: DIGEST.to_owned(),
        }
    }

    fn input(amount: u64, limit: u64, documents: Vec<SubmittedDocument>) -> SupplierDocsInput {
        SupplierDocsInput {
            evaluation_date: "2026-10-09".to_owned(),
            amount_lamports: amount,
            autonomy_limit_lamports: limit,
            documents,
        }
    }

    fn valid_docs() -> Vec<SubmittedDocument> {
        vec![
            doc(DocumentKind::TaxCertificate, "2026-01-01", "2026-12-31"),
            doc(
                DocumentKind::EnvironmentalLicense,
                "2025-06-01",
                "2027-05-31",
            ),
        ]
    }

    #[test]
    fn rule_document_hash_matches_an_independent_computation() {
        assert_eq!(
            hash::to_hex(&rule_hash().unwrap()),
            "7320d1d698663198cb21f5f5cce3e6d0064b8300a1042ebf13fc8934fbdabd2f"
        );
        let doc = rule_document().unwrap();
        assert_eq!(doc["id"], RULE_ID);
        assert_eq!(doc["version"], RULE_VERSION);
    }

    #[test]
    fn sup_001_valid_documents_within_limit_auto_approves() {
        let decision = evaluate(&input(50_000_000, 100_000_000, valid_docs())).unwrap();
        assert_eq!(decision, Decision::AutoApproved);
        assert_eq!(decision.to_state(), CaseState::AutoApproved);
        assert!(decision.reasons().is_empty());
    }

    #[test]
    fn sup_002_expired_license_above_limit_escalates_with_spec_reasons() {
        let documents = vec![
            doc(DocumentKind::TaxCertificate, "2026-01-01", "2026-12-31"),
            doc(
                DocumentKind::EnvironmentalLicense,
                "2024-01-01",
                "2026-09-30",
            ),
        ];
        let decision = evaluate(&input(200_000_000, 100_000_000, documents)).unwrap();
        assert_eq!(decision.to_state(), CaseState::Escalated);
        assert_eq!(
            decision.reasons(),
            [
                "environmental license expired",
                "amount exceeds autonomy limit"
            ]
        );
    }

    #[test]
    fn limit_and_validity_boundaries_are_inclusive() {
        let on_the_edge = vec![
            doc(DocumentKind::TaxCertificate, "2026-10-09", "2026-10-09"),
            doc(
                DocumentKind::EnvironmentalLicense,
                "2026-10-09",
                "2026-10-09",
            ),
        ];
        assert_eq!(
            evaluate(&input(100, 100, on_the_edge)).unwrap(),
            Decision::AutoApproved
        );
        assert_eq!(
            evaluate(&input(101, 100, valid_docs())).unwrap().reasons(),
            ["amount exceeds autonomy limit"]
        );
    }

    #[test]
    fn missing_future_and_duplicate_documents_escalate() {
        let reasons =
            |docs: Vec<SubmittedDocument>| evaluate(&input(1, 1, docs)).unwrap().reasons().to_vec();
        assert_eq!(
            reasons(vec![]),
            ["tax certificate missing", "environmental license missing"]
        );
        assert_eq!(
            reasons(vec![
                doc(DocumentKind::TaxCertificate, "2026-10-10", "2027-10-10"),
                doc(
                    DocumentKind::EnvironmentalLicense,
                    "2025-01-01",
                    "2027-01-01"
                ),
            ]),
            ["tax certificate not yet valid"]
        );
        let mut duplicated = valid_docs();
        duplicated.push(doc(
            DocumentKind::TaxCertificate,
            "2026-01-01",
            "2026-12-31",
        ));
        assert_eq!(
            reasons(duplicated),
            ["tax certificate submitted more than once"]
        );
    }

    #[test]
    fn malformed_input_is_an_error() {
        let bad_inputs = [
            SupplierDocsInput {
                evaluation_date: "2026-02-30".to_owned(),
                ..input(1, 1, valid_docs())
            },
            SupplierDocsInput {
                evaluation_date: "09/10/2026".to_owned(),
                ..input(1, 1, valid_docs())
            },
            input(
                1,
                1,
                vec![doc(
                    DocumentKind::TaxCertificate,
                    "2026-12-31",
                    "2026-01-01",
                )],
            ),
            input(
                1,
                1,
                vec![SubmittedDocument {
                    digest_sha256: "XYZ".to_owned(),
                    ..valid_docs()[0].clone()
                }],
            ),
        ];
        for bad in bad_inputs {
            assert!(
                matches!(evaluate(&bad), Err(EngineError::InvalidRuleInput(_))),
                "{bad:?}"
            );
        }
    }

    fn artifact_bytes(kind: &str, from: &str, until: &str) -> Vec<u8> {
        format!(
            r#"{{"synthetic":true,"kind":"{kind}","supplier":"S","issuer":"I","number":"N-1","valid_from":"{from}","valid_until":"{until}"}}"#
        )
        .into_bytes()
    }

    #[test]
    fn artifacts_parse_strictly_and_carry_their_own_digest() {
        let bytes = artifact_bytes("tax_certificate", "2026-01-01", "2026-12-31");
        let parsed = DocumentArtifact::parse(&bytes).unwrap();
        assert_eq!(parsed.kind, DocumentKind::TaxCertificate);
        let submitted = submitted_document(&bytes).unwrap();
        assert_eq!(submitted.digest_sha256, hash::to_hex(&hash::sha256(&bytes)));
        assert_eq!(
            (
                submitted.valid_from.as_str(),
                submitted.valid_until.as_str()
            ),
            ("2026-01-01", "2026-12-31")
        );
        let extra = String::from_utf8(bytes.clone())
            .unwrap()
            .replace("\"number\"", "\"extra\":1,\"number\"");
        assert!(DocumentArtifact::parse(extra.as_bytes()).is_err());
        assert!(DocumentArtifact::parse(&[0xff, 0xfe]).is_err());
        assert!(DocumentArtifact::parse(b"{}").is_err());
        assert!(
            DocumentArtifact::parse(&artifact_bytes("passport", "2026-01-01", "2026-12-31"))
                .is_err()
        );
    }

    #[test]
    fn evaluation_date_must_be_the_signing_day_or_the_day_before() {
        assert!(evaluation_date_is_credible("2026-10-09", "2026-10-09T12:00:00Z").unwrap());
        assert!(evaluation_date_is_credible("2026-10-08", "2026-10-09T00:00:01Z").unwrap());
        assert!(!evaluation_date_is_credible("2026-10-07", "2026-10-09T12:00:00Z").unwrap());
        assert!(!evaluation_date_is_credible("2026-10-10", "2026-10-09T12:00:00Z").unwrap());
        assert!(!evaluation_date_is_credible("2026-01-01", "2026-10-09T12:00:00Z").unwrap());
        assert!(evaluation_date_is_credible("2026-09-30", "2026-10-01T08:00:00Z").unwrap());
        assert!(evaluation_date_is_credible("bad", "2026-10-09T12:00:00Z").is_err());
        assert!(evaluation_date_is_credible("2026-10-09", "short").is_err());
    }

    #[test]
    fn parse_date_is_strict() {
        assert_eq!(parse_date("2028-02-29").unwrap().to_string(), "2028-02-29");
        for bad in [
            "2026-2-01",
            "2026-13-01",
            "2026-00-10",
            "2027-02-29",
            "20261009",
            "2026-10-09T00:00:00Z",
            "",
        ] {
            assert!(parse_date(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn input_json_uses_snake_case_kinds_and_rejects_unknown_fields() {
        let json = r#"{"evaluation_date":"2026-10-09","amount_lamports":5,"autonomy_limit_lamports":10,
            "documents":[{"kind":"tax_certificate","valid_from":"2026-01-01","valid_until":"2026-12-31",
            "digest_sha256":"0000000000000000000000000000000000000000000000000000000000000000"}]}"#;
        let parsed: SupplierDocsInput = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.documents[0].kind, DocumentKind::TaxCertificate);
        assert!(
            serde_json::from_str::<SupplierDocsInput>(
                &json.replace("\"documents\"", "\"extra\":1,\"documents\"")
            )
            .is_err()
        );
        assert_eq!(
            DocumentKind::EnvironmentalLicense.label(),
            "environmental license"
        );
    }
}
