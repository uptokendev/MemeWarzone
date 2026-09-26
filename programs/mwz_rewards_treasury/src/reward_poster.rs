//! Reward poster: a narrow key that may post the weekly airdrop batch root, the league epoch roots
//! and the weekly recruiter / squad earnings batch roots, so airdrops, league prizes and referral
//! earnings run unattended on our own server without the rewards authority
//! (which can also redirect the protocol route and the arena) ever leaving the founder's machine
//! (founder, 2026-09-25).
//!
//! Audit notes
//! - Who: only `reward_poster.poster`, set and revoked by `config.authority`. Default pubkey = off.
//! - What: initialize an AirdropBatch PDA or a LeagueEpoch PDA -- same seeds as the authority paths,
//!   so claims are unchanged and an epoch can never carry two roots. It never overwrites an existing
//!   epoch or batch (Anchor `init`), unlike the authority's league path.
//! - Bounded loss if the poster key leaks: total_lamports <= max_airdrop_batch_lamports (set by the
//!   authority), at most one post per REWARD_POSTER_MIN_INTERVAL_SECONDS, and never more than the
//!   airdrop vault's rent-free balance. A leaked key can therefore misdirect at most one capped
//!   batch per ~week until the authority revokes it; it can never touch any other vault or config.
//! - Checks-effects: every check runs before any write; the only CPI is the system-program create
//!   of the batch PDA (Anchor `init`), which cannot re-enter this program. No lamports move here.
//! - Overflow: checked_add on the time window; lamport comparisons only.
//! - Recruiter / squad earnings (2026-09-26): same batch PDAs and claim paths as the authority's
//!   set_recruiter_batch_root / set_squad_batch_root, so claims are unchanged. Bounded by
//!   max_lane_batch_lamports, one post per lane per REWARD_POSTER_MIN_INTERVAL_SECONDS, and the lane
//!   vault's rent-free balance. These batches carry no deadline (deadline = 0): they are earnings the
//!   chain already routed to that vault, and an earning never expires.
//! - Griefing: the poster pays the batch rent. Posting a batch for an epoch id nobody meant to use
//!   only occupies that id (claims still need a valid proof); the authority can revoke the poster.
//!   Batches do not reserve lamports, so outstanding batches can together exceed the vault; claims
//!   then fail closed (checked_sub), never overpay. The off-chain runner sizes each week's pool from
//!   the vault minus still-open batches.

use anchor_lang::prelude::*;

use crate::{league_payout_vault, AirdropBatch, AirdropBatchRootSet, LeagueEpoch, LeagueEpochRootSet, RecruiterBatchRootSet, RewardLaneBatch, RewardsConfig, SquadBatchRootSet, TreasuryError, VaultState};
use crate::{
    AIRDROP_BATCH_SEED, AIRDROP_VAULT_SEED, LEAGUE_EPOCH_SEED, PERIOD_MONTHLY, PERIOD_MWL_MONTHLY, PERIOD_QUARTERLY, PERIOD_WEEKLY,
    RECRUITER_BATCH_SEED, RECRUITER_VAULT_SEED, REWARDS_CONFIG_SEED, SQUAD_BATCH_SEED, SQUAD_VAULT_SEED,
};

pub const REWARD_POSTER_SEED: &[u8] = b"reward_poster";
/// One weekly post; six days leaves room for a late run without allowing two in one week.
pub const REWARD_POSTER_MIN_INTERVAL_SECONDS: i64 = 6 * 24 * 60 * 60;
/// A claim window longer than this is refused on the poster path.
pub const REWARD_POSTER_MAX_CLAIM_WINDOW_SECONDS: i64 = 90 * 24 * 60 * 60;
/// League roots: one per period per rhythm, for an epoch that started in the recent past.
pub const LEAGUE_WEEKLY_MIN_INTERVAL_SECONDS: i64 = 6 * 24 * 60 * 60;
pub const LEAGUE_MONTHLY_MIN_INTERVAL_SECONDS: i64 = 25 * 24 * 60 * 60;
pub const LEAGUE_QUARTERLY_MIN_INTERVAL_SECONDS: i64 = 80 * 24 * 60 * 60;
pub const LEAGUE_MAX_EPOCH_AGE_SECONDS: i64 = 120 * 24 * 60 * 60;

