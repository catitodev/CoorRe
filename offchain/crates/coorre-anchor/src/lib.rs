pub mod bridge;
pub mod memory;

use coorre_model::Role;
use coorre_verify::{AccountSnapshot, Receipt};
use thiserror::Error;

pub use bridge::{BridgeAnchorer, BridgeConfig};
pub use memory::MemoryAnchorer;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenCaseRequest {
    pub case_id: [u8; 32],
    pub submitter: [u8; 32],
    pub agent: [u8; 32],
    pub rule_engine: [u8; 32],
    pub approver: [u8; 32],
    pub amount: u64,
    pub autonomy_limit: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnchorTransitionRequest {
    pub case_record: String,
    pub evidence_hash: [u8; 32],
    pub prev_hash: [u8; 32],
    pub to_state: u8,
    pub rule_hash: [u8; 32],
    pub actor: Role,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum AnchorError {
    #[error("rejected by the program: {name}")]
    Rejected {
        name: String,
        code: Option<u32>,
        message: String,
    },
    #[error("bridge error {name}: {message}")]
    Bridge { name: String, message: String },
    #[error("bridge process failed: {0}")]
    Process(String),
    #[error("unexpected bridge output: {0}")]
    Protocol(String),
}

impl AnchorError {
    pub fn rejection_name(&self) -> Option<&str> {
        match self {
            AnchorError::Rejected { name, .. } => Some(name),
            _ => None,
        }
    }
}

pub trait Anchorer {
    fn network_id(&self) -> &str;
    fn program_id(&self) -> &str;
    fn explorer_tx_url(&self, signature: &str) -> Option<String>;
    fn explorer_address_url(&self, address: &str) -> Option<String>;
    fn open_case(&mut self, request: &OpenCaseRequest) -> Result<Receipt, AnchorError>;
    fn anchor_transition(
        &mut self,
        request: &AnchorTransitionRequest,
    ) -> Result<Receipt, AnchorError>;
    fn fetch_account(&mut self, address: &str) -> Result<Option<AccountSnapshot>, AnchorError>;
}

pub const PROGRAM_ERRORS: [&str; 10] = [
    "InvalidTransition",
    "InvalidState",
    "UnauthorizedActor",
    "PrevHashMismatch",
    "CaseClosed",
    "RolesNotDistinct",
    "MandateExceeded",
    "InsufficientEscrow",
    "Overflow",
    "AmountBelowRentExempt",
];

pub fn role_name(role: Role) -> &'static str {
    match role {
        Role::Submitter => "submitter",
        Role::Agent => "agent",
        Role::RuleEngine => "rule_engine",
        Role::Approver => "approver",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn role_names_match_the_bridge_key_files() {
        assert_eq!(
            [
                Role::Submitter,
                Role::Agent,
                Role::RuleEngine,
                Role::Approver
            ]
            .map(role_name),
            ["submitter", "agent", "rule_engine", "approver"]
        );
    }

    #[test]
    fn program_error_table_matches_the_engine_names() {
        use coorre_engine::EngineError;
        let engine = [
            EngineError::InvalidTransition,
            EngineError::InvalidState(0),
            EngineError::UnauthorizedActor,
            EngineError::PrevHashMismatch,
            EngineError::CaseClosed,
            EngineError::RolesNotDistinct,
            EngineError::MandateExceeded,
            EngineError::Overflow,
            EngineError::AmountBelowRentExempt,
        ];
        for error in engine {
            let name = error.program_error_name().unwrap();
            assert!(PROGRAM_ERRORS.contains(&name), "{name}");
        }
    }

    #[test]
    fn rejection_name_only_for_program_rejections() {
        let rejected = AnchorError::Rejected {
            name: "MandateExceeded".into(),
            code: Some(6006),
            message: String::new(),
        };
        assert_eq!(rejected.rejection_name(), Some("MandateExceeded"));
        assert_eq!(AnchorError::Process("x".into()).rejection_name(), None);
    }
}
