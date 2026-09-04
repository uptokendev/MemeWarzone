use anchor_lang::prelude::*;

use super::config::{ArenaMoneyConfigV2, ARENA_MONEY_CONFIG_SEED_V2, ARENA_MONEY_GENERATION_V2};
use super::errors::ArenaMoneyV2Error;
use super::receipts::{
    debit_program_vault, transfer_sol, CompetitionEntryReceiptV2, COMPETITION_ENTRY_RECEIPT_SEED_V2,
};

pub const COMPETITION_POOL_SEED_V2: &[u8] = b"arena_competition_v2";
pub const COMPETITION_KIND_BATTLE: u8 = 0;
pub const COMPETITION_KIND_TOURNAMENT: u8 = 1;
pub const COMPETITION_STATE_OPEN: u8 = 0;
pub const COMPETITION_STATE_LIVE: u8 = 1;
pub const COMPETITION_STATE_RESOLVED: u8 = 2;
pub const COMPETITION_STATE_CANCELLED: u8 = 3;

pub const COMPETITION_PRIZE_BPS: u64 = 7_500;
pub const COMPETITION_LEAGUE_BPS: u64 = 2_000;
pub const COMPETITION_PROTOCOL_BPS: u64 = 500;
pub const BPS_DENOMINATOR: u64 = 10_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CompetitionSplitV2 {
    pub gross: u64,
    pub prize: u64,
    pub league: u64,
    pub protocol: u64,
}

pub fn split_competition_v2(gross: u64) -> Result<CompetitionSplitV2> {
    require!(gross > 0, ArenaMoneyV2Error::InvalidAmount);
    let league = gross
        .checked_mul(COMPETITION_LEAGUE_BPS)
        .ok_or(ArenaMoneyV2Error::MathOverflow)?
        / BPS_DENOMINATOR;
    let protocol = gross
        .checked_mul(COMPETITION_PROTOCOL_BPS)
        .ok_or(ArenaMoneyV2Error::MathOverflow)?
        / BPS_DENOMINATOR;
    let prize = gross
        .checked_sub(league)
        .and_then(|v| v.checked_sub(protocol))
        .ok_or(ArenaMoneyV2Error::MathOverflow)?;
    require!(
        prize.checked_add(league).and_then(|v| v.checked_add(protocol)) == Some(gross),
        ArenaMoneyV2Error::InvalidSplit
    );
    Ok(CompetitionSplitV2 { gross, prize, league, protocol })
}

#[account]
pub struct CompetitionPoolV2 {
    pub generation: u8,
    pub competition_id: [u8; 32],
    pub kind: u8,
    pub state: u8,
    pub authority: Pubkey,
    pub asset_a: Pubkey,
    pub asset_b: Pubkey,
    pub owner_a: Pubkey,
    pub owner_b: Pubkey,
    pub required_entry_lamports: u64,
    pub entry_total_lamports: u64,
    pub entry_count: u32,
    pub boost_gross_lamports: u64,
    pub boost_prize_lamports: u64,
    pub boost_protocol_lamports: u64,
    pub winner_asset: Pubkey,
    pub winner_wallet: Pubkey,
    pub pending_winner_lamports: u64,
    pub pending_league_lamports: u64,
    pub pending_protocol_lamports: u64,
    pub winner_claimed: bool,
    pub league_claimed: bool,
    pub protocol_claimed: bool,
    pub opens_at: i64,
    pub closes_at: i64,
    pub resolved_at: i64,
    pub bump: u8,
}
impl CompetitionPoolV2 {
    pub const SIZE: usize = 1 + 32 + 2 + 32 * 5 + 8 * 9 + 4 + 32 * 2 + 3 + 8 * 3 + 1;
}

