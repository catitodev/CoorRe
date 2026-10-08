use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, anyhow, bail};
use coorre_anchor::{AnchorError, AnchorTransitionRequest, Anchorer, OpenCaseRequest};
use coorre_engine::rule::{RULE_ID, RULE_VERSION, rule_document, rule_hash};
use coorre_engine::{CaseTracker, Decision, EngineError, SupplierDocsInput, evaluate};
use coorre_model::eddsa_jcs_2022::{ProofOptions, evidence_hash, sign_document};
use coorre_model::evidence::{COORRE_CONTEXT, TRANSITION_TYPE, VC_CONTEXT_V2, VC_TYPE, case_id};
use coorre_model::hash::to_prefixed;
use coorre_model::{
    Actor, ArtifactRef, Autonomy, CaseState, EvidenceDocument, Mandate, Role, RuleRef,
    TransitionSubject,
};
use coorre_verify::{AuditBundle, BUNDLE_FORMAT, BundleEvidence, Receipt, Report, Status};
use serde_json::{Value, json};

use crate::env::Environment;
use crate::files::{fetch_accounts, read_artifacts, verify_bundle};
use crate::fixtures::{ApproverChoice, CaseSpec, load_artifacts};
use crate::keys::DemoKeys;
use crate::print::{print_report, sol};

pub struct CaseOutcome {
    pub case_ref: String,
    pub final_state: CaseState,
    pub bundle_path: PathBuf,
    pub artifacts_dir: PathBuf,
    pub report: Report,
    pub tamper_detected: bool,
    pub rogue_rejected_with: Option<String>,
}

struct RejectedAttempt {
    document: Value,
    name: String,
    code: Option<u32>,
    message: String,
}

struct Draft {
    to: CaseState,
    role: Role,
    autonomy: Autonomy,
    artifacts: Vec<ArtifactRef>,
    payload: Value,
}

struct Run<'a> {
    anchorer: &'a mut dyn Anchorer,
    keys: &'a DemoKeys,
    env: &'a mut dyn Environment,
    out: &'a mut dyn Write,
    case_ref: String,
    case_record: String,
    tracker: CaseTracker,
    mandate: Mandate,
    rule: RuleRef,
    rule_hash: [u8; 32],
    evidence: Vec<BundleEvidence>,
}

fn link(anchorer: &dyn Anchorer, signature: &str) -> String {
    anchorer
        .explorer_tx_url(signature)
        .unwrap_or_else(|| format!("{signature} (simulated)"))
}

