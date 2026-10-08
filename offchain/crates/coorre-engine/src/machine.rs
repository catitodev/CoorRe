//! Case state machine. Mirrors `anchor_transition` in the on-chain program,
//! including the order of its checks, so the off-chain core can predict and
//! replay exactly what the program accepts.

use coorre_model::{ActorKind, CaseState, Role};

use crate::error::{EngineError, Result};

/// The only allowed transitions and the role that must sign each one.
pub fn required_role(from: CaseState, to: CaseState) -> Option<Role> {
    use CaseState::*;
    match (from, to) {
        (Open, Submitted) => Some(Role::Submitter),
        (Submitted, AgentReviewed) => Some(Role::Agent),
        (AgentReviewed, AutoApproved) | (AgentReviewed, Escalated) => Some(Role::RuleEngine),
        (Escalated, Approved) | (Escalated, Rejected) => Some(Role::Approver),
        _ => None,
    }
}

/// Escrow movement triggered by entering a terminal state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Payout {
    /// Escrow released to the submitter (AUTO_APPROVED, APPROVED).
    Release,
    /// Escrow refunded to the creator (REJECTED).
    Refund,
}

/// Payout caused by entering `to`, if any.
pub fn payout_for(to: CaseState) -> Option<Payout> {
    match to {
        CaseState::AutoApproved | CaseState::Approved => Some(Payout::Release),
        CaseState::Rejected => Some(Payout::Refund),
        _ => None,
    }
}

/// Validates a transition without keys or hashes: terminal source, allowed
/// pair and, for AUTO_APPROVED, the autonomy limit. Returns the signing role.
pub fn check_transition(
    from: CaseState,
    to: CaseState,
    amount: u64,
    autonomy_limit: u64,
) -> Result<Role> {
    if from.is_terminal() {
        return Err(EngineError::CaseClosed);
    }
    let role = required_role(from, to).ok_or(EngineError::InvalidTransition)?;
    if to == CaseState::AutoApproved && amount > autonomy_limit {
        return Err(EngineError::MandateExceeded);
    }
    Ok(role)
}

/// Public keys of the four roles of a case.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RoleKeys {
    pub submitter: [u8; 32],
    pub agent: [u8; 32],
    pub rule_engine: [u8; 32],
    pub approver: [u8; 32],
}

impl RoleKeys {
    pub fn key(&self, role: Role) -> [u8; 32] {
        match role {
            Role::Submitter => self.submitter,
            Role::Agent => self.agent,
            Role::RuleEngine => self.rule_engine,
            Role::Approver => self.approver,
        }
    }

    /// Separation of duties: the four keys must be pairwise distinct.
    pub fn ensure_distinct(&self) -> Result<()> {
        let keys = [self.submitter, self.agent, self.rule_engine, self.approver];
        for (i, a) in keys.iter().enumerate() {
            if keys[i + 1..].contains(a) {
                return Err(EngineError::RolesNotDistinct);
            }
        }
        Ok(())
    }
}

/// Result of an accepted transition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AppliedTransition {
    pub from: CaseState,
    pub to: CaseState,
    pub role: Role,
    pub actor_kind: ActorKind,
    pub payout: Option<Payout>,
}

/// Off-chain replica of a `CaseRecord`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaseTracker {
    case_id: [u8; 32],
    roles: RoleKeys,
    amount: u64,
    autonomy_limit: u64,
    state: CaseState,
    last_evidence_hash: [u8; 32],
    transition_count: u32,
}

impl CaseTracker {
    /// Mirrors `open_case`. `payout_floor` is the rent-exempt minimum of a
    /// zero-data account on the target network.
    pub fn open(
        case_id: [u8; 32],
        roles: RoleKeys,
        amount: u64,
        autonomy_limit: u64,
        payout_floor: u64,
    ) -> Result<Self> {
        roles.ensure_distinct()?;
        if amount < payout_floor {
            return Err(EngineError::AmountBelowRentExempt);
        }
        Ok(Self {
            case_id,
            roles,
            amount,
            autonomy_limit,
            state: CaseState::Open,
            last_evidence_hash: [0u8; 32],
            transition_count: 0,
        })
    }

    pub fn case_id(&self) -> [u8; 32] {
        self.case_id
    }

    pub fn roles(&self) -> RoleKeys {
        self.roles
    }

    pub fn amount(&self) -> u64 {
        self.amount
    }

    pub fn autonomy_limit(&self) -> u64 {
        self.autonomy_limit
    }

    pub fn state(&self) -> CaseState {
        self.state
    }

    pub fn last_evidence_hash(&self) -> [u8; 32] {
        self.last_evidence_hash
    }

    pub fn transition_count(&self) -> u32 {
        self.transition_count
    }

    /// The `prev_hash` the next transition must carry.
    pub fn expected_prev_hash(&self) -> [u8; 32] {
        if self.transition_count == 0 {
            self.case_id
        } else {
            self.last_evidence_hash
        }
    }

