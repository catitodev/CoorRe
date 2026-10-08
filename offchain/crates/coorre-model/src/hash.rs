//! SHA-256 helpers and the textual digest formats used across CoorRe.

use sha2::{Digest, Sha256};

use crate::error::{ModelError, Result};

/// Prefix used for digests embedded in evidence documents (`sha256:<hex>`).
pub const DIGEST_PREFIX: &str = "sha256:";

/// SHA-256 of `data`.
pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

/// Lowercase hex encoding of a 32-byte digest.
pub fn to_hex(digest: &[u8; 32]) -> String {
    hex::encode(digest)
}

/// Parses a digest written as exactly 64 lowercase hex characters.
pub fn from_hex(text: &str) -> Result<[u8; 32]> {
    let well_formed = text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !well_formed {
        return Err(ModelError::InvalidDigest(format!(
            "expected 64 lowercase hex characters, got `{text}`"
        )));
    }
    let mut digest = [0u8; 32];
    hex::decode_to_slice(text, &mut digest)
        .map_err(|e| ModelError::InvalidDigest(e.to_string()))?;
    Ok(digest)
}

/// Formats a digest as `sha256:<lowercase hex>`.
pub fn to_prefixed(digest: &[u8; 32]) -> String {
    format!("{DIGEST_PREFIX}{}", to_hex(digest))
}

/// Parses a `sha256:<lowercase hex>` string.
pub fn from_prefixed(text: &str) -> Result<[u8; 32]> {
    let hex_part = text.strip_prefix(DIGEST_PREFIX).ok_or_else(|| {
        ModelError::InvalidDigest(format!("missing `{DIGEST_PREFIX}` prefix in `{text}`"))
    })?;
    from_hex(hex_part)
}

#[cfg(test)]
mod tests {
    use super::*;

    // FIPS 180-2 / NIST example: SHA-256("abc").
    const ABC_HEX: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    #[test]
    fn sha256_matches_nist_abc_vector() {
        assert_eq!(to_hex(&sha256(b"abc")), ABC_HEX);
    }

    #[test]
    fn hex_round_trip() {
        let digest = sha256(b"abc");
        assert_eq!(from_hex(&to_hex(&digest)).unwrap(), digest);
    }

    #[test]
    fn from_hex_rejects_uppercase_wrong_length_and_non_hex() {
        assert!(from_hex(&ABC_HEX.to_uppercase()).is_err());
        assert!(from_hex(&ABC_HEX[..62]).is_err());
        assert!(from_hex(&format!("{ABC_HEX}00")).is_err());
        assert!(from_hex(&format!("{}zz", &ABC_HEX[..62])).is_err());
        assert!(from_hex("").is_err());
    }

    #[test]
    fn prefixed_round_trip() {
        let digest = sha256(b"abc");
        let text = to_prefixed(&digest);
        assert_eq!(text, format!("sha256:{ABC_HEX}"));
        assert_eq!(from_prefixed(&text).unwrap(), digest);
    }

    #[test]
    fn from_prefixed_requires_the_prefix() {
        assert!(from_prefixed(ABC_HEX).is_err());
        assert!(from_prefixed(&format!("SHA256:{ABC_HEX}")).is_err());
        assert!(from_prefixed(&format!("sha512:{ABC_HEX}")).is_err());
    }
}
