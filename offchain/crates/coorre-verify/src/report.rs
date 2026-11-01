use serde::Serialize;
use serde_json::Value;

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
    pub payload: Value,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn check(id: u8, status: Status) -> CheckResult {
        CheckResult {
            id,
            name: "check",
            status,
            details: vec![],
        }
    }

    fn report(statuses: &[Status]) -> Report {
        Report {
            summary: CaseSummary {
                case_ref: "urn:coorre:case:T".to_owned(),
                program_id: "P".to_owned(),
                case_record: "R".to_owned(),
                creator: None,
                submitter: None,
                agent: None,
                rule_engine: None,
                approver: None,
                amount_lamports: None,
                autonomy_limit_lamports: None,
                final_state: None,
            },
            timeline: vec![],
            checks: statuses
                .iter()
                .enumerate()
                .map(|(i, s)| check(i as u8 + 1, *s))
                .collect(),
        }
    }

    #[test]
    fn passed_requires_every_check_to_pass() {
        assert!(report(&[Status::Pass, Status::Pass]).passed());
        assert!(!report(&[Status::Pass, Status::Fail]).passed());
    }

    #[test]
    fn passed_count_counts_only_passing_checks() {
        assert_eq!(
            report(&[Status::Pass, Status::Fail, Status::Pass]).passed_count(),
            2
        );
        assert_eq!(report(&[Status::Fail]).passed_count(), 0);
    }

    #[test]
    fn status_serializes_in_upper_case() {
        assert_eq!(
            serde_json::to_string(&[Status::Pass, Status::Fail])
                .ok()
                .as_deref(),
            Some(r#"["PASS","FAIL"]"#)
        );
    }
}
