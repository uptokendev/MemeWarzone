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
pub const ARENA_CLAIM_SEED: &[u8] = b"arena_claim";
pub const ARENA_REFUND_SEED: &[u8] = b"arena_refund";
pub const ARENA_RESOLUTION_DOMAIN: &[u8] = b"MWZ_ARENA_RESOLVE_V1";

pub const ARENA_KIND_BATTLE: u8 = 0;
pub const ARENA_KIND_TOURNAMENT: u8 = 1;

pub const ARENA_STATE_OPEN: u8 = 0;
pub const ARENA_STATE_LIVE: u8 = 1;
pub const ARENA_STATE_RESOLVED: u8 = 2;
pub const ARENA_STATE_CANCELLED: u8 = 3;

pub const ARENA_RESULT_WINNER: u8 = 1;
pub const ARENA_RESULT_TIE: u8 = 2;

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
    config.version = 1;

    emit!(ArenaInitialized {
        authority: config.authority,
        resolver,
        protocol_receiver,
        mwl_receiver,
        charity_receiver,
        version: config.version,
    });
    Ok(())
}

pub fn set_arena_resolver_handler(ctx: Context<SetArenaConfig>, resolver: Pubkey) -> Result<()> {
    require!(resolver != Pubkey::default(), ArenaError::ZeroAddress);
    ctx.accounts.arena_config.resolver = resolver;
    emit!(ArenaResolverUpdated { resolver });
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

    emit!(ArenaReceiversUpdated {
        protocol_receiver,
        mwl_receiver,
        charity_receiver,
    });
    Ok(())
}

pub fn set_arena_pause_handler(ctx: Context<SetArenaConfig>, paused: bool) -> Result<()> {
    ctx.accounts.arena_config.deposits_paused = paused;
    emit!(ArenaDepositsPaused { paused });
    Ok(())
}

pub fn open_battle_pool_handler(
    ctx: Context<OpenBattlePool>,
    pool_id: [u8; 32],
    owner_a: Pubkey,
    owner_b: Pubkey,
    stake_lamports: u64,
    deposit_deadline: i64,
    resolve_deadline: i64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(!ctx.accounts.arena_config.deposits_paused, ArenaError::DepositsPaused);
    require!(pool_id != [0u8; 32], ArenaError::InvalidPoolId);
    require!(owner_a != Pubkey::default() && owner_b != Pubkey::default(), ArenaError::ZeroAddress);
    require!(owner_a != owner_b, ArenaError::InvalidOwners);
    require!(stake_lamports > 0, ArenaError::InvalidAmount);
    require!(deposit_deadline > now && resolve_deadline > deposit_deadline, ArenaError::InvalidDeadline);

    let opener = ctx.accounts.opener.key();
    require!(opener == owner_a || opener == owner_b, ArenaError::Unauthorized);

    ctx.accounts.vault.kind = ARENA_KIND_BATTLE;
    let pool = &mut ctx.accounts.pool;
    initialize_pool_common(
        pool,
        pool_id,
        ARENA_KIND_BATTLE,
        owner_a,
        owner_b,
        stake_lamports,
        0,
        deposit_deadline,
        resolve_deadline,
        ctx.bumps.pool,
        ctx.bumps.vault,
    );

    transfer_into_vault(
        &ctx.accounts.opener.to_account_info(),
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        stake_lamports,
    )?;
    if opener == owner_a {
        pool.stake_a = stake_lamports;
    } else {
        pool.stake_b = stake_lamports;
    }

    emit!(ArenaPoolOpened {
        pool_id,
        kind: ARENA_KIND_BATTLE,
        owner_a,
        owner_b,
        stake_lamports,
        buy_in_lamports: 0,
        deposit_deadline,
        resolve_deadline,
    });
    emit!(ArenaStakeDeposited {
        pool_id,
        staker: opener,
        amount_lamports: stake_lamports,
    });
    Ok(())
}

pub fn open_tournament_pool_handler(
    ctx: Context<OpenTournamentPool>,
    pool_id: [u8; 32],
    buy_in_lamports: u64,
    deposit_deadline: i64,
    resolve_deadline: i64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(!ctx.accounts.arena_config.deposits_paused, ArenaError::DepositsPaused);
    require!(pool_id != [0u8; 32], ArenaError::InvalidPoolId);
    require!(buy_in_lamports > 0, ArenaError::InvalidAmount);
    require!(deposit_deadline > now && resolve_deadline > deposit_deadline, ArenaError::InvalidDeadline);

    ctx.accounts.vault.kind = ARENA_KIND_TOURNAMENT;
    let owner = ctx.accounts.authority.key();
    let pool = &mut ctx.accounts.pool;
    initialize_pool_common(
        pool,
        pool_id,
        ARENA_KIND_TOURNAMENT,
        owner,
        Pubkey::default(),
        0,
        buy_in_lamports,
        deposit_deadline,
        resolve_deadline,
        ctx.bumps.pool,
        ctx.bumps.vault,
    );

    emit!(ArenaPoolOpened {
        pool_id,
        kind: ARENA_KIND_TOURNAMENT,
        owner_a: owner,
        owner_b: Pubkey::default(),
        stake_lamports: 0,
        buy_in_lamports,
        deposit_deadline,
        resolve_deadline,
    });
    Ok(())
}

pub fn deposit_stake_handler(ctx: Context<DepositStake>, pool_id: [u8; 32]) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(!ctx.accounts.arena_config.deposits_paused, ArenaError::DepositsPaused);

    let pool = &mut ctx.accounts.pool;
    require!(pool.pool_id == pool_id, ArenaError::PoolMismatch);
    require!(pool.kind == ARENA_KIND_BATTLE && pool.state == ARENA_STATE_OPEN, ArenaError::InvalidState);
    require!(now <= pool.deposit_deadline, ArenaError::DeadlinePassed);

    let staker = ctx.accounts.staker.key();
    if staker == pool.owner_a {
        require!(pool.stake_a == 0, ArenaError::AlreadyDeposited);
    } else if staker == pool.owner_b {
        require!(pool.stake_b == 0, ArenaError::AlreadyDeposited);
    } else {
        return err!(ArenaError::NotParticipant);
    }

    transfer_into_vault(
        &ctx.accounts.staker.to_account_info(),
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        pool.stake_lamports,
    )?;

    if staker == pool.owner_a {
        pool.stake_a = pool.stake_lamports;
    } else {
        pool.stake_b = pool.stake_lamports;
    }

    if pool.stake_a == pool.stake_lamports && pool.stake_b == pool.stake_lamports {
        pool.state = ARENA_STATE_LIVE;
        emit!(ArenaPoolLive { pool_id });
    }

    emit!(ArenaStakeDeposited {
        pool_id,
        staker,
        amount_lamports: pool.stake_lamports,
    });
    Ok(())
}

