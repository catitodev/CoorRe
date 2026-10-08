#![allow(
    clippy::unwrap_used,
    reason = "test-only crate; fixtures are known-good"
)]

use coorre_model::eddsa_jcs_2022::{
    ProofOptions, create_proof, decode_proof_value, encode_proof_value, evidence_hash, hash_data,
    proof_configuration, transform, verify_proof,
};
use coorre_model::hash::{sha256, to_hex};
use coorre_model::keys::verify_signature;
use coorre_model::{Ed25519Keypair, ModelError, did_key, jcs};
use serde_json::{Value, json};

const EX30_CREDENTIAL: &str = include_str!("vectors/w3c-vc-di-eddsa-b3/credential.json");
const EX31_CANONICAL_CREDENTIAL: &str =
    include_str!("vectors/w3c-vc-di-eddsa-b3/canonical-credential.json");
const EX33_PROOF_OPTIONS: &str = include_str!("vectors/w3c-vc-di-eddsa-b3/proof-options.json");
const EX34_CANONICAL_PROOF_OPTIONS: &str =
    include_str!("vectors/w3c-vc-di-eddsa-b3/canonical-proof-options.json");
const EX39_SIGNED_CREDENTIAL: &str =
    include_str!("vectors/w3c-vc-di-eddsa-b3/signed-credential.json");

const EX29_PUBLIC_KEY_MULTIBASE: &str = "z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2";
const EX29_SECRET_KEY_MULTIBASE: &str = "z3u2en7t5LR2WtQH5PfFqMqwVHBeXouLzo6haApm8XHqvjxq";
const EX32_CREDENTIAL_HASH: &str =
    "59b7cb6251b8991add1ce0bc83107e3db9dbbab5bd2c28f687db1a03abc92f19";
const EX35_PROOF_OPTIONS_HASH: &str =
    "66ab154f5c2890a140cb8388a22a160454f80575f6eae09e5a097cabe539a1db";
const EX36_HASH_DATA: &str = "66ab154f5c2890a140cb8388a22a160454f80575f6eae09e5a097cabe539a1db59b7cb6251b8991add1ce0bc83107e3db9dbbab5bd2c28f687db1a03abc92f19";
const EX37_SIGNATURE_HEX: &str = "407cd12654b33d718ecbb99179a1506daaa849450bf3fc523cce3e1c96f8b80351da3f253d725c6f00b07c9e5448d50b3ef78012b9ab54255116d069c6dd2808";
const EX38_PROOF_VALUE: &str =
    "z2HnFSSPPBzR36zdDgK8PbEHeXbR56YF24jwMpt3R1eHXQzJDMWS93FCzpvJpwTWd3GAVFuUfjoJdcnTMuVor51aX";

fn load(text: &str) -> Value {
    jcs::parse(text).unwrap()
}

fn keypair() -> Ed25519Keypair {
    Ed25519Keypair::from_secret_key_multibase(EX29_SECRET_KEY_MULTIBASE).unwrap()
}

#[test]
fn secret_key_derives_the_published_public_key() {
    let public_key = keypair().public_key();
    assert_eq!(
        did_key::public_key_to_multibase(&public_key),
        EX29_PUBLIC_KEY_MULTIBASE
    );
}

#[test]
fn canonical_credential_and_hash_match_examples_31_and_32() {
    let transformed = transform(&load(EX30_CREDENTIAL)).unwrap();
    assert_eq!(
        String::from_utf8(transformed.clone()).unwrap(),
        EX31_CANONICAL_CREDENTIAL
    );
    assert_eq!(to_hex(&sha256(&transformed)), EX32_CREDENTIAL_HASH);
    assert_eq!(
        to_hex(&evidence_hash(&load(EX39_SIGNED_CREDENTIAL)).unwrap()),
        EX32_CREDENTIAL_HASH
    );
}

