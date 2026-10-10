use coorre_model::evidence::parse_lamports;
use coorre_model::jcs;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};
use time::Date;

use crate::error::{EngineError, Result};
use crate::registry::ParsedArtifact;
use crate::rule::{Decision, parse_date};

pub const MANDATE_REASON: &str = "amount exceeds autonomy limit";

fn invalid(message: String) -> EngineError {
    EngineError::InvalidRuleInput(message)
}

pub fn document_kind(bytes: &[u8]) -> Result<(String, Value)> {
    let text =
        std::str::from_utf8(bytes).map_err(|_| invalid("document is not UTF-8".to_owned()))?;
    let value = jcs::parse(text).map_err(|e| invalid(e.to_string()))?;
    let kind = value
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("document has no kind".to_owned()))?
        .to_owned();
    Ok((kind, value))
}

pub fn typed<T: DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|e| invalid(format!("document format: {e}")))
}

pub fn decimal(field: &str, text: &str) -> Result<u64> {
    parse_lamports(text).map_err(|e| invalid(format!("{field}: {e}")))
}

pub fn date(field: &str, text: &str) -> Result<Date> {
    parse_date(text).map_err(|e| invalid(format!("{field}: {e}")))
}

pub fn date_range(
    from_field: &str,
    from: &str,
    until_field: &str,
    until: &str,
) -> Result<(Date, Date)> {
    let start = date(from_field, from)?;
    let end = date(until_field, until)?;
    if start > end {
        return Err(invalid(format!("{from_field} is after {until_field}")));
    }
    Ok((start, end))
}

pub fn unknown_kind(kind: &str, rule_id: &str, rule_version: &str) -> EngineError {
    invalid(format!(
        "document kind `{kind}` is not used by {rule_id} v{rule_version}"
    ))
}

pub fn artifact(synthetic: bool, kind: &str) -> ParsedArtifact {
    let mut summary = Map::new();
    summary.insert("kind".to_owned(), Value::String(kind.to_owned()));
    ParsedArtifact {
        synthetic,
        kind: kind.to_owned(),
        summary,
    }
}

pub fn single<'a, T>(items: &'a [T], label: &str, reasons: &mut Vec<String>) -> Option<&'a T> {
    match items {
        [item] => Some(item),
        [] => {
            reasons.push(format!("{label} missing"));
            None
        }
        _ => {
            reasons.push(format!("{label} submitted more than once"));
            None
        }
    }
}

pub fn decide(
    mut reasons: Vec<String>,
    amount_lamports: u64,
    autonomy_limit_lamports: u64,
) -> Decision {
    if amount_lamports > autonomy_limit_lamports {
        reasons.push(MANDATE_REASON.to_owned());
    }
    if reasons.is_empty() {
        Decision::AutoApproved
    } else {
        Decision::Escalated { reasons }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn document_kind_reads_strict_json_with_a_kind() {
        let (kind, value) = document_kind(br#"{"kind":"invoice","n":"1"}"#).unwrap();
        assert_eq!(kind, "invoice");
        assert_eq!(value["n"], "1");
        assert!(document_kind(b"{}").is_err());
        assert!(document_kind(br#"{"kind":1}"#).is_err());
        assert!(document_kind(&[0xff]).is_err());
        assert!(document_kind(br#"{"kind":"a","kind":"b"}"#).is_err());
    }

    #[test]
    fn typed_rejects_unknown_fields() {
        #[derive(serde::Deserialize, Debug)]
        #[serde(deny_unknown_fields)]
        struct Only {
            #[allow(dead_code)]
            a: String,
        }
        assert!(typed::<Only>(serde_json::json!({"a": "x"})).is_ok());
        let error = typed::<Only>(serde_json::json!({"a": "x", "b": "y"})).unwrap_err();
        assert!(matches!(error, EngineError::InvalidRuleInput(_)));
    }

    #[test]
    fn decimals_and_dates_are_strict_and_name_the_field() {
        assert_eq!(decimal("amount_lamports", "20000000").unwrap(), 20_000_000);
        for bad in ["", "01", "1.5", "-1", " 1", "99999999999999999999"] {
            let error = decimal("amount_lamports", bad).unwrap_err().to_string();
            assert!(error.contains("amount_lamports"), "{error}");
        }
        assert_eq!(
            date("issued_on", "2026-10-09").unwrap().to_string(),
            "2026-10-09"
        );
        assert!(
            date("issued_on", "2026-10-32")
                .unwrap_err()
                .to_string()
                .contains("issued_on")
        );
        assert!(date_range("valid_from", "2026-01-01", "valid_until", "2026-01-01").is_ok());
        let error = date_range("valid_from", "2026-02-01", "valid_until", "2026-01-01")
            .unwrap_err()
            .to_string();
        assert!(error.contains("valid_from is after valid_until"), "{error}");
    }

    #[test]
    fn unknown_kind_names_the_rule() {
        assert!(
            unknown_kind("passport", "agent-purchase", "1")
                .to_string()
                .contains("`passport` is not used by agent-purchase v1")
        );
    }

    #[test]
    fn artifact_summary_carries_only_the_kind() {
        let parsed = artifact(true, "invoice");
        assert!(parsed.synthetic);
        assert_eq!(parsed.kind, "invoice");
        assert_eq!(
            Value::Object(parsed.summary),
            serde_json::json!({"kind": "invoice"})
        );
    }

    #[test]
    fn single_reports_missing_and_duplicated_documents() {
        let mut reasons = Vec::new();
        assert_eq!(single(&[1], "invoice", &mut reasons), Some(&1));
        assert_eq!(single::<u8>(&[], "invoice", &mut reasons), None);
        assert_eq!(single(&[1, 2], "invoice", &mut reasons), None);
        assert_eq!(
            reasons,
            ["invoice missing", "invoice submitted more than once"]
        );
    }

    #[test]
    fn the_mandate_is_always_the_last_reason_and_the_limit_is_inclusive() {
        assert_eq!(decide(vec![], 30, 30), Decision::AutoApproved);
        assert_eq!(decide(vec![], 31, 30).reasons(), [MANDATE_REASON]);
        assert_eq!(
            decide(vec!["first".to_owned()], 31, 30).reasons(),
            ["first", MANDATE_REASON]
        );
    }
}
