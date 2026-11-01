use std::cell::Cell;
use std::rc::Rc;

use anyhow::anyhow;
use coorre_anchor::memory::Clock;
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};

pub trait Environment {
    fn timestamp(&mut self) -> anyhow::Result<String>;
    fn uuid_urn(&mut self) -> String;
    fn today(&self) -> String;
    fn run_suffix(&self) -> String;
    fn clock(&self) -> anyhow::Result<Clock>;
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

    fn clock(&self) -> anyhow::Result<Clock> {
        Ok(Box::new(|| OffsetDateTime::now_utc().unix_timestamp()))
    }
}

pub struct FixedEnvironment {
    pub date: String,
    pub suffix: String,
    counter: Rc<Cell<u32>>,
}

impl FixedEnvironment {
    pub fn new(date: &str, suffix: &str) -> Self {
        Self {
            date: date.to_owned(),
            suffix: suffix.to_owned(),
            counter: Rc::new(Cell::new(0)),
        }
    }

    fn noon(&self) -> anyhow::Result<OffsetDateTime> {
        let day = coorre_engine::rule::parse_date(&self.date)
            .map_err(|e| anyhow!("fixed environment date: {e}"))?;
        Ok(day.midnight().assume_utc() + Duration::hours(12))
    }

    fn tick(&self) -> u32 {
        let next = self.counter.get() + 1;
        self.counter.set(next);
        next
    }
}

impl Environment for FixedEnvironment {
    fn timestamp(&mut self) -> anyhow::Result<String> {
        let seconds = self.tick();
        format_utc_seconds(self.noon()? + Duration::seconds(i64::from(seconds)))
    }

    fn uuid_urn(&mut self) -> String {
        format!("urn:uuid:00000000-0000-4000-8000-{:012x}", self.tick())
    }

    fn today(&self) -> String {
        self.date.clone()
    }

    fn run_suffix(&self) -> String {
        self.suffix.clone()
    }

    fn clock(&self) -> anyhow::Result<Clock> {
        let noon = self.noon()?.unix_timestamp();
        let counter = Rc::clone(&self.counter);
        Ok(Box::new(move || noon + i64::from(counter.get())))
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

    #[test]
    fn fixed_timestamps_stay_valid_past_one_hour_of_ticks() {
        let mut env = FixedEnvironment::new("2026-10-09", "TEST");
        for _ in 0..3_600 {
            env.uuid_urn();
        }
        assert_eq!(env.timestamp().unwrap(), "2026-10-09T13:00:01Z");
    }

    #[test]
    fn the_fixed_clock_follows_the_last_timestamp() {
        let mut env = FixedEnvironment::new("2026-10-09", "TEST");
        let mut clock = env.clock().unwrap();
        assert_eq!(clock(), 1_791_547_200);
        let stamp = env.timestamp().unwrap();
        assert_eq!(stamp, "2026-10-09T12:00:01Z");
        assert_eq!(clock(), 1_791_547_201);
        env.uuid_urn();
        assert_eq!(clock(), 1_791_547_202);
        assert!(FixedEnvironment::new("2026-02-30", "X").clock().is_err());
    }

    #[test]
    fn the_system_clock_reads_the_current_time() {
        let env = SystemEnvironment::new();
        let mut clock = env.clock().unwrap();
        let before = OffsetDateTime::now_utc().unix_timestamp();
        let read = clock();
        assert!((before..=before + 5).contains(&read), "{read} vs {before}");
    }
}