#[derive(Accounts)]
#[instruction(competition_id: [u8; 32])]
pub struct OpenCompetitionPoolV2<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [ARENA_MONEY_CONFIG_SEED_V2],
        bump = config.bump,
        constraint = config.generation == ARENA_MONEY_GENERATION_V2 @ ArenaMoneyV2Error::GenerationMismatch,
        constraint = config.authority == authority.key() @ ArenaMoneyV2Error::Unauthorized,
        constraint = !config.paused @ ArenaMoneyV2Error::Paused
    )]
    pub config: Account<'info, ArenaMoneyConfigV2>,
    #[account(
        init,
        payer = authority,
        space = 8 + CompetitionPoolV2::SIZE,
        seeds = [COMPETITION_POOL_SEED_V2, competition_id.as_ref()],
        bump
    )]
    pub pool: Account<'info, CompetitionPoolV2>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(competition_id: [u8; 32], entry_asset: Pubkey)]
pub struct DepositCompetitionEntryV2<'info> {
    #[account(mut)]
    pub entrant: Signer<'info>,
    #[account(
        seeds = [ARENA_MONEY_CONFIG_SEED_V2],
        bump = config.bump,
        constraint = config.generation == ARENA_MONEY_GENERATION_V2 @ ArenaMoneyV2Error::GenerationMismatch,
        constraint = !config.paused @ ArenaMoneyV2Error::Paused
    )]
    pub config: Account<'info, ArenaMoneyConfigV2>,
    #[account(
        mut,
        seeds = [COMPETITION_POOL_SEED_V2, competition_id.as_ref()],
        bump = pool.bump,
        constraint = pool.generation == ARENA_MONEY_GENERATION_V2 @ ArenaMoneyV2Error::GenerationMismatch,
        constraint = pool.competition_id == competition_id @ ArenaMoneyV2Error::InvalidId
    )]
    pub pool: Account<'info, CompetitionPoolV2>,
    #[account(
        init,
        payer = entrant,
        space = 8 + CompetitionEntryReceiptV2::SIZE,
        seeds = [
            COMPETITION_ENTRY_RECEIPT_SEED_V2,
            competition_id.as_ref(),
            entry_asset.as_ref(),
            entrant.key().as_ref()
        ],
        bump
    )]
    pub receipt: Account<'info, CompetitionEntryReceiptV2>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(competition_id: [u8; 32])]
pub struct ResolveCompetitionPoolV2<'info> {
    pub resolver: Signer<'info>,
    #[account(
        seeds = [ARENA_MONEY_CONFIG_SEED_V2],
        bump = config.bump,
        constraint = config.generation == ARENA_MONEY_GENERATION_V2 @ ArenaMoneyV2Error::GenerationMismatch,
        constraint = config.resolver == resolver.key() @ ArenaMoneyV2Error::Unauthorized
    )]
    pub config: Account<'info, ArenaMoneyConfigV2>,
    #[account(
        mut,
        seeds = [COMPETITION_POOL_SEED_V2, competition_id.as_ref()],
        bump = pool.bump,
        constraint = pool.generation == ARENA_MONEY_GENERATION_V2 @ ArenaMoneyV2Error::GenerationMismatch,
        constraint = pool.competition_id == competition_id @ ArenaMoneyV2Error::InvalidId
    )]
    pub pool: Account<'info, CompetitionPoolV2>,
}

#[derive(Accounts)]
#[instruction(competition_id: [u8; 32])]
pub struct ClaimCompetitionWinnerV2<'info> {
    #[account(mut)]
    pub winner: Signer<'info>,
    #[account(
        mut,
        seeds = [COMPETITION_POOL_SEED_V2, competition_id.as_ref()],
        bump = pool.bump,
        constraint = pool.generation == ARENA_MONEY_GENERATION_V2 @ ArenaMoneyV2Error::GenerationMismatch,
        constraint = pool.winner_wallet == winner.key() @ ArenaMoneyV2Error::InvalidWinner
    )]
    pub pool: Account<'info, CompetitionPoolV2>,
}