pub fn donate_support_handler(
    ctx: Context<DonateSupport>,
    pool_id: [u8; 32],
    amount_lamports: u64,
) -> Result<()> {
    require!(!ctx.accounts.arena_config.deposits_paused, ArenaError::DepositsPaused);
    require!(amount_lamports > 0, ArenaError::InvalidAmount);

    let now = Clock::get()?.unix_timestamp;
    let pool = &mut ctx.accounts.pool;
    require!(pool.pool_id == pool_id, ArenaError::PoolMismatch);
    require!(pool.state == ARENA_STATE_OPEN || pool.state == ARENA_STATE_LIVE, ArenaError::InvalidState);
    require!(now <= pool.resolve_deadline, ArenaError::DeadlinePassed);
    if pool.kind == ARENA_KIND_BATTLE && pool.state == ARENA_STATE_OPEN {
        require!(now <= pool.deposit_deadline, ArenaError::DeadlinePassed);
    }

    transfer_into_vault(
        &ctx.accounts.donor.to_account_info(),
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        amount_lamports,
    )?;
    pool.support_total = pool.support_total.checked_add(amount_lamports).ok_or(ArenaError::MathOverflow)?;

    emit!(ArenaSupportDonated {
        pool_id,
        donor: ctx.accounts.donor.key(),
        amount_lamports,
    });
    Ok(())
}

pub fn deposit_buy_in_handler(ctx: Context<DepositBuyIn>, pool_id: [u8; 32]) -> Result<()> {
    require!(!ctx.accounts.arena_config.deposits_paused, ArenaError::DepositsPaused);

    let now = Clock::get()?.unix_timestamp;
    let pool = &mut ctx.accounts.pool;
    require!(pool.pool_id == pool_id, ArenaError::PoolMismatch);
    require!(pool.kind == ARENA_KIND_TOURNAMENT, ArenaError::InvalidKind);
    require!(pool.state == ARENA_STATE_OPEN || pool.state == ARENA_STATE_LIVE, ArenaError::InvalidState);
    require!(now <= pool.deposit_deadline, ArenaError::DeadlinePassed);

    transfer_into_vault(
        &ctx.accounts.entrant.to_account_info(),
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        pool.buy_in_lamports,
    )?;
    pool.buy_in_total = pool.buy_in_total.checked_add(pool.buy_in_lamports).ok_or(ArenaError::MathOverflow)?;
    pool.state = ARENA_STATE_LIVE;

    let receipt = &mut ctx.accounts.buy_in_receipt;
    receipt.pool_id = pool_id;
    receipt.entrant = ctx.accounts.entrant.key();
    receipt.amount_lamports = pool.buy_in_lamports;
    receipt.refunded = false;
    receipt.bump = ctx.bumps.buy_in_receipt;

    emit!(ArenaBuyInDeposited {
        pool_id,
        entrant: receipt.entrant,
        amount_lamports: receipt.amount_lamports,
    });
    Ok(())
}

pub fn resolve_pool_handler(
    ctx: Context<ResolveArenaPool>,
    pool_id: [u8; 32],
    result_type: u8,
    winner: Pubkey,
    deadline: i64,
    nonce: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pool_key = ctx.accounts.pool.key();
    let config_version = ctx.accounts.arena_config.version;
    let resolver = ctx.accounts.arena_config.resolver;

    let pool = &mut ctx.accounts.pool;
    require!(pool.pool_id == pool_id, ArenaError::PoolMismatch);
    require!(pool.state == ARENA_STATE_LIVE, ArenaError::InvalidState);
    require!(now <= pool.resolve_deadline, ArenaError::DeadlinePassed);
    require!(now <= deadline && deadline <= pool.resolve_deadline, ArenaError::ResolutionSignatureExpired);
    require!(nonce == pool.resolution_nonce, ArenaError::InvalidResolutionNonce);
    require!(result_type == ARENA_RESULT_WINNER || result_type == ARENA_RESULT_TIE, ArenaError::InvalidResult);

    if result_type == ARENA_RESULT_TIE {
        require!(pool.kind == ARENA_KIND_BATTLE, ArenaError::InvalidResult);
        require!(winner == Pubkey::default(), ArenaError::InvalidWinner);
    } else if pool.kind == ARENA_KIND_BATTLE {
        require!(winner == pool.owner_a || winner == pool.owner_b, ArenaError::InvalidWinner);
    } else {
        require!(winner != Pubkey::default(), ArenaError::InvalidWinner);
        validate_tournament_winner_receipt(
            &ctx.accounts.winner_buy_in_receipt.to_account_info(),
            pool_id,
            winner,
            pool.buy_in_lamports,
        )?;
    }

    let stake_total = pool.stake_a.checked_add(pool.stake_b).ok_or(ArenaError::MathOverflow)?;
    let message = arena_resolution_message(
        config_version,
        pool_id,
        pool_key,
        winner,
        result_type,
        stake_total,
        pool.support_total,
        pool.buy_in_total,
        deadline,
        nonce,
    );
    verify_preceding_ed25519(
        &ctx.accounts.instructions.to_account_info(),
        &resolver,
        &message,
    )?;

    pool.state = ARENA_STATE_RESOLVED;
    pool.winner = winner;
    pool.resolution_nonce = pool.resolution_nonce.checked_add(1).ok_or(ArenaError::MathOverflow)?;

    if result_type == ARENA_RESULT_TIE {
        pool.pending_charity = pool.support_total;
        emit!(ArenaPoolResolved {
            pool_id,
            result_type,
            winner,
            pending_winner: 0,
            pending_protocol: 0,
            pending_mwl: 0,
            pending_charity: pool.pending_charity,
        });
        return Ok(());
    }

    let prize = stake_total
        .checked_add(pool.support_total)
        .and_then(|v| v.checked_add(pool.buy_in_total))
        .ok_or(ArenaError::MathOverflow)?;
    let (winner_amount, protocol_amount, mwl_amount) = split_arena_prize(prize)?;

    pool.pending_winner = winner_amount;
    pool.pending_protocol = protocol_amount;
    pool.pending_mwl = mwl_amount;

    emit!(ArenaPoolResolved {
        pool_id,
        result_type,
        winner,
        pending_winner: winner_amount,
        pending_protocol: protocol_amount,
        pending_mwl: mwl_amount,
        pending_charity: 0,
    });
    Ok(())
}

