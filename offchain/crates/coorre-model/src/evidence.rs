use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::datetime::validate_utc_seconds;
use crate::did_key;
use crate::eddsa_jcs_2022;
use crate::error::{ModelError, Result};
use crate::hash::{self, sha256};

pub const VC_CONTEXT_V2: &str = "https://www.w3.org/ns/credentials/v2";
pub const COORRE_CONTEXT: &str = "https://coorre.example/ns/v1";
pub const VC_TYPE: &str = "VerifiableCredential";
pub const TRANSITION_TYPE: &str = "CoorReTransition";
pub const CASE_REF_PREFIX: &str = "urn:coorre:case:";
pub const UUID_URN_PREFIX: &str = "urn:uuid:";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CaseState {
    Open,
    Submitted,
    AgentReviewed,
    AutoApproved,
    Escalated,
    Approved,
    Rejected,
}

impl CaseState {
    pub const ALL: [CaseState; 7] = [
        CaseState::Open,
        CaseState::Submitted,
        CaseState::AgentReviewed,
        CaseState::AutoApproved,
        CaseState::Escalated,
        CaseState::Approved,
        CaseState::Rejected,
    ];

    pub fn code(self) -> u8 {
        match self {
            CaseState::Open => 0,
            CaseState::Submitted => 1,
            CaseState::AgentReviewed => 2,
            CaseState::AutoApproved => 3,
            CaseState::Escalated => 4,
            CaseState::Approved => 5,
            CaseState::Rejected => 6,
        }
    }

    pub fn from_code(code: u8) -> Option<Self> {
        Self::ALL.into_iter().find(|s| s.code() == code)
    }