impl Run<'_> {
    fn sign(&mut self, d: &Draft) -> anyhow::Result<(Value, [u8; 32])> {
        let signer = self.keys.signer(d.role);
        let issuer = signer.did();
        let valid_from = self.env.timestamp()?;
        let Value::Object(payload) = d.payload.clone() else {
            bail!("payload must be a JSON object");
        };
        let doc = EvidenceDocument {
            context: vec![VC_CONTEXT_V2.to_owned(), COORRE_CONTEXT.to_owned()],
            id: self.env.uuid_urn(),
            types: vec![VC_TYPE.to_owned(), TRANSITION_TYPE.to_owned()],
            issuer: issuer.clone(),
            valid_from: valid_from.clone(),
            credential_subject: TransitionSubject {
                case: self.case_ref.clone(),
                from_state: self.tracker.state(),
                to_state: d.to,
                actor: Actor {
                    id: issuer,
                    kind: d.role.actor_kind(),
                    autonomy: d.autonomy,
                },
                mandate: self.mandate.clone(),
                rule: self.rule.clone(),
                artifacts: d.artifacts.clone(),
                payload,
                previous_evidence: to_prefixed(&self.tracker.expected_prev_hash()),
            },
        };
        doc.validate()?;
        let options = ProofOptions::assertion(valid_from, signer.verification_method());
        let secured = sign_document(&doc.to_value()?, &options, signer)?;
        let hash = evidence_hash(&secured)?;
        Ok((secured, hash))
    }

    fn predict(&self, d: &Draft, hash: [u8; 32]) -> Result<(), EngineError> {
        let mut replica = self.tracker.clone();
        let prev = replica.expected_prev_hash();
        replica
            .apply(
                d.to.code(),
                self.keys.signer(d.role).public_key(),
                prev,
                hash,
            )
            .map(|_| ())
    }

    fn send(&mut self, d: &Draft, hash: [u8; 32]) -> Result<Receipt, AnchorError> {
        self.anchorer.anchor_transition(&AnchorTransitionRequest {
            case_record: self.case_record.clone(),
            evidence_hash: hash,
            prev_hash: self.tracker.expected_prev_hash(),
            to_state: d.to.code(),
            rule_hash: self.rule_hash,
            actor: d.role,
        })
    }

    fn anchor(&mut self, d: Draft, what: &str) -> anyhow::Result<()> {
        let (document, hash) = self.sign(&d)?;
        self.predict(&d, hash)
            .map_err(|e| anyhow!("{} would be rejected: {e}", d.to.name()))?;
        let receipt = self
            .send(&d, hash)
            .map_err(|e| anyhow!("{} was rejected: {e}", d.to.name()))?;
        let prev = self.tracker.expected_prev_hash();
        self.tracker.apply(
            d.to.code(),
            self.keys.signer(d.role).public_key(),
            prev,
            hash,
        )?;
        writeln!(
            self.out,
            "  {:<15} {} ({}, {}) — {what}\n                  evidence {} anchored: {}",
            d.to.name(),
            crate::anchor_role_label(d.role),
            d.role.actor_kind().name(),
            d.autonomy.name(),
            &to_prefixed(&hash)[..19],
            link(&*self.anchorer, &receipt.tx_signature)
        )?;
        self.evidence.push(BundleEvidence {
            anchor_account: receipt.account.clone(),
            document,
            receipt: Some(receipt),
        });
        Ok(())
    }

    fn rogue_attempt(&mut self, evaluation_date: &str) -> anyhow::Result<RejectedAttempt> {
        let draft = Draft {
            to: CaseState::AutoApproved,
            role: Role::RuleEngine,
            autonomy: Autonomy::Autonomous,
            artifacts: vec![],
            payload: json!({
                "decision": "AUTO_APPROVED",
                "evaluation_date": evaluation_date,
                "note": "forced by a misconfigured automation: an out-of-mandate action, sent on purpose"
            }),
        };
        let (document, hash) = self.sign(&draft)?;
        match self.predict(&draft, hash) {
            Err(EngineError::MandateExceeded) => {}
            other => bail!("the engine should predict MandateExceeded, got {other:?}"),
        }
        match self.send(&draft, hash) {
            Err(AnchorError::Rejected {
                name,
                code,
                message,
            }) if name == "MandateExceeded" => {
                writeln!(
                    self.out,
                    "  {:<15} rule engine (system, autonomous) tried to approve {} above its {} limit\n                  rejected on-chain: MandateExceeded — no funds moved",
                    "ROGUE ATTEMPT",
                    sol(self.tracker.amount()),
                    sol(self.tracker.autonomy_limit())
                )?;
                Ok(RejectedAttempt {
                    document,
                    name,
                    code,
                    message,
                })
            }
            Err(e) => bail!("the out-of-mandate attempt failed for another reason: {e}"),
            Ok(receipt) => bail!(
                "the program accepted an AUTO_APPROVED above the mandate (tx {}); stopping",
                receipt.tx_signature
            ),
        }
    }
}

pub struct DemoContext<'a> {
    pub anchorer: &'a mut dyn Anchorer,
    pub keys: &'a DemoKeys,
    pub env: &'a mut dyn Environment,
    pub out: &'a mut dyn Write,
    pub fixtures_dir: &'a Path,
    pub out_dir: &'a Path,
}

