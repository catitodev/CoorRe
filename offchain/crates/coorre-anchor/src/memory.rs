use std::collections::{BTreeMap, BTreeSet};

use coorre_engine::{CaseTracker, EngineError, Payout, RoleKeys};
use coorre_model::accounts::{
    CaseRecordAccount, EvidenceAnchorAccount, pubkey_from_base58, pubkey_to_base58,
};
use coorre_model::hash::sha256;
use coorre_verify::{AccountSnapshot, Receipt};

use crate::{AnchorError, AnchorTransitionRequest, Anchorer, OpenCaseRequest};

pub const MEMORY_NETWORK_ID: &str = "memory:simulated";
pub const MEMORY_PROGRAM_ID: &str = "memory-simulator";

struct SimulatedCase {
    tracker: CaseTracker,
    creator: [u8; 32],
}

pub struct MemoryAnchorer {
    creator: [u8; 32],
    signers: RoleKeys,
    payout_floor: u64,
    cases: BTreeMap<String, SimulatedCase>,
    accounts: BTreeMap<String, AccountSnapshot>,
    evidence: BTreeSet<(String, [u8; 32])>,
    balances: BTreeMap<[u8; 32], i128>,
    slot: u64,
}

fn address(label: &str, parts: &[&[u8]]) -> String {
    let mut bytes = label.as_bytes().to_vec();
    for part in parts {
        bytes.extend_from_slice(part);
    }
    pubkey_to_base58(&sha256(&bytes))
}

fn rejected(error: EngineError) -> AnchorError {
    AnchorError::Rejected {
        name: error
            .program_error_name()
            .unwrap_or("InvalidInput")
            .to_owned(),
        code: None,
        message: error.to_string(),
    }
}

impl MemoryAnchorer {
    pub fn new(creator: [u8; 32], signers: RoleKeys, payout_floor: u64) -> Self {
        Self {
            creator,
            signers,
            payout_floor,
            cases: BTreeMap::new(),
            accounts: BTreeMap::new(),
            evidence: BTreeSet::new(),
            balances: BTreeMap::new(),
            slot: 0,
        }
    }

    pub fn balance_change(&self, key: &[u8; 32]) -> i128 {
        self.balances.get(key).copied().unwrap_or(0)
    }

    pub fn accounts(&self) -> &BTreeMap<String, AccountSnapshot> {
        &self.accounts
    }

    fn credit(&mut self, key: [u8; 32], amount: u64, sign: i128) {
        *self.balances.entry(key).or_insert(0) += sign * i128::from(amount);
    }

    fn receipt(&mut self, account: &str) -> Receipt {
        self.slot += 1;
        Receipt {
            network_id: MEMORY_NETWORK_ID.to_owned(),
            program_id: MEMORY_PROGRAM_ID.to_owned(),
            account: account.to_owned(),
            tx_signature: format!("simulated-{}", self.slot),
        }
    }

    fn store_record(&mut self, address: &str) {
        if let Some(case) = self.cases.get(address) {
            let t = &case.tracker;
            let roles = t.roles();
            let record = CaseRecordAccount {
                case_id: t.case_id(),
                creator: case.creator,
                submitter: roles.submitter,
                agent: roles.agent,
                rule_engine: roles.rule_engine,
                approver: roles.approver,
                amount: t.amount(),
                autonomy_limit: t.autonomy_limit(),
                state: t.state().code(),
                last_evidence_hash: t.last_evidence_hash(),
                transition_count: t.transition_count(),
                bump: 255,
            };
            self.accounts.insert(
                address.to_owned(),
                AccountSnapshot {
                    owner: MEMORY_PROGRAM_ID.to_owned(),
                    data: record.encode(),
                },
            );
        }
    }
}

impl Anchorer for MemoryAnchorer {
    fn network_id(&self) -> &str {
        MEMORY_NETWORK_ID
    }

    fn program_id(&self) -> &str {
        MEMORY_PROGRAM_ID
    }

    fn explorer_tx_url(&self, _signature: &str) -> Option<String> {
        None
    }

    fn explorer_address_url(&self, _address: &str) -> Option<String> {
        None
    }

