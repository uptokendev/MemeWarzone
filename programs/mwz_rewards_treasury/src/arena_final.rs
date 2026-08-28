use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    ed25519_program,
    program::invoke,
    system_instruction,
    sysvar::instructions::{load_current_index_checked, load_instruction_at_checked},
};

use crate::{RewardsConfig, REWARDS_CONFIG_SEED};

pub const ARENA_CONFIG_SEED: &[u8] = b"arena_config";
pub const ARENA_POOL_SEED: &[u8] = b"arena_pool";
pub const ARENA_VAULT_SEED: &[u8] = b"arena_vault";
pub const ARENA_BUYIN_SEED: &[u8] = b"arena_buyin";
pub const ARENA_BOOST_SEED: &[u8] = b"arena_boost";
pub const ARENA_CLAIM_SEED: &[u8] = b"arena_claim";
pub const ARENA_REFUND_SEED: &[u8] = b"arena_refund";
pub const ARENA_RESOLUTION_DOMAIN: &[u8] = b"MWZ_ARENA_RESOLVE_V2";
pub const ARENA_CANCEL_DOMAIN: &[u8] = b"MWZ_ARENA_CANCEL_V1";

pub const ARENA_KIND_BATTLE: u8 = 0;
pub const ARENA_KIND_TOURNAMENT: u8 = 1;
pub const ARENA_STATE_OPEN: u8 = 0;
pub const ARENA_STATE_LIVE: u8 = 1;
pub const ARENA_STATE_RESOLVED: u8 = 2;
pub const ARENA_STATE_CANCELLED: u8 = 3;
pub const ARENA_RESULT_NONE: u8 = 0;
pub const ARENA_RESULT_WINNER: u8 = 1;
pub const ARENA_RESULT_TIE: u8 = 2;
pub const ARENA_SIDE_NONE: u8 = 0;
pub const ARENA_SIDE_A: u8 = 1;
pub const ARENA_SIDE_B: u8 = 2;
pub const ARENA_CLAIM_WINNER: u8 = 0;
pub const ARENA_CLAIM_PROTOCOL: u8 = 1;
pub const ARENA_CLAIM_MWL: u8 = 2;
pub const ARENA_CLAIM_CHARITY: u8 = 3;
pub const ARENA_PROTOCOL_BPS: u64 = 500;
pub const ARENA_MWL_BPS: u64 = 1_000;
pub const ARENA_BPS_DENOM: u64 = 10_000;

pub fn initialize_arena_handler(
    ctx: Context<InitializeArena>,
    resolver: Pubkey,
    protocol_receiver: Pubkey,
    mwl_receiver: Pubkey,
    charity_receiver: Pubkey,
) -> Result<()> {
    require!(resolver != Pubkey::default(), ArenaError::ZeroAddress);
    require!(protocol_receiver != Pubkey::default(), ArenaError::ZeroAddress);
    require!(mwl_receiver != Pubkey::default(), ArenaError::ZeroAddress);
    require!(charity_receiver != Pubkey::default(), ArenaError::ZeroAddress);
    let config = &mut ctx.accounts.arena_config;
    config.authority = ctx.accounts.authority.key();
    config.resolver = resolver;
    config.protocol_receiver = protocol_receiver;
    config.mwl_receiver = mwl_receiver;
    config.charity_receiver = charity_receiver;
    config.deposits_paused = false;
    config.bump = ctx.bumps.arena_config;
    config.version = 2;
    Ok(())
}

pub fn set_arena_resolver_handler(ctx: Context<SetArenaConfig>, resolver: Pubkey) -> Result<()> {
    require!(resolver != Pubkey::default(), ArenaError::ZeroAddress);
    ctx.accounts.arena_config.resolver = resolver;
    Ok(())
}

pub fn set_arena_receivers_handler(
    ctx: Context<SetArenaConfig>,
    protocol_receiver: Pubkey,
    mwl_receiver: Pubkey,
    charity_receiver: Pubkey,
) -> Result<()> {
    require!(protocol_receiver != Pubkey::default(), ArenaError::ZeroAddress);
    require!(mwl_receiver != Pubkey::default(), ArenaError::ZeroAddress);
    require!(charity_receiver != Pubkey::default(), ArenaError::ZeroAddress);
    let config = &mut ctx.accounts.arena_config;
    config.protocol_receiver = protocol_receiver;
    config.mwl_receiver = mwl_receiver;
    config.charity_receiver = charity_receiver;
    Ok(())
}

pub fn set_arena_pause_handler(ctx: Context<SetArenaConfig>, paused: bool) -> Result<()> {
    ctx.accounts.arena_config.deposits_paused = paused;
    Ok(())
}

// Legacy Arena financial entrypoints remain in the IDL only as fail-closed tombstones.
// The final one-sweep client must use the *_v2 entrypoints below.
pub fn open_battle_pool_handler(
    _ctx: Context<OpenBattlePool>, _pool_id: [u8; 32], _owner_a: Pubkey, _owner_b: Pubkey,
    _stake_lamports: u64, _deposit_deadline: i64, _resolve_deadline: i64,
) -> Result<()> { err!(ArenaError::DeprecatedInstruction) }
pub fn open_tournament_pool_handler(
    _ctx: Context<OpenTournamentPool>, _pool_id: [u8; 32], _buy_in_lamports: u64,
    _deposit_deadline: i64, _resolve_deadline: i64,
) -> Result<()> { err!(ArenaError::DeprecatedInstruction) }
pub fn deposit_stake_handler(_ctx: Context<DepositStake>, _pool_id: [u8; 32]) -> Result<()> { err!(ArenaError::DeprecatedInstruction) }
pub fn donate_support_handler(_ctx: Context<DonateSupport>, _pool_id: [u8; 32], _amount: u64) -> Result<()> { err!(ArenaError::DeprecatedInstruction) }
pub fn deposit_buy_in_handler(_ctx: Context<DepositBuyIn>, _pool_id: [u8; 32]) -> Result<()> { err!(ArenaError::DeprecatedInstruction) }
pub fn resolve_pool_handler(
    _ctx: Context<ResolveArenaPool>, _pool_id: [u8; 32], _result_type: u8, _winner: Pubkey,
    _deadline: i64, _nonce: u64,
) -> Result<()> { err!(ArenaError::DeprecatedInstruction) }
pub fn refund_buy_in_handler(_ctx: Context<RefundArenaBuyIn>, _pool_id: [u8; 32]) -> Result<()> { err!(ArenaError::DeprecatedInstruction) }

pub fn open_battle_pool_v2_handler(
    ctx: Context<OpenBattlePoolV2>,
    pool_id: [u8; 32],
    asset_a: Pubkey,
    asset_b: Pubkey,
    owner_a: Pubkey,
    owner_b: Pubkey,
    required_stake_a: u64,
    required_stake_b: u64,
    support_deadline: i64,
    deposit_deadline: i64,
    resolve_deadline: i64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(!ctx.accounts.arena_config.deposits_paused, ArenaError::DepositsPaused);
    require!(pool_id != [0u8; 32], ArenaError::InvalidPoolId);
    require!(asset_a != Pubkey::default() && asset_b != Pubkey::default() && asset_a != asset_b, ArenaError::InvalidAssets);
    require!(owner_a != Pubkey::default() && owner_b != Pubkey::default() && owner_a != owner_b, ArenaError::InvalidOwners);
    require!(required_stake_a > 0 && required_stake_b > 0, ArenaError::InvalidAmount);
    require!(deposit_deadline > now, ArenaError::InvalidDeadline);
    require!(support_deadline >= deposit_deadline && support_deadline < resolve_deadline, ArenaError::InvalidDeadline);

    let opener = ctx.accounts.opener.key();
    require!(opener == owner_a || opener == owner_b, ArenaError::Unauthorized);
    let opener_amount = if opener == owner_a { required_stake_a } else { required_stake_b };

    ctx.accounts.vault.kind = ARENA_KIND_BATTLE;
    let pool = &mut ctx.accounts.pool;
    initialize_pool_common(
        pool, pool_id, ARENA_KIND_BATTLE, asset_a, asset_b, owner_a, owner_b,
        required_stake_a, required_stake_b, 0, support_deadline, deposit_deadline,
        resolve_deadline, ctx.bumps.pool, ctx.bumps.vault,
    );
    transfer_into_vault(
        &ctx.accounts.opener.to_account_info(), &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.system_program.to_account_info(), opener_amount,
    )?;
    if opener == owner_a { pool.deposited_stake_a = opener_amount; } else { pool.deposited_stake_b = opener_amount; }
    emit!(ArenaPoolOpenedV2 {
        pool_id, kind: ARENA_KIND_BATTLE, asset_a, asset_b, owner_a, owner_b,
        required_stake_a, required_stake_b, buy_in_lamports: 0,
        support_deadline, deposit_deadline, resolve_deadline,
    });
    emit!(ArenaStakeDeposited { pool_id, staker: opener, amount_lamports: opener_amount });
    Ok(())
}

