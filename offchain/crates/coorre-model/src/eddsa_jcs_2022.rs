//! The `eddsa-jcs-2022` cryptosuite (W3C Data Integrity EdDSA Cryptosuites
//! v1.0, section 3.3) and the CoorRe evidence hash.

use serde_json::{Map, Value};

use crate::datetime::validate_rfc3339;
use crate::did_key;
use crate::error::{ModelError, Result};
use crate::hash::sha256;
use crate::jcs;
use crate::keys::{Ed25519Keypair, verify_signature};

pub const PROOF_TYPE: &str = "DataIntegrityProof";
pub const CRYPTOSUITE: &str = "eddsa-jcs-2022";
pub const PROOF_PURPOSE_ASSERTION: &str = "assertionMethod";

const CONTEXT: &str = "@context";
const PROOF: &str = "proof";
const PROOF_VALUE: &str = "proofValue";

/// Proof options supplied by the signer. `type` and `cryptosuite` are fixed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProofOptions {
    pub created: String,
    pub verification_method: String,
    pub proof_purpose: String,
}

impl ProofOptions {
    /// Options for an `assertionMethod` proof.
    pub fn assertion(created: impl Into<String>, verification_method: impl Into<String>) -> Self {
        Self {
            created: created.into(),
            verification_method: verification_method.into(),
            proof_purpose: PROOF_PURPOSE_ASSERTION.to_owned(),
        }
    }

    /// JSON form of the options, in the member order used by the W3C examples.
    pub fn to_value(&self) -> Value {
        let mut options = Map::new();
        options.insert("type".to_owned(), Value::from(PROOF_TYPE));
        options.insert("cryptosuite".to_owned(), Value::from(CRYPTOSUITE));
        options.insert("created".to_owned(), Value::from(self.created.as_str()));
        options.insert(
            "verificationMethod".to_owned(),
            Value::from(self.verification_method.as_str()),
        );
        options.insert(
            "proofPurpose".to_owned(),
            Value::from(self.proof_purpose.as_str()),
        );
        Value::Object(options)
    }
}

/// Result of a successful proof verification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedProof {
    /// The `did:key` that issued the proof (verification method without fragment).
    pub did: String,
    /// Raw Ed25519 public key that produced the signature.
    pub public_key: [u8; 32],
    pub verification_method: String,
    pub proof_purpose: String,
    pub created: Option<String>,
}

/// Section 3.3.3: canonical (JCS) form of the unsecured document.
pub fn transform(unsecured_document: &Value) -> Result<Vec<u8>> {
    as_object(unsecured_document)?;
    jcs::canonicalize(unsecured_document)
}

/// Section 3.3.5: validates the proof options and returns their canonical form.
pub fn proof_configuration(proof_options: &Value) -> Result<Vec<u8>> {
    let options = as_object(proof_options)?;
    let proof_type = string_field(options, "type")?;
    if proof_type != PROOF_TYPE {
        return Err(ModelError::UnsupportedProofType(proof_type.to_owned()));
    }
    let cryptosuite = string_field(options, "cryptosuite")?;
    if cryptosuite != CRYPTOSUITE {
        return Err(ModelError::UnsupportedCryptosuite(cryptosuite.to_owned()));
    }
    if let Some(created) = options.get("created") {
        let created = created
            .as_str()
            .ok_or(ModelError::InvalidField("created"))?;
        validate_rfc3339(created)?;
    }
    jcs::canonicalize(proof_options)
}

/// Section 3.3.4: `SHA-256(proof configuration) || SHA-256(transformed document)`.
pub fn hash_data(transformed_document: &[u8], canonical_proof_config: &[u8]) -> [u8; 64] {
    let mut data = [0u8; 64];
    data[..32].copy_from_slice(&sha256(canonical_proof_config));
    data[32..].copy_from_slice(&sha256(transformed_document));
    data
}