    fn open_case(&mut self, r: &OpenCaseRequest) -> Result<Receipt, AnchorError> {
        let case_address = address("simulated-case", &[&self.creator, &r.case_id]);
        if self.cases.contains_key(&case_address) {
            return Err(AnchorError::Rejected {
                name: "AccountAlreadyInUse".to_owned(),
                code: None,
                message: "case record already exists".to_owned(),
            });
        }
        let roles = RoleKeys {
            submitter: r.submitter,
            agent: r.agent,
            rule_engine: r.rule_engine,
            approver: r.approver,
        };
        let tracker = CaseTracker::open(
            r.case_id,
            roles,
            r.amount,
            r.autonomy_limit,
            self.payout_floor,
        )
        .map_err(rejected)?;
        self.cases.insert(
            case_address.clone(),
            SimulatedCase {
                tracker,
                creator: self.creator,
            },
        );
        self.credit(self.creator, r.amount, -1);
        self.store_record(&case_address);
        Ok(self.receipt(&case_address))
    }

    fn anchor_transition(&mut self, r: &AnchorTransitionRequest) -> Result<Receipt, AnchorError> {
        let case_key = pubkey_from_base58(&r.case_record).map_err(|e| AnchorError::Bridge {
            name: "InvalidInput".to_owned(),
            message: e.to_string(),
        })?;
        if !self.cases.contains_key(&r.case_record) {
            return Err(AnchorError::Bridge {
                name: "AccountNotFound".to_owned(),
                message: "case record not found".to_owned(),
            });
        }
        if self
            .evidence
            .contains(&(r.case_record.clone(), r.evidence_hash))
        {
            return Err(AnchorError::Rejected {
                name: "AccountAlreadyInUse".to_owned(),
                code: None,
                message: "evidence anchor already exists".to_owned(),
            });
        }
        let actor = self.signers.key(r.actor);
        let (applied, amount, creator, submitter) = {
            let case = self
                .cases
                .get_mut(&r.case_record)
                .ok_or_else(|| AnchorError::Bridge {
                    name: "AccountNotFound".to_owned(),
                    message: "case record not found".to_owned(),
                })?;
            let applied = case
                .tracker
                .apply(r.to_state, actor, r.prev_hash, r.evidence_hash)
                .map_err(rejected)?;
            (
                applied,
                case.tracker.amount(),
                case.creator,
                case.tracker.roles().submitter,
            )
        };
        self.evidence
            .insert((r.case_record.clone(), r.evidence_hash));
        self.slot += 1;
        let anchor = EvidenceAnchorAccount {
            evidence_hash: r.evidence_hash,
            case_record: case_key,
            prev_hash: r.prev_hash,
            from_state: applied.from.code(),
            to_state: applied.to.code(),
            actor,
            actor_kind: applied.actor_kind.code(),
            rule_hash: r.rule_hash,
            slot: self.slot,
            unix_ts: 1_700_000_000 + i64::try_from(self.slot).unwrap_or(0),
            bump: 255,
        };
        let anchor_address = address("simulated-evidence", &[&case_key, &r.evidence_hash]);
        self.accounts.insert(
            anchor_address.clone(),
            AccountSnapshot {
                owner: MEMORY_PROGRAM_ID.to_owned(),
                data: anchor.encode(),
            },
        );
        match applied.payout {
            Some(Payout::Release) => self.credit(submitter, amount, 1),
            Some(Payout::Refund) => self.credit(creator, amount, 1),
            None => {}
        }
        self.store_record(&r.case_record);
        Ok(self.receipt(&anchor_address))
    }