pub fn run_case(ctx: &mut DemoContext, spec: &CaseSpec) -> anyhow::Result<CaseOutcome> {
    let artifacts = load_artifacts(ctx.fixtures_dir, spec)?;
    let amount = spec.amount()?;
    let limit = spec.autonomy_limit()?;
    let case_ref = format!("urn:coorre:case:{}-{}", spec.id, ctx.env.run_suffix());
    let id = case_id(&case_ref);
    writeln!(
        ctx.out,
        "\n== {} — {} — {} with an automation limit of {} ==\n  case {case_ref}",
        spec.id,
        spec.supplier,
        sol(amount),
        sol(limit)
    )?;

    let roles = ctx.keys.role_keys();
    let open = ctx
        .anchorer
        .open_case(&OpenCaseRequest {
            case_id: id,
            submitter: roles.submitter,
            agent: roles.agent,
            rule_engine: roles.rule_engine,
            approver: roles.approver,
            amount,
            autonomy_limit: limit,
        })
        .map_err(|e| anyhow!("open_case failed: {e}"))?;
    writeln!(
        ctx.out,
        "  {:<15} creator escrowed {} in case record {}\n                  {}",
        "OPEN",
        sol(amount),
        open.account,
        link(&*ctx.anchorer, &open.tx_signature)
    )?;

    let rule_hash_bytes = rule_hash()?;
    let refs: Vec<ArtifactRef> = artifacts.iter().map(|a| a.reference()).collect();
    let input = SupplierDocsInput {
        evaluation_date: ctx.env.today(),
        amount_lamports: amount,
        autonomy_limit_lamports: limit,
        documents: artifacts.iter().map(|a| a.submitted()).collect(),
    };
    let decision = evaluate(&input)?;

    let mut rogue = None;
    let (evidence, final_state) = {
        let mut run = Run {
            anchorer: &mut *ctx.anchorer,
            keys: ctx.keys,
            env: &mut *ctx.env,
            out: &mut *ctx.out,
            case_ref: case_ref.clone(),
            case_record: open.account.clone(),
            tracker: CaseTracker::open(id, roles, amount, limit, 0)?,
            mandate: Mandate {
                amount_lamports: amount.to_string(),
                autonomy_limit_lamports: limit.to_string(),
            },
            rule: RuleRef {
                id: RULE_ID.to_owned(),
                version: RULE_VERSION.to_owned(),
                hash: to_prefixed(&rule_hash_bytes),
            },
            rule_hash: rule_hash_bytes,
            evidence: Vec::new(),
        };

        let documents: Vec<Value> = artifacts
            .iter()
            .map(|a| {
                json!({
                    "kind": a.fixture.kind,
                    "number": a.fixture.number,
                    "valid_from": a.fixture.valid_from,
                    "valid_until": a.fixture.valid_until,
                    "artifact": a.name,
                })
            })
            .collect();
        run.anchor(
            Draft {
                to: CaseState::Submitted,
                role: Role::Submitter,
                autonomy: Autonomy::ExecuteWithApproval,
                artifacts: refs.clone(),
                payload: json!({ "supplier": spec.supplier, "documents": documents }),
            },
            "supplier submitted its documents",
        )?;
        let recommendation = match decision {
            Decision::AutoApproved => "auto_approve",
            Decision::Escalated { .. } => "escalate",
        };
        run.anchor(
            Draft {
                to: CaseState::AgentReviewed,
                role: Role::Agent,
                autonomy: Autonomy::Recommend,
                artifacts: vec![],
                payload: json!({
                    "recommendation": recommendation,
                    "findings": decision.reasons(),
                    "evaluation_date": input.evaluation_date,
                    "agent": "simulated pre-analysis agent (deterministic, no model call)"
                }),
            },
            "AI agent recommended a decision (it cannot move funds)",
        )?;

        match &decision {
            Decision::AutoApproved => run.anchor(
                Draft {
                    to: CaseState::AutoApproved,
                    role: Role::RuleEngine,
                    autonomy: Autonomy::Autonomous,
                    artifacts: vec![],
                    payload: json!({
                        "decision": "AUTO_APPROVED",
                        "reasons": [],
                        "evaluation_date": input.evaluation_date
                    }),
                },
                "within the mandate: escrow released to the supplier",
            )?,
            Decision::Escalated { reasons } => {
                if amount > limit {
                    rogue = Some(run.rogue_attempt(&input.evaluation_date)?);
                }
                run.anchor(
                    Draft {
                        to: CaseState::Escalated,
                        role: Role::RuleEngine,
                        autonomy: Autonomy::Autonomous,
                        artifacts: vec![],
                        payload: json!({
                            "decision": "ESCALATED",
                            "reasons": reasons,
                            "evaluation_date": input.evaluation_date
                        }),
                    },
                    &format!("escalated to the human approver: {}", reasons.join("; ")),
                )?;
                let approver = spec
                    .approver
                    .as_ref()
                    .context("an escalated case needs an approver decision in cases.json")?;
                let (to, name, what) = match approver.decision {
                    ApproverChoice::Approve => (
                        CaseState::Approved,
                        "APPROVED",
                        "human approver signed: escrow released to the supplier",
                    ),
                    ApproverChoice::Reject => (
                        CaseState::Rejected,
                        "REJECTED",
                        "human approver signed: escrow refunded to the creator",
                    ),
                };
                run.anchor(
                    Draft {
                        to,
                        role: Role::Approver,
                        autonomy: Autonomy::Autonomous,
                        artifacts: vec![],
                        payload: json!({ "decision": name, "justification": approver.justification }),
                    },
                    what,
                )?;
            }
        }
        (run.evidence, run.tracker.state())
    };

    let case_dir = ctx.out_dir.join(&spec.id);
    let artifacts_dir = case_dir.join("artifacts");
    std::fs::create_dir_all(&artifacts_dir)
        .with_context(|| format!("cannot create {}", artifacts_dir.display()))?;
    for artifact in &artifacts {
        std::fs::write(artifacts_dir.join(&artifact.name), &artifact.bytes)?;
    }
    let bundle = AuditBundle {
        format: BUNDLE_FORMAT.to_owned(),
        case_ref: case_ref.clone(),
        network_id: ctx.anchorer.network_id().to_owned(),
        program_id: ctx.anchorer.program_id().to_owned(),
        case_record: open.account.clone(),
        open_receipt: Some(open),
        evidence,
        rules: vec![rule_document()?],
        artifacts: refs,
    };
    let bundle_path = case_dir.join("bundle.json");
    std::fs::write(&bundle_path, bundle.to_json_pretty()?)?;
    if let Some(attempt) = &rogue {
        let attempts = case_dir.join("attempts");
        std::fs::create_dir_all(&attempts)?;
        std::fs::write(
            attempts.join("rogue-auto-approved.json"),
            serde_json::to_string_pretty(&json!({
                "rejected_with": attempt.name,
                "error_code": attempt.code,
                "anchored": false,
                "program_message": attempt.message,
                "document": attempt.document
            }))?,
        )?;
    }

    writeln!(
        ctx.out,
        "\n  Verifying {} from the chain:",
        bundle_path.display()
    )?;
    let accounts = fetch_accounts(&mut *ctx.anchorer, &bundle)?;
    let files = read_artifacts(&artifacts_dir, &bundle)?;
    let program_id = ctx.anchorer.program_id().to_owned();
    let network_id = ctx.anchorer.network_id().to_owned();
    let report = verify_bundle(&bundle, &files, &accounts, &program_id, &network_id);
    print_report(&report, &mut *ctx.out)?;

    let mut tampered = files.clone();
    let tamper_detected = match tampered.values_mut().next() {
        Some(bytes) if !bytes.is_empty() => {
            bytes[0] ^= 0x01;
            let t = verify_bundle(&bundle, &tampered, &accounts, &program_id, &network_id);
            t.checks.first().map(|c| c.status) == Some(Status::Fail)
        }
        _ => false,
    };
    writeln!(
        ctx.out,
        "  Tamper test: one byte changed in an artifact -> check 1 {}",
        if tamper_detected {
            "FAILS, as it must"
        } else {
            "DID NOT FAIL"
        }
    )?;

    Ok(CaseOutcome {
        case_ref,
        final_state,
        bundle_path,
        artifacts_dir,
        report,
        tamper_detected,
        rogue_rejected_with: rogue.map(|attempt| attempt.name),
    })
}
