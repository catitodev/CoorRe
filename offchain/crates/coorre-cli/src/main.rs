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
use coorre_verify::{COORRE_DEVNET_PROGRAM_ID, SOLANA_DEVNET_NETWORK_ID};

#[derive(Parser)]
#[command(
    name = "coorre",
    version,
    about = "Verifiable mandates for AI agents that approve and release payments"
)]
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
    let work_dir = args
        .out
        .join(format!("verify-{}", env.run_suffix()))
        .join("bridge-io");
    let keys_dir = args.out.join("no-keys");
    let mut anchorer = bridge(&args.bridge, &work_dir, &keys_dir)?;
    let accounts = fetch_accounts(&mut anchorer, &bundle)?;
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
        print_report(&report, &mut out)?;
    }
    Ok(report.passed())
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let result = match &cli.command {
        Command::Demo(DemoCommand::Run(args)) => demo(args),
        Command::Verify(args) => verify(args),
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
