//! Timestamp validation.

use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::error::{ModelError, Result};

/// Accepts any RFC 3339 date-time with an explicit offset (the profile of
/// XML Schema `dateTime` used by Verifiable Credentials).
pub fn validate_rfc3339(text: &str) -> Result<()> {
    OffsetDateTime::parse(text, &Rfc3339)
        .map(|_| ())
        .map_err(|_| ModelError::InvalidDatetime(text.to_owned()))
}

/// Accepts only the CoorRe timestamp form: UTC, second precision,
/// `YYYY-MM-DDTHH:MM:SSZ`.
pub fn validate_utc_seconds(text: &str) -> Result<()> {
    let shape_ok = text.len() == 20
        && text.bytes().enumerate().all(|(i, b)| match i {
            4 | 7 => b == b'-',
            10 => b == b'T',
            13 | 16 => b == b':',
            19 => b == b'Z',
            _ => b.is_ascii_digit(),
        });
    if !shape_ok {
        return Err(ModelError::InvalidDatetime(text.to_owned()));
    }
    validate_rfc3339(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc3339_accepts_offsets_and_fractions() {
        assert!(validate_rfc3339("2023-02-24T23:36:38Z").is_ok());
        assert!(validate_rfc3339("2026-10-09T09:00:00-03:00").is_ok());
        assert!(validate_rfc3339("2026-10-09T12:00:00.123Z").is_ok());
    }

    #[test]
    fn rfc3339_rejects_invalid_dates_and_missing_offset() {
        assert!(validate_rfc3339("2026-02-30T12:00:00Z").is_err());
        assert!(validate_rfc3339("2026-10-09T25:00:00Z").is_err());
        assert!(validate_rfc3339("2026-10-09T12:00:00").is_err());
        assert!(validate_rfc3339("2026-10-09").is_err());
        assert!(validate_rfc3339("").is_err());
    }

    #[test]
    fn utc_seconds_accepts_only_the_strict_form() {
        assert!(validate_utc_seconds("2026-10-09T12:00:00Z").is_ok());
        assert!(validate_utc_seconds("2026-10-09T12:00:00.5Z").is_err());
        assert!(validate_utc_seconds("2026-10-09T09:00:00-03:00").is_err());
        assert!(validate_utc_seconds("2026-10-09t12:00:00z").is_err());
        assert!(validate_utc_seconds("2026-13-09T12:00:00Z").is_err());
    }
}
