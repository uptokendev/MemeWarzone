use anchor_lang::prelude::*;

use super::competition::{CompetitionPoolV2, COMPETITION_POOL_SEED_V2, COMPETITION_STATE_RESOLVED};
use super::config::{ArenaMoneyConfigV2, ARENA_MONEY_CONFIG_SEED_V2, ARENA_MONEY_GENERATION_V2};
use super::errors::ArenaMoneyV2Error;
use super::receipts::{debit_program_vault, LeagueSourceReceiptV2, LEAGUE_SOURCE_RECEIPT_SEED_V2};

pub const POSTGRAD_LEAGUE_TREASURY_SEED_V2: &[u8] = b"postgrad_league_v2";
pub const LEAGUE_MONTHLY_BPS: u64 = 6_000;
pub const LEAGUE_QUARTERLY_BPS: u64 = 4_000;
pub const LEAGUE_BPS_DENOMINATOR: u64 = 10_000;
pub const LEAGUE_SOURCE_COMPETITION: u8 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LeagueSplitV2 {
    pub gross: u64,
    pub monthly: u64,
    pub quarterly: u64,
}

pub fn split_postgrad_league_v2(gross: u64) -> Result<LeagueSplitV2> {
    require!(gross > 0, ArenaMoneyV2Error::InvalidAmount);
    let quarterly = gross
        .checked_mul(LEAGUE_QUARTERLY_BPS)
        .ok_or(ArenaMoneyV2Error::MathOverflow)?
        / LEAGUE_BPS_DENOMINATOR;
    let monthly = gross.checked_sub(quarterly).ok_or(ArenaMoneyV2Error::MathOverflow)?;
    require!(monthly.checked_add(quarterly) == Some(gross), ArenaMoneyV2Error::InvalidSplit);
    Ok(LeagueSplitV2 { gross, monthly, quarterly })
}

#[account]
pub struct PostGradLeagueTreasuryV2 {
    pub generation: u8,
    pub authority: Pubkey,
    pub monthly_receiver: Pubkey,
    pub quarterly_receiver: Pubkey,
    pub monthly_lamports: u64,
    pub quarterly_lamports: u64,
    pub monthly_claimed_lamports: u64,
    pub quarterly_claimed_lamports: u64,
    pub bump: u8,
}
impl PostGradLeagueTreasuryV2 {
    pub const SIZE: usize = 1 + 32 * 3 + 8 * 4 + 1;
}

#[derive(Accounts)]
pub struct InitializePostGradLeagueTreasuryV2<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [ARENA_MONEY_CONFIG_SEED_V2],
        bump = config.bump,
        constraint = config.generation == ARENA_MONEY_GENERATION_V2 @ ArenaMoneyV2Error::GenerationMismatch,
        constraint = config.authority == authority.key() @ ArenaMoneyV2Error::Unauthorized
    )]
    pub config: Account<'info, ArenaMoneyConfigV2>,
    #[account(
        init,
        payer = authority,
        space = 8 + PostGradLeagueTreasuryV2::SIZE,
        seeds = [POSTGRAD_LEAGUE_TREASURY_SEED_V2],
        bump
    )]
    pub treasury: Account<'info, PostGradLeagueTreasuryV2>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(competition_id: [u8; 32])]
pub struct RouteCompetitionLeagueV2<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [COMPETITION_POOL_SEED_V2, competition_id.as_ref()],
        bump = pool.bump,
        constraint = pool.generation == ARENA_MONEY_GENERATION_V2 @ ArenaMoneyV2Error::GenerationMismatch,
        constraint = pool.competition_id == competition_id @ ArenaMoneyV2Error::InvalidId
    )]
    pub pool: Account<'info, CompetitionPoolV2>,
    #[account(
        mut,
        seeds = [POSTGRAD_LEAGUE_TREASURY_SEED_V2],
        bump = treasury.bump,
        constraint = treasury.generation == ARENA_MONEY_GENERATION_V2 @ ArenaMoneyV2Error::GenerationMismatch
    )]
    pub treasury: Account<'info, PostGradLeagueTreasuryV2>,
    #[account(
        init,
        payer = caller,
        space = 8 + LeagueSourceReceiptV2::SIZE,
        seeds = [LEAGUE_SOURCE_RECEIPT_SEED_V2, competition_id.as_ref()],
        bump
    )]
    pub receipt: Account<'info, LeagueSourceReceiptV2>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimMonthlyLeagueV2<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [POSTGRAD_LEAGUE_TREASURY_SEED_V2],
        bump = treasury.bump,
        constraint = treasury.generation == ARENA_MONEY_GENERATION_V2 @ ArenaMoneyV2Error::GenerationMismatch
    )]
    pub treasury: Account<'info, PostGradLeagueTreasuryV2>,
    #[account(mut, address = treasury.monthly_receiver)]
    pub receiver: SystemAccount<'info>,
}