/// Section 3.3.1: creates the proof object for `unsecured_document`.
pub fn create_proof(
    unsecured_document: &Value,
    options: &ProofOptions,
    keypair: &Ed25519Keypair,
) -> Result<Value> {
    let document = as_object(unsecured_document)?;
    if document.contains_key(PROOF) {
        return Err(ModelError::AlreadySecured);
    }
    let (_, method_key) =
        did_key::public_key_from_verification_method(&options.verification_method)?;
    if method_key != keypair.public_key() {
        return Err(ModelError::VerificationMethodMismatch);
    }

    let mut proof = options.to_value();
    if let (Some(context), Value::Object(proof_map)) = (document.get(CONTEXT), &mut proof) {
        proof_map.insert(CONTEXT.to_owned(), context.clone());
    }
    let proof_config = proof_configuration(&proof)?;
    let transformed = transform(unsecured_document)?;
    let signature = keypair.sign(&hash_data(&transformed, &proof_config));

    if let Value::Object(proof_map) = &mut proof {
        proof_map.insert(
            PROOF_VALUE.to_owned(),
            Value::from(encode_proof_value(&signature)),
        );
    }
    Ok(proof)
}

/// Returns a copy of `unsecured_document` with an `eddsa-jcs-2022` proof attached.
pub fn sign_document(
    unsecured_document: &Value,
    options: &ProofOptions,
    keypair: &Ed25519Keypair,
) -> Result<Value> {
    let proof = create_proof(unsecured_document, options, keypair)?;
    let mut secured = as_object(unsecured_document)?.clone();
    secured.insert(PROOF.to_owned(), proof);
    Ok(Value::Object(secured))
}

/// Section 3.3.2: verifies the single `eddsa-jcs-2022` proof of a secured
/// document. Only `did:key` verification methods are resolved.
pub fn verify_proof(secured_document: &Value) -> Result<VerifiedProof> {
    let document = as_object(secured_document)?;
    let proof = document
        .get(PROOF)
        .and_then(Value::as_object)
        .ok_or(ModelError::InvalidField(PROOF))?;

    let mut unsecured = document.clone();
    unsecured.remove(PROOF);
    let mut proof_options = proof.clone();
    proof_options.remove(PROOF_VALUE);
    let proof_bytes = decode_proof_value(string_field(proof, PROOF_VALUE)?)?;

    if let Some(proof_context) = proof_options.get(CONTEXT) {
        let document_context = document.get(CONTEXT).ok_or(ModelError::ContextMismatch)?;
        if !context_starts_with(document_context, proof_context) {
            return Err(ModelError::ContextMismatch);
        }
        unsecured.insert(CONTEXT.to_owned(), proof_context.clone());
    }

    let proof_options = Value::Object(proof_options);
    let transformed = transform(&Value::Object(unsecured))?;
    let proof_config = proof_configuration(&proof_options)?;
    let data = hash_data(&transformed, &proof_config);

    let options = as_object(&proof_options)?;
    let verification_method = string_field(options, "verificationMethod")?.to_owned();
    let proof_purpose = string_field(options, "proofPurpose")?.to_owned();
    let created = match options.get("created") {
        Some(value) => Some(
            value
                .as_str()
                .ok_or(ModelError::InvalidField("created"))?
                .to_owned(),
        ),
        None => None,
    };
    let (did, public_key) = did_key::public_key_from_verification_method(&verification_method)?;
    verify_signature(&public_key, &data, &proof_bytes)?;

    Ok(VerifiedProof {
        did,
        public_key,
        verification_method,
        proof_purpose,
        created,
    })
}

/// CoorRe evidence hash: `SHA-256(JCS(document without "proof"))`.
pub fn evidence_hash(document: &Value) -> Result<[u8; 32]> {
    let mut unsecured = as_object(document)?.clone();
    unsecured.remove(PROOF);
    jcs::hash(&Value::Object(unsecured))
}

/// Multibase base58btc encoding of a 64-byte signature.
pub fn encode_proof_value(signature: &[u8; 64]) -> String {
    format!(
        "{}{}",
        did_key::MULTIBASE_BASE58BTC,
        bs58::encode(signature).into_string()
    )
}

/// Decodes a multibase base58btc `proofValue` into a 64-byte signature.
pub fn decode_proof_value(text: &str) -> Result<[u8; 64]> {
    let encoded = text
        .strip_prefix(did_key::MULTIBASE_BASE58BTC)
        .ok_or_else(|| ModelError::InvalidProofValue("expected base58btc prefix `z`".to_owned()))?;
    let bytes = bs58::decode(encoded)
        .into_vec()
        .map_err(|e| ModelError::InvalidProofValue(e.to_string()))?;
    let signature: [u8; 64] = bytes.as_slice().try_into().map_err(|_| {
        ModelError::InvalidProofValue(format!("expected 64 bytes, got {}", bytes.len()))
    })?;
    if encode_proof_value(&signature) != text {
        return Err(ModelError::InvalidProofValue(
            "non-canonical encoding".to_owned(),
        ));
    }
    Ok(signature)
}

