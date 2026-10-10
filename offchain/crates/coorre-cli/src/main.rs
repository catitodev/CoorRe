use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, anyhow, bail};
use clap::{Args, Parser, Subcommand};
use coorre_anchor::memory::MemoryAnchorer;
use coorre_anchor::{Anchorer, BridgeAnchorer, BridgeConfig};
use coorre_cli::demo::{DemoContext, run_case};
use coorre_cli::env::{Environment, SystemEnvironment};
use coorre_cli::files::{fetch_accounts, load_bundle, read_artifacts, verify_bundle};
use coorre_cli::fixtures::load_cases;
use coorre_cli::keys;
use coorre_cli::print::print_report;
use coorre_cli::snapshot::load_recorded_accounts;
use coorre_cli::zcash_memo;
use coorre_verify::{COORRE_DEVNET_PROGRAM_ID, SOLANA_DEVNET_NETWORK_ID};

#[derive(Parser)]
#[command(name = "coorre", version, about = "Provable decisions for AI agents.")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    #[command(subcommand, about = "Narrated demo scenario")]
    Demo(DemoCommand),
    #[command(about = "Verify an audit bundle against the chain")]
    Verify(VerifyArgs),
    #[command(
        name = "zcash-memo",
        about = "Prepare or check the Zcash memo that links a payment to a released decision (offline; sends nothing)"
    )]
    ZcashMemo(ZcashMemoArgs),
}

#[derive(Args)]
struct ZcashMemoArgs {
    #[arg(long)]
    bundle: PathBuf,
    #[arg(
        long,
        help = "A memo read from a payment (text, or 1024 hex characters) to check against the bundle"
    )]
    check: Option<String>,
}

#[derive(Subcommand)]
enum DemoCommand {
    #[command(about = "Run the cases in demo/fixtures/cases.json on devnet")]
    Run(DemoArgs),
}

#[derive(Args)]
struct BridgeArgs {
    #[arg(long, default_value = COORRE_DEVNET_PROGRAM_ID)]
    program_id: String,
    #[arg(long, default_value = "bridge/anchor.mjs")]
    bridge: PathBuf,
    #[arg(long, env = "COORRE_NODE")]
    node: Option<PathBuf>,
    #[arg(long, env = "COORRE_RPC_URL")]
    rpc_url: Option<String>,
    #[arg(long, env = "COORRE_RPC_FALLBACK_URL")]
    rpc_fallback_url: Option<String>,
}

#[derive(Args)]
struct DemoArgs {
    #[arg(long, default_value = "demo/fixtures")]
    fixtures: PathBuf,
    #[arg(long, default_value = "out")]
    out: PathBuf,
    #[arg(long, default_value = ".local/keys")]
    keys: PathBuf,
    #[arg(
        long = "case",
        help = "Run only these case ids (default: every case marked demo)"
    )]
    cases: Vec<String>,
    #[arg(long, help = "Use the in-memory simulator instead of devnet")]
    offline: bool,
    #[command(flatten)]
    bridge: BridgeArgs,
}

#[derive(Args)]
struct VerifyArgs {
    #[arg(long)]
    bundle: PathBuf,
    #[arg(long)]
    artifacts: PathBuf,
    #[arg(long, default_value = SOLANA_DEVNET_NETWORK_ID)]
    network_id: String,
    #[arg(long, default_value = "out")]
    out: PathBuf,
    #[arg(long, help = "Print the report as JSON")]
    json: bool,
    #[arg(
        long,
        help = "Read the accounts from a recorded getMultipleAccounts response instead of the network"
    )]
    accounts: Option<PathBuf>,
    #[command(flatten)]
    bridge: BridgeArgs,
}

fn find_node(explicit: Option<&PathBuf>) -> anyhow::Result<PathBuf> {
    if let Some(path) = explicit {
        return Ok(path.clone());
    }
    let path = std::env::var_os("PATH").ok_or_else(|| anyhow!("PATH is not set"))?;
    std::env::split_paths(&path)
        .map(|dir| dir.join("node"))
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| anyhow!("node was not found in PATH; pass --node or set COORRE_NODE"))
}

fn bridge(args: &BridgeArgs, work_dir: &Path, keys_dir: &Path) -> anyhow::Result<BridgeAnchorer> {
    if !args.bridge.is_file() {
        bail!(
            "bridge script not found at {} (run from the repository root or pass --bridge)",
            args.bridge.display()
        );
    }
    Ok(BridgeAnchorer::new(BridgeConfig {
        node: find_node(args.node.as_ref())?,
        script: args.bridge.canonicalize()?,
        program_id: args.program_id.clone(),
        keys_dir: keys_dir.to_path_buf(),
        work_dir: work_dir.to_path_buf(),
        rpc_url: args.rpc_url.clone(),
        rpc_fallback_url: args.rpc_fallback_url.clone(),
    })?)
}

