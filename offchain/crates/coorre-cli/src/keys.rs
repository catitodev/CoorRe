use std::path::Path;

use anyhow::{Context, bail};
use coorre_engine::RoleKeys;
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

fn load_one(dir: &Path, role: &str) -> anyhow::Result<Ed25519Keypair> {
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
    let text = std::fs::read_to_string(&path)
        .with_context(|| format!("cannot read the key file for {role}"))?;
    Ed25519Keypair::from_solana_keypair_json(&text)
        .with_context(|| format!("invalid key file for {role}"))
}

pub fn load(dir: &Path) -> anyhow::Result<DemoKeys> {
    let keys = DemoKeys {
        creator: load_one(dir, "creator")?.public_key(),
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
