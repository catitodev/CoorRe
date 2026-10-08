use anchor_lang::prelude::*;
use anchor_lang::system_program;

// Solana Playground rewrites this on build with the project's program id.
declare_id!("11111111111111111111111111111111");

#[program]
pub mod playground_spike {
    use super::*;

    /// Creates the vault PDA and funds it with `amount` lamports on top of rent.
    pub fn open_vault(ctx: Context<OpenVault>, amount: u64) -> Result<()> {
        require!(amount > 0, SpikeError::ZeroAmount);
        let vault_info = ctx.accounts.vault.to_account_info();
        transfer_in(
            &ctx.accounts.authority,
            &vault_info,
            &ctx.accounts.system_program,
            amount,
        )?;

        let vault = &mut ctx.accounts.vault;
        vault.authority = ctx.accounts.authority.key();
        vault.bump = ctx.bumps.vault;

        emit!(VaultDeposited {
            vault: vault_info.key(),
            from: ctx.accounts.authority.key(),
            amount,
            balance: vault_info.lamports(),
        });
        Ok(())
    }

    /// Adds `amount` lamports to an existing vault through a system transfer.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, SpikeError::ZeroAmount);
        let vault_info = ctx.accounts.vault.to_account_info();
        transfer_in(
            &ctx.accounts.authority,
            &vault_info,
            &ctx.accounts.system_program,
            amount,
        )?;

        emit!(VaultDeposited {
            vault: vault_info.key(),
            from: ctx.accounts.authority.key(),
            amount,
            balance: vault_info.lamports(),
        });
        Ok(())
    }

    /// Moves exactly `amount` lamports out of the program-owned vault by
    /// editing balances directly. The vault never drops below rent exemption.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, SpikeError::ZeroAmount);
        let vault_info = ctx.accounts.vault.to_account_info();
        let recipient_info = ctx.accounts.recipient.to_account_info();

        let rent_minimum = Rent::get()?.minimum_balance(vault_info.data_len());
        let remaining = vault_info
            .lamports()
            .checked_sub(amount)
            .ok_or(SpikeError::InsufficientVaultFunds)?;
        require!(
            remaining >= rent_minimum,
            SpikeError::InsufficientVaultFunds
        );
        let recipient_balance = recipient_info
            .lamports()
            .checked_add(amount)
            .ok_or(SpikeError::Overflow)?;

        **vault_info.try_borrow_mut_lamports()? = remaining;
        **recipient_info.try_borrow_mut_lamports()? = recipient_balance;

        emit!(VaultWithdrawn {
            vault: vault_info.key(),
            to: recipient_info.key(),
            amount,
            remaining,
        });
        Ok(())
    }
}

fn transfer_in<'info>(
    from: &Signer<'info>,
    to: &AccountInfo<'info>,
    system_program: &Program<'info, System>,
    amount: u64,
) -> Result<()> {
    system_program::transfer(
        CpiContext::new(
            system_program.to_account_info(),
            system_program::Transfer {
                from: from.to_account_info(),
                to: to.clone(),
            },
        ),
        amount,
    )
}

#[derive(Accounts)]
pub struct OpenVault<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Vault::INIT_SPACE,
        seeds = [b"vault", authority.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(
        mut,
        seeds = [b"vault", authority.key().as_ref()],
        bump = vault.bump,
        has_one = authority
    )]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        mut,
        seeds = [b"vault", authority.key().as_ref()],
        bump = vault.bump,
        has_one = authority
    )]
    pub vault: Account<'info, Vault>,
    pub authority: Signer<'info>,
    #[account(mut)]
    pub recipient: SystemAccount<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub authority: Pubkey,
    pub bump: u8,
}

#[event]
pub struct VaultDeposited {
    pub vault: Pubkey,
    pub from: Pubkey,
    pub amount: u64,
    pub balance: u64,
}

#[event]
pub struct VaultWithdrawn {
    pub vault: Pubkey,
    pub to: Pubkey,
    pub amount: u64,
    pub remaining: u64,
}

#[error_code]
pub enum SpikeError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Withdrawal would leave the vault below its rent-exempt minimum")]
    InsufficientVaultFunds,
    #[msg("Arithmetic overflow")]
    Overflow,
}
