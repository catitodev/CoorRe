//! CoorRe engine: the case state machine (a replica of the on-chain checks)
//! and the deterministic "supplier-docs" rule. Pure functions, no I/O.

pub mod error;
pub mod machine;
pub mod rule;

pub use error::{EngineError, Result};
pub use machine::{
    AppliedTransition, CaseTracker, Payout, RoleKeys, check_transition, payout_for, required_role,
};
pub use rule::{Decision, DocumentKind, SubmittedDocument, SupplierDocsInput, evaluate};