    /// Mirrors `anchor_transition`. The tracker is left unchanged on error.
    pub fn apply(
        &mut self,
        to_state: u8,
        actor: [u8; 32],
        prev_hash: [u8; 32],
        evidence_hash: [u8; 32],
    ) -> Result<AppliedTransition> {
        let from = self.state;
        if from.is_terminal() {
            return Err(EngineError::CaseClosed);
        }
        let to = CaseState::from_code(to_state).ok_or(EngineError::InvalidState(to_state))?;
        let role = required_role(from, to).ok_or(EngineError::InvalidTransition)?;
        if actor != self.roles.key(role) {
            return Err(EngineError::UnauthorizedActor);
        }
        if prev_hash != self.expected_prev_hash() {
            return Err(EngineError::PrevHashMismatch);
        }
        if to == CaseState::AutoApproved && self.amount > self.autonomy_limit {
            return Err(EngineError::MandateExceeded);
        }
        let count = self
            .transition_count
            .checked_add(1)
            .ok_or(EngineError::Overflow)?;

        self.state = to;
        self.last_evidence_hash = evidence_hash;
        self.transition_count = count;
        Ok(AppliedTransition {
            from,
            to,
            role,
            actor_kind: role.actor_kind(),
            payout: payout_for(to),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use CaseState::*;

    const ROLES: RoleKeys = RoleKeys {
        submitter: [1; 32],
        agent: [2; 32],
        rule_engine: [3; 32],
        approver: [4; 32],
    };
    const CASE_ID: [u8; 32] = [9; 32];
    const FLOOR: u64 = 650_240;

    fn open(amount: u64, limit: u64) -> CaseTracker {
        CaseTracker::open(CASE_ID, ROLES, amount, limit, FLOOR).unwrap()
    }

    fn step(
        t: &mut CaseTracker,
        to: CaseState,
        actor: [u8; 32],
        evidence: u8,
    ) -> Result<AppliedTransition> {
        let prev = t.expected_prev_hash();
        t.apply(to.code(), actor, prev, [evidence; 32])
    }

    #[test]
    fn required_role_matches_the_transition_table_exactly() {
        let allowed = [
            (Open, Submitted, Role::Submitter),
            (Submitted, AgentReviewed, Role::Agent),
            (AgentReviewed, AutoApproved, Role::RuleEngine),
            (AgentReviewed, Escalated, Role::RuleEngine),
            (Escalated, Approved, Role::Approver),
            (Escalated, Rejected, Role::Approver),
        ];
        for from in CaseState::ALL {
            for to in CaseState::ALL {
                let expected = allowed
                    .iter()
                    .find(|(f, t, _)| *f == from && *t == to)
                    .map(|(_, _, role)| *role);
                assert_eq!(required_role(from, to), expected, "{from:?} -> {to:?}");
            }
        }
    }

    #[test]
    fn payout_for_terminal_states() {
        assert_eq!(payout_for(AutoApproved), Some(Payout::Release));
        assert_eq!(payout_for(Approved), Some(Payout::Release));
        assert_eq!(payout_for(Rejected), Some(Payout::Refund));
        for state in [Open, Submitted, AgentReviewed, Escalated] {
            assert_eq!(payout_for(state), None);
        }
    }

    #[test]
    fn check_transition_enforces_terminal_table_and_mandate() {
        assert_eq!(check_transition(Open, Submitted, 5, 1), Ok(Role::Submitter));
        assert_eq!(
            check_transition(AgentReviewed, AutoApproved, 10, 10),
            Ok(Role::RuleEngine)
        );
        assert_eq!(
            check_transition(AgentReviewed, AutoApproved, 11, 10),
            Err(EngineError::MandateExceeded)
        );
        assert_eq!(
            check_transition(AgentReviewed, Escalated, 11, 10),
            Ok(Role::RuleEngine)
        );
        assert_eq!(
            check_transition(Open, Approved, 1, 1),
            Err(EngineError::InvalidTransition)
        );
        for terminal in [AutoApproved, Approved, Rejected] {
            assert_eq!(
                check_transition(terminal, Escalated, 1, 1),
                Err(EngineError::CaseClosed)
            );
        }
    }

    #[test]
    fn role_keys_lookup_and_distinctness() {
        assert_eq!(ROLES.key(Role::RuleEngine), [3; 32]);
        assert!(ROLES.ensure_distinct().is_ok());
        let pairs = [(0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3)];
        for (i, j) in pairs {
            let mut keys = [
                ROLES.submitter,
                ROLES.agent,
                ROLES.rule_engine,
                ROLES.approver,
            ];
            keys[j] = keys[i];
            let roles = RoleKeys {
                submitter: keys[0],
                agent: keys[1],
                rule_engine: keys[2],
                approver: keys[3],
            };
            assert_eq!(
                roles.ensure_distinct(),
                Err(EngineError::RolesNotDistinct),
                "{i},{j}"
            );
        }
    }

    #[test]
    fn open_checks_roles_and_payout_floor() {
        let same = RoleKeys {
            approver: ROLES.submitter,
            ..ROLES
        };
        assert_eq!(
            CaseTracker::open(CASE_ID, same, FLOOR, FLOOR, FLOOR),
            Err(EngineError::RolesNotDistinct)
        );
        assert_eq!(
            CaseTracker::open(CASE_ID, ROLES, FLOOR - 1, FLOOR, FLOOR),
            Err(EngineError::AmountBelowRentExempt)
        );
        let t = open(FLOOR, 0);
        assert_eq!(t.state(), Open);
        assert_eq!(t.transition_count(), 0);
        assert_eq!(t.expected_prev_hash(), CASE_ID);
        assert_eq!(t.last_evidence_hash(), [0; 32]);
        assert_eq!(
            (t.case_id(), t.roles(), t.amount(), t.autonomy_limit()),
            (CASE_ID, ROLES, FLOOR, 0)
        );
    }

    #[test]
    fn auto_approved_path_releases_within_the_mandate() {
        let mut t = open(1_000_000, 2_000_000);
        let a = step(&mut t, Submitted, ROLES.submitter, 1).unwrap();
        assert_eq!(
            (a.role, a.actor_kind, a.payout),
            (Role::Submitter, ActorKind::Human, None)
        );
        assert_eq!(t.expected_prev_hash(), [1; 32]);
        let b = step(&mut t, AgentReviewed, ROLES.agent, 2).unwrap();
        assert_eq!(b.actor_kind, ActorKind::Agent);
        let c = step(&mut t, AutoApproved, ROLES.rule_engine, 3).unwrap();
        assert_eq!(
            (c.from, c.to, c.actor_kind, c.payout),
            (
                AgentReviewed,
                AutoApproved,
                ActorKind::System,
                Some(Payout::Release)
            )
        );
        assert_eq!(
            (t.state(), t.transition_count(), t.last_evidence_hash()),
            (AutoApproved, 3, [3; 32])
        );
        assert_eq!(
            step(&mut t, Escalated, ROLES.rule_engine, 4),
            Err(EngineError::CaseClosed)
        );
    }

    #[test]
    fn above_the_mandate_requires_escalation_and_human_approval() {
        let mut t = open(3_000_000, 2_000_000);
        step(&mut t, Submitted, ROLES.submitter, 1).unwrap();
        step(&mut t, AgentReviewed, ROLES.agent, 2).unwrap();
        let before = t.clone();
        assert_eq!(
            step(&mut t, AutoApproved, ROLES.rule_engine, 3),
            Err(EngineError::MandateExceeded)
        );
        assert_eq!(
            t, before,
            "rejected transition leaves the tracker unchanged"
        );
        step(&mut t, Escalated, ROLES.rule_engine, 3).unwrap();
        let approved = step(&mut t, Approved, ROLES.approver, 4).unwrap();
        assert_eq!(
            (approved.actor_kind, approved.payout),
            (ActorKind::Human, Some(Payout::Release))
        );
    }

    #[test]
    fn rejected_path_refunds() {
        let mut t = open(3_000_000, 2_000_000);
        step(&mut t, Submitted, ROLES.submitter, 1).unwrap();
        step(&mut t, AgentReviewed, ROLES.agent, 2).unwrap();
        step(&mut t, Escalated, ROLES.rule_engine, 3).unwrap();
        let rejected = step(&mut t, Rejected, ROLES.approver, 4).unwrap();
        assert_eq!(rejected.payout, Some(Payout::Refund));
        assert_eq!(
            step(&mut t, Approved, ROLES.approver, 5),
            Err(EngineError::CaseClosed)
        );
    }

    #[test]
    fn apply_reports_errors_in_program_order() {
        let mut t = open(3_000_000, 2_000_000);
        assert_eq!(
            t.apply(7, ROLES.submitter, CASE_ID, [1; 32]),
            Err(EngineError::InvalidState(7))
        );
        assert_eq!(
            t.apply(Approved.code(), [7; 32], [0; 32], [1; 32]),
            Err(EngineError::InvalidTransition)
        );
        assert_eq!(
            t.apply(Submitted.code(), ROLES.agent, [0; 32], [1; 32]),
            Err(EngineError::UnauthorizedActor)
        );
        assert_eq!(
            t.apply(Submitted.code(), ROLES.submitter, [0; 32], [1; 32]),
            Err(EngineError::PrevHashMismatch)
        );
        step(&mut t, Submitted, ROLES.submitter, 1).unwrap();
        assert_eq!(
            t.apply(AgentReviewed.code(), ROLES.agent, CASE_ID, [2; 32]),
            Err(EngineError::PrevHashMismatch)
        );
        step(&mut t, AgentReviewed, ROLES.agent, 2).unwrap();
        // Agent is not the role for AUTO_APPROVED: UnauthorizedActor wins over MandateExceeded.
        assert_eq!(
            step(&mut t, AutoApproved, ROLES.agent, 3),
            Err(EngineError::UnauthorizedActor)
        );
        assert_eq!(
            step(&mut t, AutoApproved, ROLES.rule_engine, 3),
            Err(EngineError::MandateExceeded)
        );
        assert_eq!(t.state(), AgentReviewed);
    }
}
