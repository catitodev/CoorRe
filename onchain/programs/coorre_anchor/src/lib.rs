use anchor_lang::prelude::*;
use anchor_lang::system_program;

// Solana Playground rewrites this on build with the project's program id.
declare_id!("11111111111111111111111111111111");

/// Case states (u8 codes shared with the off-chain core).
pub mod case_state {
    pub const OPEN: u8 = 0;
    pub const SUBMITTED: u8 = 1;
    pub const AGENT_REVIEWED: u8 = 2;
    pub const AUTO_APPROVED: u8 = 3;
    pub const ESCALATED: u8 = 4;
    pub const APPROVED: u8 = 5;
    pub const REJECTED: u8 = 6;

    pub fn is_valid(code: u8) -> bool {
        code <= REJECTED
    }

    pub fn is_terminal(code: u8) -> bool {
        matches!(code, AUTO_APPROVED | APPROVED | REJECTED)
    }
}

/// Actor kinds recorded on each anchor. Derived from the role, never taken
/// from instruction input. Zero is left unused so empty data never looks valid.
pub mod actor_kinds {
    pub const HUMAN: u8 = 1;
    pub const AGENT: u8 = 2;
    pub const SYSTEM: u8 = 3;
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Role {
    Submitter,
    Agent,
    RuleEngine,
    Approver,
}

impl Role {
    fn actor_kind(self) -> u8 {
        match self {
            Role::Submitter | Role::Approver => actor_kinds::HUMAN,
            Role::Agent => actor_kinds::AGENT,
            Role::RuleEngine => actor_kinds::SYSTEM,
        }
    }

    fn key(self, case: &CaseRecord) -> Pubkey {
        match self {
            Role::Submitter => case.submitter,
            Role::Agent => case.agent,
            Role::RuleEngine => case.rule_engine,
            Role::Approver => case.approver,
        }
    }
}

/// The only allowed transitions and the role that must sign each one.
fn required_role(from: u8, to: u8) -> Option<Role> {
    use crate::case_state::*;
    match (from, to) {
        (OPEN, SUBMITTED) => Some(Role::Submitter),
        (SUBMITTED, AGENT_REVIEWED) => Some(Role::Agent),
        (AGENT_REVIEWED, AUTO_APPROVED) | (AGENT_REVIEWED, ESCALATED) => Some(Role::RuleEngine),
        (ESCALATED, APPROVED) | (ESCALATED, REJECTED) => Some(Role::Approver),
        _ => None,
    }
}

#[program]
pub mod coorre_anchor {
    use super::*;

