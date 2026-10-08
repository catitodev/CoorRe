use sha2::{Digest, Sha256};

use crate::error::{ModelError, Result};

pub const DIGEST_PREFIX: &str = "sha256:";

pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

pub fn to_hex(digest: &[u8; 32]) -> String {
    hex::encode(digest)
}

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

pub fn to_prefixed(digest: &[u8; 32]) -> String {
    format!("{DIGEST_PREFIX}{}", to_hex(digest))
}

pub fn from_prefixed(text: &str) -> Result<[u8; 32]> {
    let hex_part = text.strip_prefix(DIGEST_PREFIX).ok_or_else(|| {
        ModelError::InvalidDigest(format!("missing `{DIGEST_PREFIX}` prefix in `{text}`"))
    })?;
    from_hex(hex_part)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIPS180_SHA256_ABC_HEX: &str =
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    #[test]
    fn sha256_matches_nist_abc_vector() {
        assert_eq!(to_hex(&sha256(b"abc")), FIPS180_SHA256_ABC_HEX);
    }

    #[test]
    fn hex_round_trip() {
        let digest = sha256(b"abc");
        assert_eq!(from_hex(&to_hex(&digest)).unwrap(), digest);
    }

    #[test]
    fn from_hex_rejects_uppercase_wrong_length_and_non_hex() {
        assert!(from_hex(&FIPS180_SHA256_ABC_HEX.to_uppercase()).is_err());
        assert!(from_hex(&FIPS180_SHA256_ABC_HEX[..62]).is_err());
        assert!(from_hex(&format!("{FIPS180_SHA256_ABC_HEX}00")).is_err());
        assert!(from_hex(&format!("{}zz", &FIPS180_SHA256_ABC_HEX[..62])).is_err());
        assert!(from_hex("").is_err());
    }

    #[test]
    fn prefixed_round_trip() {
        let digest = sha256(b"abc");
        let text = to_prefixed(&digest);
        assert_eq!(text, format!("sha256:{FIPS180_SHA256_ABC_HEX}"));
        assert_eq!(from_prefixed(&text).unwrap(), digest);
    }

    #[test]
    fn from_prefixed_requires_the_prefix() {
        assert!(from_prefixed(FIPS180_SHA256_ABC_HEX).is_err());
        assert!(from_prefixed(&format!("SHA256:{FIPS180_SHA256_ABC_HEX}")).is_err());
        assert!(from_prefixed(&format!("sha512:{FIPS180_SHA256_ABC_HEX}")).is_err());
    }
}