pub fn settle_expired_pool_handler(ctx: Context<SettleExpiredArenaPool>, pool_id: [u8; 32]) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pool = &mut ctx.accounts.pool;
    require!(pool.pool_id == pool_id, ArenaError::PoolMismatch);
    require!(pool.state == ARENA_STATE_OPEN || pool.state == ARENA_STATE_LIVE, ArenaError::InvalidState);

    let unmatched_battle = pool.kind == ARENA_KIND_BATTLE
        && pool.state == ARENA_STATE_OPEN
        && now > pool.deposit_deadline;
    let resolution_expired = now > pool.resolve_deadline;
    require!(unmatched_battle || resolution_expired, ArenaError::ExpiryUnavailable);

    pool.state = ARENA_STATE_CANCELLED;
    pool.winner = Pubkey::default();
    pool.pending_charity = pool.support_total;

    emit!(ArenaPoolExpired {
        pool_id,
        pending_charity: pool.pending_charity,
    });
    Ok(())
}

pub fn claim_winner_handler(ctx: Context<ClaimArenaWinner>, pool_id: [u8; 32]) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    require!(pool.pool_id == pool_id && pool.state == ARENA_STATE_RESOLVED, ArenaError::InvalidState);
    require!(pool.winner == ctx.accounts.winner.key(), ArenaError::InvalidWinner);
    require!(!pool.claimed_winner && pool.pending_winner > 0, ArenaError::NothingToClaim);

    let amount = pool.pending_winner;
    pool.pending_winner = 0;
    pool.claimed_winner = true;
    debit_vault(
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.winner.to_account_info(),
        amount,
    )?;
    initialize_claim_receipt(
        &mut ctx.accounts.claim_receipt,
        pool_id,
        ARENA_CLAIM_WINNER,
        ctx.accounts.winner.key(),
        amount,
        ctx.bumps.claim_receipt,
    );

    emit!(ArenaClaimed {
        pool_id,
        bucket: ARENA_CLAIM_WINNER,
        to: ctx.accounts.winner.key(),
        amount_lamports: amount,
    });
    Ok(())
}

pub fn claim_protocol_handler(ctx: Context<ClaimArenaProtocol>, pool_id: [u8; 32]) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    require!(pool.pool_id == pool_id && pool.state == ARENA_STATE_RESOLVED, ArenaError::InvalidState);
    require!(!pool.claimed_protocol && pool.pending_protocol > 0, ArenaError::NothingToClaim);

    let amount = pool.pending_protocol;
    pool.pending_protocol = 0;
    pool.claimed_protocol = true;
    debit_vault(
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.receiver.to_account_info(),
        amount,
    )?;
    initialize_claim_receipt(
        &mut ctx.accounts.claim_receipt,
        pool_id,
        ARENA_CLAIM_PROTOCOL,
        ctx.accounts.receiver.key(),
        amount,
        ctx.bumps.claim_receipt,
    );

    emit!(ArenaClaimed {
        pool_id,
        bucket: ARENA_CLAIM_PROTOCOL,
        to: ctx.accounts.receiver.key(),
        amount_lamports: amount,
    });
    Ok(())
}

pub fn claim_mwl_handler(ctx: Context<ClaimArenaMwl>, pool_id: [u8; 32]) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    require!(pool.pool_id == pool_id && pool.state == ARENA_STATE_RESOLVED, ArenaError::InvalidState);
    require!(!pool.claimed_mwl && pool.pending_mwl > 0, ArenaError::NothingToClaim);

    let amount = pool.pending_mwl;
    pool.pending_mwl = 0;
    pool.claimed_mwl = true;
    debit_vault(
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.receiver.to_account_info(),
        amount,
    )?;
    initialize_claim_receipt(
        &mut ctx.accounts.claim_receipt,
        pool_id,
        ARENA_CLAIM_MWL,
        ctx.accounts.receiver.key(),
        amount,
        ctx.bumps.claim_receipt,
    );

    emit!(ArenaClaimed {
        pool_id,
        bucket: ARENA_CLAIM_MWL,
        to: ctx.accounts.receiver.key(),
        amount_lamports: amount,
    });
    Ok(())
}

pub fn claim_charity_handler(ctx: Context<ClaimArenaCharity>, pool_id: [u8; 32]) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    require!(pool.pool_id == pool_id, ArenaError::PoolMismatch);
    require!(pool.state == ARENA_STATE_RESOLVED || pool.state == ARENA_STATE_CANCELLED, ArenaError::InvalidState);
    require!(!pool.claimed_charity && pool.pending_charity > 0, ArenaError::NothingToClaim);

    let amount = pool.pending_charity;
    pool.pending_charity = 0;
    pool.claimed_charity = true;
    debit_vault(
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.receiver.to_account_info(),
        amount,
    )?;
    initialize_claim_receipt(
        &mut ctx.accounts.claim_receipt,
        pool_id,
        ARENA_CLAIM_CHARITY,
        ctx.accounts.receiver.key(),
        amount,
        ctx.bumps.claim_receipt,
    );

    emit!(ArenaClaimed {
        pool_id,
        bucket: ARENA_CLAIM_CHARITY,
        to: ctx.accounts.receiver.key(),
        amount_lamports: amount,
    });
    Ok(())
}