#[account]
pub struct RewardPoster {
    pub poster: Pubkey,
    pub max_airdrop_batch_lamports: u64,
    pub max_league_root_lamports: u64,
    pub last_airdrop_post_at: i64,
    pub last_weekly_league_post_at: i64,
    pub last_monthly_league_post_at: i64,
    pub last_quarterly_league_post_at: i64,
    pub last_mwl_monthly_post_at: i64,
    pub bump: u8,
    pub max_lane_batch_lamports: u64,
    pub last_recruiter_post_at: i64,
    pub last_squad_post_at: i64,
}

impl RewardPoster {
    pub const SIZE: usize = 32 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 1 + 8 + 8 + 8;
}

#[event]
pub struct RewardPosterSet {
    pub poster: Pubkey,
    pub max_airdrop_batch_lamports: u64,
    pub max_league_root_lamports: u64,
    pub max_lane_batch_lamports: u64,
}

#[event]
pub struct LaneBatchPostedByPoster {
    pub poster: Pubkey,
    /// 0 = recruiter, 1 = squad.
    pub lane: u8,
    pub epoch_id: i64,
    pub total_lamports: u64,
}

#[event]
pub struct LeagueRootPostedByPoster {
    pub poster: Pubkey,
    pub period: u8,
    pub epoch_start: i64,
    pub total_lamports: u64,
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

#[derive(Accounts)]
#[instruction(period: u8, epoch_start: i64)]
pub struct PostLeagueEpochRoot<'info> {
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
    #[account(constraint = league_vault.key() == league_payout_vault(period) @ TreasuryError::WrongLeagueVault)]
    pub league_vault: Account<'info, VaultState>,
    #[account(
        init,
        payer = poster,
        space = 8 + LeagueEpoch::SIZE,
        seeds = [LEAGUE_EPOCH_SEED, &[period], &epoch_start.to_le_bytes()],
        bump
    )]
    pub league_epoch: Account<'info, LeagueEpoch>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(epoch_id: i64)]
pub struct PostRecruiterBatchRoot<'info> {
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
    #[account(seeds = [RECRUITER_VAULT_SEED], bump)]
    pub recruiter_vault: Account<'info, VaultState>,
    #[account(
        init,
        payer = poster,
        space = 8 + RewardLaneBatch::SIZE,
        seeds = [RECRUITER_BATCH_SEED, &epoch_id.to_le_bytes()],
        bump
    )]
    pub recruiter_batch: Account<'info, RewardLaneBatch>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(epoch_id: i64)]
pub struct PostSquadBatchRoot<'info> {
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
    #[account(seeds = [SQUAD_VAULT_SEED], bump)]
    pub squad_vault: Account<'info, VaultState>,
    #[account(
        init,
        payer = poster,
        space = 8 + RewardLaneBatch::SIZE,
        seeds = [SQUAD_BATCH_SEED, &epoch_id.to_le_bytes()],
        bump
    )]
    pub squad_batch: Account<'info, RewardLaneBatch>,
    pub system_program: Program<'info, System>,
}

/// Every rule of the poster's recruiter / squad earnings path in one place, before any write.
pub fn validate_poster_lane_batch(
    epoch_id: i64,
    root: &[u8; 32],
    total_lamports: u64,
    now: i64,
    max_lane_lamports: u64,
    last_post_for_lane: i64,
    vault_spendable_lamports: u64,
) -> Result<()> {
    require!(epoch_id > 0, TreasuryError::InvalidAmount);
    require!(*root != [0u8; 32], TreasuryError::InvalidRoot);
    require!(total_lamports > 0, TreasuryError::InvalidAmount);
    require!(total_lamports <= max_lane_lamports, TreasuryError::PosterBatchAboveCap);
    require!(total_lamports <= vault_spendable_lamports, TreasuryError::InsufficientVaultBalance);
    if last_post_for_lane > 0 {
        let next_allowed = last_post_for_lane
            .checked_add(REWARD_POSTER_MIN_INTERVAL_SECONDS)
            .ok_or(TreasuryError::MathOverflow)?;
        require!(now >= next_allowed, TreasuryError::PosterTooSoon);
    }
    Ok(())
}

