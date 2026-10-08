use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

pub trait Environment {
    fn timestamp(&mut self) -> anyhow::Result<String>;
    fn uuid_urn(&mut self) -> String;
    fn today(&self) -> String;
    fn run_suffix(&self) -> String;
}

pub struct SystemEnvironment {
    started: OffsetDateTime,
}

impl SystemEnvironment {
    pub fn new() -> Self {
        Self {
            started: OffsetDateTime::now_utc(),
        }
    }
}

impl Default for SystemEnvironment {
    fn default() -> Self {
        Self::new()
    }
}

pub fn format_utc_seconds(at: OffsetDateTime) -> anyhow::Result<String> {
    Ok(at.replace_nanosecond(0)?.format(&Rfc3339)?)
}

pub fn run_suffix(at: OffsetDateTime) -> String {
    format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
        at.year(),
        u8::from(at.month()),
        at.day(),
        at.hour(),
        at.minute(),
        at.second()
    )
}

impl Environment for SystemEnvironment {
    fn timestamp(&mut self) -> anyhow::Result<String> {
        format_utc_seconds(OffsetDateTime::now_utc())
    }

    fn uuid_urn(&mut self) -> String {
        format!("urn:uuid:{}", uuid::Uuid::new_v4())
    }

    fn today(&self) -> String {
        self.started.date().to_string()
    }

    fn run_suffix(&self) -> String {
        run_suffix(self.started)
    }
}

pub struct FixedEnvironment {
    pub date: String,
    pub suffix: String,
    counter: u32,
}

impl FixedEnvironment {
    pub fn new(date: &str, suffix: &str) -> Self {
        Self {
            date: date.to_owned(),
            suffix: suffix.to_owned(),
            counter: 0,
        }
    }
}

impl Environment for FixedEnvironment {
    fn timestamp(&mut self) -> anyhow::Result<String> {
        self.counter += 1;
        Ok(format!(
            "{}T12:{:02}:{:02}Z",
            self.date,
            self.counter / 60,
            self.counter % 60
        ))
    }

    fn uuid_urn(&mut self) -> String {
        self.counter += 1;
        format!("urn:uuid:00000000-0000-4000-8000-{:012x}", self.counter)
    }

    fn today(&self) -> String {
        self.date.clone()
    }

    fn run_suffix(&self) -> String {
        self.suffix.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use coorre_model::datetime::validate_utc_seconds;
    use time::{Date, Month};

    #[test]
    fn system_timestamps_have_second_precision_in_utc() {
        let mut env = SystemEnvironment::new();
        let stamp = env.timestamp().unwrap();
        validate_utc_seconds(&stamp).unwrap();
        assert!(env.uuid_urn().starts_with("urn:uuid:"));
        assert_eq!(env.today().len(), 10);
        assert_eq!(env.run_suffix().len(), 16);
    }

    #[test]
    fn formatting_drops_subseconds_and_uses_z() {
        let at = Date::from_calendar_date(2026, Month::October, 8)
            .unwrap()
            .with_hms_nano(20, 5, 7, 123_456_789)
            .unwrap()
            .assume_utc();
        assert_eq!(format_utc_seconds(at).unwrap(), "2026-10-08T20:05:07Z");
        assert_eq!(run_suffix(at), "20261008T200507Z");
    }

    #[test]
    fn fixed_environment_is_deterministic_and_valid() {
        let mut env = FixedEnvironment::new("2026-10-09", "TEST");
        let stamp = env.timestamp().unwrap();
        validate_utc_seconds(&stamp).unwrap();
        assert_eq!(
            env.uuid_urn(),
            "urn:uuid:00000000-0000-4000-8000-000000000002"
        );
        assert_eq!(
            (env.today(), env.run_suffix()),
            ("2026-10-09".to_owned(), "TEST".to_owned())
        );
    }
}
