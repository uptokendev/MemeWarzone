use anchor_lang::prelude::*;

use super::config::{ArenaMoneyConfigV2, ARENA_MONEY_CONFIG_SEED_V2, ARENA_MONEY_GENERATION_V2};
use super::errors::ArenaMoneyV2Error;
use super::receipts::{debit_program_vault, transfer_sol, SponsorshipReceiptV1, SPONSORSHIP_RECEIPT_SEED_V1};

pub const SPONSORSHIP_EVENT_SEED_V1: &[u8] = b"arena_sponsor_event_v1";
pub const EVENT_PRIZE_VAULT_SEED_V1: &[u8] = b"arena_event_prize_v1";
pub const SPONSORSHIP_GENERATION_V1: u8 = 1;
pub const SPONSORSHIP_PRIZE_BPS: u64 = 7_000;
pub const SPONSORSHIP_MARKETING_BPS: u64 = 2_000;
pub const SPONSORSHIP_PROTOCOL_BPS: u64 = 1_000;
pub const SPONSORSHIP_BPS_DENOMINATOR: u64 = 10_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SponsorshipSplitV1 {
    pub gross: u64,
    pub prize: u64,
    pub marketing: u64,
    pub protocol: u64,
}

pub fn split_sponsorship_v1(gross: u64) -> Result<SponsorshipSplitV1> {
    require!(gross > 0, ArenaMoneyV2Error::InvalidAmount);
    let marketing = gross
        .checked_mul(SPONSORSHIP_MARKETING_BPS)
        .ok_or(ArenaMoneyV2Error::MathOverflow)?
        / SPONSORSHIP_BPS_DENOMINATOR;
    let protocol = gross
        .checked_mul(SPONSORSHIP_PROTOCOL_BPS)
        .ok_or(ArenaMoneyV2Error::MathOverflow)?
        / SPONSORSHIP_BPS_DENOMINATOR;
    let prize = gross
        .checked_sub(marketing)
        .and_then(|v| v.checked_sub(protocol))
        .ok_or(ArenaMoneyV2Error::MathOverflow)?;
    require!(
        prize.checked_add(marketing).and_then(|v| v.checked_add(protocol)) == Some(gross),
        ArenaMoneyV2Error::InvalidSplit
    );
    Ok(SponsorshipSplitV1 { gross, prize, marketing, protocol })
}

#[account]
pub struct SponsorshipEventV1 {
    pub generation: u8,
    pub event_id: [u8; 32],
    pub authority: Pubkey,
    pub event_receiver: Pubkey,
    pub minimum_lamports: u64,
    pub enabled: bool,
    pub bump: u8,
}
impl SponsorshipEventV1 {
    pub const SIZE: usize = 1 + 32 + 32 * 2 + 8 + 1 + 1;
}

#[account]
pub struct EventPrizeVaultV1 {
    pub generation: u8,
    pub event_id: [u8; 32],
    pub prize_lamports: u64,
    pub marketing_lamports: u64,
    pub protocol_lamports: u64,
    pub prize_claimed_lamports: u64,
    pub marketing_claimed_lamports: u64,
    pub protocol_claimed_lamports: u64,
    pub bump: u8,
}
impl EventPrizeVaultV1 {
    pub const SIZE: usize = 1 + 32 + 8 * 6 + 1;
}

#[derive(Accounts)]
#[instruction(event_id: [u8; 32])]
pub struct InitializeSponsorshipEventV1<'info> {
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
        space = 8 + SponsorshipEventV1::SIZE,
        seeds = [SPONSORSHIP_EVENT_SEED_V1, event_id.as_ref()],
        bump
    )]
    pub event: Account<'info, SponsorshipEventV1>,
    #[account(
        init,
        payer = authority,
        space = 8 + EventPrizeVaultV1::SIZE,
        seeds = [EVENT_PRIZE_VAULT_SEED_V1, event_id.as_ref()],
        bump
    )]
    pub vault: Account<'info, EventPrizeVaultV1>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(event_id: [u8; 32], payment_id: [u8; 32])]