#[derive(Accounts)]
#[instruction(competition_id: [u8; 32])]
pub struct ClaimCompetitionProtocolV2<'info> {
    pub caller: Signer<'info>,
    #[account(
        seeds = [ARENA_MONEY_CONFIG_SEED_V2],
        bump = config.bump,
        constraint = config.generation == ARENA_MONEY_GENERATION_V2 @ ArenaMoneyV2Error::GenerationMismatch
    )]
    pub config: Account<'info, ArenaMoneyConfigV2>,
    #[account(mut, address = config.protocol_receiver)]
    pub receiver: SystemAccount<'info>,
    #[account(
        mut,
        seeds = [COMPETITION_POOL_SEED_V2, competition_id.as_ref()],
        bump = pool.bump,
        constraint = pool.generation == ARENA_MONEY_GENERATION_V2 @ ArenaMoneyV2Error::GenerationMismatch
    )]
    pub pool: Account<'info, CompetitionPoolV2>,
}

pub fn open_competition_pool_v2_handler(
    ctx: Context<OpenCompetitionPoolV2>,
    competition_id: [u8; 32],
    kind: u8,
    asset_a: Pubkey,
    asset_b: Pubkey,
    owner_a: Pubkey,
    owner_b: Pubkey,
    required_entry_lamports: u64,
    opens_at: i64,
    closes_at: i64,
) -> Result<()> {
    require!(competition_id != [0u8; 32], ArenaMoneyV2Error::InvalidId);
    require!(kind == COMPETITION_KIND_BATTLE || kind == COMPETITION_KIND_TOURNAMENT, ArenaMoneyV2Error::InvalidState);
    require!(closes_at > opens_at, ArenaMoneyV2Error::DeadlinePassed);
    if kind == COMPETITION_KIND_BATTLE {
        require!(asset_a != Pubkey::default() && asset_b != Pubkey::default() && asset_a != asset_b, ArenaMoneyV2Error::InvalidParticipant);
        require!(owner_a != Pubkey::default() && owner_b != Pubkey::default() && owner_a != owner_b, ArenaMoneyV2Error::InvalidParticipant);
    }
    let pool = &mut ctx.accounts.pool;
    pool.generation = ARENA_MONEY_GENERATION_V2;
    pool.competition_id = competition_id;
    pool.kind = kind;
    pool.state = COMPETITION_STATE_OPEN;
    pool.authority = ctx.accounts.authority.key();
    pool.asset_a = asset_a;
    pool.asset_b = asset_b;
    pool.owner_a = owner_a;
    pool.owner_b = owner_b;
    pool.required_entry_lamports = required_entry_lamports;
    pool.entry_total_lamports = 0;
    pool.entry_count = 0;
    pool.boost_gross_lamports = 0;
    pool.boost_prize_lamports = 0;
    pool.boost_protocol_lamports = 0;
    pool.winner_asset = Pubkey::default();
    pool.winner_wallet = Pubkey::default();
    pool.pending_winner_lamports = 0;
    pool.pending_league_lamports = 0;
    pool.pending_protocol_lamports = 0;
    pool.winner_claimed = false;
    pool.league_claimed = false;
    pool.protocol_claimed = false;
    pool.opens_at = opens_at;
    pool.closes_at = closes_at;
    pool.resolved_at = 0;
    pool.bump = ctx.bumps.pool;
    Ok(())
}