pub fn open_tournament_pool_v2_handler(
    ctx: Context<OpenTournamentPoolV2>,
    pool_id: [u8; 32],
    buy_in_lamports: u64,
    support_deadline: i64,
    deposit_deadline: i64,
    resolve_deadline: i64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(!ctx.accounts.arena_config.deposits_paused, ArenaError::DepositsPaused);
    require!(pool_id != [0u8; 32] && buy_in_lamports > 0, ArenaError::InvalidAmount);
    require!(deposit_deadline > now, ArenaError::InvalidDeadline);
    require!(support_deadline >= deposit_deadline && support_deadline < resolve_deadline, ArenaError::InvalidDeadline);
    ctx.accounts.vault.kind = ARENA_KIND_TOURNAMENT;
    let authority = ctx.accounts.authority.key();
    initialize_pool_common(
        &mut ctx.accounts.pool, pool_id, ARENA_KIND_TOURNAMENT,
        Pubkey::default(), Pubkey::default(), authority, Pubkey::default(),
        0, 0, buy_in_lamports, support_deadline, deposit_deadline, resolve_deadline,
        ctx.bumps.pool, ctx.bumps.vault,
    );
    emit!(ArenaPoolOpenedV2 {
        pool_id, kind: ARENA_KIND_TOURNAMENT,
        asset_a: Pubkey::default(), asset_b: Pubkey::default(), owner_a: authority,
        owner_b: Pubkey::default(), required_stake_a: 0, required_stake_b: 0,
        buy_in_lamports, support_deadline, deposit_deadline, resolve_deadline,
    });
    Ok(())
}

pub fn deposit_stake_v2_handler(ctx: Context<DepositStakeV2>, pool_id: [u8; 32]) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(!ctx.accounts.arena_config.deposits_paused, ArenaError::DepositsPaused);
    let pool = &mut ctx.accounts.pool;
    require!(pool.pool_id == pool_id && pool.kind == ARENA_KIND_BATTLE && pool.state == ARENA_STATE_OPEN, ArenaError::InvalidState);
    require!(now <= pool.deposit_deadline, ArenaError::DeadlinePassed);
    let staker = ctx.accounts.staker.key();
    let amount = if staker == pool.owner_a {
        require!(pool.deposited_stake_a == 0, ArenaError::AlreadyDeposited);
        pool.required_stake_a
    } else if staker == pool.owner_b {
        require!(pool.deposited_stake_b == 0, ArenaError::AlreadyDeposited);
        pool.required_stake_b
    } else { return err!(ArenaError::NotParticipant); };
    transfer_into_vault(
        &ctx.accounts.staker.to_account_info(), &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.system_program.to_account_info(), amount,
    )?;
    if staker == pool.owner_a { pool.deposited_stake_a = amount; } else { pool.deposited_stake_b = amount; }
    if pool.deposited_stake_a == pool.required_stake_a && pool.deposited_stake_b == pool.required_stake_b {
        pool.state = ARENA_STATE_LIVE;
        emit!(ArenaPoolLive { pool_id });
    }
    emit!(ArenaStakeDeposited { pool_id, staker, amount_lamports: amount });
    Ok(())
}

pub fn donate_support_v2_handler(ctx: Context<DonateSupportV2>, pool_id: [u8; 32], amount_lamports: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(!ctx.accounts.arena_config.deposits_paused, ArenaError::DepositsPaused);
    require!(amount_lamports > 0, ArenaError::InvalidAmount);
    let pool = &mut ctx.accounts.pool;
    require!(pool.pool_id == pool_id && (pool.state == ARENA_STATE_OPEN || pool.state == ARENA_STATE_LIVE), ArenaError::InvalidState);
    require!(!pool.support_closed && now <= pool.support_deadline, ArenaError::SupportClosed);
    transfer_into_vault(
        &ctx.accounts.donor.to_account_info(), &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.system_program.to_account_info(), amount_lamports,
    )?;
    pool.support_total = pool.support_total.checked_add(amount_lamports).ok_or(ArenaError::MathOverflow)?;
    emit!(ArenaSupportDonated { pool_id, donor: ctx.accounts.donor.key(), amount_lamports });
    Ok(())
}

pub fn close_support_v2_handler(ctx: Context<CloseSupportV2>, pool_id: [u8; 32]) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pool = &mut ctx.accounts.pool;
    require!(pool.pool_id == pool_id && (pool.state == ARENA_STATE_OPEN || pool.state == ARENA_STATE_LIVE), ArenaError::InvalidState);
    require!(!pool.support_closed, ArenaError::SupportClosed);
    let caller = ctx.accounts.caller.key();
    require!(now >= pool.support_deadline || caller == ctx.accounts.arena_config.authority, ArenaError::SupportStillOpen);
    pool.support_closed = true;
    emit!(ArenaSupportClosed { pool_id, closed_by: caller });
    Ok(())
}

pub fn deposit_buy_in_v2_handler(ctx: Context<DepositBuyInV2>, pool_id: [u8; 32], entry_asset: Pubkey) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(!ctx.accounts.arena_config.deposits_paused, ArenaError::DepositsPaused);
    require!(entry_asset != Pubkey::default(), ArenaError::InvalidAssets);
    let pool = &mut ctx.accounts.pool;
    require!(pool.pool_id == pool_id && pool.kind == ARENA_KIND_TOURNAMENT, ArenaError::InvalidKind);
    require!(pool.state == ARENA_STATE_OPEN || pool.state == ARENA_STATE_LIVE, ArenaError::InvalidState);
    require!(now <= pool.deposit_deadline, ArenaError::DeadlinePassed);
    transfer_into_vault(
        &ctx.accounts.entrant.to_account_info(), &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.system_program.to_account_info(), pool.buy_in_lamports,
    )?;
    pool.buy_in_total = pool.buy_in_total.checked_add(pool.buy_in_lamports).ok_or(ArenaError::MathOverflow)?;
    pool.state = ARENA_STATE_LIVE;
    let receipt = &mut ctx.accounts.buy_in_receipt;
    receipt.pool_id = pool_id;
    receipt.entry_asset = entry_asset;
    receipt.entrant = ctx.accounts.entrant.key();
    receipt.amount_lamports = pool.buy_in_lamports;
    receipt.refunded = false;
    receipt.bump = ctx.bumps.buy_in_receipt;
    emit!(ArenaBuyInDepositedV2 { pool_id, entry_asset, entrant: receipt.entrant, amount_lamports: receipt.amount_lamports });
    Ok(())
}

pub fn deposit_prize_boost_v2_handler(
    ctx: Context<DepositPrizeBoostV2>, pool_id: [u8; 32], funding_id: [u8; 32], amount_lamports: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(!ctx.accounts.arena_config.deposits_paused, ArenaError::DepositsPaused);
    require!(funding_id != [0u8; 32] && amount_lamports > 0, ArenaError::InvalidAmount);
    let pool = &mut ctx.accounts.pool;
    require!(pool.pool_id == pool_id && (pool.state == ARENA_STATE_OPEN || pool.state == ARENA_STATE_LIVE), ArenaError::InvalidState);
    require!(now <= pool.resolve_deadline, ArenaError::DeadlinePassed);
    transfer_into_vault(
        &ctx.accounts.funder.to_account_info(), &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.system_program.to_account_info(), amount_lamports,
    )?;
    pool.prize_boost_total = pool.prize_boost_total.checked_add(amount_lamports).ok_or(ArenaError::MathOverflow)?;
    let receipt = &mut ctx.accounts.boost_receipt;
    receipt.pool_id = pool_id;
    receipt.funding_id = funding_id;
    receipt.funder = ctx.accounts.funder.key();
    receipt.amount_lamports = amount_lamports;
    receipt.refunded = false;
    receipt.bump = ctx.bumps.boost_receipt;
    emit!(ArenaPrizeBoostDeposited { pool_id, funding_id, funder: receipt.funder, amount_lamports });
    Ok(())
}