fn demo(args: &DemoArgs) -> anyhow::Result<bool> {
    let mut env = SystemEnvironment::new();
    let keys_dir = args
        .keys
        .canonicalize()
        .with_context(|| format!("keys folder {} not found", args.keys.display()))?;
    let keys = keys::load(&keys_dir)?;
    let out_dir = args.out.join(format!("demo-{}", env.run_suffix()));
    std::fs::create_dir_all(&out_dir)?;
    let all = load_cases(&args.fixtures)?;
    let selected: Vec<_> = if args.cases.is_empty() {
        all.iter().filter(|c| c.demo).collect()
    } else {
        let picked: Vec<_> = all.iter().filter(|c| args.cases.contains(&c.id)).collect();
        if picked.len() != args.cases.len() {
            bail!("unknown case id in --case");
        }
        picked
    };

    let mut anchorer: Box<dyn Anchorer> = if args.offline {
        Box::new(MemoryAnchorer::new(keys.creator, keys.role_keys(), 0))
    } else {
        Box::new(bridge(&args.bridge, &out_dir.join("bridge-io"), &keys_dir)?)
    };
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    writeln!(
        out,
        "CoorRe demo on {} — program {}\nOutput folder: {}",
        anchorer.network_id(),
        anchorer.program_id(),
        out_dir.display()
    )?;
    if args.offline {
        writeln!(
            out,
            "Offline mode: transactions are simulated in memory; nothing is sent to a network."
        )?;
    }
    let mut all_ok = true;
    for spec in selected {
        let mut ctx = DemoContext {
            anchorer: anchorer.as_mut(),
            keys: &keys,
            env: &mut env,
            out: &mut out,
            fixtures_dir: &args.fixtures,
            out_dir: &out_dir,
        };
        let outcome = run_case(&mut ctx, spec)?;
        all_ok &= outcome.report.passed() && outcome.tamper_detected;
        writeln!(
            out,
            "  Bundle: {}\n  Verify again any time: coorre verify --bundle {} --artifacts {}",
            outcome.bundle_path.display(),
            outcome.bundle_path.display(),
            outcome.artifacts_dir.display()
        )?;
    }
    Ok(all_ok)
}

fn verify(args: &VerifyArgs) -> anyhow::Result<bool> {
    let env = SystemEnvironment::new();
    let bundle = load_bundle(&args.bundle)?;
    let files = read_artifacts(&args.artifacts, &bundle)?;
    let (accounts, source) = match &args.accounts {
        Some(path) => {
            let recorded = load_recorded_accounts(path)?;
            let slot = recorded
                .slot
                .map_or_else(|| "unknown slot".to_owned(), |s| format!("slot {s}"));
            (
                recorded.accounts,
                format!(
                    "  accounts    recorded in {} ({slot}); no network access",
                    path.display()
                ),
            )
        }
        None => {
            let work_dir = args
                .out
                .join(format!("verify-{}", env.run_suffix()))
                .join("bridge-io");
            let keys_dir = args.out.join("no-keys");
            let mut anchorer = bridge(&args.bridge, &work_dir, &keys_dir)?;
            let accounts = fetch_accounts(&mut anchorer, &bundle)?;
            (
                accounts,
                format!("  accounts    read from {}", anchorer.network_id()),
            )
        }
    };
    let report = verify_bundle(
        &bundle,
        &files,
        &accounts,
        &args.bridge.program_id,
        &args.network_id,
    );
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    if args.json {
        writeln!(out, "{}", serde_json::to_string_pretty(&report)?)?;
    } else {
        writeln!(out, "{source}")?;
        print_report(&report, &mut out)?;
    }
    Ok(report.passed())
}

fn zcash_memo_command(args: &ZcashMemoArgs) -> anyhow::Result<bool> {
    let bundle = load_bundle(&args.bundle)?;
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    match &args.check {
        None => {
            let decision = zcash_memo::release_decision(&bundle)?;
            writeln!(out, "  case        {}", bundle.case_ref)?;
            writeln!(
                out,
                "  decision    {} (evidence {})",
                decision.memo.state.name(),
                decision.evidence_number
            )?;
            writeln!(
                out,
                "  text memo   (ZIP 302 text, for a wallet's memo field)"
            )?;
            writeln!(out, "{}", zcash_memo::encode_text(&decision.memo))?;
            writeln!(
                out,
                "  binary memo (ZIP 302 arbitrary data, 512 bytes as hex)"
            )?;
            writeln!(out, "{}", zcash_memo::encode_binary_hex(&decision.memo))?;
            writeln!(
                out,
                "  Nothing is sent: no Zcash transaction is created by this command."
            )?;
            Ok(true)
        }
        Some(text) => {
            let memo = zcash_memo::parse_any(text)?;
            match zcash_memo::check(&memo, &bundle) {
                Ok(decision) => {
                    writeln!(
                        out,
                        "  MATCH       the memo points to the {} decision of {} (evidence {})",
                        decision.memo.state.name(),
                        bundle.case_ref,
                        decision.evidence_number
                    )?;
                    writeln!(
                        out,
                        "  Confirm that this decision is anchored: coorre verify --bundle {} --artifacts <folder>",
                        args.bundle.display()
                    )?;
                    Ok(true)
                }
                Err(e) => {
                    writeln!(out, "  NO MATCH    {e}")?;
                    Ok(false)
                }
            }
        }
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let result = match &cli.command {
        Command::Demo(DemoCommand::Run(args)) => demo(args),
        Command::Verify(args) => verify(args),
        Command::ZcashMemo(args) => zcash_memo_command(args),
    };
    match result {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::from(1),
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::from(2)
        }
    }
}