pub fn deposit_competition_entry_v2_handler(
    ctx: Context<DepositCompetitionEntryV2>,
    competition_id: [u8; 32],
    entry_asset: Pubkey,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pool = &mut ctx.accounts.pool;
    require!(pool.state == COMPETITION_STATE_OPEN, ArenaMoneyV2Error::InvalidState);
    require!(now >= pool.opens_at && now <= pool.closes_at, ArenaMoneyV2Error::DeadlinePassed);
    require!(entry_asset != Pubkey::default(), ArenaMoneyV2Error::InvalidParticipant);
    let amount = pool.required_entry_lamports;
    require!(amount > 0, ArenaMoneyV2Error::InvalidAmount);
    transfer_sol(
        &ctx.accounts.entrant.to_account_info(),
        &pool.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        amount,
    )?;
    pool.entry_total_lamports = pool.entry_total_lamports.checked_add(amount).ok_or(ArenaMoneyV2Error::MathOverflow)?;
    pool.entry_count = pool.entry_count.checked_add(1).ok_or(ArenaMoneyV2Error::MathOverflow)?;
    if pool.kind == COMPETITION_KIND_BATTLE && pool.entry_count >= 2 {
        pool.state = COMPETITION_STATE_LIVE;
    }
    let receipt = &mut ctx.accounts.receipt;
    receipt.generation = ARENA_MONEY_GENERATION_V2;
    receipt.competition_id = competition_id;
    receipt.entrant = ctx.accounts.entrant.key();
    receipt.entry_asset = entry_asset;
    receipt.amount_lamports = amount;
    receipt.created_at = now;
    receipt.refunded = false;
    receipt.bump = ctx.bumps.receipt;
    Ok(())
}

pub fn resolve_competition_pool_v2_handler(
    ctx: Context<ResolveCompetitionPoolV2>,
    _competition_id: [u8; 32],
    winner_asset: Pubkey,
    winner_wallet: Pubkey,
) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    require!(pool.state == COMPETITION_STATE_LIVE || (pool.kind == COMPETITION_KIND_TOURNAMENT && pool.state == COMPETITION_STATE_OPEN), ArenaMoneyV2Error::InvalidState);
    require!(winner_asset != Pubkey::default() && winner_wallet != Pubkey::default(), ArenaMoneyV2Error::InvalidWinner);
    let entry = split_competition_v2(pool.entry_total_lamports)?;
    pool.pending_winner_lamports = entry.prize.checked_add(pool.boost_prize_lamports).ok_or(ArenaMoneyV2Error::MathOverflow)?;
    pool.pending_league_lamports = entry.league;
    pool.pending_protocol_lamports = entry.protocol.checked_add(pool.boost_protocol_lamports).ok_or(ArenaMoneyV2Error::MathOverflow)?;
    let accounted = pool
        .pending_winner_lamports
        .checked_add(pool.pending_league_lamports)
        .and_then(|v| v.checked_add(pool.pending_protocol_lamports))
        .ok_or(ArenaMoneyV2Error::MathOverflow)?;
    let expected = pool.entry_total_lamports.checked_add(pool.boost_gross_lamports).ok_or(ArenaMoneyV2Error::MathOverflow)?;
    require!(accounted == expected, ArenaMoneyV2Error::InvalidSplit);
    pool.winner_asset = winner_asset;
    pool.winner_wallet = winner_wallet;
    pool.state = COMPETITION_STATE_RESOLVED;
    pool.resolved_at = Clock::get()?.unix_timestamp;
    Ok(())
}

pub fn claim_competition_winner_v2_handler(ctx: Context<ClaimCompetitionWinnerV2>, _competition_id: [u8; 32]) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    require!(pool.state == COMPETITION_STATE_RESOLVED && !pool.winner_claimed, ArenaMoneyV2Error::InvalidState);
    let amount = pool.pending_winner_lamports;
    require!(amount > 0, ArenaMoneyV2Error::NothingToClaim);
    pool.pending_winner_lamports = 0;
    pool.winner_claimed = true;
    debit_program_vault(&pool.to_account_info(), &ctx.accounts.winner.to_account_info(), amount, CompetitionPoolV2::SIZE)
}

pub fn claim_competition_protocol_v2_handler(ctx: Context<ClaimCompetitionProtocolV2>, _competition_id: [u8; 32]) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    require!(pool.state == COMPETITION_STATE_RESOLVED && !pool.protocol_claimed, ArenaMoneyV2Error::InvalidState);
    let amount = pool.pending_protocol_lamports;
    require!(amount > 0, ArenaMoneyV2Error::NothingToClaim);
    pool.pending_protocol_lamports = 0;
    pool.protocol_claimed = true;
    debit_program_vault(&pool.to_account_info(), &ctx.accounts.receiver.to_account_info(), amount, CompetitionPoolV2::SIZE)
}