pub fn refund_stake_handler(ctx: Context<RefundArenaStake>, pool_id: [u8; 32]) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    require!(pool.pool_id == pool_id && pool.kind == ARENA_KIND_BATTLE, ArenaError::PoolMismatch);

    let tie = pool.state == ARENA_STATE_RESOLVED && pool.winner == Pubkey::default();
    let cancelled = pool.state == ARENA_STATE_CANCELLED;
    require!(tie || cancelled, ArenaError::RefundUnavailable);

    let staker = ctx.accounts.staker.key();
    let amount = if staker == pool.owner_a {
        require!(!pool.refunded_a, ArenaError::AlreadyRefunded);
        pool.refunded_a = true;
        let value = pool.stake_a;
        pool.stake_a = 0;
        value
    } else if staker == pool.owner_b {
        require!(!pool.refunded_b, ArenaError::AlreadyRefunded);
        pool.refunded_b = true;
        let value = pool.stake_b;
        pool.stake_b = 0;
        value
    } else {
        return err!(ArenaError::NotParticipant);
    };
    require!(amount > 0, ArenaError::NothingToClaim);

    debit_vault(
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.staker.to_account_info(),
        amount,
    )?;
    let receipt = &mut ctx.accounts.refund_receipt;
    receipt.pool_id = pool_id;
    receipt.wallet = staker;
    receipt.amount_lamports = amount;
    receipt.kind = ARENA_KIND_BATTLE;
    receipt.bump = ctx.bumps.refund_receipt;

    emit!(ArenaStakeRefunded {
        pool_id,
        staker,
        amount_lamports: amount,
    });
    Ok(())
}

pub fn refund_buy_in_handler(ctx: Context<RefundArenaBuyIn>, pool_id: [u8; 32]) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    require!(pool.pool_id == pool_id && pool.kind == ARENA_KIND_TOURNAMENT, ArenaError::PoolMismatch);
    require!(pool.state == ARENA_STATE_CANCELLED, ArenaError::RefundUnavailable);

    let buy_in = &mut ctx.accounts.buy_in_receipt;
    require!(buy_in.pool_id == pool_id, ArenaError::PoolMismatch);
    require!(buy_in.entrant == ctx.accounts.entrant.key(), ArenaError::NotParticipant);
    require!(!buy_in.refunded, ArenaError::AlreadyRefunded);
    require!(buy_in.amount_lamports > 0, ArenaError::NothingToClaim);

    let amount = buy_in.amount_lamports;
    buy_in.refunded = true;
    pool.buy_in_total = pool.buy_in_total.checked_sub(amount).ok_or(ArenaError::MathOverflow)?;

    debit_vault(
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.entrant.to_account_info(),
        amount,
    )?;
    let receipt = &mut ctx.accounts.refund_receipt;
    receipt.pool_id = pool_id;
    receipt.wallet = ctx.accounts.entrant.key();
    receipt.amount_lamports = amount;
    receipt.kind = ARENA_KIND_TOURNAMENT;
    receipt.bump = ctx.bumps.refund_receipt;

    emit!(ArenaBuyInRefunded {
        pool_id,
        entrant: ctx.accounts.entrant.key(),
        amount_lamports: amount,
    });
    Ok(())
}

fn initialize_pool_common(
    pool: &mut Account<ArenaPool>,
    pool_id: [u8; 32],
    kind: u8,
    owner_a: Pubkey,
    owner_b: Pubkey,
    stake_lamports: u64,
    buy_in_lamports: u64,
    deposit_deadline: i64,
    resolve_deadline: i64,
    bump: u8,
    vault_bump: u8,
) {
    pool.pool_id = pool_id;
    pool.kind = kind;
    pool.state = ARENA_STATE_OPEN;
    pool.owner_a = owner_a;
    pool.owner_b = owner_b;
    pool.stake_lamports = stake_lamports;
    pool.buy_in_lamports = buy_in_lamports;
    pool.stake_a = 0;
    pool.stake_b = 0;
    pool.buy_in_total = 0;
    pool.support_total = 0;
    pool.winner = Pubkey::default();
    pool.pending_winner = 0;
    pool.pending_protocol = 0;
    pool.pending_mwl = 0;
    pool.pending_charity = 0;
    pool.deposit_deadline = deposit_deadline;
    pool.resolve_deadline = resolve_deadline;
    pool.claimed_winner = false;
    pool.claimed_protocol = false;
    pool.claimed_mwl = false;
    pool.claimed_charity = false;
    pool.refunded_a = false;
    pool.refunded_b = false;
    pool.bump = bump;
    pool.vault_bump = vault_bump;
    pool.resolution_nonce = 0;
}

fn initialize_claim_receipt(
    receipt: &mut Account<ArenaClaimReceipt>,
    pool_id: [u8; 32],
    bucket: u8,
    recipient: Pubkey,
    amount_lamports: u64,
    bump: u8,
) {
    receipt.pool_id = pool_id;
    receipt.bucket = bucket;
    receipt.recipient = recipient;
    receipt.amount_lamports = amount_lamports;
    receipt.bump = bump;
}

fn transfer_into_vault<'info>(
    from: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    lamports: u64,
) -> Result<()> {
    require!(lamports > 0, ArenaError::InvalidAmount);
    invoke(
        &system_instruction::transfer(from.key, vault.key, lamports),
        &[from.clone(), vault.clone(), system_program.clone()],
    )?;
    Ok(())
}

fn debit_vault(vault: &AccountInfo, receiver: &AccountInfo, lamports: u64) -> Result<()> {
    require!(lamports > 0, ArenaError::InvalidAmount);
    let rent_reserve = Rent::get()?.minimum_balance(8 + ArenaVault::SIZE);
    let distributable = vault.lamports().saturating_sub(rent_reserve);
    require!(distributable >= lamports, ArenaError::InsufficientVaultBalance);

    **vault.try_borrow_mut_lamports()? = vault
        .lamports()
        .checked_sub(lamports)
        .ok_or(ArenaError::InsufficientVaultBalance)?;
    **receiver.try_borrow_mut_lamports()? = receiver
        .lamports()
        .checked_add(lamports)
        .ok_or(ArenaError::MathOverflow)?;
    Ok(())
}

