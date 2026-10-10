use anyhow::{anyhow, bail};
use coorre_model::eddsa_jcs_2022::evidence_hash;
use coorre_model::evidence::case_id;
use coorre_model::hash::{from_hex, to_hex};
use coorre_model::{CaseState, EvidenceDocument};
use coorre_verify::AuditBundle;

pub const MEMO_LEN: usize = 512;
pub const ARBITRARY_DATA: u8 = 0xFF;
pub const MAGIC: &[u8; 4] = b"CRE1";
pub const KIND_RELEASE: u8 = 1;
pub const PAYLOAD_LEN: usize = 103;
pub const TEXT_PREFIX: &str = "coorre/1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReleaseMemo {
    pub case_id: [u8; 32],
    pub evidence_hash: [u8; 32],
    pub rule_hash: [u8; 32],
    pub state: CaseState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    pub memo: ReleaseMemo,
    pub evidence_number: usize,
}

fn is_release(state: CaseState) -> bool {
    matches!(state, CaseState::AutoApproved | CaseState::Approved)
}

pub fn release_decision(bundle: &AuditBundle) -> anyhow::Result<Decision> {
    let (index, evidence) = bundle
        .evidence
        .iter()
        .enumerate()
        .rev()
        .find(|(_, e)| {
            e.document
                .pointer("/credentialSubject/toState")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|s| s == "AUTO_APPROVED" || s == "APPROVED")
        })
        .ok_or_else(|| {
            anyhow!(
                "{} has no decision that releases a payment",
                bundle.case_ref
            )
        })?;
    let document = EvidenceDocument::from_secured(&evidence.document)?;
    let subject = &document.credential_subject;
    if subject.case != bundle.case_ref {
        bail!(
            "the decision belongs to {}, not {}",
            subject.case,
            bundle.case_ref
        );
    }
    Ok(Decision {
        memo: ReleaseMemo {
            case_id: case_id(&bundle.case_ref),
            evidence_hash: evidence_hash(&evidence.document)?,
            rule_hash: document.rule_hash()?,
            state: subject.to_state,
        },
        evidence_number: index + 1,
    })
}

pub fn encode_binary(memo: &ReleaseMemo) -> [u8; MEMO_LEN] {
    let mut out = [0u8; MEMO_LEN];
    out[0] = ARBITRARY_DATA;
    out[1..5].copy_from_slice(MAGIC);
    out[5] = KIND_RELEASE;
    out[6..38].copy_from_slice(&memo.case_id);
    out[38..70].copy_from_slice(&memo.evidence_hash);
    out[70..102].copy_from_slice(&memo.rule_hash);
    out[102] = memo.state.code();
    out
}

fn digest(bytes: &[u8]) -> anyhow::Result<[u8; 32]> {
    bytes
        .try_into()
        .map_err(|_| anyhow!("a digest must be 32 bytes"))
}

pub fn decode_binary(bytes: &[u8]) -> anyhow::Result<ReleaseMemo> {
    if bytes.len() != MEMO_LEN {
        bail!("a Zcash memo is {MEMO_LEN} bytes, got {}", bytes.len());
    }
    if bytes[0] != ARBITRARY_DATA {
        bail!("the memo does not start with 0xFF (ZIP 302 arbitrary data)");
    }
    if &bytes[1..5] != MAGIC || bytes[5] != KIND_RELEASE {
        bail!("the memo is not a CoorRe release memo, version 1");
    }
    if bytes[PAYLOAD_LEN..].iter().any(|&b| b != 0) {
        bail!("the memo has data after the CoorRe payload");
    }
    let state = CaseState::from_code(bytes[102])
        .filter(|s| is_release(*s))
        .ok_or_else(|| anyhow!("state code {} does not release a payment", bytes[102]))?;
    Ok(ReleaseMemo {
        case_id: digest(&bytes[6..38])?,
        evidence_hash: digest(&bytes[38..70])?,
        rule_hash: digest(&bytes[70..102])?,
        state,
    })
}

pub fn encode_binary_hex(memo: &ReleaseMemo) -> String {
    encode_binary(memo)
        .chunks(32)
        .map(|chunk| to_hex(&digest(chunk).unwrap_or([0; 32])))
        .collect()
}

pub fn decode_binary_hex(text: &str) -> anyhow::Result<ReleaseMemo> {
    if text.len() != MEMO_LEN * 2 || !text.is_ascii() {
        bail!("a binary memo is {} lowercase hex characters", MEMO_LEN * 2);
    }
    let mut bytes = Vec::with_capacity(MEMO_LEN);
    for i in (0..text.len()).step_by(64) {
        bytes.extend_from_slice(&from_hex(&text[i..i + 64])?);
    }
    decode_binary(&bytes)
}

pub fn encode_text(memo: &ReleaseMemo) -> String {
    format!(
        "{TEXT_PREFIX} case={} evidence={} rule={} state={}",
        to_hex(&memo.case_id),
        to_hex(&memo.evidence_hash),
        to_hex(&memo.rule_hash),
        memo.state.name()
    )
}