pub fn resolve_pool_v2_handler(
    ctx: Context<ResolveArenaPoolV2>,
    pool_id: [u8; 32], result_type: u8, winner_side: u8,
    winner_asset: Pubkey, winner_wallet: Pubkey, outcome_hash: [u8; 32],
    deadline: i64, nonce: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pool_key = ctx.accounts.pool.key();
    let config_version = ctx.accounts.arena_config.version;
    let resolver = ctx.accounts.arena_config.resolver;
    let pool = &mut ctx.accounts.pool;
    require!(pool.pool_id == pool_id && pool.state == ARENA_STATE_LIVE, ArenaError::InvalidState);
    require!(now <= pool.resolve_deadline && now <= deadline && deadline <= pool.resolve_deadline, ArenaError::ResolutionSignatureExpired);
    require!(nonce == pool.action_nonce, ArenaError::InvalidResolutionNonce);
    require!(outcome_hash != [0u8; 32], ArenaError::InvalidOutcomeHash);
    require!(result_type == ARENA_RESULT_WINNER || result_type == ARENA_RESULT_TIE, ArenaError::InvalidResult);

    if result_type == ARENA_RESULT_TIE {
        require!(pool.kind == ARENA_KIND_BATTLE, ArenaError::InvalidResult);
        require!(winner_side == ARENA_SIDE_NONE && winner_asset == Pubkey::default() && winner_wallet == Pubkey::default(), ArenaError::InvalidWinner);
    } else if pool.kind == ARENA_KIND_BATTLE {
        match winner_side {
            ARENA_SIDE_A => require!(winner_asset == pool.asset_a && winner_wallet == pool.owner_a, ArenaError::InvalidWinner),
            ARENA_SIDE_B => require!(winner_asset == pool.asset_b && winner_wallet == pool.owner_b, ArenaError::InvalidWinner),
            _ => return err!(ArenaError::InvalidWinner),
        }
    } else {
        require!(winner_side == ARENA_SIDE_NONE && winner_asset != Pubkey::default() && winner_wallet != Pubkey::default(), ArenaError::InvalidWinner);
        validate_tournament_winner_receipt(
            &ctx.accounts.winner_buy_in_receipt.to_account_info(), pool_id, winner_asset,
            winner_wallet, pool.buy_in_lamports,
        )?;
    }

    let message = arena_resolution_message_v2(
        config_version, pool_id, pool_key, pool.kind, pool.asset_a, pool.asset_b,
        pool.owner_a, pool.owner_b, pool.deposited_stake_a, pool.deposited_stake_b,
        pool.support_total, pool.prize_boost_total, pool.buy_in_total, winner_side,
        winner_asset, winner_wallet, result_type, outcome_hash, deadline, nonce,
    );
    verify_preceding_ed25519(&ctx.accounts.instructions.to_account_info(), &resolver, &message)?;

    pool.state = ARENA_STATE_RESOLVED;
    pool.result_type = result_type;
    pool.winner_side = winner_side;
    pool.winner_asset = winner_asset;
    pool.winner_wallet = winner_wallet;
    pool.outcome_hash = outcome_hash;
    pool.support_closed = true;
    pool.action_nonce = pool.action_nonce.checked_add(1).ok_or(ArenaError::MathOverflow)?;

    if result_type == ARENA_RESULT_TIE {
        pool.pending_charity = pool.support_total;
        emit!(ArenaPoolResolvedV2 { pool_id, result_type, winner_side, winner_asset, winner_wallet, outcome_hash, pending_winner: 0, pending_protocol: 0, pending_mwl: 0, pending_charity: pool.pending_charity });
        return Ok(());
    }

    let normal_base = pool.deposited_stake_a
        .checked_add(pool.deposited_stake_b)
        .and_then(|v| v.checked_add(pool.support_total))
        .and_then(|v| v.checked_add(pool.buy_in_total))
        .ok_or(ArenaError::MathOverflow)?;
    let (winner_normal, protocol_amount, mwl_amount) = split_arena_prize(normal_base)?;
    pool.pending_winner = winner_normal.checked_add(pool.prize_boost_total).ok_or(ArenaError::MathOverflow)?;
    pool.pending_protocol = protocol_amount;
    pool.pending_mwl = mwl_amount;
    emit!(ArenaPoolResolvedV2 {
        pool_id, result_type, winner_side, winner_asset, winner_wallet, outcome_hash,
        pending_winner: pool.pending_winner, pending_protocol: protocol_amount,
        pending_mwl: mwl_amount, pending_charity: 0,
    });
    Ok(())
}

pub fn cancel_pool_v2_handler(
    ctx: Context<CancelArenaPoolV2>, pool_id: [u8; 32], reason_code: u8, deadline: i64, nonce: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pool_key = ctx.accounts.pool.key();
    let config_version = ctx.accounts.arena_config.version;
    let resolver = ctx.accounts.arena_config.resolver;
    let pool = &mut ctx.accounts.pool;
    require!(pool.pool_id == pool_id && (pool.state == ARENA_STATE_OPEN || pool.state == ARENA_STATE_LIVE), ArenaError::InvalidState);
    require!(now <= deadline, ArenaError::ResolutionSignatureExpired);
    require!(nonce == pool.action_nonce, ArenaError::InvalidResolutionNonce);
    let message = arena_cancel_message_v1(
        config_version, pool_id, pool_key, reason_code, pool.deposited_stake_a,
        pool.deposited_stake_b, pool.support_total, pool.buy_in_total,
        pool.prize_boost_total, deadline, nonce,
    );
    verify_preceding_ed25519(&ctx.accounts.instructions.to_account_info(), &resolver, &message)?;
    pool.state = ARENA_STATE_CANCELLED;
    pool.result_type = ARENA_RESULT_NONE;
    pool.cancellation_reason = reason_code;
    pool.support_closed = true;
    pool.pending_charity = pool.support_total;
    pool.action_nonce = pool.action_nonce.checked_add(1).ok_or(ArenaError::MathOverflow)?;
    emit!(ArenaPoolCancelledV2 { pool_id, reason_code, pending_charity: pool.pending_charity });
    Ok(())
}

pub fn settle_expired_pool_handler(ctx: Context<SettleExpiredArenaPool>, pool_id: [u8; 32]) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pool = &mut ctx.accounts.pool;
    require!(pool.pool_id == pool_id && (pool.state == ARENA_STATE_OPEN || pool.state == ARENA_STATE_LIVE), ArenaError::InvalidState);
    let unmatched_battle = pool.kind == ARENA_KIND_BATTLE && pool.state == ARENA_STATE_OPEN && now > pool.deposit_deadline;
    let resolution_expired = now > pool.resolve_deadline;
    require!(unmatched_battle || resolution_expired, ArenaError::ExpiryUnavailable);
    pool.state = ARENA_STATE_CANCELLED;
    pool.support_closed = true;
    pool.cancellation_reason = 255;
    pool.pending_charity = pool.support_total;
    pool.action_nonce = pool.action_nonce.checked_add(1).ok_or(ArenaError::MathOverflow)?;
    emit!(ArenaPoolCancelledV2 { pool_id, reason_code: 255, pending_charity: pool.pending_charity });
    Ok(())
}

pub fn claim_winner_handler(ctx: Context<ClaimArenaWinner>, pool_id: [u8; 32]) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    require!(pool.pool_id == pool_id && pool.state == ARENA_STATE_RESOLVED && pool.result_type == ARENA_RESULT_WINNER, ArenaError::InvalidState);
    require!(pool.winner_wallet == ctx.accounts.winner.key(), ArenaError::InvalidWinner);
    require!(!pool.claimed_winner && pool.pending_winner > 0, ArenaError::NothingToClaim);
    let amount = pool.pending_winner;
    pool.pending_winner = 0;
    pool.claimed_winner = true;
    debit_vault(&ctx.accounts.vault.to_account_info(), &ctx.accounts.winner.to_account_info(), amount)?;
    initialize_claim_receipt(&mut ctx.accounts.claim_receipt, pool_id, ARENA_CLAIM_WINNER, ctx.accounts.winner.key(), amount, ctx.bumps.claim_receipt);
    Ok(())
}

