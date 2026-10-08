use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ModelError {
    #[error("invalid JSON: {0}")]
    InvalidJson(String),
    #[error("JCS canonicalization failed: {0}")]
    Canonicalization(String),
    #[error("invalid SHA-256 digest: {0}")]
    InvalidDigest(String),
    #[error("invalid multibase value: {0}")]
    InvalidMultibase(String),
    #[error("unexpected multicodec prefix, expected {expected}")]
    UnexpectedMulticodec { expected: &'static str },
    #[error("invalid key length: expected {expected} bytes, got {actual}")]
    InvalidKeyLength { expected: usize, actual: usize },
    #[error("invalid Ed25519 public key")]
    InvalidPublicKey,
    #[error("keypair public key does not match its secret seed")]
    KeypairMismatch,
    #[error("invalid did:key identifier: {0}")]
    InvalidDid(String),
    #[error("invalid verification method: {0}")]
    InvalidVerificationMethod(String),
    #[error("verification method does not belong to the signing key")]
    VerificationMethodMismatch,
    #[error("expected a JSON object")]
    NotAnObject,
    #[error("missing or invalid field `{0}`")]
    InvalidField(&'static str),
    #[error("document already contains a proof")]
    AlreadySecured,
    #[error("unsupported proof type `{0}`")]
    UnsupportedProofType(String),
    #[error("unsupported cryptosuite `{0}`")]
    UnsupportedCryptosuite(String),
    #[error("invalid datetime `{0}`")]
    InvalidDatetime(String),
    #[error("document @context does not start with the proof @context")]
    ContextMismatch,
    #[error("invalid proofValue: {0}")]
    InvalidProofValue(String),
    #[error("signature verification failed")]
    SignatureInvalid,
    #[error("invalid evidence document: {0}")]
    InvalidEvidence(String),
}

pub type Result<T> = core::result::Result<T, ModelError>;
