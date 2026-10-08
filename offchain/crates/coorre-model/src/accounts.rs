use crate::error::{ModelError, Result};
use crate::hash::sha256;

pub const CASE_RECORD_LEN: usize = 8 + 32 + 32 * 5 + 8 + 8 + 1 + 32 + 4 + 1;
pub const EVIDENCE_ANCHOR_LEN: usize = 8 + 32 + 32 + 32 + 1 + 1 + 32 + 1 + 32 + 8 + 8 + 1;

pub fn discriminator(namespace: &str, name: &str) -> [u8; 8] {
    let digest = sha256(format!("{namespace}:{name}").as_bytes());
    let mut out = [0u8; 8];
    out.copy_from_slice(&digest[..8]);
    out
}

pub fn pubkey_to_base58(key: &[u8; 32]) -> String {
    bs58::encode(key).into_string()
}

pub fn pubkey_from_base58(text: &str) -> Result<[u8; 32]> {
    let bytes = bs58::decode(text)
        .into_vec()
        .map_err(|e| ModelError::InvalidAccount(format!("bad base58 public key: {e}")))?;
    let key: [u8; 32] = bytes.as_slice().try_into().map_err(|_| {
        ModelError::InvalidAccount(format!("public key must be 32 bytes, got {}", bytes.len()))
    })?;
    if pubkey_to_base58(&key) != text {
        return Err(ModelError::InvalidAccount(
            "non-canonical base58 public key".to_owned(),
        ));
    }
    Ok(key)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaseRecordAccount {
    pub case_id: [u8; 32],
    pub creator: [u8; 32],
    pub submitter: [u8; 32],
    pub agent: [u8; 32],
    pub rule_engine: [u8; 32],
    pub approver: [u8; 32],
    pub amount: u64,
    pub autonomy_limit: u64,
    pub state: u8,
    pub last_evidence_hash: [u8; 32],
    pub transition_count: u32,
    pub bump: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvidenceAnchorAccount {
    pub evidence_hash: [u8; 32],
    pub case_record: [u8; 32],
    pub prev_hash: [u8; 32],
    pub from_state: u8,
    pub to_state: u8,
    pub actor: [u8; 32],
    pub actor_kind: u8,
    pub rule_hash: [u8; 32],
    pub slot: u64,
    pub unix_ts: i64,
    pub bump: u8,
}

struct Reader<'a> {
    data: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8], name: &str, expected_len: usize) -> Result<Self> {
        if data.len() != expected_len {
            return Err(ModelError::InvalidAccount(format!(
                "{name} must be {expected_len} bytes, got {}",
                data.len()
            )));
        }
        if data[..8] != discriminator("account", name) {
            return Err(ModelError::InvalidAccount(format!(
                "account is not a {name}"
            )));
        }
        Ok(Self { data, offset: 8 })
    }

    fn bytes<const N: usize>(&mut self) -> [u8; N] {
        let mut out = [0u8; N];
        out.copy_from_slice(&self.data[self.offset..self.offset + N]);
        self.offset += N;
        out
    }

    fn u8(&mut self) -> u8 {
        self.bytes::<1>()[0]
    }
}

impl CaseRecordAccount {
    pub fn decode(data: &[u8]) -> Result<Self> {
        let mut r = Reader::new(data, "CaseRecord", CASE_RECORD_LEN)?;
        Ok(Self {
            case_id: r.bytes(),
            creator: r.bytes(),
            submitter: r.bytes(),
            agent: r.bytes(),
            rule_engine: r.bytes(),
            approver: r.bytes(),
            amount: u64::from_le_bytes(r.bytes()),
            autonomy_limit: u64::from_le_bytes(r.bytes()),
            state: r.u8(),
            last_evidence_hash: r.bytes(),
            transition_count: u32::from_le_bytes(r.bytes()),
            bump: r.u8(),
        })
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(CASE_RECORD_LEN);
        out.extend_from_slice(&discriminator("account", "CaseRecord"));
        for key in [
            &self.case_id,
            &self.creator,
            &self.submitter,
            &self.agent,
            &self.rule_engine,
            &self.approver,
        ] {
            out.extend_from_slice(key);
        }
        out.extend_from_slice(&self.amount.to_le_bytes());
        out.extend_from_slice(&self.autonomy_limit.to_le_bytes());
        out.push(self.state);
        out.extend_from_slice(&self.last_evidence_hash);
        out.extend_from_slice(&self.transition_count.to_le_bytes());
        out.push(self.bump);
        out
    }
}