pub fn claim_protocol_handler(ctx: Context<ClaimArenaProtocol>, pool_id: [u8; 32]) -> Result<()> {
    claim_fixed_bucket(pool_id, &mut ctx.accounts.pool, &ctx.accounts.vault.to_account_info(), &ctx.accounts.receiver.to_account_info(), &mut ctx.accounts.claim_receipt, ARENA_CLAIM_PROTOCOL, ctx.bumps.claim_receipt)
}
pub fn claim_mwl_handler(ctx: Context<ClaimArenaMwl>, pool_id: [u8; 32]) -> Result<()> {
    claim_fixed_bucket(pool_id, &mut ctx.accounts.pool, &ctx.accounts.vault.to_account_info(), &ctx.accounts.receiver.to_account_info(), &mut ctx.accounts.claim_receipt, ARENA_CLAIM_MWL, ctx.bumps.claim_receipt)
}
pub fn claim_charity_handler(ctx: Context<ClaimArenaCharity>, pool_id: [u8; 32]) -> Result<()> {
    claim_fixed_bucket(pool_id, &mut ctx.accounts.pool, &ctx.accounts.vault.to_account_info(), &ctx.accounts.receiver.to_account_info(), &mut ctx.accounts.claim_receipt, ARENA_CLAIM_CHARITY, ctx.bumps.claim_receipt)
}

fn claim_fixed_bucket(
    pool_id: [u8; 32], pool: &mut Account<ArenaPool>, vault: &AccountInfo,
    receiver: &AccountInfo, receipt: &mut Account<ArenaClaimReceipt>, bucket: u8, bump: u8,
) -> Result<()> {
    require!(pool.pool_id == pool_id, ArenaError::PoolMismatch);
    let amount = match bucket {
        ARENA_CLAIM_PROTOCOL => { require!(pool.state == ARENA_STATE_RESOLVED && !pool.claimed_protocol, ArenaError::InvalidState); pool.claimed_protocol = true; let v = pool.pending_protocol; pool.pending_protocol = 0; v },
        ARENA_CLAIM_MWL => { require!(pool.state == ARENA_STATE_RESOLVED && !pool.claimed_mwl, ArenaError::InvalidState); pool.claimed_mwl = true; let v = pool.pending_mwl; pool.pending_mwl = 0; v },
        ARENA_CLAIM_CHARITY => { require!((pool.state == ARENA_STATE_RESOLVED || pool.state == ARENA_STATE_CANCELLED) && !pool.claimed_charity, ArenaError::InvalidState); pool.claimed_charity = true; let v = pool.pending_charity; pool.pending_charity = 0; v },
        _ => return err!(ArenaError::InvalidClaimBucket),
    };
    require!(amount > 0, ArenaError::NothingToClaim);
    debit_vault(vault, receiver, amount)?;
    initialize_claim_receipt(receipt, pool_id, bucket, receiver.key(), amount, bump);
    Ok(())
}

pub fn refund_stake_handler(ctx: Context<RefundArenaStake>, pool_id: [u8; 32]) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    require!(pool.pool_id == pool_id && pool.kind == ARENA_KIND_BATTLE, ArenaError::PoolMismatch);
    let refundable = pool.state == ARENA_STATE_CANCELLED || (pool.state == ARENA_STATE_RESOLVED && pool.result_type == ARENA_RESULT_TIE);
    require!(refundable, ArenaError::RefundUnavailable);
    let staker = ctx.accounts.staker.key();
    let amount = if staker == pool.owner_a {
        require!(!pool.refunded_a, ArenaError::AlreadyRefunded); pool.refunded_a = true; let v = pool.deposited_stake_a; pool.deposited_stake_a = 0; v
    } else if staker == pool.owner_b {
        require!(!pool.refunded_b, ArenaError::AlreadyRefunded); pool.refunded_b = true; let v = pool.deposited_stake_b; pool.deposited_stake_b = 0; v
    } else { return err!(ArenaError::NotParticipant); };
    require!(amount > 0, ArenaError::NothingToClaim);
    debit_vault(&ctx.accounts.vault.to_account_info(), &ctx.accounts.staker.to_account_info(), amount)?;
    let receipt = &mut ctx.accounts.refund_receipt;
    receipt.pool_id = pool_id; receipt.wallet = staker; receipt.identity = Pubkey::default(); receipt.amount_lamports = amount; receipt.kind = ARENA_KIND_BATTLE; receipt.bump = ctx.bumps.refund_receipt;
    Ok(())
}

pub fn refund_buy_in_v2_handler(ctx: Context<RefundArenaBuyInV2>, pool_id: [u8; 32], entry_asset: Pubkey) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    require!(pool.pool_id == pool_id && pool.kind == ARENA_KIND_TOURNAMENT && pool.state == ARENA_STATE_CANCELLED, ArenaError::RefundUnavailable);
    let buy_in = &mut ctx.accounts.buy_in_receipt;
    require!(buy_in.pool_id == pool_id && buy_in.entry_asset == entry_asset && buy_in.entrant == ctx.accounts.entrant.key(), ArenaError::PoolMismatch);
    require!(!buy_in.refunded && buy_in.amount_lamports > 0, ArenaError::AlreadyRefunded);
    let amount = buy_in.amount_lamports;
    buy_in.refunded = true;
    pool.buy_in_total = pool.buy_in_total.checked_sub(amount).ok_or(ArenaError::MathOverflow)?;
    debit_vault(&ctx.accounts.vault.to_account_info(), &ctx.accounts.entrant.to_account_info(), amount)?;
    let receipt = &mut ctx.accounts.refund_receipt;
    receipt.pool_id = pool_id; receipt.wallet = ctx.accounts.entrant.key(); receipt.identity = entry_asset; receipt.amount_lamports = amount; receipt.kind = ARENA_KIND_TOURNAMENT; receipt.bump = ctx.bumps.refund_receipt;
    Ok(())
}

pub fn refund_prize_boost_v2_handler(ctx: Context<RefundPrizeBoostV2>, pool_id: [u8; 32], funding_id: [u8; 32]) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let refundable = pool.state == ARENA_STATE_CANCELLED || (pool.state == ARENA_STATE_RESOLVED && pool.result_type == ARENA_RESULT_TIE);
    require!(pool.pool_id == pool_id && refundable, ArenaError::RefundUnavailable);
    let boost = &mut ctx.accounts.boost_receipt;
    require!(boost.pool_id == pool_id && boost.funding_id == funding_id && boost.funder == ctx.accounts.funder.key(), ArenaError::PoolMismatch);
    require!(!boost.refunded && boost.amount_lamports > 0, ArenaError::AlreadyRefunded);
    let amount = boost.amount_lamports;
    boost.refunded = true;
    pool.prize_boost_total = pool.prize_boost_total.checked_sub(amount).ok_or(ArenaError::MathOverflow)?;
    debit_vault(&ctx.accounts.vault.to_account_info(), &ctx.accounts.funder.to_account_info(), amount)?;
    let receipt = &mut ctx.accounts.refund_receipt;
    receipt.pool_id = pool_id; receipt.wallet = ctx.accounts.funder.key(); receipt.identity = Pubkey::new_from_array(funding_id); receipt.amount_lamports = amount; receipt.kind = 2; receipt.bump = ctx.bumps.refund_receipt;
    Ok(())
}