fn field<'a>(part: Option<&'a str>, name: &str) -> anyhow::Result<&'a str> {
    part.and_then(|p| p.strip_prefix(name))
        .and_then(|p| p.strip_prefix('='))
        .ok_or_else(|| anyhow!("the memo is missing `{name}=`"))
}

pub fn parse_text(text: &str) -> anyhow::Result<ReleaseMemo> {
    let mut parts = text.trim_end_matches('\0').trim().split(' ');
    if parts.next() != Some(TEXT_PREFIX) {
        bail!("the memo does not start with `{TEXT_PREFIX}`");
    }
    let case_id = from_hex(field(parts.next(), "case")?)?;
    let evidence_hash = from_hex(field(parts.next(), "evidence")?)?;
    let rule_hash = from_hex(field(parts.next(), "rule")?)?;
    let state_name = field(parts.next(), "state")?;
    if parts.next().is_some() {
        bail!("the memo has unexpected fields after `state=`");
    }
    let state = CaseState::ALL
        .into_iter()
        .find(|s| s.name() == state_name)
        .filter(|s| is_release(*s))
        .ok_or_else(|| anyhow!("state {state_name} does not release a payment"))?;
    Ok(ReleaseMemo {
        case_id,
        evidence_hash,
        rule_hash,
        state,
    })
}

pub fn parse_any(text: &str) -> anyhow::Result<ReleaseMemo> {
    let trimmed = text.trim();
    if trimmed.starts_with(TEXT_PREFIX) {
        parse_text(trimmed)
    } else {
        decode_binary_hex(trimmed)
    }
}

pub fn check(memo: &ReleaseMemo, bundle: &AuditBundle) -> anyhow::Result<Decision> {
    if memo.case_id != case_id(&bundle.case_ref) {
        bail!("the memo names another case, not {}", bundle.case_ref);
    }
    let decision = release_decision(bundle)?;
    let mut differences = Vec::new();
    if memo.evidence_hash != decision.memo.evidence_hash {
        differences.push("evidence hash");
    }
    if memo.rule_hash != decision.memo.rule_hash {
        differences.push("rule hash");
    }
    if memo.state != decision.memo.state {
        differences.push("state");
    }
    if differences.is_empty() {
        Ok(decision)
    } else {
        bail!(
            "the memo differs from the decision of {} in: {}",
            bundle.case_ref,
            differences.join(", ")
        )
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "tests")]

    use super::*;

    fn sample() -> ReleaseMemo {
        ReleaseMemo {
            case_id: [1; 32],
            evidence_hash: [2; 32],
            rule_hash: [3; 32],
            state: CaseState::Approved,
        }
    }

    #[test]
    fn the_binary_memo_follows_zip_302_arbitrary_data() {
        let bytes = encode_binary(&sample());
        assert_eq!(bytes.len(), 512);
        assert_eq!(bytes[0], 0xFF);
        assert_eq!(&bytes[1..5], b"CRE1");
        assert_eq!(bytes[5], 1);
        assert_eq!(bytes[102], CaseState::Approved.code());
        assert!(bytes[103..].iter().all(|&b| b == 0));
        assert_eq!(decode_binary(&bytes).unwrap(), sample());
    }

    #[test]
    fn the_binary_memo_round_trips_through_hex() {
        let text = encode_binary_hex(&sample());
        assert_eq!(text.len(), 1024);
        assert!(text.starts_with("ff43524531"));
        assert_eq!(decode_binary_hex(&text).unwrap(), sample());
        assert_eq!(parse_any(&text).unwrap(), sample());
    }

    #[test]
    fn decode_binary_rejects_other_memos() {
        let good = encode_binary(&sample());
        let mut cases = Vec::new();
        cases.push(good[..511].to_vec());
        for (i, value) in [
            (0, 0xF6),
            (1, b'X'),
            (5, 2),
            (102, CaseState::Rejected.code()),
            (300, 1),
        ] {
            let mut bad = good.to_vec();
            bad[i] = value;
            cases.push(bad);
        }
        for bad in cases {
            assert!(decode_binary(&bad).is_err());
        }
        assert!(decode_binary_hex(&"F".repeat(1024)).is_err());
        assert!(decode_binary_hex("ff").is_err());
    }

    #[test]
    fn the_text_memo_is_zip_302_text_and_round_trips() {
        let text = encode_text(&sample());
        assert!(text.len() <= 512);
        assert!(text.as_bytes()[0] <= 0xF4);
        assert!(text.is_ascii());
        assert_eq!(parse_text(&text).unwrap(), sample());
        assert_eq!(parse_any(&format!("{text}\0\0\0")).unwrap(), sample());
    }

    #[test]
    fn parse_text_rejects_malformed_memos() {
        let good = encode_text(&sample());
        for bad in [
            good.replace("coorre/1", "coorre/2"),
            good.replace("state=APPROVED", "state=REJECTED"),
            good.replace("state=APPROVED", "state=approved"),
            good.replace("case=", "kase="),
            good.replace(&"01".repeat(32), &"0A".repeat(32)),
            format!("{good} extra=1"),
            "coorre/1".to_owned(),
        ] {
            assert!(parse_text(&bad).is_err(), "{bad}");
        }
    }
}
