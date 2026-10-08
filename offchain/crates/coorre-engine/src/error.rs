use thiserror::Error;

/// Engine errors. The transition errors carry the same names as the
/// on-chain program errors (ADR-001) so both sides report identically.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum EngineError {
    #[error("transition not allowed from the current state")]
    InvalidTransition,
    #[error("unknown state code {0}")]
    InvalidState(u8),
    #[error("signer is not the role key required for this transition")]
    UnauthorizedActor,
    #[error("prev_hash does not match the last anchored evidence")]
    PrevHashMismatch,
    #[error("case is already in a terminal state")]
    CaseClosed,
    #[error("role keys must be pairwise distinct")]
    RolesNotDistinct,
    #[error("amount exceeds the automated actor's autonomy limit")]
    MandateExceeded,
    #[error("amount is below the rent-exempt minimum of a payee account")]
    AmountBelowRentExempt,
    #[error("arithmetic overflow")]
    Overflow,
    #[error("invalid rule input: {0}")]
    InvalidRuleInput(String),
    #[error("rule definition error: {0}")]
    RuleDefinition(String),
}

impl EngineError {
    /// Name of the matching on-chain error, when there is one.
    pub fn program_error_name(&self) -> Option<&'static str> {
        Some(match self {
            EngineError::InvalidTransition => "InvalidTransition",
            EngineError::InvalidState(_) => "InvalidState",
            EngineError::UnauthorizedActor => "UnauthorizedActor",
            EngineError::PrevHashMismatch => "PrevHashMismatch",
            EngineError::CaseClosed => "CaseClosed",
            EngineError::RolesNotDistinct => "RolesNotDistinct",
            EngineError::MandateExceeded => "MandateExceeded",
            EngineError::AmountBelowRentExempt => "AmountBelowRentExempt",
            EngineError::Overflow => "Overflow",
            EngineError::InvalidRuleInput(_) | EngineError::RuleDefinition(_) => return None,
        })
    }
}

pub type Result<T> = core::result::Result<T, EngineError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn program_error_names_match_the_program() {
        let pairs = [
            (EngineError::InvalidTransition, "InvalidTransition"),
            (EngineError::InvalidState(9), "InvalidState"),
            (EngineError::UnauthorizedActor, "UnauthorizedActor"),
            (EngineError::PrevHashMismatch, "PrevHashMismatch"),
            (EngineError::CaseClosed, "CaseClosed"),
            (EngineError::RolesNotDistinct, "RolesNotDistinct"),
            (EngineError::MandateExceeded, "MandateExceeded"),
            (EngineError::AmountBelowRentExempt, "AmountBelowRentExempt"),
            (EngineError::Overflow, "Overflow"),
        ];
        for (error, name) in pairs {
            assert_eq!(error.program_error_name(), Some(name));
        }
        assert_eq!(
            EngineError::InvalidRuleInput("x".into()).program_error_name(),
            None
        );
        assert_eq!(
            EngineError::RuleDefinition("x".into()).program_error_name(),
            None
        );
    }
}