fn initialize_pool_common(
    pool: &mut Account<ArenaPool>, pool_id: [u8; 32], kind: u8,
    asset_a: Pubkey, asset_b: Pubkey, owner_a: Pubkey, owner_b: Pubkey,
    required_stake_a: u64, required_stake_b: u64, buy_in_lamports: u64,
    support_deadline: i64, deposit_deadline: i64, resolve_deadline: i64,
    bump: u8, vault_bump: u8,
) {
    pool.pool_id = pool_id; pool.kind = kind; pool.state = ARENA_STATE_OPEN;
    pool.asset_a = asset_a; pool.asset_b = asset_b; pool.owner_a = owner_a; pool.owner_b = owner_b;
    pool.required_stake_a = required_stake_a; pool.required_stake_b = required_stake_b;
    pool.deposited_stake_a = 0; pool.deposited_stake_b = 0; pool.buy_in_lamports = buy_in_lamports;
    pool.buy_in_total = 0; pool.support_total = 0; pool.prize_boost_total = 0;
    pool.support_deadline = support_deadline; pool.deposit_deadline = deposit_deadline; pool.resolve_deadline = resolve_deadline;
    pool.support_closed = false; pool.result_type = ARENA_RESULT_NONE; pool.winner_side = ARENA_SIDE_NONE;
    pool.winner_asset = Pubkey::default(); pool.winner_wallet = Pubkey::default(); pool.outcome_hash = [0u8; 32];
    pool.cancellation_reason = 0; pool.pending_winner = 0; pool.pending_protocol = 0; pool.pending_mwl = 0; pool.pending_charity = 0;
    pool.claimed_winner = false; pool.claimed_protocol = false; pool.claimed_mwl = false; pool.claimed_charity = false;
    pool.refunded_a = false; pool.refunded_b = false; pool.bump = bump; pool.vault_bump = vault_bump; pool.action_nonce = 0;
}

fn initialize_claim_receipt(receipt: &mut Account<ArenaClaimReceipt>, pool_id: [u8; 32], bucket: u8, recipient: Pubkey, amount: u64, bump: u8) {
    receipt.pool_id = pool_id; receipt.bucket = bucket; receipt.recipient = recipient; receipt.amount_lamports = amount; receipt.bump = bump;
}

fn transfer_into_vault<'info>(from: &AccountInfo<'info>, vault: &AccountInfo<'info>, system_program: &AccountInfo<'info>, lamports: u64) -> Result<()> {
    require!(lamports > 0, ArenaError::InvalidAmount);
    invoke(&system_instruction::transfer(from.key, vault.key, lamports), &[from.clone(), vault.clone(), system_program.clone()])?;
    Ok(())
}

fn debit_vault(vault: &AccountInfo, receiver: &AccountInfo, lamports: u64) -> Result<()> {
    require!(lamports > 0, ArenaError::InvalidAmount);
    let rent_reserve = Rent::get()?.minimum_balance(8 + ArenaVault::SIZE);
    require!(vault.lamports().saturating_sub(rent_reserve) >= lamports, ArenaError::InsufficientVaultBalance);
    **vault.try_borrow_mut_lamports()? = vault.lamports().checked_sub(lamports).ok_or(ArenaError::InsufficientVaultBalance)?;
    **receiver.try_borrow_mut_lamports()? = receiver.lamports().checked_add(lamports).ok_or(ArenaError::MathOverflow)?;
    Ok(())
}

pub fn split_arena_prize(prize: u64) -> Result<(u64, u64, u64)> {
    let protocol = prize.checked_mul(ARENA_PROTOCOL_BPS).ok_or(ArenaError::MathOverflow)? / ARENA_BPS_DENOM;
    let mwl = prize.checked_mul(ARENA_MWL_BPS).ok_or(ArenaError::MathOverflow)? / ARENA_BPS_DENOM;
    let winner = prize.checked_sub(protocol).and_then(|v| v.checked_sub(mwl)).ok_or(ArenaError::MathOverflow)?;
    Ok((winner, protocol, mwl))
}

#[allow(clippy::too_many_arguments)]
pub fn arena_resolution_message_v2(
    version: u8, pool_id: [u8; 32], pool: Pubkey, kind: u8,
    asset_a: Pubkey, asset_b: Pubkey, owner_a: Pubkey, owner_b: Pubkey,
    stake_a: u64, stake_b: u64, support_total: u64, prize_boost_total: u64, buy_in_total: u64,
    winner_side: u8, winner_asset: Pubkey, winner_wallet: Pubkey, result_type: u8,
    outcome_hash: [u8; 32], deadline: i64, nonce: u64,
) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(400);
    bytes.extend_from_slice(ARENA_RESOLUTION_DOMAIN); bytes.extend_from_slice(crate::ID.as_ref()); bytes.push(version);
    bytes.extend_from_slice(&pool_id); bytes.extend_from_slice(pool.as_ref()); bytes.push(kind);
    bytes.extend_from_slice(asset_a.as_ref()); bytes.extend_from_slice(asset_b.as_ref()); bytes.extend_from_slice(owner_a.as_ref()); bytes.extend_from_slice(owner_b.as_ref());
    bytes.extend_from_slice(&stake_a.to_le_bytes()); bytes.extend_from_slice(&stake_b.to_le_bytes()); bytes.extend_from_slice(&support_total.to_le_bytes()); bytes.extend_from_slice(&prize_boost_total.to_le_bytes()); bytes.extend_from_slice(&buy_in_total.to_le_bytes());
    bytes.push(winner_side); bytes.extend_from_slice(winner_asset.as_ref()); bytes.extend_from_slice(winner_wallet.as_ref()); bytes.push(result_type); bytes.extend_from_slice(&outcome_hash);
    bytes.extend_from_slice(&deadline.to_le_bytes()); bytes.extend_from_slice(&nonce.to_le_bytes()); bytes
}

pub fn arena_cancel_message_v1(
    version: u8, pool_id: [u8; 32], pool: Pubkey, reason_code: u8,
    stake_a: u64, stake_b: u64, support_total: u64, buy_in_total: u64, prize_boost_total: u64,
    deadline: i64, nonce: u64,
) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(220);
    bytes.extend_from_slice(ARENA_CANCEL_DOMAIN); bytes.extend_from_slice(crate::ID.as_ref()); bytes.push(version);
    bytes.extend_from_slice(&pool_id); bytes.extend_from_slice(pool.as_ref()); bytes.push(reason_code);
    bytes.extend_from_slice(&stake_a.to_le_bytes()); bytes.extend_from_slice(&stake_b.to_le_bytes()); bytes.extend_from_slice(&support_total.to_le_bytes()); bytes.extend_from_slice(&buy_in_total.to_le_bytes()); bytes.extend_from_slice(&prize_boost_total.to_le_bytes());
    bytes.extend_from_slice(&deadline.to_le_bytes()); bytes.extend_from_slice(&nonce.to_le_bytes()); bytes
}

fn validate_tournament_winner_receipt(receipt_info: &AccountInfo, pool_id: [u8; 32], entry_asset: Pubkey, winner: Pubkey, required_buy_in: u64) -> Result<()> {
    let (expected, _) = Pubkey::find_program_address(&[ARENA_BUYIN_SEED, pool_id.as_ref(), entry_asset.as_ref(), winner.as_ref()], &crate::ID);
    require_keys_eq!(expected, receipt_info.key(), ArenaError::InvalidWinnerReceipt);
    require_keys_eq!(*receipt_info.owner, crate::ID, ArenaError::InvalidWinnerReceipt);
    let data = receipt_info.try_borrow_data()?; let mut slice: &[u8] = &data;
    let receipt = ArenaBuyInReceipt::try_deserialize(&mut slice).map_err(|_| error!(ArenaError::InvalidWinnerReceipt))?;
    require!(receipt.pool_id == pool_id && receipt.entry_asset == entry_asset && receipt.entrant == winner && !receipt.refunded && receipt.amount_lamports == required_buy_in, ArenaError::InvalidWinnerReceipt);
    Ok(())
}