pub fn split_arena_prize(prize: u64) -> Result<(u64, u64, u64)> {
    let protocol = prize
        .checked_mul(ARENA_PROTOCOL_BPS)
        .ok_or(ArenaError::MathOverflow)?
        / ARENA_BPS_DENOM;
    let mwl = prize
        .checked_mul(ARENA_MWL_BPS)
        .ok_or(ArenaError::MathOverflow)?
        / ARENA_BPS_DENOM;
    let winner = prize
        .checked_sub(protocol)
        .and_then(|value| value.checked_sub(mwl))
        .ok_or(ArenaError::MathOverflow)?;
    Ok((winner, protocol, mwl))
}

pub fn arena_resolution_message(
    version: u8,
    pool_id: [u8; 32],
    pool: Pubkey,
    winner: Pubkey,
    result_type: u8,
    stake_total: u64,
    support_total: u64,
    buy_in_total: u64,
    deadline: i64,
    nonce: u64,
) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(
        ARENA_RESOLUTION_DOMAIN.len() + 32 + 1 + 32 + 32 + 32 + 1 + 8 + 8 + 8 + 8 + 8,
    );
    bytes.extend_from_slice(ARENA_RESOLUTION_DOMAIN);
    bytes.extend_from_slice(crate::ID.as_ref());
    bytes.push(version);
    bytes.extend_from_slice(&pool_id);
    bytes.extend_from_slice(pool.as_ref());
    bytes.extend_from_slice(winner.as_ref());
    bytes.push(result_type);
    bytes.extend_from_slice(&stake_total.to_le_bytes());
    bytes.extend_from_slice(&support_total.to_le_bytes());
    bytes.extend_from_slice(&buy_in_total.to_le_bytes());
    bytes.extend_from_slice(&deadline.to_le_bytes());
    bytes.extend_from_slice(&nonce.to_le_bytes());
    bytes
}

fn validate_tournament_winner_receipt(
    receipt_info: &AccountInfo,
    pool_id: [u8; 32],
    winner: Pubkey,
    required_buy_in: u64,
) -> Result<()> {
    let (expected, _) = Pubkey::find_program_address(
        &[ARENA_BUYIN_SEED, pool_id.as_ref(), winner.as_ref()],
        &crate::ID,
    );
    require_keys_eq!(expected, receipt_info.key(), ArenaError::InvalidWinnerReceipt);
    require_keys_eq!(*receipt_info.owner, crate::ID, ArenaError::InvalidWinnerReceipt);

    let data = receipt_info.try_borrow_data()?;
    let mut slice: &[u8] = &data;
    let receipt = ArenaBuyInReceipt::try_deserialize(&mut slice)
        .map_err(|_| error!(ArenaError::InvalidWinnerReceipt))?;
    require!(receipt.pool_id == pool_id, ArenaError::InvalidWinnerReceipt);
    require!(receipt.entrant == winner, ArenaError::InvalidWinnerReceipt);
    require!(!receipt.refunded, ArenaError::InvalidWinnerReceipt);
    require!(receipt.amount_lamports == required_buy_in, ArenaError::InvalidWinnerReceipt);
    Ok(())
}

fn verify_preceding_ed25519(
    instructions: &AccountInfo,
    expected_pubkey: &Pubkey,
    expected_message: &[u8],
) -> Result<()> {
    let current_index = load_current_index_checked(instructions)? as usize;
    require!(current_index > 0, ArenaError::MissingResolverSignature);

    let ix = load_instruction_at_checked(current_index - 1, instructions)?;
    require!(ix.program_id == ed25519_program::id(), ArenaError::MissingResolverSignature);

    let data = ix.data;
    require!(data.len() >= 16, ArenaError::InvalidResolverSignature);
    require!(data[0] == 1 && data[1] == 0, ArenaError::InvalidResolverSignature);

    let read_u16 = |offset: usize| -> Result<usize> {
        let end = offset.checked_add(2).ok_or(ArenaError::InvalidResolverSignature)?;
        require!(end <= data.len(), ArenaError::InvalidResolverSignature);
        Ok(u16::from_le_bytes([data[offset], data[offset + 1]]) as usize)
    };

    let signature_offset = read_u16(2)?;
    let signature_instruction_index = read_u16(4)?;
    let public_key_offset = read_u16(6)?;
    let public_key_instruction_index = read_u16(8)?;
    let message_offset = read_u16(10)?;
    let message_size = read_u16(12)?;
    let message_instruction_index = read_u16(14)?;
    let self_instruction = u16::MAX as usize;

    require!(
        signature_instruction_index == self_instruction
            && public_key_instruction_index == self_instruction
            && message_instruction_index == self_instruction,
        ArenaError::InvalidResolverSignature
    );
    require!(
        signature_offset.checked_add(64).map(|end| end <= data.len()).unwrap_or(false),
        ArenaError::InvalidResolverSignature
    );
    require!(
        public_key_offset.checked_add(32).map(|end| end <= data.len()).unwrap_or(false),
        ArenaError::InvalidResolverSignature
    );
    require!(
        message_offset.checked_add(message_size).map(|end| end <= data.len()).unwrap_or(false),
        ArenaError::InvalidResolverSignature
    );
    require!(
        &data[public_key_offset..public_key_offset + 32] == expected_pubkey.as_ref(),
        ArenaError::InvalidResolverSignature
    );
    require!(
        &data[message_offset..message_offset + message_size] == expected_message,
        ArenaError::InvalidResolverSignature
    );
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeArena<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [REWARDS_CONFIG_SEED],
        bump = rewards_config.bump,
        has_one = authority
    )]
    pub rewards_config: Account<'info, RewardsConfig>,
    #[account(
        init,
        payer = authority,
        space = 8 + ArenaConfig::SIZE,
        seeds = [ARENA_CONFIG_SEED],
        bump
    )]
    pub arena_config: Account<'info, ArenaConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetArenaConfig<'info> {
    pub authority: Signer<'info>,
    #[account(
        seeds = [REWARDS_CONFIG_SEED],
        bump = rewards_config.bump,
        has_one = authority
    )]
    pub rewards_config: Account<'info, RewardsConfig>,
    #[account(
        mut,
        seeds = [ARENA_CONFIG_SEED],
        bump = arena_config.bump,
        constraint = arena_config.authority == authority.key() @ ArenaError::Unauthorized
    )]
    pub arena_config: Account<'info, ArenaConfig>,
}

