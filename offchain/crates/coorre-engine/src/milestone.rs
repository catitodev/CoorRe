use serde::Deserialize;
use time::Date;

use crate::documents::{
    artifact, date, date_range, decide, decimal, document_kind, single, typed, unknown_kind,
};
use crate::error::{EngineError, Result};
use crate::registry::ParsedArtifact;
use crate::rule::Decision;

pub const RULE_ID: &str = "milestone-payment";
pub const RULE_VERSION: &str = "1";
pub const RULE_DOCUMENT: &str = include_str!("../rules/milestone-payment-v1.json");

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AgreementFile {
    synthetic: bool,
    #[allow(dead_code)]
    kind: String,
    #[allow(dead_code)]
    issuer: String,
    agreement_number: String,
    milestone_id: String,
    milestone_amount_lamports: String,
    window_from: String,
    window_until: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MilestoneReportFile {
    synthetic: bool,
    #[allow(dead_code)]
    kind: String,
    #[allow(dead_code)]
    issuer: String,
    agreement_number: String,
    milestone_id: String,
    delivered_on: String,
    summary: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AccountabilityFile {
    synthetic: bool,
    #[allow(dead_code)]
    kind: String,
    #[allow(dead_code)]
    issuer: String,
    agreement_number: String,
    previous_installments_accounted: String,
    open_findings: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FundingAgreement {
    pub agreement_number: String,
    pub milestone_id: String,
    pub milestone_amount_lamports: u64,
    pub window_from: Date,
    pub window_until: Date,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MilestoneReport {
    pub agreement_number: String,
    pub milestone_id: String,
    pub delivered_on: Date,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountabilityReport {
    pub agreement_number: String,
    pub previous_installments_accounted: bool,
    pub open_findings: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Document {
    FundingAgreement(FundingAgreement),
    MilestoneReport(MilestoneReport),
    AccountabilityReport(AccountabilityReport),
}

fn flag(field: &str, text: &str) -> Result<bool> {
    match text {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err(EngineError::InvalidRuleInput(format!(
            "{field}: `{text}` is not \"true\" or \"false\""
        ))),
    }
}

pub fn parse(bytes: &[u8]) -> Result<(bool, Document)> {
    let (kind, value) = document_kind(bytes)?;
    match kind.as_str() {
        "funding_agreement" => {
            let f: AgreementFile = typed(value)?;
            let (window_from, window_until) = date_range(
                "window_from",
                &f.window_from,
                "window_until",
                &f.window_until,
            )?;
            Ok((
                f.synthetic,
                Document::FundingAgreement(FundingAgreement {
                    agreement_number: f.agreement_number,
                    milestone_id: f.milestone_id,
                    milestone_amount_lamports: decimal(
                        "milestone_amount_lamports",
                        &f.milestone_amount_lamports,
                    )?,
                    window_from,
                    window_until,
                }),
            ))
        }
        "milestone_report" => {
            let f: MilestoneReportFile = typed(value)?;
            Ok((
                f.synthetic,
                Document::MilestoneReport(MilestoneReport {
                    agreement_number: f.agreement_number,
                    milestone_id: f.milestone_id,
                    delivered_on: date("delivered_on", &f.delivered_on)?,
                    summary: f.summary,
                }),
            ))
        }
        "accountability_report" => {
            let f: AccountabilityFile = typed(value)?;
            Ok((
                f.synthetic,
                Document::AccountabilityReport(AccountabilityReport {
                    agreement_number: f.agreement_number,
                    previous_installments_accounted: flag(
                        "previous_installments_accounted",
                        &f.previous_installments_accounted,
                    )?,
                    open_findings: decimal("open_findings", &f.open_findings)?,
                }),
            ))
        }
        other => Err(unknown_kind(other, RULE_ID, RULE_VERSION)),
    }
}

pub fn parse_artifact(bytes: &[u8]) -> Result<ParsedArtifact> {
    let (synthetic, document) = parse(bytes)?;
    let kind = match document {
        Document::FundingAgreement(_) => "funding_agreement",
        Document::MilestoneReport(_) => "milestone_report",
        Document::AccountabilityReport(_) => "accountability_report",
    };
    Ok(artifact(synthetic, kind))
}

pub fn evaluate(
    evaluation_date: &str,
    amount_lamports: u64,
    autonomy_limit_lamports: u64,
    documents: &[&[u8]],
) -> Result<Decision> {
    crate::rule::parse_date(evaluation_date)?;
    let (mut agreements, mut reports, mut accountability) = (Vec::new(), Vec::new(), Vec::new());
    for bytes in documents {
        match parse(bytes)?.1 {
            Document::FundingAgreement(d) => agreements.push(d),
            Document::MilestoneReport(d) => reports.push(d),
            Document::AccountabilityReport(d) => accountability.push(d),
        }
    }
    let mut reasons = Vec::new();
    let agreement = single(&agreements, "funding agreement", &mut reasons);
    let report = single(&reports, "milestone report", &mut reasons);
    let accounts = single(&accountability, "accountability report", &mut reasons);
    if let (Some(a), Some(r), Some(c)) = (agreement, report, accounts)
        && (a.agreement_number != r.agreement_number || a.agreement_number != c.agreement_number)
    {
        reasons.push("agreement number differs between documents".to_owned());
    }
    if let (Some(a), Some(r)) = (agreement, report) {
        if a.milestone_id != r.milestone_id {
            reasons.push("milestone differs between agreement and report".to_owned());
        }
        if r.delivered_on < a.window_from || r.delivered_on > a.window_until {
            reasons.push("milestone delivered outside the agreed window".to_owned());
        }
    }
    if let Some(c) = accounts {
        if !c.previous_installments_accounted {
            reasons.push("previous installments not accounted for".to_owned());
        }
        if c.open_findings != 0 {
            reasons.push("open findings in the accountability report".to_owned());
        }
    }
    if let Some(a) = agreement
        && amount_lamports > a.milestone_amount_lamports
    {
        reasons.push("amount exceeds the milestone amount".to_owned());
    }
    Ok(decide(reasons, amount_lamports, autonomy_limit_lamports))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    const TODAY: &str = "2026-10-09";

    fn agreement() -> Value {
        json!({"synthetic": true, "kind": "funding_agreement", "issuer": "Fund", "agreement_number": "TF-1",
            "milestone_id": "M2", "milestone_amount_lamports": "25000000",
            "window_from": "2026-07-01", "window_until": "2026-12-31"})
    }

    fn report() -> Value {
        json!({"synthetic": true, "kind": "milestone_report", "issuer": "Grantee", "agreement_number": "TF-1",
            "milestone_id": "M2", "delivered_on": "2026-09-20", "summary": "Delivered"})
    }

    fn accountability() -> Value {
        json!({"synthetic": true, "kind": "accountability_report", "issuer": "Fund", "agreement_number": "TF-1",
            "previous_installments_accounted": "true", "open_findings": "0"})
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
            run(
                &[agreement(), report(), accountability()],
                20_000_000,
                30_000_000
            ),
            Decision::AutoApproved
        );
        assert_eq!(
            run(
                &[
                    agreement(),
                    with(report(), "delivered_on", "2026-07-01"),
                    accountability()
                ],
                25_000_000,
                25_000_000
            ),
            Decision::AutoApproved
        );
        assert_eq!(
            reasons(&[
                agreement(),
                with(report(), "delivered_on", "2026-12-31"),
                accountability()
            ]),
            Vec::<String>::new()
        );
    }

    #[test]
    fn missing_and_duplicated_documents_skip_the_conditions_that_read_them() {
        assert_eq!(
            reasons(&[]),
            [
                "funding agreement missing",
                "milestone report missing",
                "accountability report missing"
            ]
        );
        assert_eq!(
            reasons(&[
                agreement(),
                with(report(), "agreement_number", "TF-9"),
                accountability(),
                accountability()
            ]),
            ["accountability report submitted more than once"]
        );
    }

    #[test]
    fn each_condition_fails_with_its_own_reason() {
        let cases = [
            (
                [
                    agreement(),
                    with(report(), "agreement_number", "TF-2"),
                    accountability(),
                ],
                "agreement number differs between documents",
            ),
            (
                [
                    agreement(),
                    report(),
                    with(accountability(), "agreement_number", "TF-2"),
                ],
                "agreement number differs between documents",
            ),
            (
                [
                    agreement(),
                    with(report(), "milestone_id", "M3"),
                    accountability(),
                ],
                "milestone differs between agreement and report",
            ),
            (
                [
                    agreement(),
                    with(report(), "delivered_on", "2026-06-30"),
                    accountability(),
                ],
                "milestone delivered outside the agreed window",
            ),
            (
                [
                    agreement(),
                    report(),
                    with(accountability(), "previous_installments_accounted", "false"),
                ],
                "previous installments not accounted for",
            ),
            (
                [
                    agreement(),
                    report(),
                    with(accountability(), "open_findings", "2"),
                ],
                "open findings in the accountability report",
            ),
        ];
        for (documents, reason) in cases {
            assert_eq!(reasons(&documents), [reason]);
        }
        assert_eq!(
            run(
                &[agreement(), report(), accountability()],
                25_000_001,
                30_000_000
            )
            .reasons(),
            ["amount exceeds the milestone amount"]
        );
    }

    #[test]
    fn reasons_follow_the_rule_order_with_the_mandate_last() {
        let documents = [
            with(agreement(), "milestone_amount_lamports", "1000"),
            with(
                with(
                    with(report(), "agreement_number", "TF-9"),
                    "milestone_id",
                    "M9",
                ),
                "delivered_on",
                "2027-01-01",
            ),
            with(
                with(accountability(), "previous_installments_accounted", "false"),
                "open_findings",
                "3",
            ),
        ];
        assert_eq!(
            run(&documents, 40_000_000, 30_000_000).reasons(),
            [
                "agreement number differs between documents",
                "milestone differs between agreement and report",
                "milestone delivered outside the agreed window",
                "previous installments not accounted for",
                "open findings in the accountability report",
                "amount exceeds the milestone amount",
                "amount exceeds autonomy limit"
            ]
        );
    }

    #[test]
    fn mil_002_open_findings_within_the_limit_escalates_with_one_reason() {
        assert_eq!(
            reasons(&[
                agreement(),
                report(),
                with(accountability(), "open_findings", "2")
            ]),
            ["open findings in the accountability report"]
        );
    }

    #[test]
    fn malformed_documents_are_errors() {
        let bad = [
            with(agreement(), "milestone_amount_lamports", "2.5e7"),
            with(agreement(), "window_from", "2027-01-01"),
            with(report(), "delivered_on", "2026-9-20"),
            with(accountability(), "previous_installments_accounted", "yes"),
            with(accountability(), "open_findings", "none"),
            with(accountability(), "open_findings", "00"),
            with(report(), "kind", "pes_contract"),
            {
                let mut v = report();
                v["note"] = json!("x");
                v
            },
        ];
        for value in bad {
            assert!(parse(value.to_string().as_bytes()).is_err(), "{value}");
            let bytes = value.to_string().into_bytes();
            assert!(evaluate(TODAY, 1, 1, &[bytes.as_slice()]).is_err());
        }
        assert!(evaluate("09-10-2026", 1, 1, &[]).is_err());
    }

    #[test]
    fn parse_and_parse_artifact_report_kind_and_values() {
        let (synthetic, document) = parse(accountability().to_string().as_bytes()).unwrap();
        assert!(synthetic);
        assert_eq!(
            document,
            Document::AccountabilityReport(AccountabilityReport {
                agreement_number: "TF-1".to_owned(),
                previous_installments_accounted: true,
                open_findings: 0,
            })
        );
        for (value, kind) in [
            (agreement(), "funding_agreement"),
            (report(), "milestone_report"),
            (accountability(), "accountability_report"),
        ] {
            assert_eq!(
                parse_artifact(value.to_string().as_bytes()).unwrap().kind,
                kind
            );
        }
    }
}