fn verify_preceding_ed25519(instructions: &AccountInfo, expected_pubkey: &Pubkey, expected_message: &[u8]) -> Result<()> {
    let current_index = load_current_index_checked(instructions)? as usize;
    require!(current_index > 0, ArenaError::MissingResolverSignature);
    let ix = load_instruction_at_checked(current_index - 1, instructions)?;
    require!(ix.program_id == ed25519_program::id(), ArenaError::MissingResolverSignature);
    let data = ix.data; require!(data.len() >= 16 && data[0] == 1 && data[1] == 0, ArenaError::InvalidResolverSignature);
    let read_u16 = |offset: usize| -> Result<usize> { require!(offset + 2 <= data.len(), ArenaError::InvalidResolverSignature); Ok(u16::from_le_bytes([data[offset], data[offset + 1]]) as usize) };
    let signature_offset = read_u16(2)?; let signature_instruction_index = read_u16(4)?;
    let public_key_offset = read_u16(6)?; let public_key_instruction_index = read_u16(8)?;
    let message_offset = read_u16(10)?; let message_size = read_u16(12)?; let message_instruction_index = read_u16(14)?;
    let self_ix = u16::MAX as usize;
    require!(signature_instruction_index == self_ix && public_key_instruction_index == self_ix && message_instruction_index == self_ix, ArenaError::InvalidResolverSignature);
    require!(signature_offset + 64 <= data.len() && public_key_offset + 32 <= data.len() && message_offset + message_size <= data.len(), ArenaError::InvalidResolverSignature);
    require!(&data[public_key_offset..public_key_offset + 32] == expected_pubkey.as_ref(), ArenaError::InvalidResolverSignature);
    require!(&data[message_offset..message_offset + message_size] == expected_message, ArenaError::InvalidResolverSignature);
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeArena<'info> {
    #[account(mut)] pub authority: Signer<'info>,
    #[account(seeds = [REWARDS_CONFIG_SEED], bump = rewards_config.bump, has_one = authority)] pub rewards_config: Account<'info, RewardsConfig>,
    #[account(init, payer = authority, space = 8 + ArenaConfig::SIZE, seeds = [ARENA_CONFIG_SEED], bump)] pub arena_config: Account<'info, ArenaConfig>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct SetArenaConfig<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [REWARDS_CONFIG_SEED], bump = rewards_config.bump, has_one = authority)] pub rewards_config: Account<'info, RewardsConfig>,
    #[account(mut, seeds = [ARENA_CONFIG_SEED], bump = arena_config.bump, constraint = arena_config.authority == authority.key() @ ArenaError::Unauthorized)] pub arena_config: Account<'info, ArenaConfig>,
}

macro_rules! deprecated_accounts { ($name:ident) => { #[derive(Accounts)] pub struct $name<'info> { pub caller: Signer<'info> } }; }
deprecated_accounts!(OpenBattlePool); deprecated_accounts!(OpenTournamentPool); deprecated_accounts!(DepositStake); deprecated_accounts!(DonateSupport); deprecated_accounts!(DepositBuyIn); deprecated_accounts!(ResolveArenaPool); deprecated_accounts!(RefundArenaBuyIn);

#[derive(Accounts)]
#[instruction(pool_id: [u8; 32])]
pub struct OpenBattlePoolV2<'info> {
    #[account(mut)] pub opener: Signer<'info>,
    #[account(seeds = [ARENA_CONFIG_SEED], bump = arena_config.bump)] pub arena_config: Account<'info, ArenaConfig>,
    #[account(init, payer = opener, space = 8 + ArenaPool::SIZE, seeds = [ARENA_POOL_SEED, pool_id.as_ref()], bump)] pub pool: Account<'info, ArenaPool>,
    #[account(init, payer = opener, space = 8 + ArenaVault::SIZE, seeds = [ARENA_VAULT_SEED, pool_id.as_ref()], bump)] pub vault: Account<'info, ArenaVault>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(pool_id: [u8; 32])]
pub struct OpenTournamentPoolV2<'info> {
    #[account(mut)] pub authority: Signer<'info>,
    #[account(seeds = [ARENA_CONFIG_SEED], bump = arena_config.bump, constraint = arena_config.authority == authority.key() @ ArenaError::Unauthorized)] pub arena_config: Account<'info, ArenaConfig>,
    #[account(init, payer = authority, space = 8 + ArenaPool::SIZE, seeds = [ARENA_POOL_SEED, pool_id.as_ref()], bump)] pub pool: Account<'info, ArenaPool>,
    #[account(init, payer = authority, space = 8 + ArenaVault::SIZE, seeds = [ARENA_VAULT_SEED, pool_id.as_ref()], bump)] pub vault: Account<'info, ArenaVault>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(pool_id: [u8; 32])]
pub struct DepositStakeV2<'info> {
    #[account(mut)] pub staker: Signer<'info>,
    #[account(seeds = [ARENA_CONFIG_SEED], bump = arena_config.bump)] pub arena_config: Account<'info, ArenaConfig>,
    #[account(mut, seeds = [ARENA_POOL_SEED, pool_id.as_ref()], bump = pool.bump)] pub pool: Account<'info, ArenaPool>,
    #[account(mut, seeds = [ARENA_VAULT_SEED, pool_id.as_ref()], bump = pool.vault_bump)] pub vault: Account<'info, ArenaVault>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(pool_id: [u8; 32])]
pub struct DonateSupportV2<'info> {
    #[account(mut)] pub donor: Signer<'info>,
    #[account(seeds = [ARENA_CONFIG_SEED], bump = arena_config.bump)] pub arena_config: Account<'info, ArenaConfig>,
    #[account(mut, seeds = [ARENA_POOL_SEED, pool_id.as_ref()], bump = pool.bump)] pub pool: Account<'info, ArenaPool>,
    #[account(mut, seeds = [ARENA_VAULT_SEED, pool_id.as_ref()], bump = pool.vault_bump)] pub vault: Account<'info, ArenaVault>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(pool_id: [u8; 32])]
pub struct CloseSupportV2<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [ARENA_CONFIG_SEED], bump = arena_config.bump)] pub arena_config: Account<'info, ArenaConfig>,
    #[account(mut, seeds = [ARENA_POOL_SEED, pool_id.as_ref()], bump = pool.bump)] pub pool: Account<'info, ArenaPool>,
}
#[derive(Accounts)]
#[instruction(pool_id: [u8; 32], entry_asset: Pubkey)]
pub struct DepositBuyInV2<'info> {
    #[account(mut)] pub entrant: Signer<'info>,
    #[account(seeds = [ARENA_CONFIG_SEED], bump = arena_config.bump)] pub arena_config: Account<'info, ArenaConfig>,
    #[account(mut, seeds = [ARENA_POOL_SEED, pool_id.as_ref()], bump = pool.bump)] pub pool: Account<'info, ArenaPool>,
    #[account(mut, seeds = [ARENA_VAULT_SEED, pool_id.as_ref()], bump = pool.vault_bump)] pub vault: Account<'info, ArenaVault>,
    #[account(init, payer = entrant, space = 8 + ArenaBuyInReceipt::SIZE, seeds = [ARENA_BUYIN_SEED, pool_id.as_ref(), entry_asset.as_ref(), entrant.key().as_ref()], bump)] pub buy_in_receipt: Account<'info, ArenaBuyInReceipt>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(pool_id: [u8; 32], funding_id: [u8; 32])]
pub struct DepositPrizeBoostV2<'info> {
    #[account(mut)] pub funder: Signer<'info>,
    #[account(seeds = [ARENA_CONFIG_SEED], bump = arena_config.bump)] pub arena_config: Account<'info, ArenaConfig>,
    #[account(mut, seeds = [ARENA_POOL_SEED, pool_id.as_ref()], bump = pool.bump)] pub pool: Account<'info, ArenaPool>,
    #[account(mut, seeds = [ARENA_VAULT_SEED, pool_id.as_ref()], bump = pool.vault_bump)] pub vault: Account<'info, ArenaVault>,
    #[account(init, payer = funder, space = 8 + ArenaBoostReceipt::SIZE, seeds = [ARENA_BOOST_SEED, pool_id.as_ref(), funding_id.as_ref(), funder.key().as_ref()], bump)] pub boost_receipt: Account<'info, ArenaBoostReceipt>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(pool_id: [u8; 32])]
pub struct ResolveArenaPoolV2<'info> {
    #[account(seeds = [ARENA_CONFIG_SEED], bump = arena_config.bump)] pub arena_config: Account<'info, ArenaConfig>,
    #[account(mut, seeds = [ARENA_POOL_SEED, pool_id.as_ref()], bump = pool.bump)] pub pool: Account<'info, ArenaPool>,
    /// CHECK: validated for tournament winner receipts; ignored for battles.
    pub winner_buy_in_receipt: UncheckedAccount<'info>,
    /// CHECK: canonical instructions sysvar.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)] pub instructions: UncheckedAccount<'info>,
}
#[derive(Accounts)]
#[instruction(pool_id: [u8; 32])]
pub struct CancelArenaPoolV2<'info> {
    #[account(seeds = [ARENA_CONFIG_SEED], bump = arena_config.bump)] pub arena_config: Account<'info, ArenaConfig>,
    #[account(mut, seeds = [ARENA_POOL_SEED, pool_id.as_ref()], bump = pool.bump)] pub pool: Account<'info, ArenaPool>,
    /// CHECK: canonical instructions sysvar.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)] pub instructions: UncheckedAccount<'info>,
}
#[derive(Accounts)]
#[instruction(pool_id: [u8; 32])]
pub struct SettleExpiredArenaPool<'info> { #[account(mut, seeds = [ARENA_POOL_SEED, pool_id.as_ref()], bump = pool.bump)] pub pool: Account<'info, ArenaPool> }
#[derive(Accounts)]
#[instruction(pool_id: [u8; 32])]
pub struct ClaimArenaWinner<'info> {
    #[account(mut)] pub winner: Signer<'info>,
    #[account(mut, seeds = [ARENA_POOL_SEED, pool_id.as_ref()], bump = pool.bump)] pub pool: Account<'info, ArenaPool>,
    #[account(mut, seeds = [ARENA_VAULT_SEED, pool_id.as_ref()], bump = pool.vault_bump)] pub vault: Account<'info, ArenaVault>,
    #[account(init, payer = winner, space = 8 + ArenaClaimReceipt::SIZE, seeds = [ARENA_CLAIM_SEED, pool_id.as_ref(), &[ARENA_CLAIM_WINNER]], bump)] pub claim_receipt: Account<'info, ArenaClaimReceipt>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(pool_id: [u8; 32])]