    fn fetch_account(&mut self, address: &str) -> Result<Option<AccountSnapshot>, AnchorError> {
        Ok(self.accounts.get(address).cloned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use coorre_model::{CaseState, Role};

    const FLOOR: u64 = 650_240;

    fn signers() -> RoleKeys {
        RoleKeys {
            submitter: [2; 32],
            agent: [3; 32],
            rule_engine: [4; 32],
            approver: [5; 32],
        }
    }

    fn open(m: &mut MemoryAnchorer, amount: u64, limit: u64) -> String {
        let s = signers();
        m.open_case(&OpenCaseRequest {
            case_id: [9; 32],
            submitter: s.submitter,
            agent: s.agent,
            rule_engine: s.rule_engine,
            approver: s.approver,
            amount,
            autonomy_limit: limit,
        })
        .unwrap()
        .account
    }

    fn step(
        m: &mut MemoryAnchorer,
        case: &str,
        to: CaseState,
        actor: Role,
        prev: [u8; 32],
        hash: u8,
    ) -> Result<Receipt, AnchorError> {
        m.anchor_transition(&AnchorTransitionRequest {
            case_record: case.to_owned(),
            evidence_hash: [hash; 32],
            prev_hash: prev,
            to_state: to.code(),
            rule_hash: [7; 32],
            actor,
        })
    }

    #[test]
    fn mirrors_the_program_for_release_rejection_and_refund() {
        let mut m = MemoryAnchorer::new([1; 32], signers(), FLOOR);
        let case = open(&mut m, 3_000_000, 2_000_000);
        step(
            &mut m,
            &case,
            CaseState::Submitted,
            Role::Submitter,
            [9; 32],
            11,
        )
        .unwrap();
        step(
            &mut m,
            &case,
            CaseState::AgentReviewed,
            Role::Agent,
            [11; 32],
            12,
        )
        .unwrap();
        let rogue = step(
            &mut m,
            &case,
            CaseState::AutoApproved,
            Role::RuleEngine,
            [12; 32],
            13,
        )
        .unwrap_err();
        assert_eq!(rogue.rejection_name(), Some("MandateExceeded"));
        let wrong = step(
            &mut m,
            &case,
            CaseState::Escalated,
            Role::Agent,
            [12; 32],
            13,
        )
        .unwrap_err();
        assert_eq!(wrong.rejection_name(), Some("UnauthorizedActor"));
        step(
            &mut m,
            &case,
            CaseState::Escalated,
            Role::RuleEngine,
            [12; 32],
            13,
        )
        .unwrap();
        let replay = step(
            &mut m,
            &case,
            CaseState::Rejected,
            Role::Approver,
            [13; 32],
            13,
        )
        .unwrap_err();
        assert_eq!(replay.rejection_name(), Some("AccountAlreadyInUse"));
        step(
            &mut m,
            &case,
            CaseState::Rejected,
            Role::Approver,
            [13; 32],
            14,
        )
        .unwrap();
        assert_eq!(
            m.balance_change(&[1; 32]),
            0,
            "creator refunded exactly the amount"
        );
        assert_eq!(m.balance_change(&signers().submitter), 0);
        let record =
            CaseRecordAccount::decode(&m.fetch_account(&case).unwrap().unwrap().data).unwrap();
        assert_eq!(
            (record.state, record.transition_count),
            (CaseState::Rejected.code(), 4)
        );
    }

    #[test]
    fn release_credits_the_submitter_and_rejects_low_amounts_and_duplicates() {
        let mut m = MemoryAnchorer::new([1; 32], signers(), FLOOR);
        let case = open(&mut m, 1_000_000, 2_000_000);
        step(
            &mut m,
            &case,
            CaseState::Submitted,
            Role::Submitter,
            [9; 32],
            11,
        )
        .unwrap();
        step(
            &mut m,
            &case,
            CaseState::AgentReviewed,
            Role::Agent,
            [11; 32],
            12,
        )
        .unwrap();
        let receipt = step(
            &mut m,
            &case,
            CaseState::AutoApproved,
            Role::RuleEngine,
            [12; 32],
            13,
        )
        .unwrap();
        assert_eq!(m.balance_change(&signers().submitter), 1_000_000);
        let anchor = EvidenceAnchorAccount::decode(
            &m.fetch_account(&receipt.account).unwrap().unwrap().data,
        )
        .unwrap();
        assert_eq!((anchor.actor_kind, anchor.to_state), (3, 3));
        let s = signers();
        let duplicate = m.open_case(&OpenCaseRequest {
            case_id: [9; 32],
            submitter: s.submitter,
            agent: s.agent,
            rule_engine: s.rule_engine,
            approver: s.approver,
            amount: 1_000_000,
            autonomy_limit: 1,
        });
        assert_eq!(
            duplicate.unwrap_err().rejection_name(),
            Some("AccountAlreadyInUse")
        );
        let low = m.open_case(&OpenCaseRequest {
            case_id: [8; 32],
            submitter: s.submitter,
            agent: s.agent,
            rule_engine: s.rule_engine,
            approver: s.approver,
            amount: FLOOR - 1,
            autonomy_limit: 1,
        });
        assert_eq!(
            low.unwrap_err().rejection_name(),
            Some("AmountBelowRentExempt")
        );
        assert!(m.fetch_account("unknown").unwrap().is_none());
    }
}