#[test]
fn canonical_proof_options_and_hash_match_examples_34_and_35() {
    let config = proof_configuration(&load(EX33_PROOF_OPTIONS)).unwrap();
    assert_eq!(
        String::from_utf8(config.clone()).unwrap(),
        EX34_CANONICAL_PROOF_OPTIONS
    );
    assert_eq!(to_hex(&sha256(&config)), EX35_PROOF_OPTIONS_HASH);
}

#[test]
fn combined_hash_signature_and_proof_value_match_examples_36_to_38() {
    let transformed = transform(&load(EX30_CREDENTIAL)).unwrap();
    let config = proof_configuration(&load(EX33_PROOF_OPTIONS)).unwrap();
    let data = hash_data(&transformed, &config);
    assert_eq!(hex::encode(data), EX36_HASH_DATA);

    let signature = keypair().sign(&data);
    assert_eq!(hex::encode(signature), EX37_SIGNATURE_HEX);
    assert_eq!(encode_proof_value(&signature), EX38_PROOF_VALUE);
    assert_eq!(decode_proof_value(EX38_PROOF_VALUE).unwrap(), signature);
}

#[test]
fn create_proof_reproduces_the_published_proof_of_example_39() {
    let key = keypair();
    let options = ProofOptions::assertion("2023-02-24T23:36:38Z", key.verification_method());
    let proof = create_proof(&load(EX30_CREDENTIAL), &options, &key).unwrap();
    assert_eq!(proof, load(EX39_SIGNED_CREDENTIAL)["proof"]);
}

#[test]
fn published_signed_credential_verifies_with_the_published_key() {
    let verified = verify_proof(&load(EX39_SIGNED_CREDENTIAL)).unwrap();
    assert_eq!(
        did_key::public_key_to_multibase(&verified.public_key),
        EX29_PUBLIC_KEY_MULTIBASE
    );
    assert_eq!(verified.did, format!("did:key:{EX29_PUBLIC_KEY_MULTIBASE}"));
    assert_eq!(verified.proof_purpose, "assertionMethod");
    assert_eq!(verified.created.as_deref(), Some("2023-02-24T23:36:38Z"));

    let mut data = [0u8; 64];
    hex::decode_to_slice(EX36_HASH_DATA, &mut data).unwrap();
    let signature = decode_proof_value(EX38_PROOF_VALUE).unwrap();
    assert!(verify_signature(&verified.public_key, &data, &signature).is_ok());
}

#[test]
fn tampering_with_the_published_credential_breaks_verification() {
    let mut tampered = load(EX39_SIGNED_CREDENTIAL);
    tampered["credentialSubject"]["alumniOf"] = json!("The School of Counterexamples");
    assert_eq!(verify_proof(&tampered), Err(ModelError::SignatureInvalid));

    let mut forged = load(EX39_SIGNED_CREDENTIAL);
    let mut signature = decode_proof_value(EX38_PROOF_VALUE).unwrap();
    signature[10] ^= 0x01;
    forged["proof"]["proofValue"] = json!(encode_proof_value(&signature));
    assert_eq!(verify_proof(&forged), Err(ModelError::SignatureInvalid));
}

#[test]
fn key_order_and_whitespace_do_not_change_the_hash() {
    let reordered = r#"{"validFrom":"2023-01-01T00:00:00Z",
        "credentialSubject" : { "alumniOf" : "The School of Examples", "id" : "did:example:abcdefgh" },
        "type":["VerifiableCredential","AlumniCredential"],   "issuer":"https://vc.example/issuers/5678",
        "name":"Alumni Credential",
        "description":"A minimum viable example of an Alumni Credential.",
        "id":"urn:uuid:58172aac-d8ba-11ed-83dd-0b3aef56cc33",
        "@context":["https://www.w3.org/ns/credentials/v2","https://www.w3.org/ns/credentials/examples/v2"]}"#;
    let original = evidence_hash(&load(EX30_CREDENTIAL)).unwrap();
    assert_eq!(evidence_hash(&load(reordered)).unwrap(), original);
    assert_eq!(
        evidence_hash(&load(EX31_CANONICAL_CREDENTIAL)).unwrap(),
        original
    );
    assert_eq!(to_hex(&original), EX32_CREDENTIAL_HASH);
}