fn write_lane_batch(batch: &mut Account<RewardLaneBatch>, epoch_id: i64, root: [u8; 32], total_lamports: u64, bump: u8) -> Result<()> {
    require!(!batch.initialized, TreasuryError::EpochAlreadySealed);
    batch.epoch_id = epoch_id;
    batch.root = root;
    batch.total_lamports = total_lamports;
    batch.claimed_lamports = 0;
    batch.deadline = 0; // earnings never expire
    batch.bump = bump;
    batch.initialized = true;
    Ok(())
}

fn spendable(vault: &AccountInfo) -> Result<u64> {
    let rent_min = Rent::get()?.minimum_balance(vault.data_len());
    Ok(vault.lamports().saturating_sub(rent_min))
}

pub fn post_recruiter_batch_root_handler(ctx: Context<PostRecruiterBatchRoot>, epoch_id: i64, root: [u8; 32], total_lamports: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let available = spendable(&ctx.accounts.recruiter_vault.to_account_info())?;
    let state = &ctx.accounts.reward_poster;
    validate_poster_lane_batch(epoch_id, &root, total_lamports, now, state.max_lane_batch_lamports, state.last_recruiter_post_at, available)?;
    write_lane_batch(&mut ctx.accounts.recruiter_batch, epoch_id, root, total_lamports, ctx.bumps.recruiter_batch)?;
    ctx.accounts.reward_poster.last_recruiter_post_at = now;
    emit!(RecruiterBatchRootSet { epoch_id, root, total_lamports, deadline: 0 });
    emit!(LaneBatchPostedByPoster { poster: ctx.accounts.poster.key(), lane: 0, epoch_id, total_lamports });
    Ok(())
}

pub fn post_squad_batch_root_handler(ctx: Context<PostSquadBatchRoot>, epoch_id: i64, root: [u8; 32], total_lamports: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let available = spendable(&ctx.accounts.squad_vault.to_account_info())?;
    let state = &ctx.accounts.reward_poster;
    validate_poster_lane_batch(epoch_id, &root, total_lamports, now, state.max_lane_batch_lamports, state.last_squad_post_at, available)?;
    write_lane_batch(&mut ctx.accounts.squad_batch, epoch_id, root, total_lamports, ctx.bumps.squad_batch)?;
    ctx.accounts.reward_poster.last_squad_post_at = now;
    emit!(SquadBatchRootSet { epoch_id, root, total_lamports, deadline: 0 });
    emit!(LaneBatchPostedByPoster { poster: ctx.accounts.poster.key(), lane: 1, epoch_id, total_lamports });
    Ok(())
}