    /// Opens a case and moves `amount` lamports from the creator into escrow.
    pub fn open_case(
        ctx: Context<OpenCase>,
        case_id: [u8; 32],
        submitter: Pubkey,
        agent: Pubkey,
        rule_engine: Pubkey,
        approver: Pubkey,
        amount: u64,
        autonomy_limit: u64,
    ) -> Result<()> {
        let roles = [submitter, agent, rule_engine, approver];
        for i in 0..roles.len() {
            for j in (i + 1)..roles.len() {
                require_keys_neq!(roles[i], roles[j], CoorreError::RolesNotDistinct);
            }
        }
        // The payee must end rent-exempt or the final payout would be rejected.
        let payout_floor = Rent::get()?.minimum_balance(0);
        require!(amount >= payout_floor, CoorreError::AmountBelowRentExempt);

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.creator.to_account_info(),
                    to: ctx.accounts.case_record.to_account_info(),
                },
            ),
            amount,
        )?;

        let case = &mut ctx.accounts.case_record;
        case.case_id = case_id;
        case.creator = ctx.accounts.creator.key();
        case.submitter = submitter;
        case.agent = agent;
        case.rule_engine = rule_engine;
        case.approver = approver;
        case.amount = amount;
        case.autonomy_limit = autonomy_limit;
        case.state = case_state::OPEN;
        case.last_evidence_hash = [0u8; 32];
        case.transition_count = 0;
        case.bump = ctx.bumps.case_record;

        emit!(CaseOpened {
            case_id,
            creator: case.creator,
            amount,
            autonomy_limit,
        });
        Ok(())
    }

    /// Anchors one evidence-backed transition and, on a terminal state,
    /// releases or refunds the escrow.
    pub fn anchor_transition(
        ctx: Context<AnchorTransition>,
        evidence_hash: [u8; 32],
        prev_hash: [u8; 32],
        to_state: u8,
        rule_hash: [u8; 32],
    ) -> Result<()> {
        let clock = Clock::get()?;
        let case_key = ctx.accounts.case_record.key();
        let case = &mut ctx.accounts.case_record;
        let from_state = case.state;

        require!(!case_state::is_terminal(from_state), CoorreError::CaseClosed);
        require!(case_state::is_valid(to_state), CoorreError::InvalidState);
        let role = required_role(from_state, to_state).ok_or(CoorreError::InvalidTransition)?;
        let actor = ctx.accounts.actor.key();
        require_keys_eq!(actor, role.key(case), CoorreError::UnauthorizedActor);
        let expected_prev = if case.transition_count == 0 {
            case.case_id
        } else {
            case.last_evidence_hash
        };
        require!(prev_hash == expected_prev, CoorreError::PrevHashMismatch);
        if to_state == case_state::AUTO_APPROVED {
            require!(case.amount <= case.autonomy_limit, CoorreError::MandateExceeded);
        }

        let anchor = &mut ctx.accounts.evidence_anchor;
        anchor.evidence_hash = evidence_hash;
        anchor.case_record = case_key;
        anchor.prev_hash = prev_hash;
        anchor.from_state = from_state;
        anchor.to_state = to_state;
        anchor.actor = actor;
        anchor.actor_kind = role.actor_kind();
        anchor.rule_hash = rule_hash;
        anchor.slot = clock.slot;
        anchor.unix_ts = clock.unix_timestamp;
        anchor.bump = ctx.bumps.evidence_anchor;

        case.state = to_state;
        case.last_evidence_hash = evidence_hash;
        case.transition_count = case
            .transition_count
            .checked_add(1)
            .ok_or(CoorreError::Overflow)?;
        let amount = case.amount;

        emit!(TransitionAnchored {
            case_record: case_key,
            evidence_hash,
            prev_hash,
            from_state,
            to_state,
            actor,
            actor_kind: anchor.actor_kind,
            rule_hash,
            slot: anchor.slot,
            unix_ts: anchor.unix_ts,
        });

        match to_state {
            case_state::AUTO_APPROVED | case_state::APPROVED => {
                let to = ctx.accounts.submitter.to_account_info();
                pay_out(&ctx.accounts.case_record.to_account_info(), &to, amount)?;
                emit!(FundsReleased {
                    case_record: case_key,
                    to: to.key(),
                    amount,
                });
            }
            case_state::REJECTED => {
                let to = ctx.accounts.creator.to_account_info();
                pay_out(&ctx.accounts.case_record.to_account_info(), &to, amount)?;
                emit!(FundsRefunded {
                    case_record: case_key,
                    to: to.key(),
                    amount,
                });
            }
            _ => {}
        }
        Ok(())
    }
}

/// Moves exactly `amount` lamports out of the program-owned case record,
/// never leaving it below its rent-exempt minimum.
fn pay_out<'info>(from: &AccountInfo<'info>, to: &AccountInfo<'info>, amount: u64) -> Result<()> {
    let rent_minimum = Rent::get()?.minimum_balance(from.data_len());
    let remaining = from
        .lamports()
        .checked_sub(amount)
        .ok_or(CoorreError::InsufficientEscrow)?;
    require!(remaining >= rent_minimum, CoorreError::InsufficientEscrow);
    let credited = to
        .lamports()
        .checked_add(amount)
        .ok_or(CoorreError::Overflow)?;
    **from.try_borrow_mut_lamports()? = remaining;
    **to.try_borrow_mut_lamports()? = credited;
    Ok(())
}

