use std::fmt;

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};

use crate::did_key;
use crate::error::{ModelError, Result};

pub const SOLANA_KEYPAIR_LENGTH: usize = 64;

pub struct Ed25519Keypair {
    signing_key: SigningKey,
}

impl Ed25519Keypair {
    pub fn from_seed(seed: &[u8; 32]) -> Self {
        Self {
            signing_key: SigningKey::from_bytes(seed),
        }
    }

    pub fn from_solana_keypair_bytes(bytes: &[u8]) -> Result<Self> {
        let bytes: &[u8; SOLANA_KEYPAIR_LENGTH] =
            bytes.try_into().map_err(|_| ModelError::InvalidKeyLength {
                expected: SOLANA_KEYPAIR_LENGTH,
                actual: bytes.len(),
            })?;
        let signing_key =
            SigningKey::from_keypair_bytes(bytes).map_err(|_| ModelError::KeypairMismatch)?;
        Ok(Self { signing_key })
    }

    pub fn from_solana_keypair_json(json: &str) -> Result<Self> {
        let bytes: Vec<u8> =
            serde_json::from_str(json).map_err(|e| ModelError::InvalidJson(e.to_string()))?;
        Self::from_solana_keypair_bytes(&bytes)
    }

    pub fn from_secret_key_multibase(text: &str) -> Result<Self> {
        Ok(Self::from_seed(&did_key::secret_key_from_multibase(text)?))
    }

    pub fn public_key(&self) -> [u8; 32] {
        self.signing_key.verifying_key().to_bytes()
    }

    pub fn did(&self) -> String {
        did_key::did_from_public_key(&self.public_key())
    }

    pub fn verification_method(&self) -> String {
        did_key::verification_method(&self.public_key())
    }

    pub fn sign(&self, message: &[u8]) -> [u8; 64] {
        self.signing_key.sign(message).to_bytes()
    }
}

impl fmt::Debug for Ed25519Keypair {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Ed25519Keypair")
            .field("did", &self.did())
            .finish_non_exhaustive()
    }
}

pub fn verify_signature(public_key: &[u8; 32], message: &[u8], signature: &[u8; 64]) -> Result<()> {
    let verifying_key =
        VerifyingKey::from_bytes(public_key).map_err(|_| ModelError::InvalidPublicKey)?;
    verifying_key
        .verify_strict(message, &Signature::from_bytes(signature))
        .map_err(|_| ModelError::SignatureInvalid)
}

#[cfg(test)]
mod tests {
    use super::*;

    const RFC8032_TEST1_SECRET: &str =
        "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
    const RFC8032_TEST1_PUBLIC: &str =
        "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
    const RFC8032_TEST1_SIGNATURE: &str = "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";

    fn rfc8032_keypair() -> Ed25519Keypair {
        let mut seed = [0u8; 32];
        hex::decode_to_slice(RFC8032_TEST1_SECRET, &mut seed).unwrap();
        Ed25519Keypair::from_seed(&seed)
    }

    fn solana_bytes(keypair: &Ed25519Keypair, seed: &[u8; 32]) -> Vec<u8> {
        let mut bytes = seed.to_vec();
        bytes.extend_from_slice(&keypair.public_key());
        bytes
    }

    #[test]
    fn from_seed_and_sign_match_rfc8032_test_1() {
        let keypair = rfc8032_keypair();
        assert_eq!(hex::encode(keypair.public_key()), RFC8032_TEST1_PUBLIC);
        assert_eq!(hex::encode(keypair.sign(b"")), RFC8032_TEST1_SIGNATURE);
    }

    #[test]
    fn verify_signature_accepts_valid_and_rejects_tampered() {
        let keypair = rfc8032_keypair();
        let signature = keypair.sign(b"coorre");
        assert!(verify_signature(&keypair.public_key(), b"coorre", &signature).is_ok());
        assert_eq!(
            verify_signature(&keypair.public_key(), b"coorrE", &signature),
            Err(ModelError::SignatureInvalid)
        );
        let mut flipped = signature;
        flipped[0] ^= 1;
        assert!(verify_signature(&keypair.public_key(), b"coorre", &flipped).is_err());
        let other = Ed25519Keypair::from_seed(&[1u8; 32]);
        assert!(verify_signature(&other.public_key(), b"coorre", &signature).is_err());
    }

    #[test]
    fn solana_keypair_bytes_round_trip() {
        let seed = [42u8; 32];
        let keypair = Ed25519Keypair::from_seed(&seed);
        let loaded =
            Ed25519Keypair::from_solana_keypair_bytes(&solana_bytes(&keypair, &seed)).unwrap();
        assert_eq!(loaded.public_key(), keypair.public_key());
    }

    #[test]
    fn solana_keypair_bytes_rejects_mismatch_and_bad_length() {
        let seed = [42u8; 32];
        let keypair = Ed25519Keypair::from_seed(&seed);
        let mut bytes = solana_bytes(&keypair, &seed);
        bytes[63] ^= 1;
        assert!(Ed25519Keypair::from_solana_keypair_bytes(&bytes).is_err());
        assert!(matches!(
            Ed25519Keypair::from_solana_keypair_bytes(&bytes[..32]),
            Err(ModelError::InvalidKeyLength {
                expected: 64,
                actual: 32
            })
        ));
    }

    #[test]
    fn solana_keypair_json_round_trip_and_errors() {
        let seed = [3u8; 32];
        let keypair = Ed25519Keypair::from_seed(&seed);
        let json = serde_json::to_string(&solana_bytes(&keypair, &seed)).unwrap();
        let loaded = Ed25519Keypair::from_solana_keypair_json(&json).unwrap();
        assert_eq!(loaded.public_key(), keypair.public_key());
        assert!(Ed25519Keypair::from_solana_keypair_json("[256]").is_err());
        assert!(Ed25519Keypair::from_solana_keypair_json("{}").is_err());
        assert!(Ed25519Keypair::from_solana_keypair_json("[1,2,3]").is_err());
    }

    #[test]
    fn from_secret_key_multibase_matches_w3c_example_29() {
        let keypair = Ed25519Keypair::from_secret_key_multibase(
            "z3u2en7t5LR2WtQH5PfFqMqwVHBeXouLzo6haApm8XHqvjxq",
        )
        .unwrap();
        assert_eq!(
            did_key::public_key_to_multibase(&keypair.public_key()),
            "z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2"
        );
    }

    #[test]
    fn did_and_verification_method_use_the_public_key() {
        let keypair = rfc8032_keypair();
        let multibase = did_key::public_key_to_multibase(&keypair.public_key());
        assert_eq!(keypair.did(), format!("did:key:{multibase}"));
        assert_eq!(
            keypair.verification_method(),
            format!("did:key:{multibase}#{multibase}")
        );
    }

    #[test]
    fn debug_output_never_contains_the_secret() {
        let keypair = rfc8032_keypair();
        let debug = format!("{keypair:?}");
        assert!(debug.contains("did:key:"));
        assert!(!debug.contains(RFC8032_TEST1_SECRET));
        assert!(!debug.to_lowercase().contains("9d61b19d"));
    }
}
