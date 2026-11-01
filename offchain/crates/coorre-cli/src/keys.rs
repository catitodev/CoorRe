use std::path::Path;

use anyhow::{Context, bail};
use coorre_engine::RoleKeys;
use coorre_model::keys::public_key_from_solana_keypair_json;
use coorre_model::{Ed25519Keypair, Role};

pub struct DemoKeys {
    pub creator: [u8; 32],
    pub submitter: Ed25519Keypair,
    pub agent: Ed25519Keypair,
    pub rule_engine: Ed25519Keypair,
    pub approver: Ed25519Keypair,
}

impl DemoKeys {
    pub fn signer(&self, role: Role) -> &Ed25519Keypair {
        match role {
            Role::Submitter => &self.submitter,
            Role::Agent => &self.agent,
            Role::RuleEngine => &self.rule_engine,
            Role::Approver => &self.approver,
        }
    }

    pub fn role_keys(&self) -> RoleKeys {
        RoleKeys {
            submitter: self.submitter.public_key(),
            agent: self.agent.public_key(),
            rule_engine: self.rule_engine.public_key(),
            approver: self.approver.public_key(),
        }
    }

    pub fn from_seeds(seeds: [[u8; 32]; 5]) -> Self {
        Self {
            creator: Ed25519Keypair::from_seed(&seeds[0]).public_key(),
            submitter: Ed25519Keypair::from_seed(&seeds[1]),
            agent: Ed25519Keypair::from_seed(&seeds[2]),
            rule_engine: Ed25519Keypair::from_seed(&seeds[3]),
            approver: Ed25519Keypair::from_seed(&seeds[4]),
        }
    }
}

fn read_key_file(dir: &Path, role: &str) -> anyhow::Result<String> {
    let path = dir.join(format!("{role}.json"));
    let metadata = std::fs::metadata(&path)
        .with_context(|| format!("key file for {role} not found in {}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            bail!("key file for {role} must not be readable by group or others (chmod 600)");
        }
    }
    #[cfg(not(unix))]
    let _ = metadata;
    std::fs::read_to_string(&path).with_context(|| format!("cannot read the key file for {role}"))
}

fn load_one(dir: &Path, role: &str) -> anyhow::Result<Ed25519Keypair> {
    Ed25519Keypair::from_solana_keypair_json(&read_key_file(dir, role)?)
        .with_context(|| format!("invalid key file for {role}"))
}

fn load_public(dir: &Path, role: &str) -> anyhow::Result<[u8; 32]> {
    public_key_from_solana_keypair_json(&read_key_file(dir, role)?)
        .with_context(|| format!("invalid key file for {role}"))
}

pub fn load(dir: &Path) -> anyhow::Result<DemoKeys> {
    let keys = DemoKeys {
        creator: load_public(dir, "creator")?,
        submitter: load_one(dir, "submitter")?,
        agent: load_one(dir, "agent")?,
        rule_engine: load_one(dir, "rule_engine")?,
        approver: load_one(dir, "approver")?,
    };
    keys.role_keys()
        .ensure_distinct()
        .map_err(|e| anyhow::anyhow!("demo keys: {e}"))?;
    Ok(keys)
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn key_file(dir: &Path, role: &str, bytes: &[u8]) {
        let path = dir.join(format!("{role}.json"));
        std::fs::write(&path, serde_json::to_string(bytes).unwrap()).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }

    fn solana_bytes(seed: u8) -> Vec<u8> {
        let mut bytes = vec![seed; 32];
        bytes.extend_from_slice(&Ed25519Keypair::from_seed(&[seed; 32]).public_key());
        bytes
    }

    #[test]
    fn the_creator_key_is_read_from_its_public_half_only() {
        let dir = std::env::temp_dir().join(format!("coorre-keys-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for (seed, role) in [
            (2, "submitter"),
            (3, "agent"),
            (4, "rule_engine"),
            (5, "approver"),
        ] {
            key_file(&dir, role, &solana_bytes(seed));
        }
        let mut creator = solana_bytes(1);
        creator[..32].fill(0xee);
        key_file(&dir, "creator", &creator);
        let keys = load(&dir).unwrap();
        assert_eq!(
            keys.creator,
            Ed25519Keypair::from_seed(&[1; 32]).public_key()
        );
        assert_eq!(
            keys.agent.public_key(),
            Ed25519Keypair::from_seed(&[3; 32]).public_key()
        );
        std::fs::set_permissions(
            dir.join("creator.json"),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        let error = load(&dir).err().unwrap().to_string();
        assert!(error.contains("chmod 600"), "{error}");
    }
}
