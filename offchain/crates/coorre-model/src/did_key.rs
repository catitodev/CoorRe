//! `did:key` identifiers for Ed25519 public keys (multicodec `ed25519-pub`,
//! base58btc multibase), as used by eddsa-jcs-2022 verification methods.

use ed25519_dalek::VerifyingKey;

use crate::error::{ModelError, Result};

/// Prefix of every `did:key` identifier.
pub const DID_KEY_PREFIX: &str = "did:key:";
/// Multibase prefix for base58btc.
pub const MULTIBASE_BASE58BTC: char = 'z';
/// Varint-encoded multicodec `ed25519-pub` (0xed).
pub const ED25519_PUB_MULTICODEC: [u8; 2] = [0xed, 0x01];
/// Varint-encoded multicodec `ed25519-priv` (0x1300).
pub const ED25519_PRIV_MULTICODEC: [u8; 2] = [0x80, 0x26];

/// Multibase (`z...`) encoding of an Ed25519 public key with its multicodec.
pub fn public_key_to_multibase(public_key: &[u8; 32]) -> String {
    encode_multibase(&ED25519_PUB_MULTICODEC, public_key)
}

/// Decodes an Ed25519 public key from its multibase form and checks it is a
/// valid curve point.
pub fn public_key_from_multibase(text: &str) -> Result<[u8; 32]> {
    let key = decode_multibase(text, &ED25519_PUB_MULTICODEC, "ed25519-pub")?;
    VerifyingKey::from_bytes(&key).map_err(|_| ModelError::InvalidPublicKey)?;
    Ok(key)
}

/// Decodes a 32-byte Ed25519 secret seed from its multibase form (`ed25519-priv`).
pub fn secret_key_from_multibase(text: &str) -> Result<[u8; 32]> {
    decode_multibase(text, &ED25519_PRIV_MULTICODEC, "ed25519-priv")
}

/// `did:key:z...` identifier for an Ed25519 public key.
pub fn did_from_public_key(public_key: &[u8; 32]) -> String {
    format!("{DID_KEY_PREFIX}{}", public_key_to_multibase(public_key))
}

/// Extracts the Ed25519 public key from a `did:key` identifier (no fragment).
pub fn public_key_from_did(did: &str) -> Result<[u8; 32]> {
    let multibase = did
        .strip_prefix(DID_KEY_PREFIX)
        .ok_or_else(|| ModelError::InvalidDid(did.to_owned()))?;
    if multibase.contains(['#', '?', '/', ':']) {
        return Err(ModelError::InvalidDid(did.to_owned()));
    }
    public_key_from_multibase(multibase)
}

/// Verification method id `did:key:z...#z...` for an Ed25519 public key.
pub fn verification_method(public_key: &[u8; 32]) -> String {
    let multibase = public_key_to_multibase(public_key);
    format!("{DID_KEY_PREFIX}{multibase}#{multibase}")
}

/// Splits a verification method id into its DID and public key. The fragment
/// must repeat the DID's multibase value, as the did:key method defines.
pub fn public_key_from_verification_method(id: &str) -> Result<(String, [u8; 32])> {
    let (did, fragment) = id
        .split_once('#')
        .ok_or_else(|| ModelError::InvalidVerificationMethod(id.to_owned()))?;
    let public_key = public_key_from_did(did)?;
    if did.strip_prefix(DID_KEY_PREFIX) != Some(fragment) {
        return Err(ModelError::InvalidVerificationMethod(id.to_owned()));
    }
    Ok((did.to_owned(), public_key))
}

fn encode_multibase(codec: &[u8; 2], key: &[u8; 32]) -> String {
    let mut bytes = Vec::with_capacity(34);
    bytes.extend_from_slice(codec);
    bytes.extend_from_slice(key);
    format!("{MULTIBASE_BASE58BTC}{}", bs58::encode(bytes).into_string())
}

