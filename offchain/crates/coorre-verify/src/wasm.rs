use std::collections::BTreeMap;

use wasm_bindgen::prelude::*;

use crate::{
    AccountSnapshot, AuditBundle, COORRE_DEVNET_PROGRAM_ID, Inputs, SOLANA_DEVNET_NETWORK_ID,
    verify,
};

#[wasm_bindgen]
pub struct BundleVerifier {
    bundle: AuditBundle,
    artifacts: BTreeMap<String, Vec<u8>>,
    accounts: BTreeMap<String, AccountSnapshot>,
}

#[wasm_bindgen]
impl BundleVerifier {
    #[wasm_bindgen(constructor)]
    pub fn new(bundle_json: &str) -> Result<BundleVerifier, JsError> {
        Ok(Self {
            bundle: AuditBundle::from_json(bundle_json)?,
            artifacts: BTreeMap::new(),
            accounts: BTreeMap::new(),
        })
    }

    #[wasm_bindgen(js_name = requiredAccounts)]
    pub fn required_accounts(&self) -> Result<String, JsError> {
        Ok(serde_json::to_string(&self.bundle.required_accounts())?)
    }

    #[wasm_bindgen(js_name = declaredArtifacts)]
    pub fn declared_artifacts(&self) -> Result<String, JsError> {
        Ok(serde_json::to_string(
            &self.bundle.declared_artifact_names(),
        )?)
    }

    #[wasm_bindgen(js_name = caseRef)]
    pub fn case_ref(&self) -> String {
        self.bundle.case_ref.clone()
    }

    #[wasm_bindgen(js_name = bundleProgramId)]
    pub fn bundle_program_id(&self) -> String {
        self.bundle.program_id.clone()
    }

    #[wasm_bindgen(js_name = bundleNetworkId)]
    pub fn bundle_network_id(&self) -> String {
        self.bundle.network_id.clone()
    }

    #[wasm_bindgen(js_name = addArtifact)]
    pub fn add_artifact(&mut self, name: &str, bytes: &[u8]) {
        self.artifacts.insert(name.to_owned(), bytes.to_vec());
    }

    #[wasm_bindgen(js_name = addAccount)]
    pub fn add_account(&mut self, address: &str, owner: &str, data: &[u8]) {
        self.accounts.insert(
            address.to_owned(),
            AccountSnapshot {
                owner: owner.to_owned(),
                data: data.to_vec(),
            },
        );
    }

    pub fn verify(
        &self,
        expected_program_id: &str,
        expected_network_id: &str,
    ) -> Result<String, JsError> {
        let report = verify(&Inputs {
            bundle: &self.bundle,
            artifacts: &self.artifacts,
            accounts: &self.accounts,
            expected_program_id,
            expected_network_id,
        });
        Ok(serde_json::to_string(&report)?)
    }
}

#[wasm_bindgen(js_name = defaultProgramId)]
pub fn default_program_id() -> String {
    COORRE_DEVNET_PROGRAM_ID.to_owned()
}

#[wasm_bindgen(js_name = defaultNetworkId)]
pub fn default_network_id() -> String {
    SOLANA_DEVNET_NETWORK_ID.to_owned()
}
