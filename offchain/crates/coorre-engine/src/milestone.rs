use serde::Deserialize;
use time::Date;

use crate::documents::{
    RuleVersion, after_evaluation_date, artifact, date, date_range, decide, decimal, document_kind,
    single, typed, unknown_kind,
};
use crate::error::{EngineError, Result};
use crate::registry::ParsedArtifact;
use crate::rule::{Decision, parse_date};

pub const RULE_ID: &str = "milestone-payment";
pub const RULE_DOCUMENT_V1: &str = include_str!("../rules/milestone-payment-v1.json");
pub const RULE_DOCUMENT_V2: &str = include_str!("../rules/milestone-payment-v2.json");

pub fn rule_document(version: RuleVersion) -> &'static str {
    match version {
        RuleVersion::V1 => RULE_DOCUMENT_V1,
        RuleVersion::V2 => RULE_DOCUMENT_V2,
    }
}

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

pub fn parse(version: RuleVersion, bytes: &[u8]) -> Result<(bool, Document)> {
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
        other => Err(unknown_kind(other, RULE_ID, version.as_str())),
    }
}

pub fn parse_artifact(version: RuleVersion, bytes: &[u8]) -> Result<ParsedArtifact> {
    let (synthetic, document) = parse(version, bytes)?;
    let kind = match document {
        Document::FundingAgreement(_) => "funding_agreement",
        Document::MilestoneReport(_) => "milestone_report",
        Document::AccountabilityReport(_) => "accountability_report",
    };
    Ok(artifact(synthetic, kind))
}

