use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Status {
    Pass,
    Fail,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CheckResult {
    pub id: u8,
    pub name: &'static str,
    pub status: Status,
    pub details: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TimelineEntry {
    pub from_state: String,
    pub to_state: String,
    pub actor_did: String,
    pub actor_kind: String,
    pub autonomy: String,
    pub valid_from: String,
    pub evidence_hash: String,
    pub anchor_account: String,
    pub anchor_slot: Option<u64>,
    pub anchor_unix_ts: Option<i64>,
    pub tx_signature: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CaseSummary {
    pub case_ref: String,
    pub program_id: String,
    pub case_record: String,
    pub creator: Option<String>,
    pub submitter: Option<String>,
    pub agent: Option<String>,
    pub rule_engine: Option<String>,
    pub approver: Option<String>,
    pub amount_lamports: Option<u64>,
    pub autonomy_limit_lamports: Option<u64>,
    pub final_state: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Report {
    pub summary: CaseSummary,
    pub timeline: Vec<TimelineEntry>,
    pub checks: Vec<CheckResult>,
}

impl Report {
    pub fn passed(&self) -> bool {
        self.checks.iter().all(|c| c.status == Status::Pass)
    }

    pub fn passed_count(&self) -> usize {
        self.checks
            .iter()
            .filter(|c| c.status == Status::Pass)
            .count()
    }
}