#[derive(Accounts)]
#[instruction(pool_id: [u8; 32])]
pub struct OpenBattlePool<'info> {
    #[account(mut)]
    pub opener: Signer<'info>,
    #[account(seeds = [ARENA_CONFIG_SEED], bump = arena_config.bump)]
    pub arena_config: Account<'info, ArenaConfig>,
    #[account(
        init,
        payer = opener,
        space = 8 + ArenaPool::SIZE,
        seeds = [ARENA_POOL_SEED, pool_id.as_ref()],
        bump
    )]
    pub pool: Account<'info, ArenaPool>,
    #[account(
        init,
        payer = opener,
        space = 8 + ArenaVault::SIZE,
        seeds = [ARENA_VAULT_SEED, pool_id.as_ref()],
        bump
    )]
    pub vault: Account<'info, ArenaVault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(pool_id: [u8; 32])]
pub struct OpenTournamentPool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [ARENA_CONFIG_SEED],
        bump = arena_config.bump,
        constraint = arena_config.authority == authority.key() @ ArenaError::Unauthorized
    )]
    pub arena_config: Account<'info, ArenaConfig>,
    #[account(
        init,
        payer = authority,
        space = 8 + ArenaPool::SIZE,
        seeds = [ARENA_POOL_SEED, pool_id.as_ref()],
        bump
    )]
    pub pool: Account<'info, ArenaPool>,
    #[account(
        init,
        payer = authority,
        space = 8 + ArenaVault::SIZE,
        seeds = [ARENA_VAULT_SEED, pool_id.as_ref()],
        bump
    )]
    pub vault: Account<'info, ArenaVault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(pool_id: [u8; 32])]
pub struct DepositStake<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,
    #[account(seeds = [ARENA_CONFIG_SEED], bump = arena_config.bump)]
    pub arena_config: Account<'info, ArenaConfig>,
    #[account(mut, seeds = [ARENA_POOL_SEED, pool_id.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, ArenaPool>,
    #[account(mut, seeds = [ARENA_VAULT_SEED, pool_id.as_ref()], bump = pool.vault_bump)]
    pub vault: Account<'info, ArenaVault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(pool_id: [u8; 32])]
pub struct DonateSupport<'info> {
    #[account(mut)]
    pub donor: Signer<'info>,
    #[account(seeds = [ARENA_CONFIG_SEED], bump = arena_config.bump)]
    pub arena_config: Account<'info, ArenaConfig>,
    #[account(mut, seeds = [ARENA_POOL_SEED, pool_id.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, ArenaPool>,
    #[account(mut, seeds = [ARENA_VAULT_SEED, pool_id.as_ref()], bump = pool.vault_bump)]
    pub vault: Account<'info, ArenaVault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(pool_id: [u8; 32])]
pub struct DepositBuyIn<'info> {
    #[account(mut)]
    pub entrant: Signer<'info>,
    #[account(seeds = [ARENA_CONFIG_SEED], bump = arena_config.bump)]
    pub arena_config: Account<'info, ArenaConfig>,
    #[account(mut, seeds = [ARENA_POOL_SEED, pool_id.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, ArenaPool>,
    #[account(mut, seeds = [ARENA_VAULT_SEED, pool_id.as_ref()], bump = pool.vault_bump)]
    pub vault: Account<'info, ArenaVault>,
    #[account(
        init,
        payer = entrant,
        space = 8 + ArenaBuyInReceipt::SIZE,
        seeds = [ARENA_BUYIN_SEED, pool_id.as_ref(), entrant.key().as_ref()],
        bump
    )]
    pub buy_in_receipt: Account<'info, ArenaBuyInReceipt>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(pool_id: [u8; 32])]
pub struct ResolveArenaPool<'info> {
    #[account(seeds = [ARENA_CONFIG_SEED], bump = arena_config.bump)]
    pub arena_config: Account<'info, ArenaConfig>,
    #[account(mut, seeds = [ARENA_POOL_SEED, pool_id.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, ArenaPool>,
    /// CHECK: Required only for tournament winner validation; battle resolution ignores it.
    pub winner_buy_in_receipt: UncheckedAccount<'info>,
    /// CHECK: Constrained to the canonical instructions sysvar.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(pool_id: [u8; 32])]
pub struct SettleExpiredArenaPool<'info> {
    #[account(mut, seeds = [ARENA_POOL_SEED, pool_id.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, ArenaPool>,
}

#[derive(Accounts)]
#[instruction(pool_id: [u8; 32])]
pub struct ClaimArenaWinner<'info> {
    #[account(mut)]
    pub winner: Signer<'info>,
    #[account(mut, seeds = [ARENA_POOL_SEED, pool_id.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, ArenaPool>,
    #[account(mut, seeds = [ARENA_VAULT_SEED, pool_id.as_ref()], bump = pool.vault_bump)]
    pub vault: Account<'info, ArenaVault>,
    #[account(
        init,
        payer = winner,
        space = 8 + ArenaClaimReceipt::SIZE,
        seeds = [ARENA_CLAIM_SEED, pool_id.as_ref(), &[ARENA_CLAIM_WINNER]],
        bump
    )]
    pub claim_receipt: Account<'info, ArenaClaimReceipt>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(pool_id: [u8; 32])]
pub struct ClaimArenaProtocol<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(seeds = [ARENA_CONFIG_SEED], bump = arena_config.bump)]
    pub arena_config: Account<'info, ArenaConfig>,
    #[account(mut, seeds = [ARENA_POOL_SEED, pool_id.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, ArenaPool>,
    #[account(mut, seeds = [ARENA_VAULT_SEED, pool_id.as_ref()], bump = pool.vault_bump)]
    pub vault: Account<'info, ArenaVault>,
    #[account(mut, address = arena_config.protocol_receiver)]
    pub receiver: SystemAccount<'info>,
    #[account(
        init,
        payer = caller,
        space = 8 + ArenaClaimReceipt::SIZE,
        seeds = [ARENA_CLAIM_SEED, pool_id.as_ref(), &[ARENA_CLAIM_PROTOCOL]],
        bump
    )]
    pub claim_receipt: Account<'info, ArenaClaimReceipt>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(pool_id: [u8; 32])]
