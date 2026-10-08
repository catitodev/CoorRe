pub mod bundle;
pub mod report;
pub mod verify;

pub use bundle::{AuditBundle, BUNDLE_FORMAT, BundleEvidence, Receipt};
pub use report::{CaseSummary, CheckResult, Report, Status, TimelineEntry};
pub use verify::{AccountSnapshot, Inputs, SOLANA_DEVNET_NETWORK_ID, verify};

pub const COORRE_DEVNET_PROGRAM_ID: &str = "9esN1A8K1SASLg17ob81dbSdB4VX8ozc6tBLmJ247Wv";
