//! Reward poster: a narrow key that may post the weekly airdrop batch root, so the weekly airdrop
//! runs unattended on our own server without the rewards authority (which can also redirect the
//! protocol route and the arena) ever leaving the founder's machine (founder, 2026-09-25).
//!
//! Audit notes
//! - Who: only `reward_poster.poster`, set and revoked by `config.authority`. Default pubkey = off.
//! - What: exactly one thing -- initialize an AirdropBatch PDA (same seeds as the authority path,
//!   so claims are unchanged and one epoch can never have two batches).
//! - Bounded loss if the poster key leaks: total_lamports <= max_airdrop_batch_lamports (set by the
//!   authority), at most one post per REWARD_POSTER_MIN_INTERVAL_SECONDS, and never more than the
//!   airdrop vault's rent-free balance. A leaked key can therefore misdirect at most one capped
//!   batch per ~week until the authority revokes it; it can never touch any other vault or config.
//! - Checks-effects: every check runs before any write; the only CPI is the system-program create
//!   of the batch PDA (Anchor `init`), which cannot re-enter this program. No lamports move here.
//! - Overflow: checked_add on the time window; lamport comparisons only.
//! - Griefing: the poster pays the batch rent. Posting a batch for an epoch id nobody meant to use
//!   only occupies that id (claims still need a valid proof); the authority can revoke the poster.
//!   Batches do not reserve lamports, so outstanding batches can together exceed the vault; claims
//!   then fail closed (checked_sub), never overpay. The off-chain runner sizes each week's pool from
//!   the vault minus still-open batches.

use anchor_lang::prelude::*;

use crate::{AirdropBatch, AirdropBatchRootSet, RewardsConfig, TreasuryError, VaultState};
use crate::{AIRDROP_BATCH_SEED, AIRDROP_VAULT_SEED, REWARDS_CONFIG_SEED};

pub const REWARD_POSTER_SEED: &[u8] = b"reward_poster";
/// One weekly post; six days leaves room for a late run without allowing two in one week.
pub const REWARD_POSTER_MIN_INTERVAL_SECONDS: i64 = 6 * 24 * 60 * 60;
/// A claim window longer than this is refused on the poster path.
pub const REWARD_POSTER_MAX_CLAIM_WINDOW_SECONDS: i64 = 90 * 24 * 60 * 60;

#[account]
pub struct RewardPoster {
    pub poster: Pubkey,
    pub max_airdrop_batch_lamports: u64,
    pub last_airdrop_post_at: i64,
    pub bump: u8,
}

impl RewardPoster {
    pub const SIZE: usize = 32 + 8 + 8 + 1;
}

#[event]
pub struct RewardPosterSet {
    pub poster: Pubkey,
    pub max_airdrop_batch_lamports: u64,
}

#[event]
pub struct AirdropBatchPostedByPoster {
    pub poster: Pubkey,
    pub epoch_id: i64,
    pub total_lamports: u64,
}

#[derive(Accounts)]
pub struct InitializeRewardPoster<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [REWARDS_CONFIG_SEED], bump = config.bump, has_one = authority)]
    pub config: Account<'info, RewardsConfig>,
    #[account(
        init,
        payer = authority,
        space = 8 + RewardPoster::SIZE,
        seeds = [REWARD_POSTER_SEED],
        bump
    )]
    pub reward_poster: Account<'info, RewardPoster>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetRewardPoster<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [REWARDS_CONFIG_SEED], bump = config.bump, has_one = authority)]
    pub config: Account<'info, RewardsConfig>,
    #[account(mut, seeds = [REWARD_POSTER_SEED], bump = reward_poster.bump)]
    pub reward_poster: Account<'info, RewardPoster>,
}

#[derive(Accounts)]
#[instruction(epoch_id: i64)]
pub struct PostAirdropBatchRoot<'info> {
    #[account(mut)]
    pub poster: Signer<'info>,
    #[account(seeds = [REWARDS_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, RewardsConfig>,
    #[account(
        mut,
        seeds = [REWARD_POSTER_SEED],
        bump = reward_poster.bump,
        constraint = reward_poster.poster != Pubkey::default() @ TreasuryError::PosterNotAuthorized,
        constraint = reward_poster.poster == poster.key() @ TreasuryError::PosterNotAuthorized
    )]
    pub reward_poster: Account<'info, RewardPoster>,
    #[account(seeds = [AIRDROP_VAULT_SEED], bump = config.airdrop_vault_bump)]
    pub airdrop_vault: Account<'info, VaultState>,
    #[account(
        init,
        payer = poster,
        space = 8 + AirdropBatch::SIZE,
        seeds = [AIRDROP_BATCH_SEED, &epoch_id.to_le_bytes()],
        bump
    )]
    pub airdrop_batch: Account<'info, AirdropBatch>,
    pub system_program: Program<'info, System>,
}