pub struct ClaimArenaMwl<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(seeds = [ARENA_CONFIG_SEED], bump = arena_config.bump)]
    pub arena_config: Account<'info, ArenaConfig>,
    #[account(mut, seeds = [ARENA_POOL_SEED, pool_id.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, ArenaPool>,
    #[account(mut, seeds = [ARENA_VAULT_SEED, pool_id.as_ref()], bump = pool.vault_bump)]
    pub vault: Account<'info, ArenaVault>,
    #[account(mut, address = arena_config.mwl_receiver)]
    pub receiver: SystemAccount<'info>,
    #[account(
        init,
        payer = caller,
        space = 8 + ArenaClaimReceipt::SIZE,
        seeds = [ARENA_CLAIM_SEED, pool_id.as_ref(), &[ARENA_CLAIM_MWL]],
        bump
    )]
    pub claim_receipt: Account<'info, ArenaClaimReceipt>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(pool_id: [u8; 32])]
pub struct ClaimArenaCharity<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(seeds = [ARENA_CONFIG_SEED], bump = arena_config.bump)]
    pub arena_config: Account<'info, ArenaConfig>,
    #[account(mut, seeds = [ARENA_POOL_SEED, pool_id.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, ArenaPool>,
    #[account(mut, seeds = [ARENA_VAULT_SEED, pool_id.as_ref()], bump = pool.vault_bump)]
    pub vault: Account<'info, ArenaVault>,
    #[account(mut, address = arena_config.charity_receiver)]
    pub receiver: SystemAccount<'info>,
    #[account(
        init,
        payer = caller,
        space = 8 + ArenaClaimReceipt::SIZE,
        seeds = [ARENA_CLAIM_SEED, pool_id.as_ref(), &[ARENA_CLAIM_CHARITY]],
        bump
    )]
    pub claim_receipt: Account<'info, ArenaClaimReceipt>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(pool_id: [u8; 32])]
pub struct RefundArenaStake<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,
    #[account(mut, seeds = [ARENA_POOL_SEED, pool_id.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, ArenaPool>,
    #[account(mut, seeds = [ARENA_VAULT_SEED, pool_id.as_ref()], bump = pool.vault_bump)]
    pub vault: Account<'info, ArenaVault>,
    #[account(
        init,
        payer = staker,
        space = 8 + ArenaRefundReceipt::SIZE,
        seeds = [ARENA_REFUND_SEED, pool_id.as_ref(), staker.key().as_ref()],
        bump
    )]
    pub refund_receipt: Account<'info, ArenaRefundReceipt>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(pool_id: [u8; 32])]
pub struct RefundArenaBuyIn<'info> {
    #[account(mut)]
    pub entrant: Signer<'info>,
    #[account(mut, seeds = [ARENA_POOL_SEED, pool_id.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, ArenaPool>,
    #[account(mut, seeds = [ARENA_VAULT_SEED, pool_id.as_ref()], bump = pool.vault_bump)]
    pub vault: Account<'info, ArenaVault>,
    #[account(
        mut,
        seeds = [ARENA_BUYIN_SEED, pool_id.as_ref(), entrant.key().as_ref()],
        bump = buy_in_receipt.bump
    )]
    pub buy_in_receipt: Account<'info, ArenaBuyInReceipt>,
    #[account(
        init,
        payer = entrant,
        space = 8 + ArenaRefundReceipt::SIZE,
        seeds = [ARENA_REFUND_SEED, pool_id.as_ref(), entrant.key().as_ref()],
        bump
    )]
    pub refund_receipt: Account<'info, ArenaRefundReceipt>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct ArenaConfig {
    pub authority: Pubkey,
    pub resolver: Pubkey,
    pub protocol_receiver: Pubkey,
    pub mwl_receiver: Pubkey,
    pub charity_receiver: Pubkey,
    pub deposits_paused: bool,
    pub bump: u8,
    pub version: u8,
}

impl ArenaConfig {
    pub const SIZE: usize = 32 * 5 + 1 + 1 + 1;
}

#[account]
pub struct ArenaPool {
    pub pool_id: [u8; 32],
    pub kind: u8,
    pub state: u8,
    pub owner_a: Pubkey,
    pub owner_b: Pubkey,
    pub stake_lamports: u64,
    pub buy_in_lamports: u64,
    pub stake_a: u64,
    pub stake_b: u64,
    pub buy_in_total: u64,
    pub support_total: u64,
    pub winner: Pubkey,
    pub pending_winner: u64,
    pub pending_protocol: u64,
    pub pending_mwl: u64,
    pub pending_charity: u64,
    pub deposit_deadline: i64,
    pub resolve_deadline: i64,
    pub claimed_winner: bool,
    pub claimed_protocol: bool,
    pub claimed_mwl: bool,
    pub claimed_charity: bool,
    pub refunded_a: bool,
    pub refunded_b: bool,
    pub bump: u8,
    pub vault_bump: u8,
    pub resolution_nonce: u64,
}

impl ArenaPool {
    pub const SIZE: usize = 320;
}

#[account]
pub struct ArenaVault {
    pub kind: u8,
}

impl ArenaVault {
    pub const SIZE: usize = 1;
}

#[account]
pub struct ArenaBuyInReceipt {
    pub pool_id: [u8; 32],
    pub entrant: Pubkey,
    pub amount_lamports: u64,
    pub refunded: bool,
    pub bump: u8,
}

impl ArenaBuyInReceipt {
    pub const SIZE: usize = 32 + 32 + 8 + 1 + 1;
}

#[account]
pub struct ArenaClaimReceipt {
    pub pool_id: [u8; 32],
    pub bucket: u8,
    pub recipient: Pubkey,
    pub amount_lamports: u64,
    pub bump: u8,
}

impl ArenaClaimReceipt {
    pub const SIZE: usize = 32 + 1 + 32 + 8 + 1;
}

#[account]
pub struct ArenaRefundReceipt {
    pub pool_id: [u8; 32],
    pub wallet: Pubkey,
    pub amount_lamports: u64,
    pub kind: u8,
    pub bump: u8,
}

