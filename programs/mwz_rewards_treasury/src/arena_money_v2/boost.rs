use anchor_lang::prelude::*;

use super::competition::{
    CompetitionPoolV2, COMPETITION_POOL_SEED_V2, COMPETITION_STATE_CANCELLED,
    COMPETITION_STATE_LIVE, COMPETITION_STATE_OPEN,
};
use super::config::{ArenaMoneyConfigV2, ARENA_MONEY_CONFIG_SEED_V2, ARENA_MONEY_GENERATION_V2};
use super::errors::ArenaMoneyV2Error;
use super::math::mul_bps_u64;
use super::receipts::{debit_program_vault, transfer_sol, BoostReceiptV2, BOOST_RECEIPT_SEED_V2};

pub const BOOST_PRIZE_BPS: u64 = 9_000;
pub const BOOST_PROTOCOL_BPS: u64 = 1_000;
pub const BOOST_LEAGUE_BPS: u64 = 0;
pub const BOOST_BPS_DENOMINATOR: u64 = 10_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BoostSplitV2 {
    pub gross: u64,
    pub prize: u64,
    pub protocol: u64,
}

pub fn split_boost_v2(gross: u64) -> Result<BoostSplitV2> {
    require!(gross > 0, ArenaMoneyV2Error::InvalidAmount);
    let protocol = mul_bps_u64(gross, BOOST_PROTOCOL_BPS)?;
    let prize = gross.checked_sub(protocol).ok_or(ArenaMoneyV2Error::MathOverflow)?;
    require!(prize.checked_add(protocol) == Some(gross), ArenaMoneyV2Error::InvalidSplit);
    Ok(BoostSplitV2 { gross, prize, protocol })
}

#[derive(Accounts)]
#[instruction(competition_id: [u8; 32], funding_id: [u8; 32])]
pub struct DepositCompetitionBoostV2<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,
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
        payer = funder,
        space = 8 + BoostReceiptV2::SIZE,
        seeds = [BOOST_RECEIPT_SEED_V2, competition_id.as_ref(), funding_id.as_ref(), funder.key().as_ref()],
        bump
    )]
    pub receipt: Account<'info, BoostReceiptV2>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(competition_id: [u8; 32], funding_id: [u8; 32])]
pub struct RefundCompetitionBoostV2<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,
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
        seeds = [BOOST_RECEIPT_SEED_V2, competition_id.as_ref(), funding_id.as_ref(), funder.key().as_ref()],
        bump = receipt.bump,
        constraint = receipt.generation == ARENA_MONEY_GENERATION_V2 @ ArenaMoneyV2Error::GenerationMismatch,
        constraint = receipt.competition_id == competition_id @ ArenaMoneyV2Error::ReceiptMismatch,
        constraint = receipt.funding_id == funding_id @ ArenaMoneyV2Error::ReceiptMismatch,
        constraint = receipt.funder == funder.key() @ ArenaMoneyV2Error::ReceiptMismatch
    )]
    pub receipt: Account<'info, BoostReceiptV2>,
}

pub fn deposit_competition_boost_v2_handler(
    ctx: Context<DepositCompetitionBoostV2>,
    competition_id: [u8; 32],
    funding_id: [u8; 32],
    gross_lamports: u64,
) -> Result<()> {
    require!(funding_id != [0u8; 32], ArenaMoneyV2Error::InvalidId);
    let now = Clock::get()?.unix_timestamp;
    let pool = &mut ctx.accounts.pool;
    require!(
        pool.state == COMPETITION_STATE_OPEN || pool.state == COMPETITION_STATE_LIVE,
        ArenaMoneyV2Error::InvalidState
    );
    require!(now <= pool.closes_at, ArenaMoneyV2Error::DeadlinePassed);
    let split = split_boost_v2(gross_lamports)?;
    transfer_sol(
        &ctx.accounts.funder.to_account_info(),
        &pool.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        split.gross,
    )?;
    pool.boost_gross_lamports = pool.boost_gross_lamports.checked_add(split.gross).ok_or(ArenaMoneyV2Error::MathOverflow)?;
    pool.boost_prize_lamports = pool.boost_prize_lamports.checked_add(split.prize).ok_or(ArenaMoneyV2Error::MathOverflow)?;
    pool.boost_protocol_lamports = pool.boost_protocol_lamports.checked_add(split.protocol).ok_or(ArenaMoneyV2Error::MathOverflow)?;

    let receipt = &mut ctx.accounts.receipt;
    receipt.generation = ARENA_MONEY_GENERATION_V2;
    receipt.competition_id = competition_id;
    receipt.funding_id = funding_id;
    receipt.funder = ctx.accounts.funder.key();
    receipt.gross_lamports = split.gross;
    receipt.prize_lamports = split.prize;
    receipt.protocol_lamports = split.protocol;
    receipt.created_at = now;
    receipt.refunded = false;
    receipt.bump = ctx.bumps.receipt;
    Ok(())
}

pub fn refund_competition_boost_v2_handler(
    ctx: Context<RefundCompetitionBoostV2>,
    _competition_id: [u8; 32],
    _funding_id: [u8; 32],
) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    require!(pool.state == COMPETITION_STATE_CANCELLED, ArenaMoneyV2Error::InvalidState);
    let receipt = &mut ctx.accounts.receipt;
    require!(!receipt.refunded, ArenaMoneyV2Error::Replay);
    let gross = receipt.gross_lamports;
    require!(gross > 0, ArenaMoneyV2Error::NothingToClaim);
    pool.boost_gross_lamports = pool.boost_gross_lamports.checked_sub(gross).ok_or(ArenaMoneyV2Error::MathOverflow)?;
    pool.boost_prize_lamports = pool.boost_prize_lamports.checked_sub(receipt.prize_lamports).ok_or(ArenaMoneyV2Error::MathOverflow)?;
    pool.boost_protocol_lamports = pool.boost_protocol_lamports.checked_sub(receipt.protocol_lamports).ok_or(ArenaMoneyV2Error::MathOverflow)?;
    receipt.refunded = true;
    debit_program_vault(
        &pool.to_account_info(),
        &ctx.accounts.funder.to_account_info(),
        gross,
        CompetitionPoolV2::SIZE,
    )
}