fn as_object(value: &Value) -> Result<&Map<String, Value>> {
    value.as_object().ok_or(ModelError::NotAnObject)
}

fn string_field<'a>(object: &'a Map<String, Value>, name: &'static str) -> Result<&'a str> {
    object
        .get(name)
        .and_then(Value::as_str)
        .ok_or(ModelError::InvalidField(name))
}

fn context_items(context: &Value) -> Vec<&Value> {
    match context {
        Value::Array(items) => items.iter().collect(),
        other => vec![other],
    }
}

fn context_starts_with(document_context: &Value, proof_context: &Value) -> bool {
    let document_items = context_items(document_context);
    let proof_items = context_items(proof_context);
    proof_items.len() <= document_items.len()
        && proof_items.iter().zip(&document_items).all(|(p, d)| p == d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const CREATED: &str = "2026-10-09T12:00:00Z";

    fn keypair() -> Ed25519Keypair {
        Ed25519Keypair::from_seed(&[11u8; 32])
    }

    fn document() -> Value {
        json!({
            "@context": ["https://www.w3.org/ns/credentials/v2", "https://coorre.example/ns/v1"],
            "id": "urn:uuid:00000000-0000-4000-8000-000000000000",
            "type": ["VerifiableCredential", "CoorReTransition"],
            "issuer": keypair().did(),
            "validFrom": CREATED,
            "credentialSubject": { "case": "urn:coorre:case:SUP-001", "toState": "SUBMITTED" }
        })
    }

    fn signed() -> Value {
        let key = keypair();
        sign_document(
            &document(),
            &ProofOptions::assertion(CREATED, key.verification_method()),
            &key,
        )
        .unwrap()
    }

    #[test]
    fn proof_options_to_value_has_fixed_type_and_cryptosuite() {
        let value = ProofOptions::assertion(CREATED, "vm").to_value();
        assert_eq!(value["type"], PROOF_TYPE);
        assert_eq!(value["cryptosuite"], CRYPTOSUITE);
        assert_eq!(value["proofPurpose"], PROOF_PURPOSE_ASSERTION);
        assert_eq!(value["created"], CREATED);
        assert_eq!(value["verificationMethod"], "vm");
    }

    #[test]
    fn transform_is_jcs_and_requires_an_object() {
        assert_eq!(
            transform(&json!({"b": 1, "a": 2})).unwrap(),
            br#"{"a":2,"b":1}"#
        );
        assert_eq!(transform(&json!([1])), Err(ModelError::NotAnObject));
    }

    #[test]
    fn proof_configuration_validates_type_cryptosuite_and_created() {
        let ok = ProofOptions::assertion(CREATED, "vm").to_value();
        assert!(proof_configuration(&ok).is_ok());

        let mut wrong_type = ok.clone();
        wrong_type["type"] = json!("Ed25519Signature2020");
        assert!(matches!(
            proof_configuration(&wrong_type),
            Err(ModelError::UnsupportedProofType(_))
        ));

        let mut wrong_suite = ok.clone();
        wrong_suite["cryptosuite"] = json!("eddsa-rdfc-2022");
        assert!(matches!(
            proof_configuration(&wrong_suite),
            Err(ModelError::UnsupportedCryptosuite(_))
        ));

        let mut bad_created = ok.clone();
        bad_created["created"] = json!("yesterday");
        assert!(matches!(
            proof_configuration(&bad_created),
            Err(ModelError::InvalidDatetime(_))
        ));
    }

    #[test]
    fn hash_data_puts_the_proof_config_hash_first() {
        let data = hash_data(b"doc", b"config");
        assert_eq!(data[..32], sha256(b"config"));
        assert_eq!(data[32..], sha256(b"doc"));
    }

    #[test]
    fn sign_then_verify_round_trip() {
        let secured = signed();
        let verified = verify_proof(&secured).unwrap();
        assert_eq!(verified.public_key, keypair().public_key());
        assert_eq!(verified.did, keypair().did());
        assert_eq!(
            verified.verification_method,
            keypair().verification_method()
        );
        assert_eq!(verified.proof_purpose, PROOF_PURPOSE_ASSERTION);
        assert_eq!(verified.created.as_deref(), Some(CREATED));
        assert_eq!(secured["proof"]["@context"], document()["@context"]);
    }

    #[test]
    fn create_proof_rejects_a_foreign_verification_method() {
        let other = Ed25519Keypair::from_seed(&[12u8; 32]);
        let options = ProofOptions::assertion(CREATED, other.verification_method());
        assert_eq!(
            create_proof(&document(), &options, &keypair()),
            Err(ModelError::VerificationMethodMismatch)
        );
    }

    #[test]
    fn create_proof_rejects_documents_that_already_have_a_proof() {
        let key = keypair();
        let options = ProofOptions::assertion(CREATED, key.verification_method());
        assert_eq!(
            create_proof(&signed(), &options, &key),
            Err(ModelError::AlreadySecured)
        );
    }

    #[test]
    fn verify_detects_any_change_to_the_document() {
        let mut tampered = signed();
        tampered["credentialSubject"]["toState"] = json!("APPROVED");
        assert_eq!(verify_proof(&tampered), Err(ModelError::SignatureInvalid));

        let mut extra = signed();
        extra["credentialSubject"]["extra"] = json!("x");
        assert_eq!(verify_proof(&extra), Err(ModelError::SignatureInvalid));
    }

    #[test]
    fn verify_detects_changes_to_the_proof_options() {
        let mut tampered = signed();
        tampered["proof"]["created"] = json!("2026-10-10T12:00:00Z");
        assert_eq!(verify_proof(&tampered), Err(ModelError::SignatureInvalid));
    }

    #[test]
    fn verify_rejects_a_proof_swapped_to_another_key() {
        let other = Ed25519Keypair::from_seed(&[12u8; 32]);
        let mut swapped = signed();
        swapped["proof"]["verificationMethod"] = json!(other.verification_method());
        assert_eq!(verify_proof(&swapped), Err(ModelError::SignatureInvalid));
    }

    #[test]
    fn verify_requires_matching_context_prefix() {
        let mut changed = signed();
        changed["@context"] = json!(["https://www.w3.org/ns/credentials/v2"]);
        assert_eq!(verify_proof(&changed), Err(ModelError::ContextMismatch));

        let mut missing = signed();
        missing.as_object_mut().unwrap().remove("@context");
        assert_eq!(verify_proof(&missing), Err(ModelError::ContextMismatch));
    }

    #[test]
    fn verify_reports_missing_or_malformed_proof_fields() {
        let mut no_proof = signed();
        no_proof.as_object_mut().unwrap().remove("proof");
        assert_eq!(
            verify_proof(&no_proof),
            Err(ModelError::InvalidField("proof"))
        );

        let mut no_value = signed();
        no_value["proof"]
            .as_object_mut()
            .unwrap()
            .remove("proofValue");
        assert_eq!(
            verify_proof(&no_value),
            Err(ModelError::InvalidField("proofValue"))
        );

        let mut bad_value = signed();
        bad_value["proof"]["proofValue"] = json!("uAAAA");
        assert!(matches!(
            verify_proof(&bad_value),
            Err(ModelError::InvalidProofValue(_))
        ));

        let mut no_purpose = signed();
        no_purpose["proof"]
            .as_object_mut()
            .unwrap()
            .remove("proofPurpose");
        assert!(verify_proof(&no_purpose).is_err());
    }

    #[test]
    fn evidence_hash_is_the_hash_of_the_canonical_unsecured_document() {
        let expected = sha256(&jcs::canonicalize(&document()).unwrap());
        assert_eq!(evidence_hash(&document()).unwrap(), expected);
        assert_eq!(evidence_hash(&signed()).unwrap(), expected);
        assert_eq!(evidence_hash(&json!("x")), Err(ModelError::NotAnObject));
    }

    #[test]
    fn proof_value_round_trip_and_errors() {
        let signature = [5u8; 64];
        let text = encode_proof_value(&signature);
        assert!(text.starts_with('z'));
        assert_eq!(decode_proof_value(&text).unwrap(), signature);
        assert!(decode_proof_value(&text[1..]).is_err());
        assert!(decode_proof_value("z111").is_err());
        assert!(decode_proof_value("z0OIl").is_err());
    }
}