pub struct PaySponsorshipV1<'info> {
    #[account(mut)]
    pub sponsor: Signer<'info>,
    #[account(
        seeds = [ARENA_MONEY_CONFIG_SEED_V2],
        bump = config.bump,
        constraint = config.generation == ARENA_MONEY_GENERATION_V2 @ ArenaMoneyV2Error::GenerationMismatch,
        constraint = !config.paused @ ArenaMoneyV2Error::Paused
    )]
    pub config: Account<'info, ArenaMoneyConfigV2>,
    #[account(
        seeds = [SPONSORSHIP_EVENT_SEED_V1, event_id.as_ref()],
        bump = event.bump,
        constraint = event.generation == SPONSORSHIP_GENERATION_V1 @ ArenaMoneyV2Error::GenerationMismatch,
        constraint = event.event_id == event_id @ ArenaMoneyV2Error::InvalidId,
        constraint = event.enabled @ ArenaMoneyV2Error::EventDisabled
    )]
    pub event: Account<'info, SponsorshipEventV1>,
    #[account(
        mut,
        seeds = [EVENT_PRIZE_VAULT_SEED_V1, event_id.as_ref()],
        bump = vault.bump,
        constraint = vault.generation == SPONSORSHIP_GENERATION_V1 @ ArenaMoneyV2Error::GenerationMismatch,
        constraint = vault.event_id == event_id @ ArenaMoneyV2Error::InvalidId
    )]
    pub vault: Account<'info, EventPrizeVaultV1>,
    #[account(
        init,
        payer = sponsor,
        space = 8 + SponsorshipReceiptV1::SIZE,
        seeds = [SPONSORSHIP_RECEIPT_SEED_V1, event_id.as_ref(), payment_id.as_ref(), sponsor.key().as_ref()],
        bump
    )]
    pub receipt: Account<'info, SponsorshipReceiptV1>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(event_id: [u8; 32])]
pub struct ClaimEventPrizeV1<'info> {
    #[account(mut)]
    pub receiver: Signer<'info>,
    #[account(
        seeds = [SPONSORSHIP_EVENT_SEED_V1, event_id.as_ref()],
        bump = event.bump,
        constraint = event.event_receiver == receiver.key() @ ArenaMoneyV2Error::Unauthorized
    )]
    pub event: Account<'info, SponsorshipEventV1>,
    #[account(mut, seeds = [EVENT_PRIZE_VAULT_SEED_V1, event_id.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, EventPrizeVaultV1>,
}

#[derive(Accounts)]
#[instruction(event_id: [u8; 32])]
pub struct ClaimSponsorshipMarketingV1<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [ARENA_MONEY_CONFIG_SEED_V2], bump = config.bump)]
    pub config: Account<'info, ArenaMoneyConfigV2>,
    #[account(mut, address = config.marketing_receiver)]
    pub receiver: SystemAccount<'info>,
    #[account(mut, seeds = [EVENT_PRIZE_VAULT_SEED_V1, event_id.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, EventPrizeVaultV1>,
}

#[derive(Accounts)]
#[instruction(event_id: [u8; 32])]
pub struct ClaimSponsorshipProtocolV1<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [ARENA_MONEY_CONFIG_SEED_V2], bump = config.bump)]
    pub config: Account<'info, ArenaMoneyConfigV2>,
    #[account(mut, address = config.protocol_receiver)]
    pub receiver: SystemAccount<'info>,
    #[account(mut, seeds = [EVENT_PRIZE_VAULT_SEED_V1, event_id.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, EventPrizeVaultV1>,
}

pub fn initialize_sponsorship_event_v1_handler(
    ctx: Context<InitializeSponsorshipEventV1>,
    event_id: [u8; 32],
    event_receiver: Pubkey,
    minimum_lamports: u64,
) -> Result<()> {
    require!(event_id != [0u8; 32], ArenaMoneyV2Error::InvalidId);
    require!(event_receiver != Pubkey::default(), ArenaMoneyV2Error::ZeroAddress);
    require!(minimum_lamports > 0, ArenaMoneyV2Error::InvalidAmount);
    let event = &mut ctx.accounts.event;
    event.generation = SPONSORSHIP_GENERATION_V1;
    event.event_id = event_id;
    event.authority = ctx.accounts.authority.key();
    event.event_receiver = event_receiver;
    event.minimum_lamports = minimum_lamports;
    event.enabled = true;
    event.bump = ctx.bumps.event;
    let vault = &mut ctx.accounts.vault;
    vault.generation = SPONSORSHIP_GENERATION_V1;
    vault.event_id = event_id;
    vault.prize_lamports = 0;
    vault.marketing_lamports = 0;
    vault.protocol_lamports = 0;
    vault.prize_claimed_lamports = 0;
    vault.marketing_claimed_lamports = 0;
    vault.protocol_claimed_lamports = 0;
    vault.bump = ctx.bumps.vault;
    Ok(())
}

