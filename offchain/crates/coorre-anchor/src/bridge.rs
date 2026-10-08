use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use coorre_model::accounts::pubkey_to_base58;
use coorre_model::hash::to_hex;
use coorre_verify::{AccountSnapshot, Receipt};
use serde_json::{Value, json};

use crate::{
    AnchorError, AnchorTransitionRequest, Anchorer, OpenCaseRequest, PROGRAM_ERRORS, role_name,
};

pub const NETWORK_ID: &str = "solana:devnet";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeConfig {
    pub node: PathBuf,
    pub script: PathBuf,
    pub program_id: String,
    pub keys_dir: PathBuf,
    pub work_dir: PathBuf,
    pub rpc_url: Option<String>,
    pub rpc_fallback_url: Option<String>,
}

pub struct BridgeAnchorer {
    config: BridgeConfig,
    sequence: AtomicU64,
}

impl BridgeAnchorer {
    pub fn new(config: BridgeConfig) -> Result<Self, AnchorError> {
        std::fs::create_dir_all(&config.work_dir).map_err(|e| {
            AnchorError::Process(format!("cannot create {}: {e}", config.work_dir.display()))
        })?;
        Ok(Self {
            config,
            sequence: AtomicU64::new(0),
        })
    }

    fn call(&self, command: &str, input: Value) -> Result<Value, AnchorError> {
        let n = self.sequence.fetch_add(1, Ordering::SeqCst) + 1;
        let input_path = self.config.work_dir.join(format!("{n:04}-{command}.json"));
        std::fs::write(&input_path, input.to_string()).map_err(|e| {
            AnchorError::Process(format!("cannot write {}: {e}", input_path.display()))
        })?;

        let mut process = Command::new(&self.config.node);
        process
            .arg(&self.config.script)
            .arg(command)
            .arg("--input")
            .arg(&input_path)
            .env_clear()
            .env("COORRE_PROGRAM_ID", &self.config.program_id)
            .env("COORRE_KEYS_DIR", &self.config.keys_dir);
        if let Some(path) = std::env::var_os("PATH") {
            process.env("PATH", path);
        }
        if let Some(url) = &self.config.rpc_url {
            process.env("COORRE_RPC_URL", url);
        }
        if let Some(url) = &self.config.rpc_fallback_url {
            process.env("COORRE_RPC_FALLBACK_URL", url);
        }
        let output = process.output().map_err(|e| {
            AnchorError::Process(format!("cannot start {}: {e}", self.config.node.display()))
        })?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let value: Value = serde_json::from_str(stdout.trim()).map_err(|e| {
            AnchorError::Protocol(format!(
                "{e}; stdout: {}; stderr: {}",
                stdout.trim(),
                String::from_utf8_lossy(&output.stderr).trim()
            ))
        })?;
        if output.status.success() {
            return Ok(value);
        }
        let error = value.get("error").ok_or_else(|| {
            AnchorError::Protocol(format!("failed without an error object: {value}"))
        })?;
        let name = error
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("UnknownError")
            .to_owned();
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        if PROGRAM_ERRORS.contains(&name.as_str())
            || name == "AccountAlreadyInUse"
            || name.starts_with("Constraint")
        {
            let code = error
                .get("code")
                .and_then(Value::as_u64)
                .and_then(|c| u32::try_from(c).ok());
            return Err(AnchorError::Rejected {
                name,
                code,
                message,
            });
        }
        Err(AnchorError::Bridge { name, message })
    }
}

fn receipt(value: Value) -> Result<Receipt, AnchorError> {
    serde_json::from_value(value).map_err(|e| AnchorError::Protocol(format!("receipt: {e}")))
}

fn hex_bytes(text: &str) -> Result<Vec<u8>, AnchorError> {
    if !text.len().is_multiple_of(2) || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AnchorError::Protocol("data_hex is not hex".to_owned()));
    }
    (0..text.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&text[i..i + 2], 16)
                .map_err(|e| AnchorError::Protocol(e.to_string()))
        })
        .collect()
}

impl Anchorer for BridgeAnchorer {
    fn network_id(&self) -> &str {
        NETWORK_ID
    }

    fn program_id(&self) -> &str {
        &self.config.program_id
    }

    fn explorer_tx_url(&self, signature: &str) -> Option<String> {
        Some(format!(
            "https://explorer.solana.com/tx/{signature}?cluster=devnet"
        ))
    }

    fn explorer_address_url(&self, address: &str) -> Option<String> {
        Some(format!(
            "https://explorer.solana.com/address/{address}?cluster=devnet"
        ))
    }

    fn open_case(&mut self, r: &OpenCaseRequest) -> Result<Receipt, AnchorError> {
        receipt(self.call(
            "open-case",
            json!({
                "case_id": to_hex(&r.case_id),
                "submitter": pubkey_to_base58(&r.submitter),
                "agent": pubkey_to_base58(&r.agent),
                "rule_engine": pubkey_to_base58(&r.rule_engine),
                "approver": pubkey_to_base58(&r.approver),
                "amount_lamports": r.amount.to_string(),
                "autonomy_limit_lamports": r.autonomy_limit.to_string(),
            }),
        )?)
    }

    fn anchor_transition(&mut self, r: &AnchorTransitionRequest) -> Result<Receipt, AnchorError> {
        receipt(self.call(
            "anchor-transition",
            json!({
                "case_record": r.case_record,
                "evidence_hash": to_hex(&r.evidence_hash),
                "prev_hash": to_hex(&r.prev_hash),
                "to_state": r.to_state,
                "rule_hash": to_hex(&r.rule_hash),
                "actor_role": role_name(r.actor),
            }),
        )?)
    }

    fn fetch_account(&mut self, address: &str) -> Result<Option<AccountSnapshot>, AnchorError> {
        let value = self.call("fetch-account", json!({ "address": address }))?;
        if value.get("exists").and_then(Value::as_bool) != Some(true) {
            return Ok(None);
        }
        let owner = value
            .get("owner")
            .and_then(Value::as_str)
            .ok_or_else(|| AnchorError::Protocol("fetch-account: missing owner".to_owned()))?;
        let data = value
            .get("data_hex")
            .and_then(Value::as_str)
            .ok_or_else(|| AnchorError::Protocol("fetch-account: missing data_hex".to_owned()))?;
        Ok(Some(AccountSnapshot {
            owner: owner.to_owned(),
            data: hex_bytes(data)?,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_bytes_accepts_hex_and_rejects_garbage() {
        assert_eq!(hex_bytes("00ff10").unwrap(), [0, 255, 16]);
        assert_eq!(hex_bytes("").unwrap(), Vec::<u8>::new());
        assert!(hex_bytes("abc").is_err());
        assert!(hex_bytes("zz").is_err());
    }

    #[test]
    fn receipt_parses_bridge_output() {
        let value = json!({"network_id": "solana:devnet", "program_id": "P", "account": "A", "tx_signature": "S"});
        assert_eq!(receipt(value).unwrap().tx_signature, "S");
        assert!(receipt(json!({"account": "A"})).is_err());
    }
}