pub struct ClaimArenaProtocol<'info> {
    #[account(mut)] pub caller: Signer<'info>,
    #[account(seeds = [ARENA_CONFIG_SEED], bump = arena_config.bump)] pub arena_config: Account<'info, ArenaConfig>,
    #[account(mut, seeds = [ARENA_POOL_SEED, pool_id.as_ref()], bump = pool.bump)] pub pool: Account<'info, ArenaPool>,
    #[account(mut, seeds = [ARENA_VAULT_SEED, pool_id.as_ref()], bump = pool.vault_bump)] pub vault: Account<'info, ArenaVault>,
    #[account(mut, address = arena_config.protocol_receiver)] pub receiver: SystemAccount<'info>,
    #[account(init, payer = caller, space = 8 + ArenaClaimReceipt::SIZE, seeds = [ARENA_CLAIM_SEED, pool_id.as_ref(), &[ARENA_CLAIM_PROTOCOL]], bump)] pub claim_receipt: Account<'info, ArenaClaimReceipt>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(pool_id: [u8; 32])]
pub struct ClaimArenaMwl<'info> {
    #[account(mut)] pub caller: Signer<'info>,
    #[account(seeds = [ARENA_CONFIG_SEED], bump = arena_config.bump)] pub arena_config: Account<'info, ArenaConfig>,
    #[account(mut, seeds = [ARENA_POOL_SEED, pool_id.as_ref()], bump = pool.bump)] pub pool: Account<'info, ArenaPool>,
    #[account(mut, seeds = [ARENA_VAULT_SEED, pool_id.as_ref()], bump = pool.vault_bump)] pub vault: Account<'info, ArenaVault>,
    #[account(mut, address = arena_config.mwl_receiver)] pub receiver: SystemAccount<'info>,
    #[account(init, payer = caller, space = 8 + ArenaClaimReceipt::SIZE, seeds = [ARENA_CLAIM_SEED, pool_id.as_ref(), &[ARENA_CLAIM_MWL]], bump)] pub claim_receipt: Account<'info, ArenaClaimReceipt>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(pool_id: [u8; 32])]
pub struct ClaimArenaCharity<'info> {
    #[account(mut)] pub caller: Signer<'info>,
    #[account(seeds = [ARENA_CONFIG_SEED], bump = arena_config.bump)] pub arena_config: Account<'info, ArenaConfig>,
    #[account(mut, seeds = [ARENA_POOL_SEED, pool_id.as_ref()], bump = pool.bump)] pub pool: Account<'info, ArenaPool>,
    #[account(mut, seeds = [ARENA_VAULT_SEED, pool_id.as_ref()], bump = pool.vault_bump)] pub vault: Account<'info, ArenaVault>,
    #[account(mut, address = arena_config.charity_receiver)] pub receiver: SystemAccount<'info>,
    #[account(init, payer = caller, space = 8 + ArenaClaimReceipt::SIZE, seeds = [ARENA_CLAIM_SEED, pool_id.as_ref(), &[ARENA_CLAIM_CHARITY]], bump)] pub claim_receipt: Account<'info, ArenaClaimReceipt>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(pool_id: [u8; 32])]
pub struct RefundArenaStake<'info> {
    #[account(mut)] pub staker: Signer<'info>,
    #[account(mut, seeds = [ARENA_POOL_SEED, pool_id.as_ref()], bump = pool.bump)] pub pool: Account<'info, ArenaPool>,
    #[account(mut, seeds = [ARENA_VAULT_SEED, pool_id.as_ref()], bump = pool.vault_bump)] pub vault: Account<'info, ArenaVault>,
    #[account(init, payer = staker, space = 8 + ArenaRefundReceipt::SIZE, seeds = [ARENA_REFUND_SEED, pool_id.as_ref(), staker.key().as_ref(), &[ARENA_KIND_BATTLE]], bump)] pub refund_receipt: Account<'info, ArenaRefundReceipt>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(pool_id: [u8; 32], entry_asset: Pubkey)]
pub struct RefundArenaBuyInV2<'info> {
    #[account(mut)] pub entrant: Signer<'info>,
    #[account(mut, seeds = [ARENA_POOL_SEED, pool_id.as_ref()], bump = pool.bump)] pub pool: Account<'info, ArenaPool>,
    #[account(mut, seeds = [ARENA_VAULT_SEED, pool_id.as_ref()], bump = pool.vault_bump)] pub vault: Account<'info, ArenaVault>,
    #[account(mut, seeds = [ARENA_BUYIN_SEED, pool_id.as_ref(), entry_asset.as_ref(), entrant.key().as_ref()], bump = buy_in_receipt.bump)] pub buy_in_receipt: Account<'info, ArenaBuyInReceipt>,
    #[account(init, payer = entrant, space = 8 + ArenaRefundReceipt::SIZE, seeds = [ARENA_REFUND_SEED, pool_id.as_ref(), entrant.key().as_ref(), entry_asset.as_ref()], bump)] pub refund_receipt: Account<'info, ArenaRefundReceipt>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(pool_id: [u8; 32], funding_id: [u8; 32])]
pub struct RefundPrizeBoostV2<'info> {
    #[account(mut)] pub funder: Signer<'info>,
    #[account(mut, seeds = [ARENA_POOL_SEED, pool_id.as_ref()], bump = pool.bump)] pub pool: Account<'info, ArenaPool>,
    #[account(mut, seeds = [ARENA_VAULT_SEED, pool_id.as_ref()], bump = pool.vault_bump)] pub vault: Account<'info, ArenaVault>,
    #[account(mut, seeds = [ARENA_BOOST_SEED, pool_id.as_ref(), funding_id.as_ref(), funder.key().as_ref()], bump = boost_receipt.bump)] pub boost_receipt: Account<'info, ArenaBoostReceipt>,
    #[account(init, payer = funder, space = 8 + ArenaRefundReceipt::SIZE, seeds = [ARENA_REFUND_SEED, pool_id.as_ref(), funder.key().as_ref(), funding_id.as_ref()], bump)] pub refund_receipt: Account<'info, ArenaRefundReceipt>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct ArenaConfig {
    pub authority: Pubkey, pub resolver: Pubkey, pub protocol_receiver: Pubkey,
    pub mwl_receiver: Pubkey, pub charity_receiver: Pubkey,
    pub deposits_paused: bool, pub bump: u8, pub version: u8,
}
impl ArenaConfig { pub const SIZE: usize = 32 * 5 + 3; }