impl ArenaRefundReceipt {
    pub const SIZE: usize = 32 + 32 + 8 + 1 + 1;
}

#[event]
pub struct ArenaInitialized {
    pub authority: Pubkey,
    pub resolver: Pubkey,
    pub protocol_receiver: Pubkey,
    pub mwl_receiver: Pubkey,
    pub charity_receiver: Pubkey,
    pub version: u8,
}

#[event]
pub struct ArenaResolverUpdated {
    pub resolver: Pubkey,
}

#[event]
pub struct ArenaReceiversUpdated {
    pub protocol_receiver: Pubkey,
    pub mwl_receiver: Pubkey,
    pub charity_receiver: Pubkey,
}

#[event]
pub struct ArenaDepositsPaused {
    pub paused: bool,
}

#[event]
pub struct ArenaPoolOpened {
    pub pool_id: [u8; 32],
    pub kind: u8,
    pub owner_a: Pubkey,
    pub owner_b: Pubkey,
    pub stake_lamports: u64,
    pub buy_in_lamports: u64,
    pub deposit_deadline: i64,
    pub resolve_deadline: i64,
}

#[event]
pub struct ArenaStakeDeposited {
    pub pool_id: [u8; 32],
    pub staker: Pubkey,
    pub amount_lamports: u64,
}

#[event]
pub struct ArenaBuyInDeposited {
    pub pool_id: [u8; 32],
    pub entrant: Pubkey,
    pub amount_lamports: u64,
}

#[event]
pub struct ArenaSupportDonated {
    pub pool_id: [u8; 32],
    pub donor: Pubkey,
    pub amount_lamports: u64,
}

#[event]
pub struct ArenaPoolLive {
    pub pool_id: [u8; 32],
}

#[event]
pub struct ArenaPoolResolved {
    pub pool_id: [u8; 32],
    pub result_type: u8,
    pub winner: Pubkey,
    pub pending_winner: u64,
    pub pending_protocol: u64,
    pub pending_mwl: u64,
    pub pending_charity: u64,
}

#[event]
pub struct ArenaPoolExpired {
    pub pool_id: [u8; 32],
    pub pending_charity: u64,
}

#[event]
pub struct ArenaClaimed {
    pub pool_id: [u8; 32],
    pub bucket: u8,
    pub to: Pubkey,
    pub amount_lamports: u64,
}

#[event]
pub struct ArenaStakeRefunded {
    pub pool_id: [u8; 32],
    pub staker: Pubkey,
    pub amount_lamports: u64,
}

#[event]
pub struct ArenaBuyInRefunded {
    pub pool_id: [u8; 32],
    pub entrant: Pubkey,
    pub amount_lamports: u64,
}

#[error_code]
pub enum ArenaError {
    #[msg("Arena address may not be the zero address.")]
    ZeroAddress,
    #[msg("Arena caller is not authorized for this action.")]
    Unauthorized,
    #[msg("Arena deposits are paused.")]
    DepositsPaused,
    #[msg("Arena pool id is invalid.")]
    InvalidPoolId,
    #[msg("Arena owners are invalid.")]
    InvalidOwners,
    #[msg("Arena amount is invalid.")]
    InvalidAmount,
    #[msg("Arena deadline is invalid.")]
    InvalidDeadline,
    #[msg("Arena deadline has passed.")]
    DeadlinePassed,
    #[msg("Arena pool does not match the requested id.")]
    PoolMismatch,
    #[msg("Arena pool state is invalid for this action.")]
    InvalidState,
    #[msg("Arena pool kind is invalid for this action.")]
    InvalidKind,
    #[msg("Arena participant already deposited.")]
    AlreadyDeposited,
    #[msg("Wallet is not a participant in this pool.")]
    NotParticipant,
    #[msg("Arena resolution result is invalid.")]
    InvalidResult,
    #[msg("Arena winner is invalid.")]
    InvalidWinner,
    #[msg("Arena tournament winner receipt is invalid.")]
    InvalidWinnerReceipt,
    #[msg("Arena resolution nonce is invalid.")]
    InvalidResolutionNonce,
    #[msg("Arena resolver signature has expired.")]
    ResolutionSignatureExpired,
    #[msg("Arena resolver Ed25519 instruction is missing.")]
    MissingResolverSignature,
    #[msg("Arena resolver Ed25519 instruction is invalid.")]
    InvalidResolverSignature,
    #[msg("Arena vault has insufficient distributable SOL.")]
    InsufficientVaultBalance,
    #[msg("Arena arithmetic overflow.")]
    MathOverflow,
    #[msg("Arena bucket has nothing to claim.")]
    NothingToClaim,
    #[msg("Arena stake or buy-in refund is not available.")]
    RefundUnavailable,
    #[msg("Arena stake or buy-in was already refunded.")]
    AlreadyRefunded,
    #[msg("Arena pool cannot be expired yet.")]
    ExpiryUnavailable,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_is_exact_85_5_10_for_clean_amount() {
        let (winner, protocol, mwl) = split_arena_prize(10_000).unwrap();
        assert_eq!(winner, 8_500);
        assert_eq!(protocol, 500);
        assert_eq!(mwl, 1_000);
    }

    #[test]
    fn rounding_remainder_stays_with_winner() {
        let (winner, protocol, mwl) = split_arena_prize(101).unwrap();
        assert_eq!(winner + protocol + mwl, 101);
        assert_eq!(protocol, 5);
        assert_eq!(mwl, 10);
        assert_eq!(winner, 86);
    }

    #[test]
    fn resolution_message_changes_with_nonce_and_pool() {
        let pool_a = Pubkey::new_unique();
        let pool_b = Pubkey::new_unique();
        let winner = Pubkey::new_unique();
        let id = [7u8; 32];
        let a = arena_resolution_message(1, id, pool_a, winner, ARENA_RESULT_WINNER, 10, 2, 0, 99, 0);
        let b = arena_resolution_message(1, id, pool_a, winner, ARENA_RESULT_WINNER, 10, 2, 0, 99, 1);
        let c = arena_resolution_message(1, id, pool_b, winner, ARENA_RESULT_WINNER, 10, 2, 0, 99, 0);
        assert_ne!(a, b);
        assert_ne!(a, c);
    }
}