    pub fn name(self) -> &'static str {
        match self {
            CaseState::Open => "OPEN",
            CaseState::Submitted => "SUBMITTED",
            CaseState::AgentReviewed => "AGENT_REVIEWED",
            CaseState::AutoApproved => "AUTO_APPROVED",
            CaseState::Escalated => "ESCALATED",
            CaseState::Approved => "APPROVED",
            CaseState::Rejected => "REJECTED",
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            CaseState::AutoApproved | CaseState::Approved | CaseState::Rejected
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActorKind {
    Human,
    Agent,
    System,
}

impl ActorKind {
    pub fn code(self) -> u8 {
        match self {
            ActorKind::Human => 1,
            ActorKind::Agent => 2,
            ActorKind::System => 3,
        }
    }

    pub fn from_code(code: u8) -> Option<Self> {
        [ActorKind::Human, ActorKind::Agent, ActorKind::System]
            .into_iter()
            .find(|k| k.code() == code)
    }

    pub fn name(self) -> &'static str {
        match self {
            ActorKind::Human => "human",
            ActorKind::Agent => "agent",
            ActorKind::System => "system",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Autonomy {
    Recommend,
    ExecuteWithApproval,
    Autonomous,
    Escalate,
}

impl Autonomy {
    pub fn name(self) -> &'static str {
        match self {
            Autonomy::Recommend => "recommend",
            Autonomy::ExecuteWithApproval => "execute_with_approval",
            Autonomy::Autonomous => "autonomous",
            Autonomy::Escalate => "escalate",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Submitter,
    Agent,
    RuleEngine,
    Approver,
}

impl Role {
    pub fn actor_kind(self) -> ActorKind {
        match self {
            Role::Submitter | Role::Approver => ActorKind::Human,
            Role::Agent => ActorKind::Agent,
            Role::RuleEngine => ActorKind::System,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Actor {
    pub id: String,
    pub kind: ActorKind,
    pub autonomy: Autonomy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Mandate {
    pub amount_lamports: String,
    pub autonomy_limit_lamports: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuleRef {
    pub id: String,
    pub version: String,
    pub hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactRef {
    pub name: String,
    #[serde(rename = "mediaType")]
    pub media_type: String,
    #[serde(rename = "digestSHA256")]
    pub digest_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransitionSubject {
    pub case: String,
    pub from_state: CaseState,
    pub to_state: CaseState,
    pub actor: Actor,
    pub mandate: Mandate,
    pub rule: RuleRef,
    pub artifacts: Vec<ArtifactRef>,
    pub payload: Map<String, Value>,
    pub previous_evidence: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceDocument {
    #[serde(rename = "@context")]
    pub context: Vec<String>,
    pub id: String,
    #[serde(rename = "type")]
    pub types: Vec<String>,
    pub issuer: String,
    #[serde(rename = "validFrom")]
    pub valid_from: String,
    #[serde(rename = "credentialSubject")]
    pub credential_subject: TransitionSubject,
}

impl EvidenceDocument {
    pub fn to_value(&self) -> Result<Value> {
        serde_json::to_value(self).map_err(|e| ModelError::InvalidEvidence(e.to_string()))
    }

    pub fn from_value(value: &Value) -> Result<Self> {
        let document: Self = serde_json::from_value(value.clone())
            .map_err(|e| ModelError::InvalidEvidence(e.to_string()))?;
        document.validate()?;
        Ok(document)
    }

    pub fn from_secured(value: &Value) -> Result<Self> {
        let mut object = value.as_object().ok_or(ModelError::NotAnObject)?.clone();
        object.remove("proof");
        Self::from_value(&Value::Object(object))
    }

    pub fn evidence_hash(&self) -> Result<[u8; 32]> {
        eddsa_jcs_2022::evidence_hash(&self.to_value()?)
    }

    pub fn amount_lamports(&self) -> Result<u64> {
        parse_lamports(&self.credential_subject.mandate.amount_lamports)
    }

    pub fn autonomy_limit_lamports(&self) -> Result<u64> {
        parse_lamports(&self.credential_subject.mandate.autonomy_limit_lamports)
    }

    pub fn previous_evidence_hash(&self) -> Result<[u8; 32]> {
        hash::from_prefixed(&self.credential_subject.previous_evidence)
    }

    pub fn rule_hash(&self) -> Result<[u8; 32]> {
        hash::from_prefixed(&self.credential_subject.rule.hash)
    }

    pub fn validate(&self) -> Result<()> {
        let fail = |reason: &str| Err(ModelError::InvalidEvidence(reason.to_owned()));
        if self.context != [VC_CONTEXT_V2, COORRE_CONTEXT] {
            return fail("@context must be [credentials v2, coorre v1]");
        }
        if self.types != [VC_TYPE, TRANSITION_TYPE] {
            return fail("type must be [VerifiableCredential, CoorReTransition]");
        }
        if !is_uuid_v4_urn(&self.id) {
            return fail("id must be urn:uuid:<lowercase v4 uuid>");
        }
        did_key::public_key_from_did(&self.issuer)?;
        validate_utc_seconds(&self.valid_from)?;

        let subject = &self.credential_subject;
        if subject.actor.id != self.issuer {
            return fail("credentialSubject.actor.id must equal issuer");
        }
        if !is_case_ref(&subject.case) {
            return fail("credentialSubject.case must be urn:coorre:case:<id>");
        }
        if subject.from_state == subject.to_state {
            return fail("fromState and toState must differ");
        }
        self.amount_lamports()?;
        self.autonomy_limit_lamports()?;
        if subject.rule.id.is_empty() || subject.rule.version.is_empty() {
            return fail("rule id and version are required");
        }
        self.rule_hash()?;
        self.previous_evidence_hash()?;
        for artifact in &subject.artifacts {
            if !is_safe_artifact_name(&artifact.name) {
                return fail(
                    "artifact name must be 1-128 characters of [A-Za-z0-9._-] and not start with a dot",
                );
            }
            if artifact.media_type.is_empty() {
                return fail("artifact mediaType is required");
            }
            hash::from_hex(&artifact.digest_sha256)?;
        }
        Ok(())
    }
}

pub fn case_id(case_ref: &str) -> [u8; 32] {
    sha256(case_ref.as_bytes())
}

pub fn genesis_previous_evidence(case_ref: &str) -> String {
    hash::to_prefixed(&case_id(case_ref))
}

pub fn parse_lamports(text: &str) -> Result<u64> {
    let canonical = !text.is_empty()
        && text.bytes().all(|b| b.is_ascii_digit())
        && (text == "0" || !text.starts_with('0'));
    if !canonical {
        return Err(ModelError::InvalidEvidence(format!(
            "`{text}` is not a canonical decimal amount"
        )));
    }
    text.parse::<u64>()
        .map_err(|_| ModelError::InvalidEvidence(format!("`{text}` does not fit in u64")))
}

pub fn is_safe_artifact_name(name: &str) -> bool {
    (1..=128).contains(&name.len())
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
}

fn is_case_ref(text: &str) -> bool {
    text.strip_prefix(CASE_REF_PREFIX).is_some_and(|id| {
        !id.is_empty()
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
    })
}

fn is_uuid_v4_urn(text: &str) -> bool {
    let Some(uuid) = text.strip_prefix(UUID_URN_PREFIX) else {
        return false;
    };
    let bytes = uuid.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, &b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(&b),
        })
        && bytes[14] == b'4'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eddsa_jcs_2022::{ProofOptions, sign_document, verify_proof};
    use crate::jcs;
    use crate::keys::Ed25519Keypair;
    use serde_json::json;

    const ID: &str = "urn:uuid:0b6c1f5e-3f7a-4c2d-9e1b-2a3c4d5e6f70";
    const VALID_FROM: &str = "2026-10-09T12:00:00Z";

    fn keypair() -> Ed25519Keypair {
        Ed25519Keypair::from_seed(&[21u8; 32])
    }

    fn document() -> EvidenceDocument {
        let issuer = keypair().did();
        EvidenceDocument {
            context: vec![VC_CONTEXT_V2.to_owned(), COORRE_CONTEXT.to_owned()],
            id: ID.to_owned(),
            types: vec![VC_TYPE.to_owned(), TRANSITION_TYPE.to_owned()],
            issuer: issuer.clone(),
            valid_from: VALID_FROM.to_owned(),
            credential_subject: TransitionSubject {
                case: "urn:coorre:case:SUP-002".to_owned(),
                from_state: CaseState::AgentReviewed,
                to_state: CaseState::Escalated,
                actor: Actor {
                    id: issuer,
                    kind: ActorKind::System,
                    autonomy: Autonomy::Autonomous,
                },
                mandate: Mandate {
                    amount_lamports: "200000000".to_owned(),
                    autonomy_limit_lamports: "100000000".to_owned(),
                },
                rule: RuleRef {
                    id: "supplier-docs".to_owned(),
                    version: "1".to_owned(),
                    hash: hash::to_prefixed(&sha256(b"rule")),
                },
                artifacts: vec![ArtifactRef {
                    name: "license.pdf".to_owned(),
                    media_type: "application/pdf".to_owned(),
                    digest_sha256: hash::to_hex(&sha256(b"license")),
                }],
                payload: json!({"reasons": ["environmental license expired", "amount exceeds autonomy limit"]})
                    .as_object()
                    .unwrap()
                    .clone(),
                previous_evidence: genesis_previous_evidence("urn:coorre:case:SUP-002"),
            },
        }
    }

    #[test]
    fn case_id_matches_an_independent_sha256() {
        assert_eq!(
            hash::to_hex(&case_id("urn:coorre:case:SUP-001")),
            "3399ee0b9edb655f3ca4c144f4f37310fc6b20ca53423dd567d890970b50a805"
        );
        assert_eq!(
            genesis_previous_evidence("urn:coorre:case:SUP-002"),
            "sha256:b2c5d5c63c30130ae8b3bed41015176b0fb39a1e4c7a178662bb694496b1e1ee"
        );
    }

    #[test]
    fn state_codes_names_and_terminal_flags_match_adr_001() {
        let expected = [
            (0, "OPEN", false),
            (1, "SUBMITTED", false),
            (2, "AGENT_REVIEWED", false),
            (3, "AUTO_APPROVED", true),
            (4, "ESCALATED", false),
            (5, "APPROVED", true),
            (6, "REJECTED", true),
        ];
        for (state, (code, name, terminal)) in CaseState::ALL.into_iter().zip(expected) {
            assert_eq!(state.code(), code);
            assert_eq!(state.name(), name);
            assert_eq!(state.is_terminal(), terminal);
            assert_eq!(CaseState::from_code(code), Some(state));
            assert_eq!(serde_json::to_value(state).unwrap(), json!(name));
        }
        assert_eq!(CaseState::from_code(7), None);
    }

    #[test]
    fn actor_kind_codes_and_role_mapping_match_adr_001() {
        assert_eq!(ActorKind::Human.code(), 1);
        assert_eq!(ActorKind::Agent.code(), 2);
        assert_eq!(ActorKind::System.code(), 3);
        assert_eq!(ActorKind::from_code(0), None);
        assert_eq!(ActorKind::from_code(2), Some(ActorKind::Agent));
        assert_eq!(Role::Submitter.actor_kind(), ActorKind::Human);
        assert_eq!(Role::Agent.actor_kind(), ActorKind::Agent);
        assert_eq!(Role::RuleEngine.actor_kind(), ActorKind::System);
        assert_eq!(Role::Approver.actor_kind(), ActorKind::Human);
        assert_eq!(
            serde_json::to_value(Role::RuleEngine).unwrap(),
            json!("rule_engine")
        );
        assert_eq!(
            serde_json::to_value(Autonomy::ExecuteWithApproval).unwrap(),
            json!("execute_with_approval")
        );
    }

    #[test]
    fn serialized_member_names_follow_the_spec() {
        let value = document().to_value().unwrap();
        let subject = &value["credentialSubject"];
        assert!(value.get("@context").is_some() && value.get("validFrom").is_some());
        assert_eq!(subject["fromState"], "AGENT_REVIEWED");
        assert_eq!(subject["toState"], "ESCALATED");
        assert_eq!(subject["actor"]["kind"], "system");
        assert_eq!(subject["mandate"]["amountLamports"], "200000000");
        assert_eq!(subject["mandate"]["autonomyLimitLamports"], "100000000");
        assert!(subject["artifacts"][0].get("digestSHA256").is_some());
        assert!(subject["artifacts"][0].get("mediaType").is_some());
        assert!(subject.get("previousEvidence").is_some());
    }

    #[test]
    fn json_round_trip_and_validation() {
        let doc = document();
        doc.validate().unwrap();
        let back = EvidenceDocument::from_value(&doc.to_value().unwrap()).unwrap();
        assert_eq!(back, doc);
        assert_eq!(doc.amount_lamports().unwrap(), 200_000_000);
        assert_eq!(doc.autonomy_limit_lamports().unwrap(), 100_000_000);
        assert_eq!(
            doc.previous_evidence_hash().unwrap(),
            case_id("urn:coorre:case:SUP-002")
        );
        assert_eq!(doc.rule_hash().unwrap(), sha256(b"rule"));
    }

    #[test]
    fn sign_verify_and_reparse_a_transition_credential() {
        let key = keypair();
        let doc = document();
        let secured = sign_document(
            &doc.to_value().unwrap(),
            &ProofOptions::assertion(VALID_FROM, key.verification_method()),
            &key,
        )
        .unwrap();
        let verified = verify_proof(&secured).unwrap();
        assert_eq!(verified.did, doc.issuer);
        assert_eq!(EvidenceDocument::from_secured(&secured).unwrap(), doc);
        assert_eq!(
            doc.evidence_hash().unwrap(),
            eddsa_jcs_2022::evidence_hash(&secured).unwrap()
        );
    }

    #[test]
    fn evidence_hash_is_stable_across_key_order_and_whitespace() {
        let doc = document();
        let compact =
            String::from_utf8(jcs::canonicalize(&doc.to_value().unwrap()).unwrap()).unwrap();
        let pretty = serde_json::to_string_pretty(&doc.to_value().unwrap()).unwrap();
        let a = EvidenceDocument::from_value(&jcs::parse(&compact).unwrap()).unwrap();
        let b = EvidenceDocument::from_value(&jcs::parse(&pretty).unwrap()).unwrap();
        assert_eq!(a.evidence_hash().unwrap(), b.evidence_hash().unwrap());
    }

    #[test]
    fn unknown_members_are_rejected() {
        let mut value = document().to_value().unwrap();
        value["credentialSubject"]["extra"] = json!("x");
        assert!(EvidenceDocument::from_value(&value).is_err());
        let mut value = document().to_value().unwrap();
        value["evidence"] = json!([]);
        assert!(EvidenceDocument::from_value(&value).is_err());
    }

    type Mutation = Box<dyn Fn(&mut EvidenceDocument)>;

    #[test]
    fn validate_rejects_malformed_documents() {
        let cases: Vec<Mutation> = vec![
            Box::new(|d| d.context.reverse()),
            Box::new(|d| d.types = vec![VC_TYPE.to_owned()]),
            Box::new(|d| d.id = "urn:uuid:0B6C1F5E-3F7A-4C2D-9E1B-2A3C4D5E6F70".to_owned()),
            Box::new(|d| d.id = "urn:uuid:0b6c1f5e-3f7a-1c2d-9e1b-2a3c4d5e6f70".to_owned()),
            Box::new(|d| d.issuer = "did:web:example.com".to_owned()),
            Box::new(|d| d.valid_from = "2026-10-09T12:00:00.5Z".to_owned()),
            Box::new(|d| d.credential_subject.actor.id = Ed25519Keypair::from_seed(&[1; 32]).did()),
            Box::new(|d| d.credential_subject.case = "SUP-002".to_owned()),
            Box::new(|d| d.credential_subject.case = "urn:coorre:case:".to_owned()),
            Box::new(|d| d.credential_subject.to_state = d.credential_subject.from_state),
            Box::new(|d| d.credential_subject.mandate.amount_lamports = "0200".to_owned()),
            Box::new(|d| d.credential_subject.mandate.amount_lamports = "-1".to_owned()),
            Box::new(|d| {
                d.credential_subject.mandate.autonomy_limit_lamports =
                    "18446744073709551616".to_owned()
            }),
            Box::new(|d| d.credential_subject.rule.hash = "abc".to_owned()),
            Box::new(|d| d.credential_subject.rule.id.clear()),
            Box::new(|d| d.credential_subject.previous_evidence = hash::to_hex(&[0; 32])),
            Box::new(|d| d.credential_subject.artifacts[0].digest_sha256 = "ABC".to_owned()),
            Box::new(|d| d.credential_subject.artifacts[0].media_type.clear()),
            Box::new(|d| {
                d.credential_subject.artifacts[0].name = "../keys/creator.json".to_owned()
            }),
            Box::new(|d| d.credential_subject.artifacts[0].name = ".hidden".to_owned()),
        ];
        for (i, mutate) in cases.iter().enumerate() {
            let mut doc = document();
            mutate(&mut doc);
            assert!(doc.validate().is_err(), "case {i} should fail validation");
        }
    }

    #[test]
    fn safe_artifact_names() {
        for good in ["license.pdf", "tax-certificate_2026.json", "A1"] {
            assert!(is_safe_artifact_name(good), "{good}");
        }
        let too_long = "a".repeat(129);
        for bad in [
            "",
            ".env",
            "../x",
            "a/b",
            "a\\b",
            "c:x",
            "nome com espaco",
            too_long.as_str(),
        ] {
            assert!(!is_safe_artifact_name(bad), "{bad}");
        }
    }

    #[test]
    fn names_match_the_serialized_forms() {
        for kind in [ActorKind::Human, ActorKind::Agent, ActorKind::System] {
            assert_eq!(serde_json::to_value(kind).unwrap(), json!(kind.name()));
        }
        for autonomy in [
            Autonomy::Recommend,
            Autonomy::ExecuteWithApproval,
            Autonomy::Autonomous,
            Autonomy::Escalate,
        ] {
            assert_eq!(
                serde_json::to_value(autonomy).unwrap(),
                json!(autonomy.name())
            );
        }
    }

    #[test]
    fn parse_lamports_accepts_only_canonical_u64() {
        assert_eq!(parse_lamports("0").unwrap(), 0);
        assert_eq!(parse_lamports("18446744073709551615").unwrap(), u64::MAX);
        for bad in [
            "",
            "00",
            "01",
            "+1",
            "1.0",
            "1e3",
            " 1",
            "18446744073709551616",
        ] {
            assert!(parse_lamports(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn from_secured_requires_an_object() {
        assert_eq!(
            EvidenceDocument::from_secured(&json!([])),
            Err(ModelError::NotAnObject)
        );
    }
}
