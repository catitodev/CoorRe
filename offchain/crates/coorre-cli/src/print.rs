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

fn is_hidden(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{200B}'..='\u{200F}'
                | '\u{202A}'..='\u{202E}'
                | '\u{2060}'..='\u{2069}'
                | '\u{FEFF}'
        )
}

pub fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if is_hidden(c) {
            out.extend(c.escape_unicode());
        } else {
            out.push(c);
        }
    }
    out
}

pub fn print_report(report: &Report, out: &mut dyn Write) -> std::io::Result<()> {
    let s = &report.summary;
    writeln!(out, "  case        {}", escape(&s.case_ref))?;
    writeln!(out, "  program     {}", escape(&s.program_id))?;
    writeln!(out, "  case record {}", escape(&s.case_record))?;
    if let (Some(state), Some(amount), Some(limit)) =
        (&s.final_state, s.amount_lamports, s.autonomy_limit_lamports)
    {
        writeln!(
            out,
            "  final state {}, amount {}, automation limit {}",
            escape(state),
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
            writeln!(out, "  {role:<11} {}", escape(key))?;
        }
    }
    for check in &report.checks {
        let status = match check.status {
            Status::Pass => "PASS",
            Status::Fail => "FAIL",
        };
        writeln!(out, "  [{status}] {} {}", check.id, escape(check.name))?;
        for detail in &check.details {
            writeln!(out, "         {}", escape(detail))?;
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

    #[test]
    fn escape_neutralizes_terminal_and_bidi_controls() {
        assert_eq!(escape("plain — text ✓"), "plain — text ✓");
        assert_eq!(escape("a\u{1b}[2Jb"), "a\\u{1b}[2Jb");
        assert_eq!(escape("x\ny\rz\t"), "x\\u{a}y\\u{d}z\\u{9}");
        assert_eq!(escape("\u{9b}\u{7f}"), "\\u{9b}\\u{7f}");
        assert_eq!(escape("abc\u{202e}cba"), "abc\\u{202e}cba");
        assert_eq!(
            escape("\u{2066}\u{200b}\u{feff}"),
            "\\u{2066}\\u{200b}\\u{feff}"
        );
    }

    #[test]
    fn print_report_escapes_every_string_from_the_bundle() {
        use coorre_verify::{CaseSummary, CheckResult};
        let report = Report {
            summary: CaseSummary {
                case_ref: "urn:coorre:case:X\u{1b}]0;owned\u{7}".to_owned(),
                program_id: "P\u{1b}[31m".to_owned(),
                case_record: "R\u{202e}".to_owned(),
                creator: Some("C\u{1b}".to_owned()),
                submitter: None,
                agent: None,
                rule_engine: None,
                approver: None,
                amount_lamports: Some(1),
                autonomy_limit_lamports: Some(2),
                final_state: Some("S\u{1b}".to_owned()),
            },
            timeline: vec![],
            checks: vec![CheckResult {
                id: 7,
                name: "check",
                status: Status::Fail,
                details: vec!["rule \u{1b}[2J\nFAKE [PASS] line".to_owned()],
            }],
        };
        let mut out = Vec::new();
        print_report(&report, &mut out).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(!text.contains('\u{1b}'), "{text}");
        assert!(!text.contains('\u{202e}'), "{text}");
        assert!(!text.contains('\u{7}'), "{text}");
        assert!(
            text.contains("rule \\u{1b}[2J\\u{a}FAKE [PASS] line"),
            "{text}"
        );
        assert_eq!(text.lines().filter(|l| l.contains("FAKE")).count(), 1);
    }
}