#[derive(Accounts)]
#[instruction(case_id: [u8; 32])]
pub struct OpenCase<'info> {
    #[account(
        init,
        payer = creator,
        space = 8 + CaseRecord::INIT_SPACE,
        seeds = [b"case", creator.key().as_ref(), case_id.as_ref()],
        bump
    )]
    pub case_record: Account<'info, CaseRecord>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(evidence_hash: [u8; 32])]
pub struct AnchorTransition<'info> {
    #[account(
        mut,
        seeds = [b"case", case_record.creator.as_ref(), case_record.case_id.as_ref()],
        bump = case_record.bump
    )]
    pub case_record: Account<'info, CaseRecord>,
    #[account(
        init,
        payer = payer,
        space = 8 + EvidenceAnchor::INIT_SPACE,
        seeds = [b"evidence", case_record.key().as_ref(), evidence_hash.as_ref()],
        bump
    )]
    pub evidence_anchor: Account<'info, EvidenceAnchor>,
    pub actor: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Payee on release; must be the submitter stored in the case.
    #[account(mut, address = case_record.submitter)]
    pub submitter: SystemAccount<'info>,
    /// Refund target on rejection; must be the creator stored in the case.
    #[account(mut, address = case_record.creator)]
    pub creator: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct CaseRecord {
    pub case_id: [u8; 32],
    pub creator: Pubkey,
    pub submitter: Pubkey,
    pub agent: Pubkey,
    pub rule_engine: Pubkey,
    pub approver: Pubkey,
    pub amount: u64,
    pub autonomy_limit: u64,
    pub state: u8,
    pub last_evidence_hash: [u8; 32],
    pub transition_count: u32,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct EvidenceAnchor {
    pub evidence_hash: [u8; 32],
    pub case_record: Pubkey,
    pub prev_hash: [u8; 32],
    pub from_state: u8,
    pub to_state: u8,
    pub actor: Pubkey,
    pub actor_kind: u8,
    pub rule_hash: [u8; 32],
    pub slot: u64,
    pub unix_ts: i64,
    pub bump: u8,
}

#[event]
pub struct CaseOpened {
    pub case_id: [u8; 32],
    pub creator: Pubkey,
    pub amount: u64,
    pub autonomy_limit: u64,
}

#[event]
pub struct TransitionAnchored {
    pub case_record: Pubkey,
    pub evidence_hash: [u8; 32],
    pub prev_hash: [u8; 32],
    pub from_state: u8,
    pub to_state: u8,
    pub actor: Pubkey,
    pub actor_kind: u8,
    pub rule_hash: [u8; 32],
    pub slot: u64,
    pub unix_ts: i64,
}

#[event]
pub struct FundsReleased {
    pub case_record: Pubkey,
    pub to: Pubkey,
    pub amount: u64,
}

#[event]
pub struct FundsRefunded {
    pub case_record: Pubkey,
    pub to: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum CoorreError {
    #[msg("Transition not allowed from the current state")]
    InvalidTransition,
    #[msg("Unknown state code")]
    InvalidState,
    #[msg("Signer is not the role key required for this transition")]
    UnauthorizedActor,
    #[msg("prev_hash does not match the last anchored evidence")]
    PrevHashMismatch,
    #[msg("Case is already in a terminal state")]
    CaseClosed,
    #[msg("Role keys must be pairwise distinct")]
    RolesNotDistinct,
    #[msg("Amount exceeds the automated actor's autonomy limit")]
    MandateExceeded,
    #[msg("Escrow cannot cover the payout without breaking rent exemption")]
    InsufficientEscrow,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Amount is below the rent-exempt minimum of a payee account")]
    AmountBelowRentExempt,
}
