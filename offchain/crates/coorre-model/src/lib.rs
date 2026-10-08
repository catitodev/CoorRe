//! CoorRe evidence model: RFC 8785 canonicalization, SHA-256 digests,
//! `did:key` identifiers and `eddsa-jcs-2022` Data Integrity proofs.
//!
//! Everything here is pure and free of I/O so it can run natively and in
//! WebAssembly.

pub mod datetime;
pub mod did_key;
pub mod eddsa_jcs_2022;
pub mod error;
pub mod hash;
pub mod jcs;
pub mod keys;

pub use eddsa_jcs_2022::{ProofOptions, VerifiedProof};
pub use error::{ModelError, Result};
pub use keys::Ed25519Keypair;