impl EvidenceAnchorAccount {
    pub fn decode(data: &[u8]) -> Result<Self> {
        let mut r = Reader::new(data, "EvidenceAnchor", EVIDENCE_ANCHOR_LEN)?;
        Ok(Self {
            evidence_hash: r.bytes(),
            case_record: r.bytes(),
            prev_hash: r.bytes(),
            from_state: r.u8(),
            to_state: r.u8(),
            actor: r.bytes(),
            actor_kind: r.u8(),
            rule_hash: r.bytes(),
            slot: u64::from_le_bytes(r.bytes()),
            unix_ts: i64::from_le_bytes(r.bytes()),
            bump: r.u8(),
        })
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(EVIDENCE_ANCHOR_LEN);
        out.extend_from_slice(&discriminator("account", "EvidenceAnchor"));
        out.extend_from_slice(&self.evidence_hash);
        out.extend_from_slice(&self.case_record);
        out.extend_from_slice(&self.prev_hash);
        out.push(self.from_state);
        out.push(self.to_state);
        out.extend_from_slice(&self.actor);
        out.push(self.actor_kind);
        out.extend_from_slice(&self.rule_hash);
        out.extend_from_slice(&self.slot.to_le_bytes());
        out.extend_from_slice(&self.unix_ts.to_le_bytes());
        out.push(self.bump);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hash::{from_hex, to_hex};

    const SMOKE_CASE_REF: &str = "urn:coorre:case:BRIDGE-SMOKE-20261008";
    const SMOKE_CASE_RECORD: &str = "A3GQ8hYbUfmnsbk4zsZUtgCi3XpUMeEkcFtXKBiZJZWU";
    const SMOKE_CREATOR: &str = "HX4cZ2jyJxJ4iFV2CjjzdLVzNM1wQ1KvBm2MiXYdowGr";
    const SMOKE_SUBMITTER: &str = "6WzsMBReuCzbyqrT1ny5V8FSax9xP9w3Mk2DXphchYSm";
    const SMOKE_AGENT: &str = "Fr7kYffQLDLauGN4nVG1CmYNWfQNrTR47HPKbVuoinLz";
    const SMOKE_RULE_ENGINE: &str = "6296obD4FzBygg2BiC2K2DAyEtCLbDNvDEmXvMTg4AGc";
    const SMOKE_APPROVER: &str = "FMn9kaTjuar4URdxcNjxHQr2SJjDfdMvk29b6qZ91ie2";
    const SUPPLIER_DOCS_V1_RULE_HASH: &str =
        "7320d1d698663198cb21f5f5cce3e6d0064b8300a1042ebf13fc8934fbdabd2f";
    const CASE_RECORD_HEX: &str =
        include_str!("../tests/vectors/devnet-bridge-smoke/case-record.hex");
    const ANCHOR_HEX: [&str; 3] = [
        include_str!("../tests/vectors/devnet-bridge-smoke/anchor-submitted.hex"),
        include_str!("../tests/vectors/devnet-bridge-smoke/anchor-agent-reviewed.hex"),
        include_str!("../tests/vectors/devnet-bridge-smoke/anchor-auto-approved.hex"),
    ];

    fn bytes(hex_text: &str) -> Vec<u8> {
        hex::decode(hex_text.trim()).unwrap()
    }

    fn smoke_hash(step: &str) -> [u8; 32] {
        sha256(format!("bridge-smoke:{SMOKE_CASE_REF}:{step}").as_bytes())
    }

    fn key(text: &str) -> [u8; 32] {
        pubkey_from_base58(text).unwrap()
    }

    #[test]
    fn discriminators_match_values_observed_on_devnet() {
        assert_eq!(
            hex::encode(discriminator("account", "Vault")),
            "d308e82b02987577"
        );
        assert_eq!(
            hex::encode(discriminator("event", "VaultDeposited")),
            "3b3e2bc8dc686443"
        );
        assert_eq!(
            hex::encode(discriminator("global", "open_vault")),
            "b5f8e44306af25a7"
        );
        assert_eq!(
            &bytes(CASE_RECORD_HEX)[..8],
            discriminator("account", "CaseRecord")
        );
        assert_eq!(
            &bytes(ANCHOR_HEX[0])[..8],
            discriminator("account", "EvidenceAnchor")
        );
    }

    #[test]
    fn lengths_match_the_program_layout() {
        assert_eq!(CASE_RECORD_LEN, 254);
        assert_eq!(EVIDENCE_ANCHOR_LEN, 188);
        assert_eq!(bytes(CASE_RECORD_HEX).len(), CASE_RECORD_LEN);
        assert!(
            ANCHOR_HEX
                .iter()
                .all(|h| bytes(h).len() == EVIDENCE_ANCHOR_LEN)
        );
    }

    #[test]
    fn decodes_the_devnet_case_record_and_round_trips_its_bytes() {
        let data = bytes(CASE_RECORD_HEX);
        let record = CaseRecordAccount::decode(&data).unwrap();
        assert_eq!(record.case_id, sha256(SMOKE_CASE_REF.as_bytes()));
        assert_eq!(record.creator, key(SMOKE_CREATOR));
        assert_eq!(record.submitter, key(SMOKE_SUBMITTER));
        assert_eq!(record.agent, key(SMOKE_AGENT));
        assert_eq!(record.rule_engine, key(SMOKE_RULE_ENGINE));
        assert_eq!(record.approver, key(SMOKE_APPROVER));
        assert_eq!(
            (record.amount, record.autonomy_limit),
            (1_000_000, 2_000_000)
        );
        assert_eq!((record.state, record.transition_count), (3, 3));
        assert_eq!(record.last_evidence_hash, smoke_hash("auto-approved"));
        assert_eq!(record.encode(), data);
    }

    #[test]
    fn decodes_the_devnet_evidence_anchors_and_round_trips_their_bytes() {
        let case_id = sha256(SMOKE_CASE_REF.as_bytes());
        let expected = [
            ("submitted", case_id, 0, 1, SMOKE_SUBMITTER, 1),
            (
                "agent-reviewed",
                smoke_hash("submitted"),
                1,
                2,
                SMOKE_AGENT,
                2,
            ),
            (
                "auto-approved",
                smoke_hash("agent-reviewed"),
                2,
                3,
                SMOKE_RULE_ENGINE,
                3,
            ),
        ];
        for (hex_text, (step, prev, from, to, actor, kind)) in ANCHOR_HEX.iter().zip(expected) {
            let data = bytes(hex_text);
            let anchor = EvidenceAnchorAccount::decode(&data).unwrap();
            assert_eq!(anchor.evidence_hash, smoke_hash(step), "{step}");
            assert_eq!(anchor.case_record, key(SMOKE_CASE_RECORD));
            assert_eq!(anchor.prev_hash, prev);
            assert_eq!((anchor.from_state, anchor.to_state), (from, to));
            assert_eq!(anchor.actor, key(actor));
            assert_eq!(anchor.actor_kind, kind);
            assert_eq!(to_hex(&anchor.rule_hash), SUPPLIER_DOCS_V1_RULE_HASH);
            assert!(anchor.slot > 0 && anchor.unix_ts > 0);
            assert_eq!(anchor.encode(), data, "{step}");
        }
        assert_eq!(from_hex(SUPPLIER_DOCS_V1_RULE_HASH).unwrap().len(), 32);
    }

    #[test]
    fn rejects_wrong_type_and_wrong_length() {
        let anchor = bytes(ANCHOR_HEX[0]);
        let record = bytes(CASE_RECORD_HEX);
        assert!(matches!(
            CaseRecordAccount::decode(&anchor),
            Err(ModelError::InvalidAccount(_))
        ));
        assert!(matches!(
            EvidenceAnchorAccount::decode(&record),
            Err(ModelError::InvalidAccount(_))
        ));
        let mut renamed = anchor.clone();
        renamed[..8].copy_from_slice(&discriminator("account", "CaseRecord"));
        assert!(EvidenceAnchorAccount::decode(&renamed).is_err());
        assert!(CaseRecordAccount::decode(&record[..200]).is_err());
        let mut longer = record.clone();
        longer.push(0);
        assert!(CaseRecordAccount::decode(&longer).is_err());
    }

    #[test]
    fn base58_public_keys_are_strict() {
        let k = key(SMOKE_SUBMITTER);
        assert_eq!(pubkey_to_base58(&k), SMOKE_SUBMITTER);
        assert!(pubkey_from_base58("not-base58!").is_err());
        assert!(pubkey_from_base58("1111").is_err());
        assert!(pubkey_from_base58(&format!("1{SMOKE_SUBMITTER}")).is_err());
    }
}