/// Every rule of the poster path in one place, before any write.
#[allow(clippy::too_many_arguments)]
pub fn validate_poster_batch(
    epoch_id: i64,
    root: &[u8; 32],
    total_lamports: u64,
    deadline: i64,
    now: i64,
    max_batch_lamports: u64,
    last_post_at: i64,
    vault_spendable_lamports: u64,
) -> Result<()> {
    require!(epoch_id > 0, TreasuryError::InvalidAmount);
    require!(*root != [0u8; 32], TreasuryError::InvalidRoot);
    require!(total_lamports > 0, TreasuryError::InvalidAmount);
    require!(total_lamports <= max_batch_lamports, TreasuryError::PosterBatchAboveCap);
    require!(total_lamports <= vault_spendable_lamports, TreasuryError::InsufficientVaultBalance);
    if last_post_at > 0 {
        let next_allowed = last_post_at
            .checked_add(REWARD_POSTER_MIN_INTERVAL_SECONDS)
            .ok_or(TreasuryError::MathOverflow)?;
        require!(now >= next_allowed, TreasuryError::PosterTooSoon);
    }
    let latest_deadline = now
        .checked_add(REWARD_POSTER_MAX_CLAIM_WINDOW_SECONDS)
        .ok_or(TreasuryError::MathOverflow)?;
    require!(deadline > now && deadline <= latest_deadline, TreasuryError::PosterBadDeadline);
    Ok(())
}

pub fn initialize_reward_poster_handler(
    ctx: Context<InitializeRewardPoster>,
    poster: Pubkey,
    max_airdrop_batch_lamports: u64,
) -> Result<()> {
    let state = &mut ctx.accounts.reward_poster;
    state.poster = poster;
    state.max_airdrop_batch_lamports = max_airdrop_batch_lamports;
    state.last_airdrop_post_at = 0;
    state.bump = ctx.bumps.reward_poster;
    emit!(RewardPosterSet { poster, max_airdrop_batch_lamports });
    Ok(())
}

pub fn set_reward_poster_handler(
    ctx: Context<SetRewardPoster>,
    poster: Pubkey,
    max_airdrop_batch_lamports: u64,
) -> Result<()> {
    let state = &mut ctx.accounts.reward_poster;
    state.poster = poster;
    state.max_airdrop_batch_lamports = max_airdrop_batch_lamports;
    emit!(RewardPosterSet { poster, max_airdrop_batch_lamports });
    Ok(())
}

pub fn post_airdrop_batch_root_handler(
    ctx: Context<PostAirdropBatchRoot>,
    epoch_id: i64,
    root: [u8; 32],
    total_lamports: u64,
    deadline: i64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let vault_info = ctx.accounts.airdrop_vault.to_account_info();
    let rent_min = Rent::get()?.minimum_balance(vault_info.data_len());
    let spendable = vault_info.lamports().saturating_sub(rent_min);
    validate_poster_batch(
        epoch_id,
        &root,
        total_lamports,
        deadline,
        now,
        ctx.accounts.reward_poster.max_airdrop_batch_lamports,
        ctx.accounts.reward_poster.last_airdrop_post_at,
        spendable,
    )?;

    let batch = &mut ctx.accounts.airdrop_batch;
    require!(!batch.initialized, TreasuryError::EpochAlreadySealed);
    batch.epoch_id = epoch_id;
    batch.root = root;
    batch.total_lamports = total_lamports;
    batch.claimed_lamports = 0;
    batch.deadline = deadline;
    batch.bump = ctx.bumps.airdrop_batch;
    batch.initialized = true;
    ctx.accounts.reward_poster.last_airdrop_post_at = now;

    emit!(AirdropBatchRootSet { epoch_id, root, total_lamports, deadline });
    emit!(AirdropBatchPostedByPoster { poster: ctx.accounts.poster.key(), epoch_id, total_lamports });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT: [u8; 32] = [7u8; 32];
    const NOW: i64 = 1_800_000_000;
    const DAY: i64 = 24 * 60 * 60;

    fn ok(total: u64, deadline: i64, last: i64, spendable: u64) -> Result<()> {
        validate_poster_batch(42, &ROOT, total, deadline, NOW, 1_000_000_000, last, spendable)
    }

    #[test]
    fn accepts_a_capped_weekly_batch() {
        assert!(ok(500_000_000, NOW + 30 * DAY, 0, 2_000_000_000).is_ok());
        assert!(ok(1_000_000_000, NOW + 30 * DAY, NOW - 7 * DAY, 2_000_000_000).is_ok());
    }

    #[test]
    fn refuses_above_the_authority_cap_or_the_vault() {
        assert!(ok(1_000_000_001, NOW + 30 * DAY, 0, 5_000_000_000).is_err());
        assert!(ok(600_000_000, NOW + 30 * DAY, 0, 599_999_999).is_err());
    }

    #[test]
    fn refuses_a_second_post_within_the_week() {
        assert!(ok(1, NOW + 30 * DAY, NOW - 5 * DAY, 10).is_err());
        assert!(ok(1, NOW + 30 * DAY, NOW - REWARD_POSTER_MIN_INTERVAL_SECONDS, 10).is_ok());
    }

    #[test]
    fn refuses_bad_deadlines_roots_amounts_and_epochs() {
        assert!(ok(1, NOW, 0, 10).is_err());
        assert!(ok(1, NOW + 91 * DAY, 0, 10).is_err());
        assert!(ok(0, NOW + DAY, 0, 10).is_err());
        assert!(validate_poster_batch(42, &[0u8; 32], 1, NOW + DAY, NOW, 10, 0, 10).is_err());
        assert!(validate_poster_batch(0, &ROOT, 1, NOW + DAY, NOW, 10, 0, 10).is_err());
    }
}
