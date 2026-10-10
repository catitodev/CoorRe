use serde::Deserialize;
use time::Date;

use crate::documents::{
    artifact, date, date_range, decide, decimal, document_kind, single, typed, unknown_kind,
};
use crate::error::Result;
use crate::registry::ParsedArtifact;
use crate::rule::{Decision, parse_date};

pub const RULE_ID: &str = "ecosystem-services-payment";
pub const RULE_VERSION: &str = "1";
pub const RULE_DOCUMENT: &str = include_str!("../rules/ecosystem-services-payment-v1.json");

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ContractFile {
    synthetic: bool,
    #[allow(dead_code)]
    kind: String,
    #[allow(dead_code)]
    issuer: String,
    contract_number: String,
    registry_reference: String,
    committed_area_m2: String,
    valid_from: String,
    valid_until: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MonitoringFile {
    synthetic: bool,
    #[allow(dead_code)]
    kind: String,
    #[allow(dead_code)]
    issuer: String,
    contract_number: String,
    period_from: String,
    period_to: String,
    verified_area_m2: String,
    method: String,
    observed_on: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Contract {
    pub contract_number: String,
    pub registry_reference: String,
    pub committed_area_m2: u64,
    pub valid_from: Date,
    pub valid_until: Date,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MonitoringReport {
    pub contract_number: String,
    pub period_from: Date,
    pub period_to: Date,
    pub verified_area_m2: u64,
    pub method: String,
    pub observed_on: Date,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Document {
    Contract(Contract),
    MonitoringReport(MonitoringReport),
}

pub fn parse(bytes: &[u8]) -> Result<(bool, Document)> {
    let (kind, value) = document_kind(bytes)?;
    match kind.as_str() {
        "pes_contract" => {
            let f: ContractFile = typed(value)?;
            let (valid_from, valid_until) =
                date_range("valid_from", &f.valid_from, "valid_until", &f.valid_until)?;
            Ok((
                f.synthetic,
                Document::Contract(Contract {
                    contract_number: f.contract_number,
                    registry_reference: f.registry_reference,
                    committed_area_m2: decimal("committed_area_m2", &f.committed_area_m2)?,
                    valid_from,
                    valid_until,
                }),
            ))
        }
        "monitoring_report" => {
            let f: MonitoringFile = typed(value)?;
            let (period_from, period_to) =
                date_range("period_from", &f.period_from, "period_to", &f.period_to)?;
            Ok((
                f.synthetic,
                Document::MonitoringReport(MonitoringReport {
                    contract_number: f.contract_number,
                    period_from,
                    period_to,
                    verified_area_m2: decimal("verified_area_m2", &f.verified_area_m2)?,
                    method: f.method,
                    observed_on: date("observed_on", &f.observed_on)?,
                }),
            ))
        }
        other => Err(unknown_kind(other, RULE_ID, RULE_VERSION)),
    }
}

pub fn parse_artifact(bytes: &[u8]) -> Result<ParsedArtifact> {
    let (synthetic, document) = parse(bytes)?;
    let kind = match document {
        Document::Contract(_) => "pes_contract",
        Document::MonitoringReport(_) => "monitoring_report",
    };
    Ok(artifact(synthetic, kind))
}

pub fn evaluate(
    evaluation_date: &str,
    amount_lamports: u64,
    autonomy_limit_lamports: u64,
    documents: &[&[u8]],
) -> Result<Decision> {
    let today = parse_date(evaluation_date)?;
    let (mut contracts, mut reports) = (Vec::new(), Vec::new());
    for bytes in documents {
        match parse(bytes)?.1 {
            Document::Contract(d) => contracts.push(d),
            Document::MonitoringReport(d) => reports.push(d),
        }
    }
    let mut reasons = Vec::new();
    let contract = single(&contracts, "ecosystem services contract", &mut reasons);
    let report = single(&reports, "monitoring report", &mut reasons);
    if let (Some(c), Some(r)) = (contract, report)
        && c.contract_number != r.contract_number
    {
        reasons.push("contract number differs between contract and monitoring report".to_owned());
    }
    if let Some(c) = contract {
        if today < c.valid_from {
            reasons.push("ecosystem services contract not yet valid".to_owned());
        } else if today > c.valid_until {
            reasons.push("ecosystem services contract expired".to_owned());
        }
    }
    if let (Some(c), Some(r)) = (contract, report) {
        if r.observed_on < c.valid_from || r.observed_on > c.valid_until {
            reasons.push("monitoring observed outside the contract validity".to_owned());
        } else if r.observed_on > today {
            reasons.push("monitoring observed after the evaluation date".to_owned());
        }
        if r.verified_area_m2 < c.committed_area_m2 {
            reasons.push("verified area below committed area".to_owned());
        }
    }
    Ok(decide(reasons, amount_lamports, autonomy_limit_lamports))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    const TODAY: &str = "2026-10-09";

    fn contract() -> Value {
        json!({"synthetic": true, "kind": "pes_contract", "issuer": "Program", "contract_number": "PSA-1",
            "registry_reference": "SYN-REG-1", "committed_area_m2": "120000",
            "valid_from": "2026-01-01", "valid_until": "2027-12-31"})
    }

    fn report() -> Value {
        json!({"synthetic": true, "kind": "monitoring_report", "issuer": "Monitor", "contract_number": "PSA-1",
            "period_from": "2026-04-01", "period_to": "2026-09-30", "verified_area_m2": "124500",
            "method": "field survey", "observed_on": "2026-09-15"})
    }

    fn with(mut value: Value, field: &str, text: &str) -> Value {
        value[field] = json!(text);
        value
    }

    fn run(values: &[Value], amount: u64, limit: u64) -> Decision {
        let files: Vec<Vec<u8>> = values.iter().map(|v| v.to_string().into_bytes()).collect();
        let refs: Vec<&[u8]> = files.iter().map(Vec::as_slice).collect();
        evaluate(TODAY, amount, limit, &refs).unwrap()
    }

    fn reasons(values: &[Value]) -> Vec<String> {
        run(values, 20_000_000, 30_000_000).reasons().to_vec()
    }

    #[test]
    fn every_condition_holding_auto_approves() {
        assert_eq!(
            run(&[contract(), report()], 20_000_000, 30_000_000),
            Decision::AutoApproved
        );
        assert_eq!(
            run(
                &[
                    with(contract(), "valid_until", TODAY),
                    with(
                        with(report(), "observed_on", TODAY),
                        "verified_area_m2",
                        "120000"
                    )
                ],
                30_000_000,
                30_000_000
            ),
            Decision::AutoApproved
        );
    }

    #[test]
    fn missing_and_duplicated_documents_skip_the_conditions_that_read_them() {
        assert_eq!(
            reasons(&[]),
            [
                "ecosystem services contract missing",
                "monitoring report missing"
            ]
        );
        assert_eq!(
            reasons(&[
                with(contract(), "valid_until", "2026-06-30"),
                report(),
                report()
            ]),
            [
                "monitoring report submitted more than once",
                "ecosystem services contract expired"
            ]
        );
    }

    #[test]
    fn each_condition_fails_with_its_own_reason() {
        let cases = [
            (
                [contract(), with(report(), "contract_number", "PSA-2")],
                "contract number differs between contract and monitoring report",
            ),
            (
                [
                    with(contract(), "valid_until", "2026-10-08"),
                    with(report(), "observed_on", "2026-10-01"),
                ],
                "ecosystem services contract expired",
            ),
            (
                [contract(), with(report(), "observed_on", "2025-12-31")],
                "monitoring observed outside the contract validity",
            ),
            (
                [contract(), with(report(), "observed_on", "2026-10-10")],
                "monitoring observed after the evaluation date",
            ),
            (
                [contract(), with(report(), "verified_area_m2", "119999")],
                "verified area below committed area",
            ),
        ];
        for (documents, reason) in cases {
            assert_eq!(reasons(&documents), [reason]);
        }
    }

    #[test]
    fn not_yet_valid_contract_also_flags_an_observation_before_its_start() {
        assert_eq!(
            reasons(&[with(contract(), "valid_from", "2026-10-10"), report()]),
            [
                "ecosystem services contract not yet valid",
                "monitoring observed outside the contract validity"
            ]
        );
    }

    #[test]
    fn reasons_follow_the_rule_order_with_the_mandate_last() {
        let documents = [
            with(contract(), "valid_until", "2026-09-30"),
            with(
                with(
                    with(report(), "contract_number", "PSA-9"),
                    "observed_on",
                    "2026-10-05",
                ),
                "verified_area_m2",
                "1",
            ),
        ];
        assert_eq!(
            run(&documents, 40_000_000, 30_000_000).reasons(),
            [
                "contract number differs between contract and monitoring report",
                "ecosystem services contract expired",
                "monitoring observed outside the contract validity",
                "verified area below committed area",
                "amount exceeds autonomy limit"
            ]
        );
    }

    #[test]
    fn pes_002_verified_area_below_committed_above_the_limit_escalates_with_two_reasons() {
        let documents = [
            with(contract(), "committed_area_m2", "150000"),
            with(report(), "verified_area_m2", "118000"),
        ];
        assert_eq!(
            run(&documents, 40_000_000, 30_000_000).reasons(),
            [
                "verified area below committed area",
                "amount exceeds autonomy limit"
            ]
        );
    }

    #[test]
    fn malformed_documents_are_errors() {
        let bad = [
            with(contract(), "committed_area_m2", "120000.5"),
            with(contract(), "valid_from", "2028-01-01"),
            with(report(), "period_to", "2026-03-01"),
            with(report(), "observed_on", "15/09/2026"),
            with(report(), "verified_area_m2", "-1"),
            with(report(), "kind", "invoice"),
            {
                let mut v = contract();
                v.as_object_mut().unwrap().remove("registry_reference");
                v
            },
        ];
        for value in bad {
            assert!(parse(value.to_string().as_bytes()).is_err(), "{value}");
            let bytes = value.to_string().into_bytes();
            assert!(evaluate(TODAY, 1, 1, &[bytes.as_slice()]).is_err());
        }
        assert!(evaluate("2026-02-30", 1, 1, &[]).is_err());
    }

    #[test]
    fn parse_and_parse_artifact_report_kind_and_values() {
        let (synthetic, document) = parse(contract().to_string().as_bytes()).unwrap();
        assert!(synthetic);
        assert!(matches!(
            document,
            Document::Contract(Contract {
                committed_area_m2: 120_000,
                ..
            })
        ));
        let parsed = parse_artifact(report().to_string().as_bytes()).unwrap();
        assert_eq!(parsed.kind, "monitoring_report");
        assert!(parsed.synthetic);
        assert_eq!(
            parse_artifact(contract().to_string().as_bytes())
                .unwrap()
                .kind,
            "pes_contract"
        );
    }
}
