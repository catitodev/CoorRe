use serde::Deserialize;
use time::Date;

use crate::documents::{
    artifact, date, date_range, decide, decimal, document_kind, single, typed, unknown_kind,
};
use crate::error::Result;
use crate::registry::ParsedArtifact;
use crate::rule::{Decision, parse_date};

pub const RULE_ID: &str = "service-delivery";
pub const RULE_VERSION: &str = "1";
pub const RULE_DOCUMENT: &str = include_str!("../rules/service-delivery-v1.json");

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ContractFile {
    synthetic: bool,
    #[allow(dead_code)]
    kind: String,
    #[allow(dead_code)]
    issuer: String,
    contract_number: String,
    provider: String,
    scope: String,
    price_cap_lamports: String,
    valid_from: String,
    valid_until: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AcceptanceFile {
    synthetic: bool,
    #[allow(dead_code)]
    kind: String,
    #[allow(dead_code)]
    issuer: String,
    contract_number: String,
    deliverable: String,
    accepted_on: String,
    accepted_by: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InvoiceFile {
    synthetic: bool,
    #[allow(dead_code)]
    kind: String,
    #[allow(dead_code)]
    issuer: String,
    contract_number: String,
    provider: String,
    number: String,
    amount_lamports: String,
    issued_on: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceContract {
    pub contract_number: String,
    pub provider: String,
    pub scope: String,
    pub price_cap_lamports: u64,
    pub valid_from: Date,
    pub valid_until: Date,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcceptanceRecord {
    pub contract_number: String,
    pub deliverable: String,
    pub accepted_on: Date,
    pub accepted_by: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invoice {
    pub contract_number: String,
    pub provider: String,
    pub number: String,
    pub amount_lamports: u64,
    pub issued_on: Date,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Document {
    ServiceContract(ServiceContract),
    AcceptanceRecord(AcceptanceRecord),
    Invoice(Invoice),
}

pub fn parse(bytes: &[u8]) -> Result<(bool, Document)> {
    let (kind, value) = document_kind(bytes)?;
    match kind.as_str() {
        "service_contract" => {
            let f: ContractFile = typed(value)?;
            let (valid_from, valid_until) =
                date_range("valid_from", &f.valid_from, "valid_until", &f.valid_until)?;
            Ok((
                f.synthetic,
                Document::ServiceContract(ServiceContract {
                    contract_number: f.contract_number,
                    provider: f.provider,
                    scope: f.scope,
                    price_cap_lamports: decimal("price_cap_lamports", &f.price_cap_lamports)?,
                    valid_from,
                    valid_until,
                }),
            ))
        }
        "acceptance_record" => {
            let f: AcceptanceFile = typed(value)?;
            Ok((
                f.synthetic,
                Document::AcceptanceRecord(AcceptanceRecord {
                    contract_number: f.contract_number,
                    deliverable: f.deliverable,
                    accepted_on: date("accepted_on", &f.accepted_on)?,
                    accepted_by: f.accepted_by,
                }),
            ))
        }
        "invoice" => {
            let f: InvoiceFile = typed(value)?;
            Ok((
                f.synthetic,
                Document::Invoice(Invoice {
                    contract_number: f.contract_number,
                    provider: f.provider,
                    number: f.number,
                    amount_lamports: decimal("amount_lamports", &f.amount_lamports)?,
                    issued_on: date("issued_on", &f.issued_on)?,
                }),
            ))
        }
        other => Err(unknown_kind(other, RULE_ID, RULE_VERSION)),
    }
}

pub fn parse_artifact(bytes: &[u8]) -> Result<ParsedArtifact> {
    let (synthetic, document) = parse(bytes)?;
    let kind = match document {
        Document::ServiceContract(_) => "service_contract",
        Document::AcceptanceRecord(_) => "acceptance_record",
        Document::Invoice(_) => "invoice",
    };
    Ok(artifact(synthetic, kind))
}

pub fn evaluate(
    evaluation_date: &str,
    amount_lamports: u64,
    autonomy_limit_lamports: u64,
    documents: &[&[u8]],
) -> Result<Decision> {
    parse_date(evaluation_date)?;
    let (mut contracts, mut acceptances, mut invoices) = (Vec::new(), Vec::new(), Vec::new());
    for bytes in documents {
        match parse(bytes)?.1 {
            Document::ServiceContract(d) => contracts.push(d),
            Document::AcceptanceRecord(d) => acceptances.push(d),
            Document::Invoice(d) => invoices.push(d),
        }
    }
    let mut reasons = Vec::new();
    let contract = single(&contracts, "service contract", &mut reasons);
    let acceptance = single(&acceptances, "acceptance record", &mut reasons);
    let invoice = single(&invoices, "invoice", &mut reasons);
    if let (Some(c), Some(a), Some(i)) = (contract, acceptance, invoice)
        && (c.contract_number != a.contract_number || c.contract_number != i.contract_number)
    {
        reasons.push("contract number differs between documents".to_owned());
    }
    if let (Some(c), Some(i)) = (contract, invoice)
        && c.provider != i.provider
    {
        reasons.push("provider differs between contract and invoice".to_owned());
    }
    if let (Some(c), Some(a)) = (contract, acceptance)
        && (a.accepted_on < c.valid_from || a.accepted_on > c.valid_until)
    {
        reasons.push("acceptance outside the contract validity".to_owned());
    }
    if let (Some(a), Some(i)) = (acceptance, invoice)
        && i.issued_on < a.accepted_on
    {
        reasons.push("invoice issued before acceptance".to_owned());
    }
    if let Some(i) = invoice
        && amount_lamports != i.amount_lamports
    {
        reasons.push("amount differs from the invoice".to_owned());
    }
    if let (Some(c), Some(i)) = (contract, invoice)
        && i.amount_lamports > c.price_cap_lamports
    {
        reasons.push("invoice amount exceeds the price cap".to_owned());
    }
    Ok(decide(reasons, amount_lamports, autonomy_limit_lamports))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    const TODAY: &str = "2026-10-09";

    fn contract() -> Value {
        json!({"synthetic": true, "kind": "service_contract", "issuer": "Client", "contract_number": "CT-1",
            "provider": "Consultancy", "scope": "Report", "price_cap_lamports": "25000000",
            "valid_from": "2026-03-01", "valid_until": "2027-02-28"})
    }

    fn acceptance() -> Value {
        json!({"synthetic": true, "kind": "acceptance_record", "issuer": "Client", "contract_number": "CT-1",
            "deliverable": "Final report", "accepted_on": "2026-09-25", "accepted_by": "Manager"})
    }

    fn invoice() -> Value {
        json!({"synthetic": true, "kind": "invoice", "issuer": "Consultancy", "contract_number": "CT-1",
            "provider": "Consultancy", "number": "NF-1", "amount_lamports": "20000000",
            "issued_on": "2026-09-28"})
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
                &[contract(), acceptance(), invoice()],
                20_000_000,
                30_000_000
            ),
            Decision::AutoApproved
        );
        assert_eq!(
            run(
                &[
                    with(contract(), "price_cap_lamports", "20000000"),
                    with(acceptance(), "accepted_on", "2026-03-01"),
                    with(invoice(), "issued_on", "2026-03-01")
                ],
                20_000_000,
                20_000_000
            ),
            Decision::AutoApproved
        );
    }

    #[test]
    fn missing_and_duplicated_documents_skip_the_conditions_that_read_them() {
        assert_eq!(
            reasons(&[]),
            [
                "service contract missing",
                "acceptance record missing",
                "invoice missing"
            ]
        );
        assert_eq!(
            reasons(&[
                contract(),
                contract(),
                with(acceptance(), "contract_number", "CT-9"),
                with(invoice(), "issued_on", "2026-09-01")
            ]),
            [
                "service contract submitted more than once",
                "invoice issued before acceptance"
            ]
        );
    }

    #[test]
    fn each_condition_fails_with_its_own_reason() {
        let cases = [
            (
                [
                    contract(),
                    with(acceptance(), "contract_number", "CT-2"),
                    invoice(),
                ],
                "contract number differs between documents",
            ),
            (
                [
                    contract(),
                    acceptance(),
                    with(invoice(), "contract_number", "CT-2"),
                ],
                "contract number differs between documents",
            ),
            (
                [
                    contract(),
                    acceptance(),
                    with(invoice(), "provider", "Other"),
                ],
                "provider differs between contract and invoice",
            ),
            (
                [
                    contract(),
                    with(acceptance(), "accepted_on", "2026-02-27"),
                    with(invoice(), "issued_on", "2026-02-28"),
                ],
                "acceptance outside the contract validity",
            ),
            (
                [
                    contract(),
                    acceptance(),
                    with(invoice(), "issued_on", "2026-09-20"),
                ],
                "invoice issued before acceptance",
            ),
        ];
        for (documents, reason) in cases {
            assert_eq!(reasons(&documents), [reason]);
        }
        assert_eq!(
            run(
                &[contract(), acceptance(), invoice()],
                19_999_999,
                30_000_000
            )
            .reasons(),
            ["amount differs from the invoice"]
        );
        assert_eq!(
            run(
                &[
                    with(contract(), "price_cap_lamports", "19999999"),
                    acceptance(),
                    invoice()
                ],
                20_000_000,
                30_000_000
            )
            .reasons(),
            ["invoice amount exceeds the price cap"]
        );
    }

    #[test]
    fn reasons_follow_the_rule_order_with_the_mandate_last() {
        let documents = [
            with(contract(), "price_cap_lamports", "1000"),
            with(acceptance(), "accepted_on", "2027-03-01"),
            with(
                with(
                    with(invoice(), "contract_number", "CT-9"),
                    "provider",
                    "Other",
                ),
                "issued_on",
                "2027-01-01",
            ),
        ];
        assert_eq!(
            run(&documents, 40_000_000, 30_000_000).reasons(),
            [
                "contract number differs between documents",
                "provider differs between contract and invoice",
                "acceptance outside the contract validity",
                "invoice issued before acceptance",
                "amount differs from the invoice",
                "invoice amount exceeds the price cap",
                "amount exceeds autonomy limit"
            ]
        );
    }

    #[test]
    fn srv_002_invoice_before_acceptance_within_the_limit_escalates_with_one_reason() {
        assert_eq!(
            reasons(&[
                contract(),
                acceptance(),
                with(invoice(), "issued_on", "2026-09-20")
            ]),
            ["invoice issued before acceptance"]
        );
    }

    #[test]
    fn malformed_documents_are_errors() {
        let bad = [
            with(contract(), "price_cap_lamports", "25,000,000"),
            with(contract(), "valid_until", "2026-02-01"),
            with(acceptance(), "accepted_on", "yesterday"),
            with(invoice(), "amount_lamports", "0x10"),
            with(invoice(), "issued_on", "2026-09-28T10:00:00Z"),
            with(invoice(), "kind", "receipt"),
            {
                let mut v = invoice();
                v.as_object_mut().unwrap().remove("number");
                v
            },
        ];
        for value in bad {
            assert!(parse(value.to_string().as_bytes()).is_err(), "{value}");
            let bytes = value.to_string().into_bytes();
            assert!(evaluate(TODAY, 1, 1, &[bytes.as_slice()]).is_err());
        }
        assert!(evaluate("2026-10-9", 1, 1, &[]).is_err());
    }

    #[test]
    fn parse_and_parse_artifact_report_kind_and_values() {
        let (synthetic, document) = parse(invoice().to_string().as_bytes()).unwrap();
        assert!(synthetic);
        assert!(matches!(
            document,
            Document::Invoice(Invoice {
                amount_lamports: 20_000_000,
                ..
            })
        ));
        for (value, kind) in [
            (contract(), "service_contract"),
            (acceptance(), "acceptance_record"),
            (invoice(), "invoice"),
        ] {
            assert_eq!(
                parse_artifact(value.to_string().as_bytes()).unwrap().kind,
                kind
            );
        }
    }
}
