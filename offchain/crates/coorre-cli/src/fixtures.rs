use std::path::Path;

use anyhow::{Context, bail};
use coorre_engine::{ParsedArtifact, RuleId};
use coorre_model::evidence::{is_safe_artifact_name, parse_lamports};
use coorre_model::hash::{sha256, to_hex};
use coorre_model::{ArtifactRef, jcs};
use serde::Deserialize;

pub const ARTIFACT_MEDIA_TYPE: &str = "application/json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApproverChoice {
    Approve,
    Reject,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApproverDecision {
    pub decision: ApproverChoice,
    pub justification: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuleSpec {
    pub id: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CaseSpec {
    pub id: String,
    pub rule: Option<RuleSpec>,
    pub supplier: Option<String>,
    pub payee: Option<String>,
    pub amount_lamports: String,
    pub autonomy_limit_lamports: String,
    pub documents: Vec<String>,
    pub approver: Option<ApproverDecision>,
    pub demo: bool,
}

impl CaseSpec {
    pub fn amount(&self) -> anyhow::Result<u64> {
        Ok(parse_lamports(&self.amount_lamports)?)
    }

    pub fn autonomy_limit(&self) -> anyhow::Result<u64> {
        Ok(parse_lamports(&self.autonomy_limit_lamports)?)
    }

    pub fn rule_id(&self) -> anyhow::Result<RuleId> {
        match &self.rule {
            None => Ok(RuleId::SupplierDocs),
            Some(rule) => RuleId::find(&rule.id, &rule.version).with_context(|| {
                format!(
                    "case {}: rule {} v{} is not in the registry",
                    self.id, rule.id, rule.version
                )
            }),
        }
    }

    pub fn payee_name(&self) -> anyhow::Result<&str> {
        match (&self.supplier, &self.payee) {
            (Some(name), None) | (None, Some(name)) => Ok(name),
            _ => bail!(
                "case {}: give exactly one of \"supplier\" or \"payee\"",
                self.id
            ),
        }
    }

    pub fn payee_label(&self) -> &'static str {
        if self.supplier.is_some() {
            "supplier"
        } else {
            "payee"
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
struct CasesFile {
    cases: Vec<CaseSpec>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Artifact {
    pub name: String,
    pub bytes: Vec<u8>,
    pub parsed: ParsedArtifact,
}

impl Artifact {
    pub fn reference(&self) -> ArtifactRef {
        ArtifactRef {
            name: self.name.clone(),
            media_type: ARTIFACT_MEDIA_TYPE.to_owned(),
            digest_sha256: to_hex(&sha256(&self.bytes)),
        }
    }
}

pub const MAX_CASE_ID_LEN: usize = 32;

pub fn is_case_id(id: &str) -> bool {
    (1..=MAX_CASE_ID_LEN).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn select_cases<'a>(
    all: &'a [CaseSpec],
    requested: &[String],
) -> anyhow::Result<Vec<&'a CaseSpec>> {
    if requested.is_empty() {
        return Ok(all.iter().filter(|c| c.demo).collect());
    }
    let unknown: Vec<&str> = requested
        .iter()
        .filter(|id| !all.iter().any(|c| &c.id == *id))
        .map(String::as_str)
        .collect();
    if !unknown.is_empty() {
        bail!(
            "unknown case id in --case: {}",
            unknown
                .iter()
                .map(|id| format!("{id:?}"))
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    Ok(all.iter().filter(|c| requested.contains(&c.id)).collect())
}

pub fn load_cases(dir: &Path) -> anyhow::Result<Vec<CaseSpec>> {
    let path = dir.join("cases.json");
    let text = std::fs::read_to_string(&path)
        .with_context(|| format!("cannot read {}", path.display()))?;
    let value = jcs::parse(&text)?;
    let file: CasesFile =
        serde_json::from_value(value).with_context(|| format!("invalid {}", path.display()))?;
    let mut seen = std::collections::BTreeSet::new();
    for case in &file.cases {
        if !is_case_id(&case.id) {
            bail!(
                "{}: case id {:?} must be 1 to {MAX_CASE_ID_LEN} letters, digits, '-' or '_'",
                path.display(),
                case.id
            );
        }
        if !seen.insert(case.id.as_str()) {
            bail!("{}: case id {} appears twice", path.display(), case.id);
        }
        case.amount()?;
        case.autonomy_limit()?;
        case.rule_id()?;
        case.payee_name()?;
    }
    Ok(file.cases)
}

pub fn load_artifacts(dir: &Path, case: &CaseSpec) -> anyhow::Result<Vec<Artifact>> {
    let rule = case.rule_id()?;
    let mut artifacts = Vec::new();
    for relative in &case.documents {
        let path = dir.join(relative);
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_owned)
            .with_context(|| format!("invalid document path {relative}"))?;
        if !is_safe_artifact_name(&name) {
            bail!("unsafe artifact name {name}");
        }
        let bytes =
            std::fs::read(&path).with_context(|| format!("cannot read {}", path.display()))?;
        let parsed = rule
            .parse_artifact(&bytes)
            .with_context(|| format!("invalid document fixture {name}"))?;
        if !parsed.synthetic {
            bail!("{name}: only synthetic documents are allowed in the demo");
        }
        artifacts.push(Artifact {
            name,
            bytes,
            parsed,
        });
    }
    Ok(artifacts)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn case(id: &str, demo: bool) -> CaseSpec {
        CaseSpec {
            id: id.to_owned(),
            rule: None,
            supplier: Some("S".to_owned()),
            payee: None,
            amount_lamports: "1".to_owned(),
            autonomy_limit_lamports: "1".to_owned(),
            documents: vec![],
            approver: None,
            demo,
        }
    }

    fn ids(cases: &[&CaseSpec]) -> Vec<String> {
        cases.iter().map(|c| c.id.clone()).collect()
    }

    #[test]
    fn case_ids_are_short_and_path_safe() {
        for good in ["SUP-001", "a_b", "X"] {
            assert!(is_case_id(good), "{good}");
        }
        for bad in [
            "",
            "../x",
            "a/b",
            "a b",
            "a.b",
            "\u{1b}[2J",
            "ÁGT",
            &"A".repeat(MAX_CASE_ID_LEN + 1),
        ] {
            assert!(!is_case_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn select_cases_defaults_to_demo_cases_and_ignores_repeated_ids() {
        let all = vec![case("A", true), case("B", false), case("C", true)];
        assert_eq!(ids(&select_cases(&all, &[]).unwrap()), ["A", "C"]);
        let requested = ["B".to_owned(), "B".to_owned(), "A".to_owned()];
        assert_eq!(ids(&select_cases(&all, &requested).unwrap()), ["A", "B"]);
    }

    #[test]
    fn select_cases_names_the_unknown_ids() {
        let all = vec![case("A", true)];
        let error = select_cases(&all, &["A".to_owned(), "Z\u{1b}".to_owned()])
            .unwrap_err()
            .to_string();
        assert_eq!(error, "unknown case id in --case: \"Z\\u{1b}\"");
    }

    fn write_cases(name: &str, ids: &[&str]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("coorre-cases-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cases: Vec<serde_json::Value> = ids
            .iter()
            .map(|id| {
                serde_json::json!({
                    "id": id, "supplier": "S", "amount_lamports": "1",
                    "autonomy_limit_lamports": "1", "documents": [], "demo": false
                })
            })
            .collect();
        std::fs::write(
            dir.join("cases.json"),
            serde_json::json!({ "cases": cases }).to_string(),
        )
        .unwrap();
        dir
    }

    #[test]
    fn load_cases_rejects_unsafe_and_repeated_ids_before_anything_runs() {
        let dir = write_cases("unsafe", &["../../tmp/x"]);
        let error = load_cases(&dir).unwrap_err().to_string();
        assert!(error.contains("case id \"../../tmp/x\""), "{error}");
        let dir = write_cases("twice", &["A-1", "A-1"]);
        let error = load_cases(&dir).unwrap_err().to_string();
        assert!(error.contains("case id A-1 appears twice"), "{error}");
        let dir = write_cases("fine", &["A-1", "B_2"]);
        assert_eq!(load_cases(&dir).unwrap().len(), 2);
    }
}