#[account]
pub struct ArenaPool {
    pub pool_id: [u8; 32], pub kind: u8, pub state: u8,
    pub asset_a: Pubkey, pub asset_b: Pubkey, pub owner_a: Pubkey, pub owner_b: Pubkey,
    pub required_stake_a: u64, pub required_stake_b: u64,
    pub deposited_stake_a: u64, pub deposited_stake_b: u64,
    pub buy_in_lamports: u64, pub buy_in_total: u64, pub support_total: u64, pub prize_boost_total: u64,
    pub support_deadline: i64, pub deposit_deadline: i64, pub resolve_deadline: i64, pub support_closed: bool,
    pub result_type: u8, pub winner_side: u8, pub winner_asset: Pubkey, pub winner_wallet: Pubkey,
    pub outcome_hash: [u8; 32], pub cancellation_reason: u8,
    pub pending_winner: u64, pub pending_protocol: u64, pub pending_mwl: u64, pub pending_charity: u64,
    pub claimed_winner: bool, pub claimed_protocol: bool, pub claimed_mwl: bool, pub claimed_charity: bool,
    pub refunded_a: bool, pub refunded_b: bool, pub bump: u8, pub vault_bump: u8, pub action_nonce: u64,
}
impl ArenaPool { pub const SIZE: usize = 544; }
#[account] pub struct ArenaVault { pub kind: u8 }
impl ArenaVault { pub const SIZE: usize = 1; }
#[account]
pub struct ArenaBuyInReceipt { pub pool_id: [u8; 32], pub entry_asset: Pubkey, pub entrant: Pubkey, pub amount_lamports: u64, pub refunded: bool, pub bump: u8 }
impl ArenaBuyInReceipt { pub const SIZE: usize = 32 + 32 + 32 + 8 + 1 + 1; }
#[account]
pub struct ArenaBoostReceipt { pub pool_id: [u8; 32], pub funding_id: [u8; 32], pub funder: Pubkey, pub amount_lamports: u64, pub refunded: bool, pub bump: u8 }
impl ArenaBoostReceipt { pub const SIZE: usize = 32 + 32 + 32 + 8 + 1 + 1; }
#[account]
pub struct ArenaClaimReceipt { pub pool_id: [u8; 32], pub bucket: u8, pub recipient: Pubkey, pub amount_lamports: u64, pub bump: u8 }
impl ArenaClaimReceipt { pub const SIZE: usize = 32 + 1 + 32 + 8 + 1; }
#[account]
pub struct ArenaRefundReceipt { pub pool_id: [u8; 32], pub wallet: Pubkey, pub identity: Pubkey, pub amount_lamports: u64, pub kind: u8, pub bump: u8 }
impl ArenaRefundReceipt { pub const SIZE: usize = 32 + 32 + 32 + 8 + 1 + 1; }

#[event]
pub struct ArenaPoolOpenedV2 { pub pool_id: [u8; 32], pub kind: u8, pub asset_a: Pubkey, pub asset_b: Pubkey, pub owner_a: Pubkey, pub owner_b: Pubkey, pub required_stake_a: u64, pub required_stake_b: u64, pub buy_in_lamports: u64, pub support_deadline: i64, pub deposit_deadline: i64, pub resolve_deadline: i64 }
#[event] pub struct ArenaStakeDeposited { pub pool_id: [u8; 32], pub staker: Pubkey, pub amount_lamports: u64 }
#[event] pub struct ArenaPoolLive { pub pool_id: [u8; 32] }
#[event] pub struct ArenaSupportDonated { pub pool_id: [u8; 32], pub donor: Pubkey, pub amount_lamports: u64 }
#[event] pub struct ArenaSupportClosed { pub pool_id: [u8; 32], pub closed_by: Pubkey }
#[event] pub struct ArenaBuyInDepositedV2 { pub pool_id: [u8; 32], pub entry_asset: Pubkey, pub entrant: Pubkey, pub amount_lamports: u64 }
#[event] pub struct ArenaPrizeBoostDeposited { pub pool_id: [u8; 32], pub funding_id: [u8; 32], pub funder: Pubkey, pub amount_lamports: u64 }
#[event] pub struct ArenaPoolResolvedV2 { pub pool_id: [u8; 32], pub result_type: u8, pub winner_side: u8, pub winner_asset: Pubkey, pub winner_wallet: Pubkey, pub outcome_hash: [u8; 32], pub pending_winner: u64, pub pending_protocol: u64, pub pending_mwl: u64, pub pending_charity: u64 }
#[event] pub struct ArenaPoolCancelledV2 { pub pool_id: [u8; 32], pub reason_code: u8, pub pending_charity: u64 }

#[error_code]
pub enum ArenaError {
    #[msg("Arena address may not be zero.")] ZeroAddress,
    #[msg("Arena caller is not authorized.")] Unauthorized,
    #[msg("Arena deposits are paused.")] DepositsPaused,
    #[msg("Arena pool id is invalid.")] InvalidPoolId,
    #[msg("Arena owners are invalid.")] InvalidOwners,
    #[msg("Arena participant assets are invalid.")] InvalidAssets,
    #[msg("Arena amount is invalid.")] InvalidAmount,
    #[msg("Arena deadline is invalid.")] InvalidDeadline,
    #[msg("Arena deadline has passed.")] DeadlinePassed,
    #[msg("Arena pool mismatch.")] PoolMismatch,
    #[msg("Arena pool state is invalid.")] InvalidState,
    #[msg("Arena pool kind is invalid.")] InvalidKind,
    #[msg("Arena participant already deposited.")] AlreadyDeposited,
    #[msg("Wallet is not a participant.")] NotParticipant,
    #[msg("Support is closed.")] SupportClosed,
    #[msg("Support cannot be closed before its deadline by this caller.")] SupportStillOpen,
    #[msg("Arena result is invalid.")] InvalidResult,
    #[msg("Arena winner is invalid.")] InvalidWinner,
    #[msg("Arena outcome hash is invalid.")] InvalidOutcomeHash,
    #[msg("Arena tournament winner receipt is invalid.")] InvalidWinnerReceipt,
    #[msg("Arena action nonce is invalid.")] InvalidResolutionNonce,
    #[msg("Arena resolver signature has expired.")] ResolutionSignatureExpired,
    #[msg("Arena resolver Ed25519 instruction is missing.")] MissingResolverSignature,
    #[msg("Arena resolver Ed25519 instruction is invalid.")] InvalidResolverSignature,
    #[msg("Arena vault has insufficient distributable SOL.")] InsufficientVaultBalance,
    #[msg("Arena arithmetic overflow.")] MathOverflow,
    #[msg("Arena bucket has nothing to claim.")] NothingToClaim,
    #[msg("Arena claim bucket is invalid.")] InvalidClaimBucket,
    #[msg("Arena refund is unavailable.")] RefundUnavailable,
    #[msg("Arena funds were already refunded.")] AlreadyRefunded,
    #[msg("Arena pool cannot be expired yet.")] ExpiryUnavailable,
    #[msg("Legacy Arena financial instruction is disabled; use the V2 instruction.")] DeprecatedInstruction,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normal_base_is_85_5_10_and_boost_is_not_resplit() {
        let (winner, protocol, mwl) = split_arena_prize(10_000).unwrap();
        assert_eq!((winner, protocol, mwl), (8_500, 500, 1_000));
        assert_eq!(winner + 7_000, 15_500);
    }
    #[test]
    fn resolution_message_binds_assets_outcome_and_boost() {
        let p = Pubkey::new_unique(); let a = Pubkey::new_unique(); let b = Pubkey::new_unique();
        let oa = Pubkey::new_unique(); let ob = Pubkey::new_unique(); let w = oa; let id = [7u8; 32];
        let x = arena_resolution_message_v2(2,id,p,ARENA_KIND_BATTLE,a,b,oa,ob,10,12,2,7,0,ARENA_SIDE_A,a,w,ARENA_RESULT_WINNER,[1u8;32],99,0);
        let y = arena_resolution_message_v2(2,id,p,ARENA_KIND_BATTLE,a,b,oa,ob,10,12,2,8,0,ARENA_SIDE_A,a,w,ARENA_RESULT_WINNER,[1u8;32],99,0);
        let z = arena_resolution_message_v2(2,id,p,ARENA_KIND_BATTLE,a,b,oa,ob,10,12,2,7,0,ARENA_SIDE_A,a,w,ARENA_RESULT_WINNER,[2u8;32],99,0);
        assert_ne!(x,y); assert_ne!(x,z);
    }
    #[test]
    fn cancellation_message_binds_current_totals_and_nonce() {
        let p = Pubkey::new_unique(); let id = [9u8;32];
        let a = arena_cancel_message_v1(2,id,p,1,10,12,2,0,7,99,0);
        let b = arena_cancel_message_v1(2,id,p,1,10,12,2,0,8,99,0);
        let c = arena_cancel_message_v1(2,id,p,1,10,12,2,0,7,99,1);
        assert_ne!(a,b); assert_ne!(a,c);
    }
}
