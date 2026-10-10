pub mod demo;
pub mod env;
pub mod files;
pub mod fixtures;
pub mod keys;
pub mod print;
pub mod snapshot;

use coorre_model::Role;

pub fn anchor_role_label(role: Role) -> &'static str {
    match role {
        Role::Submitter => "supplier",
        Role::Agent => "AI agent",
        Role::RuleEngine => "rule engine",
        Role::Approver => "approver",
    }
}