fn decode_multibase(text: &str, codec: &[u8; 2], codec_name: &'static str) -> Result<[u8; 32]> {
    let encoded = text
        .strip_prefix(MULTIBASE_BASE58BTC)
        .ok_or_else(|| ModelError::InvalidMultibase("expected base58btc prefix `z`".to_owned()))?;
    let bytes = bs58::decode(encoded)
        .into_vec()
        .map_err(|e| ModelError::InvalidMultibase(e.to_string()))?;
    let key_bytes =
        bytes
            .strip_prefix(codec.as_slice())
            .ok_or(ModelError::UnexpectedMulticodec {
                expected: codec_name,
            })?;
    let key: [u8; 32] = key_bytes
        .try_into()
        .map_err(|_| ModelError::InvalidKeyLength {
            expected: 32,
            actual: key_bytes.len(),
        })?;
    if encode_multibase(codec, &key) != text {
        return Err(ModelError::InvalidMultibase(
            "non-canonical encoding".to_owned(),
        ));
    }
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Keys published in W3C vc-di-eddsa, Appendix B.3 (Example 29).
    const W3C_PUBLIC: &str = "z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2";
    const W3C_SECRET: &str = "z3u2en7t5LR2WtQH5PfFqMqwVHBeXouLzo6haApm8XHqvjxq";

    #[test]
    fn public_key_multibase_round_trip() {
        let key = public_key_from_multibase(W3C_PUBLIC).unwrap();
        assert_eq!(public_key_to_multibase(&key), W3C_PUBLIC);
        assert!(W3C_PUBLIC.starts_with("z6Mk"));
    }

    #[test]
    fn secret_key_multibase_decodes_to_32_bytes() {
        let seed = secret_key_from_multibase(W3C_SECRET).unwrap();
        assert_eq!(seed.len(), 32);
    }

    #[test]
    fn multicodecs_are_not_interchangeable() {
        assert_eq!(
            public_key_from_multibase(W3C_SECRET),
            Err(ModelError::UnexpectedMulticodec {
                expected: "ed25519-pub"
            })
        );
        assert_eq!(
            secret_key_from_multibase(W3C_PUBLIC),
            Err(ModelError::UnexpectedMulticodec {
                expected: "ed25519-priv"
            })
        );
    }

    #[test]
    fn multibase_rejects_other_bases_bad_alphabet_and_wrong_length() {
        assert!(public_key_from_multibase(&W3C_PUBLIC.replacen('z', "f", 1)).is_err());
        assert!(public_key_from_multibase("z0OIl").is_err());
        let short = encode_short_key();
        assert!(matches!(
            public_key_from_multibase(&short),
            Err(ModelError::InvalidKeyLength {
                expected: 32,
                actual: 31
            })
        ));
    }

    fn encode_short_key() -> String {
        let mut bytes = ED25519_PUB_MULTICODEC.to_vec();
        bytes.extend_from_slice(&[7u8; 31]);
        format!("z{}", bs58::encode(bytes).into_string())
    }

    #[test]
    fn did_round_trip() {
        let key = public_key_from_multibase(W3C_PUBLIC).unwrap();
        let did = did_from_public_key(&key);
        assert_eq!(did, format!("did:key:{W3C_PUBLIC}"));
        assert_eq!(public_key_from_did(&did).unwrap(), key);
    }

    #[test]
    fn public_key_from_did_rejects_other_methods_and_fragments() {
        assert!(public_key_from_did(&format!("did:web:{W3C_PUBLIC}")).is_err());
        assert!(public_key_from_did(&format!("did:key:{W3C_PUBLIC}#{W3C_PUBLIC}")).is_err());
        assert!(public_key_from_did(W3C_PUBLIC).is_err());
        assert!(public_key_from_did("did:key:").is_err());
    }

    #[test]
    fn verification_method_round_trip() {
        let key = public_key_from_multibase(W3C_PUBLIC).unwrap();
        let id = verification_method(&key);
        assert_eq!(id, format!("did:key:{W3C_PUBLIC}#{W3C_PUBLIC}"));
        let (did, parsed) = public_key_from_verification_method(&id).unwrap();
        assert_eq!(did, format!("did:key:{W3C_PUBLIC}"));
        assert_eq!(parsed, key);
    }

    #[test]
    fn verification_method_fragment_must_match_the_key() {
        let other = public_key_to_multibase(&[9u8; 32]);
        assert!(
            public_key_from_verification_method(&format!("did:key:{W3C_PUBLIC}#{other}")).is_err()
        );
        assert!(public_key_from_verification_method(&format!("did:key:{W3C_PUBLIC}")).is_err());
        assert!(
            public_key_from_verification_method(&format!("did:key:{W3C_PUBLIC}#key-1")).is_err()
        );
    }
}
