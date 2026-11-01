use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{Context, anyhow, bail};
use coorre_anchor::Anchorer;
use coorre_model::evidence::is_safe_artifact_name;
use coorre_verify::{
    AccountSnapshot, AuditBundle, Inputs, Report, SOLANA_DEVNET_NETWORK_ID, verify,
};

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

pub fn expected_network_id(
    requested: Option<&str>,
    online_network: Option<&str>,
) -> anyhow::Result<String> {
    match (requested, online_network) {
        (Some(requested), Some(online)) if requested != online => bail!(
            "--network-id {requested} does not match the network the accounts are read from ({online}); drop --network-id or read recorded accounts with --accounts"
        ),
        (_, Some(online)) => Ok(online.to_owned()),
        (Some(requested), None) => Ok(requested.to_owned()),
        (None, None) => Ok(SOLANA_DEVNET_NETWORK_ID.to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn online_verification_expects_the_network_it_reads_from() {
        assert_eq!(
            expected_network_id(None, Some("solana:devnet")).unwrap(),
            "solana:devnet"
        );
        assert_eq!(
            expected_network_id(Some("solana:devnet"), Some("solana:devnet")).unwrap(),
            "solana:devnet"
        );
        let error = expected_network_id(Some("memory:simulated"), Some("solana:devnet"))
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("--network-id memory:simulated does not match the network the accounts are read from (solana:devnet)"),
            "{error}"
        );
    }

    #[test]
    fn recorded_accounts_use_the_requested_network_or_devnet() {
        assert_eq!(
            expected_network_id(Some("memory:simulated"), None).unwrap(),
            "memory:simulated"
        );
        assert_eq!(expected_network_id(None, None).unwrap(), "solana:devnet");
    }
}
