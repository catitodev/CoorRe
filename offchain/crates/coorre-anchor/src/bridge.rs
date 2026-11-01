use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use coorre_model::accounts::pubkey_to_base58;
use coorre_model::hash::to_hex;
use coorre_verify::{AccountSnapshot, Receipt};
use serde_json::{Value, json};

use crate::{
    AnchorError, AnchorTransitionRequest, Anchorer, OpenCaseRequest, PROGRAM_ERRORS, role_name,
};

pub const NETWORK_ID: &str = "solana:devnet";
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(180);
pub const BRIDGE_DEADLINE_MARGIN: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(20);

pub fn bridge_deadline(timeout: Duration) -> Duration {
    timeout
        .saturating_sub(BRIDGE_DEADLINE_MARGIN)
        .max(Duration::from_millis(1))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeConfig {
    pub node: PathBuf,
    pub script: PathBuf,
    pub program_id: String,
    pub keys_dir: PathBuf,
    pub work_dir: PathBuf,
    pub rpc_url: Option<String>,
    pub rpc_fallback_url: Option<String>,
    pub timeout: Duration,
}

struct Finished {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn drain(stream: Option<impl Read + Send + 'static>) -> JoinHandle<std::io::Result<Vec<u8>>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut stream) = stream {
            stream.read_to_end(&mut bytes)?;
        }
        Ok(bytes)
    })
}

fn collect(
    handle: JoinHandle<std::io::Result<Vec<u8>>>,
    name: &str,
) -> Result<Vec<u8>, AnchorError> {
    handle
        .join()
        .map_err(|_| AnchorError::Process(format!("the {name} reader of the bridge stopped")))?
        .map_err(|e| AnchorError::Process(format!("cannot read the bridge {name}: {e}")))
}

fn stop(child: &mut Child, command: &str, timeout: Duration) -> AnchorError {
    let outcome = match child.kill().and_then(|()| child.wait()) {
        Ok(_) => "the bridge process was stopped".to_owned(),
        Err(e) => format!("stopping the bridge process failed: {e}"),
    };
    AnchorError::Process(format!(
        "{command} did not finish within {} s and {outcome}; a transaction it sent may still land, so check the case record on the explorer before running again",
        timeout.as_secs_f64()
    ))
}

fn run_with_deadline(
    mut process: Command,
    command: &str,
    timeout: Duration,
) -> Result<Finished, AnchorError> {
    let mut child = process
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AnchorError::Process(format!("cannot start the bridge: {e}")))?;
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                return Err(stop(&mut child, command, timeout));
            }
            Ok(None) => thread::sleep(POLL_INTERVAL),
            Err(e) => {
                let stopped = stop(&mut child, command, timeout);
                return Err(AnchorError::Process(format!(
                    "cannot wait for the bridge: {e} ({stopped})"
                )));
            }
        }
    };
    Ok(Finished {
        status,
        stdout: collect(stdout, "stdout")?,
        stderr: collect(stderr, "stderr")?,
    })
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
            .env("COORRE_KEYS_DIR", &self.config.keys_dir)
            .env(
                "COORRE_BRIDGE_TIMEOUT_MS",
                bridge_deadline(self.config.timeout).as_millis().to_string(),
            );
        if let Some(path) = std::env::var_os("PATH") {
            process.env("PATH", path);
        }
        if let Some(url) = &self.config.rpc_url {
            process.env("COORRE_RPC_URL", url);
        }
        if let Some(url) = &self.config.rpc_fallback_url {
            process.env("COORRE_RPC_FALLBACK_URL", url);
        }
        let output =
            run_with_deadline(process, command, self.config.timeout).map_err(|e| match e {
                AnchorError::Process(message) => AnchorError::Process(format!(
                    "{} ({}): {message}",
                    command,
                    self.config.node.display()
                )),
                other => other,
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
        let (Some(name), Some(message)) = (
            error.get("name").and_then(Value::as_str),
            error.get("message").and_then(Value::as_str),
        ) else {
            return Err(AnchorError::Protocol(format!(
                "error object without a name and a message: {error}"
            )));
        };
        let (name, message) = (name.to_owned(), message.to_owned());
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

    #[cfg(unix)]
    fn bridge_running(name: &str, script: &str, timeout: Duration) -> BridgeAnchorer {
        let dir = std::env::temp_dir().join(format!("coorre-bridge-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("bridge.sh");
        std::fs::write(&path, script).unwrap();
        BridgeAnchorer::new(BridgeConfig {
            node: PathBuf::from("/bin/sh"),
            script: path,
            program_id: "P".to_owned(),
            keys_dir: dir.join("keys"),
            work_dir: dir.join("io"),
            rpc_url: None,
            rpc_fallback_url: None,
            timeout,
        })
        .unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn a_bridge_that_hangs_is_stopped_at_the_deadline() {
        let mut bridge = bridge_running("hang", "exec sleep 30\n", Duration::from_millis(300));
        let started = Instant::now();
        let error = bridge.fetch_account("A").unwrap_err();
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "{:?}",
            started.elapsed()
        );
        let text = error.to_string();
        assert!(matches!(error, AnchorError::Process(_)), "{text}");
        assert!(
            text.contains(
                "fetch-account did not finish within 0.3 s and the bridge process was stopped"
            ),
            "{text}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_bridge_that_answers_in_time_is_read() {
        let mut bridge = bridge_running(
            "answer",
            "printf '{\"exists\":false}'\n",
            Duration::from_secs(30),
        );
        assert_eq!(bridge.fetch_account("A").unwrap(), None);
    }

    #[test]
    fn the_bridge_stops_itself_before_the_cli_stops_it() {
        assert_eq!(bridge_deadline(DEFAULT_TIMEOUT), Duration::from_secs(150));
        assert_eq!(
            bridge_deadline(Duration::from_secs(60)),
            Duration::from_secs(30)
        );
        assert_eq!(
            bridge_deadline(Duration::from_secs(5)),
            Duration::from_millis(1)
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_bridge_receives_its_own_deadline() {
        let mut bridge = bridge_running(
            "deadline",
            "if [ \"$COORRE_BRIDGE_TIMEOUT_MS\" = 30000 ]; then printf '{\"exists\":false}'; else printf '{\"error\":{\"name\":\"WrongDeadline\",\"message\":\"%s\"}}' \"$COORRE_BRIDGE_TIMEOUT_MS\"; exit 1; fi\n",
            Duration::from_secs(60),
        );
        assert_eq!(bridge.fetch_account("A").unwrap(), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_bridge_error_without_a_name_is_a_protocol_error() {
        let mut bridge = bridge_running(
            "nameless",
            "printf '{\"error\":{\"code\":1}}'; exit 1\n",
            Duration::from_secs(30),
        );
        let error = bridge.fetch_account("A").unwrap_err();
        assert!(matches!(error, AnchorError::Protocol(_)), "{error}");
        assert!(
            error.to_string().contains("without a name and a message"),
            "{error}"
        );
    }

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