pub fn pay_sponsorship_v1_handler(
    ctx: Context<PaySponsorshipV1>,
    event_id: [u8; 32],
    payment_id: [u8; 32],
    gross_lamports: u64,
) -> Result<()> {
    require!(payment_id != [0u8; 32], ArenaMoneyV2Error::InvalidId);
    require!(gross_lamports >= ctx.accounts.event.minimum_lamports, ArenaMoneyV2Error::SponsorshipBelowMinimum);
    let split = split_sponsorship_v1(gross_lamports)?;
    transfer_sol(
        &ctx.accounts.sponsor.to_account_info(),
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        split.gross,
    )?;
    let vault = &mut ctx.accounts.vault;
    vault.prize_lamports = vault.prize_lamports.checked_add(split.prize).ok_or(ArenaMoneyV2Error::MathOverflow)?;
    vault.marketing_lamports = vault.marketing_lamports.checked_add(split.marketing).ok_or(ArenaMoneyV2Error::MathOverflow)?;
    vault.protocol_lamports = vault.protocol_lamports.checked_add(split.protocol).ok_or(ArenaMoneyV2Error::MathOverflow)?;
    let receipt = &mut ctx.accounts.receipt;
    receipt.generation = SPONSORSHIP_GENERATION_V1;
    receipt.event_id = event_id;
    receipt.payment_id = payment_id;
    receipt.sponsor = ctx.accounts.sponsor.key();
    receipt.gross_lamports = split.gross;
    receipt.prize_lamports = split.prize;
    receipt.marketing_lamports = split.marketing;
    receipt.protocol_lamports = split.protocol;
    receipt.created_at = Clock::get()?.unix_timestamp;
    receipt.bump = ctx.bumps.receipt;
    Ok(())
}

pub fn claim_event_prize_v1_handler(ctx: Context<ClaimEventPrizeV1>, _event_id: [u8; 32]) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let amount = vault.prize_lamports;
    require!(amount > 0, ArenaMoneyV2Error::NothingToClaim);
    vault.prize_lamports = 0;
    vault.prize_claimed_lamports = vault.prize_claimed_lamports.checked_add(amount).ok_or(ArenaMoneyV2Error::MathOverflow)?;
    debit_program_vault(&vault.to_account_info(), &ctx.accounts.receiver.to_account_info(), amount, EventPrizeVaultV1::SIZE)
}

pub fn claim_sponsorship_marketing_v1_handler(ctx: Context<ClaimSponsorshipMarketingV1>, _event_id: [u8; 32]) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let amount = vault.marketing_lamports;
    require!(amount > 0, ArenaMoneyV2Error::NothingToClaim);
    vault.marketing_lamports = 0;
    vault.marketing_claimed_lamports = vault.marketing_claimed_lamports.checked_add(amount).ok_or(ArenaMoneyV2Error::MathOverflow)?;
    debit_program_vault(&vault.to_account_info(), &ctx.accounts.receiver.to_account_info(), amount, EventPrizeVaultV1::SIZE)
}

pub fn claim_sponsorship_protocol_v1_handler(ctx: Context<ClaimSponsorshipProtocolV1>, _event_id: [u8; 32]) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let amount = vault.protocol_lamports;
    require!(amount > 0, ArenaMoneyV2Error::NothingToClaim);
    vault.protocol_lamports = 0;
    vault.protocol_claimed_lamports = vault.protocol_claimed_lamports.checked_add(amount).ok_or(ArenaMoneyV2Error::MathOverflow)?;
    debit_program_vault(&vault.to_account_info(), &ctx.accounts.receiver.to_account_info(), amount, EventPrizeVaultV1::SIZE)
}