pub fn evaluate(
    version: RuleVersion,
    evaluation_date: &str,
    amount_lamports: u64,
    autonomy_limit_lamports: u64,
    documents: &[&[u8]],
) -> Result<Decision> {
    let today = parse_date(evaluation_date)?;
    let (mut agreements, mut reports, mut accountability) = (Vec::new(), Vec::new(), Vec::new());
    for bytes in documents {
        match parse(version, bytes)?.1 {
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
        } else if version == RuleVersion::V2 && after_evaluation_date(r.delivered_on, today) {
            reasons.push("milestone delivered after the evaluation date".to_owned());
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
    const VERSIONS: [RuleVersion; 2] = [RuleVersion::V1, RuleVersion::V2];

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

    fn run(version: RuleVersion, values: &[Value], amount: u64, limit: u64) -> Decision {
        let files: Vec<Vec<u8>> = values.iter().map(|v| v.to_string().into_bytes()).collect();
        let refs: Vec<&[u8]> = files.iter().map(Vec::as_slice).collect();
        evaluate(version, TODAY, amount, limit, &refs).unwrap()
    }

    fn reasons(version: RuleVersion, values: &[Value]) -> Vec<String> {
        run(version, values, 20_000_000, 30_000_000)
            .reasons()
            .to_vec()
    }

    #[test]
    fn every_condition_holding_auto_approves() {
        for version in VERSIONS {
            assert_eq!(
                run(
                    version,
                    &[agreement(), report(), accountability()],
                    20_000_000,
                    30_000_000
                ),
                Decision::AutoApproved
            );
            assert_eq!(
                run(
                    version,
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
        }
    }

    #[test]
    fn v1_still_approves_a_delivery_dated_after_the_evaluation_date() {
        let later = [
            agreement(),
            with(report(), "delivered_on", "2026-12-31"),
            accountability(),
        ];
        assert_eq!(reasons(RuleVersion::V1, &later), Vec::<String>::new());
        assert_eq!(
            reasons(RuleVersion::V2, &later),
            ["milestone delivered after the evaluation date"]
        );
    }

    #[test]
    fn v2_escalates_a_delivery_dated_after_the_evaluation_date() {
        assert_eq!(
            reasons(
                RuleVersion::V2,
                &[
                    agreement(),
                    with(report(), "delivered_on", "2026-10-10"),
                    accountability()
                ]
            ),
            ["milestone delivered after the evaluation date"]
        );
    }

    #[test]
    fn v2_approves_a_delivery_on_the_evaluation_date() {
        assert_eq!(
            run(
                RuleVersion::V2,
                &[
                    agreement(),
                    with(report(), "delivered_on", TODAY),
                    accountability()
                ],
                20_000_000,
                30_000_000
            ),
            Decision::AutoApproved
        );
    }

    #[test]
    fn v2_reports_a_delivery_outside_the_window_once_even_after_the_evaluation_date() {
        assert_eq!(
            reasons(
                RuleVersion::V2,
                &[
                    agreement(),
                    with(report(), "delivered_on", "2027-01-01"),
                    accountability()
                ]
            ),
            ["milestone delivered outside the agreed window"]
        );
    }

    #[test]
    fn missing_and_duplicated_documents_skip_the_conditions_that_read_them() {
        for version in VERSIONS {
            assert_eq!(
                reasons(version, &[]),
                [
                    "funding agreement missing",
                    "milestone report missing",
                    "accountability report missing"
                ]
            );
            assert_eq!(
                reasons(
                    version,
                    &[
                        agreement(),
                        with(report(), "agreement_number", "TF-9"),
                        accountability(),
                        accountability()
                    ]
                ),
                ["accountability report submitted more than once"]
            );
        }
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
        for version in VERSIONS {
            for (documents, reason) in &cases {
                assert_eq!(reasons(version, documents), [*reason]);
            }
            assert_eq!(
                run(
                    version,
                    &[agreement(), report(), accountability()],
                    25_000_001,
                    30_000_000
                )
                .reasons(),
                ["amount exceeds the milestone amount"]
            );
        }
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
        for version in VERSIONS {
            assert_eq!(
                run(version, &documents, 40_000_000, 30_000_000).reasons(),
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
        let mut after = documents.clone();
        after[1] = with(after[1].clone(), "delivered_on", "2026-12-31");
        assert_eq!(
            run(RuleVersion::V2, &after, 40_000_000, 30_000_000).reasons(),
            [
                "agreement number differs between documents",
                "milestone differs between agreement and report",
                "milestone delivered after the evaluation date",
                "previous installments not accounted for",
                "open findings in the accountability report",
                "amount exceeds the milestone amount",
                "amount exceeds autonomy limit"
            ]
        );
    }

    #[test]
    fn mil_002_open_findings_within_the_limit_escalates_with_one_reason() {
        for version in VERSIONS {
            assert_eq!(
                reasons(
                    version,
                    &[
                        agreement(),
                        report(),
                        with(accountability(), "open_findings", "2")
                    ]
                ),
                ["open findings in the accountability report"]
            );
        }
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
        for version in VERSIONS {
            for value in &bad {
                assert!(
                    parse(version, value.to_string().as_bytes()).is_err(),
                    "{value}"
                );
                let bytes = value.to_string().into_bytes();
                assert!(evaluate(version, TODAY, 1, 1, &[bytes.as_slice()]).is_err());
            }
            assert!(evaluate(version, "09-10-2026", 1, 1, &[]).is_err());
        }
    }

    #[test]
    fn an_unknown_kind_names_the_rule_version() {
        let invoice = with(report(), "kind", "invoice").to_string();
        for version in VERSIONS {
            let error = parse(version, invoice.as_bytes()).unwrap_err().to_string();
            assert!(
                error.contains(&format!("milestone-payment v{}", version.as_str())),
                "{error}"
            );
        }
    }

    #[test]
    fn each_version_has_its_own_rule_document() {
        assert_eq!(rule_document(RuleVersion::V1), RULE_DOCUMENT_V1);
        assert_eq!(rule_document(RuleVersion::V2), RULE_DOCUMENT_V2);
        assert_ne!(RULE_DOCUMENT_V1, RULE_DOCUMENT_V2);
    }

    #[test]
    fn parse_and_parse_artifact_report_kind_and_values() {
        for version in VERSIONS {
            let (synthetic, document) =
                parse(version, accountability().to_string().as_bytes()).unwrap();
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
                    parse_artifact(version, value.to_string().as_bytes())
                        .unwrap()
                        .kind,
                    kind
                );
            }
        }
    }
}
