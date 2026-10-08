use std::path::Path;

use anyhow::{Context, bail};
use coorre_engine::{DocumentKind, SubmittedDocument};
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
pub struct CaseSpec {
    pub id: String,
    pub supplier: String,
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
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
struct CasesFile {
    cases: Vec<CaseSpec>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DocumentFixture {
    pub synthetic: bool,
    pub kind: DocumentKind,
    pub supplier: String,
    pub issuer: String,
    pub number: String,
    pub valid_from: String,
    pub valid_until: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Artifact {
    pub name: String,
    pub bytes: Vec<u8>,
    pub fixture: DocumentFixture,
}

impl Artifact {
    pub fn reference(&self) -> ArtifactRef {
        ArtifactRef {
            name: self.name.clone(),
            media_type: ARTIFACT_MEDIA_TYPE.to_owned(),
            digest_sha256: to_hex(&sha256(&self.bytes)),
        }
    }

    pub fn submitted(&self) -> SubmittedDocument {
        SubmittedDocument {
            kind: self.fixture.kind,
            valid_from: self.fixture.valid_from.clone(),
            valid_until: self.fixture.valid_until.clone(),
            digest_sha256: to_hex(&sha256(&self.bytes)),
        }
    }
}

pub fn load_cases(dir: &Path) -> anyhow::Result<Vec<CaseSpec>> {
    let path = dir.join("cases.json");
    let text = std::fs::read_to_string(&path)
        .with_context(|| format!("cannot read {}", path.display()))?;
    let value = jcs::parse(&text)?;
    let file: CasesFile =
        serde_json::from_value(value).with_context(|| format!("invalid {}", path.display()))?;
    for case in &file.cases {
        case.amount()?;
        case.autonomy_limit()?;
    }
    Ok(file.cases)
}

pub fn load_artifacts(dir: &Path, case: &CaseSpec) -> anyhow::Result<Vec<Artifact>> {
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
        let text = std::str::from_utf8(&bytes).with_context(|| format!("{name} is not UTF-8"))?;
        let fixture: DocumentFixture = serde_json::from_value(jcs::parse(text)?)
            .with_context(|| format!("invalid document fixture {name}"))?;
        if !fixture.synthetic {
            bail!("{name}: only synthetic documents are allowed in the demo");
        }
        artifacts.push(Artifact {
            name,
            bytes,
            fixture,
        });
    }
    Ok(artifacts)
}
