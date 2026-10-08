use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{Context, anyhow};
use coorre_anchor::Anchorer;
use coorre_model::evidence::is_safe_artifact_name;
use coorre_verify::{AccountSnapshot, AuditBundle, Inputs, Report, verify};

pub fn load_bundle(path: &Path) -> anyhow::Result<AuditBundle> {
    let text =
        std::fs::read_to_string(path).with_context(|| format!("cannot read {}", path.display()))?;
    AuditBundle::from_json(&text).map_err(|e| anyhow!("{}: {e}", path.display()))
}

pub fn fetch_accounts(
    anchorer: &mut dyn Anchorer,
    bundle: &AuditBundle,
) -> anyhow::Result<BTreeMap<String, AccountSnapshot>> {
    let mut accounts = BTreeMap::new();
    for address in bundle.required_accounts() {
        if let Some(snapshot) = anchorer
            .fetch_account(&address)
            .map_err(|e| anyhow!("fetching {address}: {e}"))?
        {
            accounts.insert(address, snapshot);
        }
    }
    Ok(accounts)
}

pub fn read_artifacts(
    dir: &Path,
    bundle: &AuditBundle,
) -> anyhow::Result<BTreeMap<String, Vec<u8>>> {
    let mut files = BTreeMap::new();
    for name in bundle.declared_artifact_names() {
        if !is_safe_artifact_name(&name) {
            continue;
        }
        let path = dir.join(&name);
        match std::fs::read(&path) {
            Ok(bytes) => {
                files.insert(name, bytes);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(anyhow!("cannot read {}: {e}", path.display())),
        }
    }
    Ok(files)
}

pub fn verify_bundle(
    bundle: &AuditBundle,
    artifacts: &BTreeMap<String, Vec<u8>>,
    accounts: &BTreeMap<String, AccountSnapshot>,
    expected_program_id: &str,
    expected_network_id: &str,
) -> Report {
    verify(&Inputs {
        bundle,
        artifacts,
        accounts,
        expected_program_id,
        expected_network_id,
    })
}