/// Every rule of the poster's league path in one place, before any write.
#[allow(clippy::too_many_arguments)]
pub fn validate_poster_league_root(
    period: u8,
    epoch_start: i64,
    root: &[u8; 32],
    total_lamports: u64,
    now: i64,
    max_root_lamports: u64,
    last_post_for_period: i64,
    vault_spendable_lamports: u64,
) -> Result<()> {
    let interval = match period {
        PERIOD_WEEKLY => LEAGUE_WEEKLY_MIN_INTERVAL_SECONDS,
        PERIOD_MONTHLY => LEAGUE_MONTHLY_MIN_INTERVAL_SECONDS,
        PERIOD_QUARTERLY => LEAGUE_QUARTERLY_MIN_INTERVAL_SECONDS,
        PERIOD_MWL_MONTHLY => LEAGUE_MONTHLY_MIN_INTERVAL_SECONDS,
        _ => return err!(TreasuryError::InvalidPeriod),
    };
    require!(*root != [0u8; 32], TreasuryError::InvalidRoot);
    require!(total_lamports > 0, TreasuryError::InvalidAmount);
    require!(total_lamports <= max_root_lamports, TreasuryError::PosterBatchAboveCap);
    require!(total_lamports <= vault_spendable_lamports, TreasuryError::InsufficientVaultBalance);
    let oldest = now.checked_sub(LEAGUE_MAX_EPOCH_AGE_SECONDS).ok_or(TreasuryError::MathOverflow)?;
    require!(epoch_start <= now && epoch_start >= oldest, TreasuryError::PosterBadEpochStart);
    if last_post_for_period > 0 {
        let next_allowed = last_post_for_period.checked_add(interval).ok_or(TreasuryError::MathOverflow)?;
        require!(now >= next_allowed, TreasuryError::PosterTooSoon);
    }
    Ok(())
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
    max_league_root_lamports: u64,
    max_lane_batch_lamports: u64,
) -> Result<()> {
    let state = &mut ctx.accounts.reward_poster;
    state.poster = poster;
    state.max_airdrop_batch_lamports = max_airdrop_batch_lamports;
    state.max_league_root_lamports = max_league_root_lamports;
    state.last_airdrop_post_at = 0;
    state.last_weekly_league_post_at = 0;
    state.last_monthly_league_post_at = 0;
    state.last_quarterly_league_post_at = 0;
    state.last_mwl_monthly_post_at = 0;
    state.bump = ctx.bumps.reward_poster;
    state.max_lane_batch_lamports = max_lane_batch_lamports;
    state.last_recruiter_post_at = 0;
    state.last_squad_post_at = 0;
    emit!(RewardPosterSet { poster, max_airdrop_batch_lamports, max_league_root_lamports, max_lane_batch_lamports });
    Ok(())
}

pub fn set_reward_poster_handler(
    ctx: Context<SetRewardPoster>,
    poster: Pubkey,
    max_airdrop_batch_lamports: u64,
    max_league_root_lamports: u64,
    max_lane_batch_lamports: u64,
) -> Result<()> {
    let state = &mut ctx.accounts.reward_poster;
    state.poster = poster;
    state.max_airdrop_batch_lamports = max_airdrop_batch_lamports;
    state.max_league_root_lamports = max_league_root_lamports;
    state.max_lane_batch_lamports = max_lane_batch_lamports;
    emit!(RewardPosterSet { poster, max_airdrop_batch_lamports, max_league_root_lamports, max_lane_batch_lamports });
    Ok(())
}

