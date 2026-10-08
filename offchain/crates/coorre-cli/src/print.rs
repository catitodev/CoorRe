use std::io::Write;

use coorre_verify::{Report, Status};

pub fn sol(lamports: u64) -> String {
    let whole = lamports / 1_000_000_000;
    let fraction = format!("{:09}", lamports % 1_000_000_000);
    let fraction = fraction.trim_end_matches('0');
    if fraction.is_empty() {
        format!("{whole} SOL")
    } else {
        format!("{whole}.{fraction} SOL")
    }
}

pub fn print_report(report: &Report, out: &mut dyn Write) -> std::io::Result<()> {
    let s = &report.summary;
    writeln!(out, "  case        {}", s.case_ref)?;
    writeln!(out, "  program     {}", s.program_id)?;
    writeln!(out, "  case record {}", s.case_record)?;
    if let (Some(state), Some(amount), Some(limit)) =
        (&s.final_state, s.amount_lamports, s.autonomy_limit_lamports)
    {
        writeln!(
            out,
            "  final state {state}, amount {}, automation limit {}",
            sol(amount),
            sol(limit)
        )?;
    }
    for (role, key) in [
        ("creator", &s.creator),
        ("submitter", &s.submitter),
        ("agent", &s.agent),
        ("rule engine", &s.rule_engine),
        ("approver", &s.approver),
    ] {
        if let Some(key) = key {
            writeln!(out, "  {role:<11} {key}")?;
        }
    }
    for check in &report.checks {
        let status = match check.status {
            Status::Pass => "PASS",
            Status::Fail => "FAIL",
        };
        writeln!(out, "  [{status}] {} {}", check.id, check.name)?;
        for detail in &check.details {
            writeln!(out, "         {detail}")?;
        }
    }
    writeln!(
        out,
        "  {}/{} checks passed{}",
        report.passed_count(),
        report.checks.len(),
        if report.passed() {
            ""
        } else {
            " — VERIFICATION FAILED"
        }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sol_formats_lamports_without_trailing_zeros() {
        assert_eq!(sol(50_000_000), "0.05 SOL");
        assert_eq!(sol(200_000_000), "0.2 SOL");
        assert_eq!(sol(1_000_000_000), "1 SOL");
        assert_eq!(sol(1_500_000_001), "1.500000001 SOL");
        assert_eq!(sol(0), "0 SOL");
    }
}