#[derive(Accounts)]
pub struct ClaimQuarterlyLeagueV2<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [POSTGRAD_LEAGUE_TREASURY_SEED_V2],
        bump = treasury.bump,
        constraint = treasury.generation == ARENA_MONEY_GENERATION_V2 @ ArenaMoneyV2Error::GenerationMismatch
    )]
    pub treasury: Account<'info, PostGradLeagueTreasuryV2>,
    #[account(mut, address = treasury.quarterly_receiver)]
    pub receiver: SystemAccount<'info>,
}

pub fn initialize_postgrad_league_treasury_v2_handler(
    ctx: Context<InitializePostGradLeagueTreasuryV2>,
    monthly_receiver: Pubkey,
    quarterly_receiver: Pubkey,
) -> Result<()> {
    require!(monthly_receiver != Pubkey::default(), ArenaMoneyV2Error::ZeroAddress);
    require!(quarterly_receiver != Pubkey::default(), ArenaMoneyV2Error::ZeroAddress);
    let treasury = &mut ctx.accounts.treasury;
    treasury.generation = ARENA_MONEY_GENERATION_V2;
    treasury.authority = ctx.accounts.authority.key();
    treasury.monthly_receiver = monthly_receiver;
    treasury.quarterly_receiver = quarterly_receiver;
    treasury.monthly_lamports = 0;
    treasury.quarterly_lamports = 0;
    treasury.monthly_claimed_lamports = 0;
    treasury.quarterly_claimed_lamports = 0;
    treasury.bump = ctx.bumps.treasury;
    Ok(())
}

pub fn route_competition_league_v2_handler(
    ctx: Context<RouteCompetitionLeagueV2>,
    competition_id: [u8; 32],
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pool = &mut ctx.accounts.pool;
    require!(pool.state == COMPETITION_STATE_RESOLVED && !pool.league_claimed, ArenaMoneyV2Error::InvalidState);
    let amount = pool.pending_league_lamports;
    require!(amount > 0, ArenaMoneyV2Error::NothingToClaim);
    let split = split_postgrad_league_v2(amount)?;

    debit_program_vault(
        &pool.to_account_info(),
        &ctx.accounts.treasury.to_account_info(),
        amount,
        CompetitionPoolV2::SIZE,
    )?;
    pool.pending_league_lamports = 0;
    pool.league_claimed = true;

    let treasury = &mut ctx.accounts.treasury;
    treasury.monthly_lamports = treasury.monthly_lamports.checked_add(split.monthly).ok_or(ArenaMoneyV2Error::MathOverflow)?;
    treasury.quarterly_lamports = treasury.quarterly_lamports.checked_add(split.quarterly).ok_or(ArenaMoneyV2Error::MathOverflow)?;

    let receipt = &mut ctx.accounts.receipt;
    receipt.generation = ARENA_MONEY_GENERATION_V2;
    receipt.source_id = competition_id;
    receipt.source_kind = LEAGUE_SOURCE_COMPETITION;
    receipt.amount_lamports = split.gross;
    receipt.monthly_lamports = split.monthly;
    receipt.quarterly_lamports = split.quarterly;
    receipt.created_at = now;
    receipt.bump = ctx.bumps.receipt;
    Ok(())
}

pub fn claim_monthly_league_v2_handler(ctx: Context<ClaimMonthlyLeagueV2>) -> Result<()> {
    let treasury = &mut ctx.accounts.treasury;
    let amount = treasury.monthly_lamports;
    require!(amount > 0, ArenaMoneyV2Error::NothingToClaim);
    treasury.monthly_lamports = 0;
    treasury.monthly_claimed_lamports = treasury.monthly_claimed_lamports.checked_add(amount).ok_or(ArenaMoneyV2Error::MathOverflow)?;
    debit_program_vault(&treasury.to_account_info(), &ctx.accounts.receiver.to_account_info(), amount, PostGradLeagueTreasuryV2::SIZE)
}

pub fn claim_quarterly_league_v2_handler(ctx: Context<ClaimQuarterlyLeagueV2>) -> Result<()> {
    let treasury = &mut ctx.accounts.treasury;
    let amount = treasury.quarterly_lamports;
    require!(amount > 0, ArenaMoneyV2Error::NothingToClaim);
    treasury.quarterly_lamports = 0;
    treasury.quarterly_claimed_lamports = treasury.quarterly_claimed_lamports.checked_add(amount).ok_or(ArenaMoneyV2Error::MathOverflow)?;
    debit_program_vault(&treasury.to_account_info(), &ctx.accounts.receiver.to_account_info(), amount, PostGradLeagueTreasuryV2::SIZE)
}