pub fn post_league_epoch_root_handler(
    ctx: Context<PostLeagueEpochRoot>,
    period: u8,
    epoch_start: i64,
    root: [u8; 32],
    total_lamports: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let vault_info = ctx.accounts.league_vault.to_account_info();
    let rent_min = Rent::get()?.minimum_balance(vault_info.data_len());
    let spendable = vault_info.lamports().saturating_sub(rent_min);
    let poster_state = &ctx.accounts.reward_poster;
    let last = match period {
        PERIOD_WEEKLY => poster_state.last_weekly_league_post_at,
        PERIOD_MONTHLY => poster_state.last_monthly_league_post_at,
        PERIOD_MWL_MONTHLY => poster_state.last_mwl_monthly_post_at,
        _ => poster_state.last_quarterly_league_post_at,
    };
    validate_poster_league_root(
        period,
        epoch_start,
        &root,
        total_lamports,
        now,
        poster_state.max_league_root_lamports,
        last,
        spendable,
    )?;

    let epoch = &mut ctx.accounts.league_epoch;
    epoch.period = period;
    epoch.epoch_start = epoch_start;
    epoch.root = root;
    epoch.total_lamports = total_lamports;
    epoch.claimed_lamports = 0;
    epoch.bump = ctx.bumps.league_epoch;
    epoch.initialized = true;
    epoch.sealed = true;

    let state = &mut ctx.accounts.reward_poster;
    match period {
        PERIOD_WEEKLY => state.last_weekly_league_post_at = now,
        PERIOD_MONTHLY => state.last_monthly_league_post_at = now,
        PERIOD_MWL_MONTHLY => state.last_mwl_monthly_post_at = now,
        _ => state.last_quarterly_league_post_at = now,
    }
    emit!(LeagueEpochRootSet { period, epoch_start, root, total_lamports });
    emit!(LeagueRootPostedByPoster { poster: ctx.accounts.poster.key(), period, epoch_start, total_lamports });
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

    fn league(period: u8, start: i64, total: u64, last: i64, spendable: u64) -> Result<()> {
        validate_poster_league_root(period, start, &ROOT, total, NOW, 1_000_000_000, last, spendable)
    }

    #[test]
    fn league_root_per_period_rhythm_cap_and_vault() {
        assert!(league(PERIOD_WEEKLY, NOW - 7 * DAY, 500, 0, 1_000).is_ok());
        assert!(league(PERIOD_WEEKLY, NOW - 7 * DAY, 500, NOW - 5 * DAY, 1_000).is_err());
        assert!(league(PERIOD_WEEKLY, NOW - 7 * DAY, 500, NOW - 6 * DAY, 1_000).is_ok());
        assert!(league(PERIOD_MONTHLY, NOW - 31 * DAY, 500, NOW - 20 * DAY, 1_000).is_err());
        assert!(league(PERIOD_MONTHLY, NOW - 31 * DAY, 500, NOW - 25 * DAY, 1_000).is_ok());
        assert!(league(PERIOD_QUARTERLY, NOW - 91 * DAY, 500, NOW - 79 * DAY, 1_000).is_err());
        assert!(league(PERIOD_WEEKLY, NOW - 7 * DAY, 1_000_000_001, 0, u64::MAX).is_err());
        assert!(league(PERIOD_WEEKLY, NOW - 7 * DAY, 1_001, 0, 1_000).is_err());
        assert!(league(PERIOD_MWL_MONTHLY, NOW - 31 * DAY, 500, NOW - 25 * DAY, 1_000).is_ok());
        assert!(league(PERIOD_MWL_MONTHLY, NOW - 31 * DAY, 500, NOW - 24 * DAY, 1_000).is_err());
        assert!(league(4, NOW - 7 * DAY, 500, 0, 1_000).is_err());
    }

    #[test]
    fn league_root_epoch_start_must_be_recent_past() {
        assert!(league(PERIOD_WEEKLY, NOW + DAY, 500, 0, 1_000).is_err());
        assert!(league(PERIOD_WEEKLY, NOW - 121 * DAY, 500, 0, 1_000).is_err());
        assert!(league(PERIOD_WEEKLY, NOW - 120 * DAY, 500, 0, 1_000).is_ok());
    }

    fn lane(total: u64, last: i64, spendable: u64) -> Result<()> {
        validate_poster_lane_batch(42, &ROOT, total, NOW, 1_000_000_000, last, spendable)
    }

    #[test]
    fn lane_batch_cap_vault_and_weekly_rhythm() {
        assert!(lane(500, 0, 1_000).is_ok());
        assert!(lane(1_001, 0, 1_000).is_err(), "above the vault");
        assert!(lane(1_000_000_001, 0, u64::MAX).is_err(), "above the cap");
        assert!(lane(500, NOW - 5 * DAY, 1_000).is_err(), "twice in a week");
        assert!(lane(500, NOW - REWARD_POSTER_MIN_INTERVAL_SECONDS, 1_000).is_ok());
        assert!(lane(0, 0, 1_000).is_err());
        assert!(validate_poster_lane_batch(0, &ROOT, 1, NOW, 10, 0, 10).is_err());
        assert!(validate_poster_lane_batch(42, &[0u8; 32], 1, NOW, 10, 0, 10).is_err());
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
