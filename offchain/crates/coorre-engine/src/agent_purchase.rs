use serde::Deserialize;
use time::Date;

use crate::documents::{
    artifact, date, decide, decimal, document_kind, single, typed, unknown_kind,
};
use crate::error::Result;
use crate::registry::ParsedArtifact;
use crate::rule::{Decision, parse_date};

pub const RULE_ID: &str = "agent-purchase";
pub const RULE_VERSION: &str = "1";
pub const RULE_DOCUMENT: &str = include_str!("../rules/agent-purchase-v1.json");

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PurchaseRequestFile {
    synthetic: bool,
    #[allow(dead_code)]
    kind: String,
    #[allow(dead_code)]
    issuer: String,
    request_number: String,
    item: String,
    budget_cap_lamports: String,
    needed_by: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SupplierQuoteFile {
    synthetic: bool,
    #[allow(dead_code)]
    kind: String,
    #[allow(dead_code)]
    issuer: String,
    request_number: String,
    supplier: String,
    item: String,
    amount_lamports: String,
    valid_until: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SupplierRegistrationFile {
    synthetic: bool,
    #[allow(dead_code)]
    kind: String,
    #[allow(dead_code)]
    issuer: String,
    supplier: String,
    status: String,
    valid_until: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PurchaseRequest {
    pub request_number: String,
    pub item: String,
    pub budget_cap_lamports: u64,
    pub needed_by: Date,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SupplierQuote {
    pub request_number: String,
    pub supplier: String,
    pub item: String,
    pub amount_lamports: u64,
    pub valid_until: Date,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SupplierRegistration {
    pub supplier: String,
    pub status: String,
    pub valid_until: Date,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Document {
    PurchaseRequest(PurchaseRequest),
    SupplierQuote(SupplierQuote),
    SupplierRegistration(SupplierRegistration),
}

pub fn parse(bytes: &[u8]) -> Result<(bool, Document)> {
    let (kind, value) = document_kind(bytes)?;
    match kind.as_str() {
        "purchase_request" => {
            let f: PurchaseRequestFile = typed(value)?;
            Ok((
                f.synthetic,
                Document::PurchaseRequest(PurchaseRequest {
                    request_number: f.request_number,
                    item: f.item,
                    budget_cap_lamports: decimal("budget_cap_lamports", &f.budget_cap_lamports)?,
                    needed_by: date("needed_by", &f.needed_by)?,
                }),
            ))
        }
        "supplier_quote" => {
            let f: SupplierQuoteFile = typed(value)?;
            Ok((
                f.synthetic,
                Document::SupplierQuote(SupplierQuote {
                    request_number: f.request_number,
                    supplier: f.supplier,
                    item: f.item,
                    amount_lamports: decimal("amount_lamports", &f.amount_lamports)?,
                    valid_until: date("valid_until", &f.valid_until)?,
                }),
            ))
        }
        "supplier_registration" => {
            let f: SupplierRegistrationFile = typed(value)?;
            Ok((
                f.synthetic,
                Document::SupplierRegistration(SupplierRegistration {
                    supplier: f.supplier,
                    status: f.status,
                    valid_until: date("valid_until", &f.valid_until)?,
                }),
            ))
        }
        other => Err(unknown_kind(other, RULE_ID, RULE_VERSION)),
    }
}

pub fn parse_artifact(bytes: &[u8]) -> Result<ParsedArtifact> {
    let (synthetic, document) = parse(bytes)?;
    let kind = match document {
        Document::PurchaseRequest(_) => "purchase_request",
        Document::SupplierQuote(_) => "supplier_quote",
        Document::SupplierRegistration(_) => "supplier_registration",
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
    let (mut requests, mut quotes, mut registrations) = (Vec::new(), Vec::new(), Vec::new());
    for bytes in documents {
        match parse(bytes)?.1 {
            Document::PurchaseRequest(d) => requests.push(d),
            Document::SupplierQuote(d) => quotes.push(d),
            Document::SupplierRegistration(d) => registrations.push(d),
        }
    }
    let mut reasons = Vec::new();
    let request = single(&requests, "purchase request", &mut reasons);
    let quote = single(&quotes, "supplier quote", &mut reasons);
    let registration = single(&registrations, "supplier registration", &mut reasons);
    if let (Some(r), Some(q)) = (request, quote) {
        if r.request_number != q.request_number {
            reasons.push("request number differs between request and quote".to_owned());
        }
        if r.item != q.item {
            reasons.push("item differs between request and quote".to_owned());
        }
    }
    if let (Some(q), Some(s)) = (quote, registration)
        && q.supplier != s.supplier
    {
        reasons.push("supplier differs between quote and registration".to_owned());
    }
    if let Some(s) = registration {
        if s.status != "approved" {
            reasons.push("supplier registration not approved".to_owned());
        }
        if s.valid_until < today {
            reasons.push("supplier registration expired".to_owned());
        }
    }
    if let Some(q) = quote {
        if q.valid_until < today {
            reasons.push("supplier quote expired".to_owned());
        }
        if amount_lamports != q.amount_lamports {
            reasons.push("amount differs from the quote".to_owned());
        }
    }
    if let Some(r) = request
        && amount_lamports > r.budget_cap_lamports
    {
        reasons.push("amount exceeds the budget cap".to_owned());
    }
    Ok(decide(reasons, amount_lamports, autonomy_limit_lamports))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    const TODAY: &str = "2026-10-09";

    fn request() -> Value {
        json!({"synthetic": true, "kind": "purchase_request", "issuer": "Buyer", "request_number": "PR-1",
            "item": "Kit", "budget_cap_lamports": "25000000", "needed_by": "2026-11-30"})
    }

    fn quote() -> Value {
        json!({"synthetic": true, "kind": "supplier_quote", "issuer": "Supplier", "request_number": "PR-1",
            "supplier": "Supplier", "item": "Kit", "amount_lamports": "20000000", "valid_until": "2026-12-31"})
    }

    fn registration() -> Value {
        json!({"synthetic": true, "kind": "supplier_registration", "issuer": "Registry", "supplier": "Supplier",
            "status": "approved", "valid_until": "2027-06-30"})
    }

    fn bytes(values: &[Value]) -> Vec<Vec<u8>> {
        values.iter().map(|v| v.to_string().into_bytes()).collect()
    }

    fn run(values: &[Value], amount: u64, limit: u64) -> Decision {
        let files = bytes(values);
        let refs: Vec<&[u8]> = files.iter().map(Vec::as_slice).collect();
        evaluate(TODAY, amount, limit, &refs).unwrap()
    }

    fn with(mut value: Value, field: &str, text: &str) -> Value {
        value[field] = json!(text);
        value
    }

    fn reasons(values: &[Value]) -> Vec<String> {
        run(values, 20_000_000, 30_000_000).reasons().to_vec()
    }

    #[test]
    fn every_condition_holding_auto_approves() {
        assert_eq!(
            run(
                &[request(), quote(), registration()],
                20_000_000,
                30_000_000
            ),
            Decision::AutoApproved
        );
        assert_eq!(
            run(
                &[registration(), request(), quote()],
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
                "purchase request missing",
                "supplier quote missing",
                "supplier registration missing"
            ]
        );
        assert_eq!(
            reasons(&[
                request(),
                quote(),
                quote(),
                with(registration(), "status", "suspended")
            ]),
            [
                "supplier quote submitted more than once",
                "supplier registration not approved"
            ]
        );
    }

    #[test]
    fn each_condition_fails_with_its_own_reason() {
        let cases = [
            (
                [
                    request(),
                    with(quote(), "request_number", "PR-2"),
                    registration(),
                ],
                "request number differs between request and quote",
            ),
            (
                [request(), with(quote(), "item", "Other"), registration()],
                "item differs between request and quote",
            ),
            (
                [
                    request(),
                    quote(),
                    with(registration(), "supplier", "Other"),
                ],
                "supplier differs between quote and registration",
            ),
            (
                [
                    request(),
                    quote(),
                    with(registration(), "status", "pending"),
                ],
                "supplier registration not approved",
            ),
            (
                [
                    request(),
                    quote(),
                    with(registration(), "valid_until", "2026-10-08"),
                ],
                "supplier registration expired",
            ),
            (
                [
                    request(),
                    with(quote(), "valid_until", "2026-10-08"),
                    registration(),
                ],
                "supplier quote expired",
            ),
        ];
        for (documents, reason) in cases {
            assert_eq!(reasons(&documents), [reason]);
        }
        assert_eq!(
            run(
                &[request(), quote(), registration()],
                19_000_000,
                30_000_000
            )
            .reasons(),
            ["amount differs from the quote"]
        );
        assert_eq!(
            run(
                &[
                    with(request(), "budget_cap_lamports", "19000000"),
                    quote(),
                    registration()
                ],
                20_000_000,
                30_000_000
            )
            .reasons(),
            ["amount exceeds the budget cap"]
        );
    }

    #[test]
    fn validity_boundaries_are_inclusive() {
        assert_eq!(
            run(
                &[
                    request(),
                    with(quote(), "valid_until", TODAY),
                    with(registration(), "valid_until", TODAY)
                ],
                20_000_000,
                30_000_000
            ),
            Decision::AutoApproved
        );
        assert_eq!(
            run(
                &[
                    with(request(), "budget_cap_lamports", "20000000"),
                    quote(),
                    registration()
                ],
                20_000_000,
                30_000_000
            ),
            Decision::AutoApproved
        );
    }

    #[test]
    fn reasons_follow_the_rule_order_with_the_mandate_last() {
        let documents = [
            with(request(), "budget_cap_lamports", "1000"),
            with(
                with(
                    with(with(quote(), "request_number", "PR-9"), "item", "Other"),
                    "valid_until",
                    "2026-01-01",
                ),
                "supplier",
                "Other",
            ),
            with(
                with(registration(), "status", "revoked"),
                "valid_until",
                "2026-01-01",
            ),
        ];
        assert_eq!(
            run(&documents, 40_000_000, 30_000_000).reasons(),
            [
                "request number differs between request and quote",
                "item differs between request and quote",
                "supplier differs between quote and registration",
                "supplier registration not approved",
                "supplier registration expired",
                "supplier quote expired",
                "amount differs from the quote",
                "amount exceeds the budget cap",
                "amount exceeds autonomy limit"
            ]
        );
    }

    #[test]
    fn agt_002_expired_registration_above_the_limit_escalates_with_two_reasons() {
        let documents = [
            with(request(), "budget_cap_lamports", "50000000"),
            with(quote(), "amount_lamports", "40000000"),
            with(registration(), "valid_until", "2026-09-30"),
        ];
        assert_eq!(
            run(&documents, 40_000_000, 30_000_000).reasons(),
            [
                "supplier registration expired",
                "amount exceeds autonomy limit"
            ]
        );
    }

    #[test]
    fn malformed_documents_are_errors() {
        let bad = [
            with(request(), "budget_cap_lamports", "25.0"),
            with(request(), "needed_by", "30/11/2026"),
            with(quote(), "amount_lamports", "020000000"),
            with(registration(), "valid_until", "2027-02-30"),
            with(registration(), "kind", "tax_certificate"),
            {
                let mut v = quote();
                v["extra"] = json!("x");
                v
            },
            {
                let mut v = registration();
                v.as_object_mut().unwrap().remove("issuer");
                v
            },
        ];
        for value in bad {
            assert!(parse(value.to_string().as_bytes()).is_err(), "{value}");
            let files = bytes(&[value]);
            assert!(evaluate(TODAY, 1, 1, &[files[0].as_slice()]).is_err());
        }
        assert!(evaluate("2026-13-01", 1, 1, &[]).is_err());
    }

    #[test]
    fn parse_and_parse_artifact_report_kind_and_synthetic_flag() {
        let (synthetic, document) = parse(request().to_string().as_bytes()).unwrap();
        assert!(synthetic);
        assert!(matches!(
            document,
            Document::PurchaseRequest(PurchaseRequest {
                budget_cap_lamports: 25_000_000,
                ..
            })
        ));
        let real = with(registration(), "issuer", "Registry");
        let mut real = real;
        real["synthetic"] = json!(false);
        let parsed = parse_artifact(real.to_string().as_bytes()).unwrap();
        assert!(!parsed.synthetic);
        assert_eq!(parsed.kind, "supplier_registration");
        assert_eq!(
            parse_artifact(quote().to_string().as_bytes()).unwrap().kind,
            "supplier_quote"
        );
    }
}
