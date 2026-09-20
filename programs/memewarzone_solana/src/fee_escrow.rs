//! Per-campaign fee escrow for bonding BUY/SELL.
//!
//! User trades accrue the 2% protocol fee here. Physical six-way routing to
//! rewards vaults happens later via permissionless `flush_campaign_fees`.
//! The creator's 0.10% share is isolated in a dedicated per-campaign vault PDA
//! so FeeEscrow V1 stays byte-for-byte stable for deployed campaigns.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::system_instruction;

use crate::authorized_trade::{
    preview_bnb_route, validate_route_profile_id, TRADE_SIDE_BUY, TRADE_SIDE_FINALIZE,
    TRADE_SIDE_SELL,
};
use crate::campaign_view::{load_campaign_view, CAMPAIGN_ACCOUNT_BYTES};
use crate::{LaunchpadError, ROUTE_KIND_TRADE};

pub const FEE_ESCROW_SEED: &[u8] = b"fee-escrow";
pub const FEE_ESCROW_VERSION: u8 = 1;
pub const CREATOR_FEE_VAULT_SEED: &[u8] = b"creator-fee-vault";
pub const CREATOR_FEE_VAULT_VERSION: u8 = 1;

#[account]
#[derive(InitSpace)]
pub struct FeeEscrow {
    pub campaign: Pubkey,
    pub weekly_pending: u64,
    pub monthly_pending: u64,
    pub recruiter_pending: u64,
    pub airdrop_pending: u64,
    pub squad_pending: u64,
    pub protocol_pending: u64,
    pub total_received: u64,
    pub total_flushed: u64,
    pub bump: u8,
    pub version: u8,
}

#[account]
#[derive(InitSpace)]
pub struct CreatorFeeVault {
    pub campaign: Pubkey,
    pub creator: Pubkey,
    pub pending_lamports: u64,
    pub total_received: u64,
    pub total_claimed: u64,
    pub bump: u8,
    pub version: u8,
}

#[event]
pub struct FeeSlicesAccrued {
    pub campaign: Pubkey,
    pub trader: Pubkey,
    pub side: u8,
    pub route_profile: u8,
    pub fee_lamports: u64,
    pub weekly_league_lamports: u64,
    pub monthly_league_lamports: u64,
    pub creator_lamports: u64,
    pub recruiter_lamports: u64,
    pub airdrop_lamports: u64,
    pub squad_lamports: u64,
    pub protocol_lamports: u64,
}

#[event]
pub struct FeeEscrowInitialized {
    pub campaign: Pubkey,
    pub escrow: Pubkey,
    pub payer: Pubkey,
}

#[event]
pub struct CreatorFeeVaultInitialized {
    pub campaign: Pubkey,
    pub creator: Pubkey,
    pub creator_fee_vault: Pubkey,
    pub payer: Pubkey,
}

#[event]
pub struct CreatorFeeAccrued {
    pub campaign: Pubkey,
    pub creator: Pubkey,
    pub creator_fee_vault: Pubkey,
    pub trader: Pubkey,
    pub side: u8,
    pub route_profile: u8,
    pub amount_lamports: u64,
    pub pending_lamports: u64,
    pub total_received: u64,
}

#[event]
pub struct CreatorFeeClaimed {
    pub campaign: Pubkey,
    pub creator: Pubkey,
    pub creator_fee_vault: Pubkey,
    pub amount_lamports: u64,
    pub total_claimed: u64,
}

#[event]
pub struct FeeEscrowFlushed {
    pub campaign: Pubkey,
    pub escrow: Pubkey,
    pub weekly_league_lamports: u64,
    pub monthly_league_lamports: u64,
    pub recruiter_lamports: u64,
    pub airdrop_lamports: u64,
    pub squad_lamports: u64,
    pub protocol_lamports: u64,
    pub total_lamports: u64,
    pub caller: Pubkey,
}

#[derive(Accounts)]
pub struct InitializeFeeEscrow<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: launchpad-owned Campaign; validated in handler.
    pub campaign: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + FeeEscrow::INIT_SPACE,
        seeds = [FEE_ESCROW_SEED, campaign.key().as_ref()],
        bump
    )]
    pub fee_escrow: Account<'info, FeeEscrow>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeCreatorFeeVault<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: launchpad-owned Campaign; validated in handler.
    pub campaign: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + CreatorFeeVault::INIT_SPACE,
        seeds = [CREATOR_FEE_VAULT_SEED, campaign.key().as_ref()],
        bump
    )]
    pub creator_fee_vault: Account<'info, CreatorFeeVault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimCreatorFees<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    /// CHECK: campaign is validated in handler and binds the creator fee vault PDA.
    pub campaign: UncheckedAccount<'info>,
    /// CHECK: deserialized in handler so the fee-escrow layout stays isolated.
    #[account(
        mut,
        seeds = [CREATOR_FEE_VAULT_SEED, campaign.key().as_ref()],
        bump
    )]
    pub creator_fee_vault: UncheckedAccount<'info>,
    /// CHECK: fee escrow PDA; the creator's accrued lamports live here now.
    ///
    /// Trades stopped moving the creator's slice into the vault because paying
    /// two fee destinations inside the trader's transaction is what made wallets
    /// flag every buy. The vault keeps the counter; the lamports are paid out
    /// from here on claim.
    #[account(mut, seeds = [FEE_ESCROW_SEED, campaign.key().as_ref()], bump)]
    pub fee_escrow: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct FlushCampaignFees<'info> {
    pub caller: Signer<'info>,
    /// CHECK: campaign key binds the escrow PDA.
    pub campaign: UncheckedAccount<'info>,
    /// CHECK: deserialized in an isolated frame.
    #[account(
        mut,
        seeds = [FEE_ESCROW_SEED, campaign.key().as_ref()],
        bump
    )]
    pub fee_escrow: UncheckedAccount<'info>,
    /// CHECK: must equal canonical weekly league vault.
    #[account(mut)]
    pub weekly_league_vault: UncheckedAccount<'info>,
    /// CHECK: must equal canonical airdrop vault.
    #[account(mut)]
    pub airdrop_vault: UncheckedAccount<'info>,
    /// CHECK: must equal canonical monthly league vault.
    #[account(mut)]
    pub monthly_league_vault: UncheckedAccount<'info>,
    /// CHECK: must equal canonical recruiter vault.
    #[account(mut)]
    pub recruiter_vault: UncheckedAccount<'info>,
    /// CHECK: must equal canonical squad vault.
    #[account(mut)]
    pub squad_vault: UncheckedAccount<'info>,
    /// CHECK: must equal canonical protocol vault.
    #[account(mut)]
    pub protocol_vault: UncheckedAccount<'info>,
}

pub fn initialize_fee_escrow_handler(ctx: Context<InitializeFeeEscrow>) -> Result<()> {
    require_keys_eq!(
        *ctx.accounts.campaign.owner,
        crate::ID,
        LaunchpadError::InvalidCampaign
    );
    require!(
        ctx.accounts.campaign.data_len() == CAMPAIGN_ACCOUNT_BYTES,
        LaunchpadError::InvalidCampaign
    );

    let escrow = &mut ctx.accounts.fee_escrow;
    escrow.campaign = ctx.accounts.campaign.key();
    escrow.weekly_pending = 0;
    escrow.monthly_pending = 0;
    escrow.recruiter_pending = 0;
    escrow.airdrop_pending = 0;
    escrow.squad_pending = 0;
    escrow.protocol_pending = 0;
    escrow.total_received = 0;
    escrow.total_flushed = 0;
    escrow.bump = ctx.bumps.fee_escrow;
    escrow.version = FEE_ESCROW_VERSION;

    emit!(FeeEscrowInitialized {
        campaign: escrow.campaign,
        escrow: ctx.accounts.fee_escrow.key(),
        payer: ctx.accounts.payer.key(),
    });
    Ok(())
}

pub fn initialize_creator_fee_vault_handler(ctx: Context<InitializeCreatorFeeVault>) -> Result<()> {
    require_keys_eq!(
        *ctx.accounts.campaign.owner,
        crate::ID,
        LaunchpadError::InvalidCampaign
    );
    require!(
        ctx.accounts.campaign.data_len() == CAMPAIGN_ACCOUNT_BYTES,
        LaunchpadError::InvalidCampaign
    );
    let campaign_view = load_campaign_view(&ctx.accounts.campaign.to_account_info())?;

    let creator_fee_vault = &mut ctx.accounts.creator_fee_vault;
    creator_fee_vault.campaign = ctx.accounts.campaign.key();
    creator_fee_vault.creator = campaign_view.creator;
    creator_fee_vault.pending_lamports = 0;
    creator_fee_vault.total_received = 0;
    creator_fee_vault.total_claimed = 0;
    creator_fee_vault.bump = ctx.bumps.creator_fee_vault;
    creator_fee_vault.version = CREATOR_FEE_VAULT_VERSION;

    emit!(CreatorFeeVaultInitialized {
        campaign: creator_fee_vault.campaign,
        creator: creator_fee_vault.creator,
        creator_fee_vault: ctx.accounts.creator_fee_vault.key(),
        payer: ctx.accounts.payer.key(),
    });
    Ok(())
}

pub fn claim_creator_fees_handler(ctx: Context<ClaimCreatorFees>) -> Result<()> {
    require_keys_eq!(
        *ctx.accounts.campaign.owner,
        crate::ID,
        LaunchpadError::InvalidCampaign
    );
    require!(
        ctx.accounts.campaign.data_len() == CAMPAIGN_ACCOUNT_BYTES,
        LaunchpadError::InvalidCampaign
    );
    let campaign = load_campaign_view(&ctx.accounts.campaign.to_account_info())?;
    require_keys_eq!(
        campaign.creator,
        ctx.accounts.creator.key(),
        LaunchpadError::Unauthorized
    );
    require_creator_fee_vault(
        &ctx.accounts.creator_fee_vault.to_account_info(),
        ctx.accounts.campaign.key(),
    )?;

    {
        let data = ctx.accounts.creator_fee_vault.try_borrow_data()?;
        let mut slice: &[u8] = &data;
        let vault = Box::new(CreatorFeeVault::try_deserialize(&mut slice)?);
        require_keys_eq!(
            vault.creator,
            ctx.accounts.creator.key(),
            LaunchpadError::Unauthorized
        );
    }

    require_fee_escrow(
        &ctx.accounts.fee_escrow.to_account_info(),
        ctx.accounts.campaign.key(),
        ctx.bumps.fee_escrow,
    )?;

    // What the creator is owed is whatever the collector holds above rent and
    // the six other buckets. No counter, because slices_sum == fee_lamports is
    // asserted on every trade and flush only ever spends pending_sum().
    //
    // Claiming empties it, so it is self-accounting: nothing can be claimed
    // twice, and nothing needs to be written during a trade to keep it honest.
    let escrow_info = ctx.accounts.fee_escrow.to_account_info();
    let escrow_rent = Rent::get()?.minimum_balance(8 + FeeEscrow::INIT_SPACE);
    let reserved = {
        let data = escrow_info.try_borrow_data()?;
        let mut slice: &[u8] = &data;
        let escrow = Box::new(FeeEscrow::try_deserialize(&mut slice)?);
        require_keys_eq!(
            escrow.campaign,
            ctx.accounts.campaign.key(),
            LaunchpadError::InvalidFeeEscrow
        );
        pending_sum(&escrow)?
    };
    let from_escrow = escrow_info
        .lamports()
        .saturating_sub(escrow_rent)
        .saturating_sub(reserved);

    // Campaigns that traded before this change hold real lamports in the vault,
    // because the trade used to move the creator slice there. Pay that out too
    // so nothing is stranded.
    let vault_rent = Rent::get()?.minimum_balance(8 + CreatorFeeVault::INIT_SPACE);
    let vault_info = ctx.accounts.creator_fee_vault.to_account_info();
    let from_vault = vault_info.lamports().saturating_sub(vault_rent);

    let amount = from_vault
        .checked_add(from_escrow)
        .ok_or(LaunchpadError::MathOverflow)?;
    if amount == 0 {
        return Ok(());
    }

    // Pay the vault's own surplus first, then the escrow.
    //
    // Campaigns that traded before this change already hold real lamports in
    // the vault, because trades used to move the creator slice there. Draining
    // that first means those balances are still claimable and nothing is
    // stranded; everything accrued since is paid from the escrow.
    require_fee_escrow(
        &ctx.accounts.fee_escrow.to_account_info(),
        ctx.accounts.campaign.key(),
        ctx.bumps.fee_escrow,
    )?;

    let vault_rent = Rent::get()?.minimum_balance(8 + CreatorFeeVault::INIT_SPACE);
    let vault_info = ctx.accounts.creator_fee_vault.to_account_info();
    let from_vault = vault_info.lamports().saturating_sub(vault_rent).min(amount);
    let from_escrow = amount.saturating_sub(from_vault);

    if from_escrow > 0 {
        // Only the surplus above what the escrow still owes its own six slices
        // is the creator's. flush_campaign_fees spends pending_sum(); taking
        // from below that line would steal the league/protocol/airdrop shares.
        let escrow_info = ctx.accounts.fee_escrow.to_account_info();
        let escrow_rent = Rent::get()?.minimum_balance(8 + FeeEscrow::INIT_SPACE);
        let reserved = {
            let data = escrow_info.try_borrow_data()?;
            let mut slice: &[u8] = &data;
            let escrow = Box::new(FeeEscrow::try_deserialize(&mut slice)?);
            require_keys_eq!(
                escrow.campaign,
                ctx.accounts.campaign.key(),
                LaunchpadError::InvalidFeeEscrow
            );
            pending_sum(&escrow)?
        };
        let escrow_spendable = escrow_info
            .lamports()
            .saturating_sub(escrow_rent)
            .saturating_sub(reserved);
        require!(
            escrow_spendable >= from_escrow,
            LaunchpadError::FeeEscrowBalanceMismatch
        );
    }

    {
        let creator_info = ctx.accounts.creator.to_account_info();
        if from_vault > 0 {
            **vault_info.try_borrow_mut_lamports()? = vault_info
                .lamports()
                .checked_sub(from_vault)
                .ok_or(LaunchpadError::FeeEscrowBalanceMismatch)?;
        }
        if from_escrow > 0 {
            let escrow_info = ctx.accounts.fee_escrow.to_account_info();
            **escrow_info.try_borrow_mut_lamports()? = escrow_info
                .lamports()
                .checked_sub(from_escrow)
                .ok_or(LaunchpadError::FeeEscrowBalanceMismatch)?;
        }
        **creator_info.try_borrow_mut_lamports()? = creator_info
            .lamports()
            .checked_add(amount)
            .ok_or(LaunchpadError::MathOverflow)?;
    }

    let total_claimed = {
        let mut data = ctx.accounts.creator_fee_vault.try_borrow_mut_data()?;
        let mut slice: &[u8] = &data;
        let mut vault = Box::new(CreatorFeeVault::try_deserialize(&mut slice)?);
        vault.pending_lamports = 0;
        vault.total_claimed = vault
            .total_claimed
            .checked_add(amount)
            .ok_or(LaunchpadError::MathOverflow)?;
        let total_claimed = vault.total_claimed;
        let mut cursor = std::io::Cursor::new(&mut data[..]);
        vault.try_serialize(&mut cursor)?;
        total_claimed
    };

    emit!(CreatorFeeClaimed {
        campaign: ctx.accounts.campaign.key(),
        creator: ctx.accounts.creator.key(),
        creator_fee_vault: ctx.accounts.creator_fee_vault.key(),
        amount_lamports: amount,
        total_claimed,
    });
    Ok(())
}

pub fn flush_campaign_fees_handler(ctx: Context<FlushCampaignFees>) -> Result<()> {
    let expected = crate::authorized_trade::expected_reward_vaults();
    let vaults = [
        ctx.accounts.weekly_league_vault.to_account_info(),
        ctx.accounts.airdrop_vault.to_account_info(),
        ctx.accounts.monthly_league_vault.to_account_info(),
        ctx.accounts.recruiter_vault.to_account_info(),
        ctx.accounts.squad_vault.to_account_info(),
        ctx.accounts.protocol_vault.to_account_info(),
    ];
    for i in 0..6 {
        require_keys_eq!(
            *vaults[i].key,
            expected[i],
            LaunchpadError::InvalidRewardsVault
        );
        require!(vaults[i].is_writable, LaunchpadError::InvalidRewardsVault);
        require!(
            vaults[i].lamports() > 0,
            LaunchpadError::InvalidRewardsVault
        );
    }

    let campaign = ctx.accounts.campaign.key();
    let caller = ctx.accounts.caller.key();
    flush_escrow_lamports(
        &ctx.accounts.fee_escrow.to_account_info(),
        &vaults,
        campaign,
        caller,
    )
}

/// BUY: trader System-transfers net to sol_vault and fee to escrow.
pub fn transfer_buy_net_and_fee<'info>(
    trader: &AccountInfo<'info>,
    sol_vault: &AccountInfo<'info>,
    fee_escrow: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    net: u64,
    fee: u64,
    lamports_spent: u64,
) -> Result<()> {
    let total = net.checked_add(fee).ok_or(LaunchpadError::MathOverflow)?;
    require!(total == lamports_spent, LaunchpadError::InvalidTradeAmount);
    if net > 0 {
        invoke(
            &system_instruction::transfer(trader.key, sol_vault.key, net),
            &[trader.clone(), sol_vault.clone(), system_program.clone()],
        )?;
    }
    if fee > 0 {
        invoke(
            &system_instruction::transfer(trader.key, fee_escrow.key, fee),
            &[trader.clone(), fee_escrow.clone(), system_program.clone()],
        )?;
    }
    Ok(())
}

/// SELL: debit gross from program-owned sol_vault; net to seller; fee to escrow.
pub fn credit_sell_net_and_fee(
    sol_vault: &AccountInfo,
    seller: &AccountInfo,
    fee_escrow: &AccountInfo,
    net: u64,
    fee: u64,
    gross: u64,
) -> Result<()> {
    let total = net.checked_add(fee).ok_or(LaunchpadError::MathOverflow)?;
    require!(total == gross, LaunchpadError::InvalidTradeAmount);
    {
        let mut vault_lamports = sol_vault.try_borrow_mut_lamports()?;
        **vault_lamports = vault_lamports
            .checked_sub(gross)
            .ok_or(LaunchpadError::InsufficientVaultBalance)?;
    }
    if net > 0 {
        let mut seller_lamports = seller.try_borrow_mut_lamports()?;
        **seller_lamports = seller_lamports
            .checked_add(net)
            .ok_or(LaunchpadError::MathOverflow)?;
    }
    if fee > 0 {
        let mut escrow_lamports = fee_escrow.try_borrow_mut_lamports()?;
        **escrow_lamports = escrow_lamports
            .checked_add(fee)
            .ok_or(LaunchpadError::MathOverflow)?;
    }
    Ok(())
}

#[inline(never)]
pub fn require_fee_escrow(info: &AccountInfo, campaign: Pubkey, bump: u8) -> Result<()> {
    require_keys_eq!(
        *info.owner,
        crate::ID,
        LaunchpadError::FeeEscrowNotInitialized
    );
    let expected = Pubkey::find_program_address(&[FEE_ESCROW_SEED, campaign.as_ref()], &crate::ID);
    require_keys_eq!(*info.key, expected.0, LaunchpadError::InvalidFeeEscrow);
    require!(expected.1 == bump, LaunchpadError::InvalidFeeEscrow);
    require!(
        info.data_len() == 8 + FeeEscrow::INIT_SPACE,
        LaunchpadError::FeeEscrowNotInitialized
    );
    let data = info.try_borrow_data()?;
    let mut slice: &[u8] = &data;
    let escrow = Box::new(FeeEscrow::try_deserialize(&mut slice)?);
    require_keys_eq!(escrow.campaign, campaign, LaunchpadError::InvalidFeeEscrow);
    require!(
        escrow.version == FEE_ESCROW_VERSION,
        LaunchpadError::InvalidFeeEscrow
    );
    Ok(())
}

#[inline(never)]
pub fn require_creator_fee_vault(info: &AccountInfo, campaign: Pubkey) -> Result<()> {
    require_keys_eq!(
        *info.owner,
        crate::ID,
        LaunchpadError::FeeEscrowNotInitialized
    );
    let expected =
        Pubkey::find_program_address(&[CREATOR_FEE_VAULT_SEED, campaign.as_ref()], &crate::ID);
    require_keys_eq!(*info.key, expected.0, LaunchpadError::InvalidFeeEscrow);
    require!(
        info.data_len() == 8 + CreatorFeeVault::INIT_SPACE,
        LaunchpadError::FeeEscrowNotInitialized
    );
    let data = info.try_borrow_data()?;
    let mut slice: &[u8] = &data;
    let vault = Box::new(CreatorFeeVault::try_deserialize(&mut slice)?);
    require_keys_eq!(vault.campaign, campaign, LaunchpadError::InvalidFeeEscrow);
    require!(
        vault.version == CREATOR_FEE_VAULT_VERSION,
        LaunchpadError::InvalidFeeEscrow
    );
    require!(vault.bump == expected.1, LaunchpadError::InvalidFeeEscrow);
    Ok(())
}

#[inline(never)]
pub fn require_fee_escrow_empty(info: &AccountInfo, campaign: Pubkey) -> Result<()> {
    require_keys_eq!(
        *info.owner,
        crate::ID,
        LaunchpadError::FeeEscrowNotInitialized
    );
    let data = info.try_borrow_data()?;
    let mut slice: &[u8] = &data;
    let escrow = Box::new(FeeEscrow::try_deserialize(&mut slice)?);
    require_keys_eq!(escrow.campaign, campaign, LaunchpadError::InvalidFeeEscrow);
    let pending = pending_sum(&escrow)?;
    require!(pending == 0, LaunchpadError::FeeEscrowPendingNonzero);
    Ok(())
}

#[inline(never)]
pub fn accrue_fee_escrow(
    info: &AccountInfo,
    campaign: Pubkey,
    trader: Pubkey,
    side: u8,
    fee_lamports: u64,
    route_profile: u8,
) -> Result<()> {
    require!(
        side == TRADE_SIDE_BUY || side == TRADE_SIDE_SELL,
        LaunchpadError::InvalidTradeAmount
    );
    require!(
        side != TRADE_SIDE_FINALIZE,
        LaunchpadError::InvalidTradeAmount
    );
    validate_route_profile_id(route_profile)?;
    require_keys_eq!(
        *info.owner,
        crate::ID,
        LaunchpadError::FeeEscrowNotInitialized
    );

    let amounts = preview_bnb_route(ROUTE_KIND_TRADE, route_profile, fee_lamports)?;
    let slices_sum = amounts
        .weekly_league
        .checked_add(amounts.monthly_league)
        .and_then(|v| v.checked_add(amounts.creator))
        .and_then(|v| v.checked_add(amounts.recruiter))
        .and_then(|v| v.checked_add(amounts.airdrop))
        .and_then(|v| v.checked_add(amounts.squad))
        .and_then(|v| v.checked_add(amounts.protocol))
        .ok_or(LaunchpadError::MathOverflow)?;
    require!(slices_sum == fee_lamports, LaunchpadError::InvalidFeeEscrow);

    {
        let data = info.try_borrow_data()?;
        let mut slice: &[u8] = &data;
        let escrow = Box::new(FeeEscrow::try_deserialize(&mut slice)?);
        require_keys_eq!(escrow.campaign, campaign, LaunchpadError::InvalidFeeEscrow);
        require!(
            escrow.version == FEE_ESCROW_VERSION,
            LaunchpadError::InvalidFeeEscrow
        );
    }

    // The creator's slice is the seventh bucket in this collector, and like the
    // other six it needs no separate account.
    //
    // It used to be tracked as a counter on CreatorFeeVault, a different
    // account, so every buy and sell had to carry that account and write to it
    // -- a 15th account, writable, purely to increment a number. The six league,
    // recruiter, airdrop, squad and protocol buckets are fields on this struct
    // and cost nothing extra; the creator bucket was the odd one out for no
    // reason anyone can point to.
    //
    // It does not even need a field. slices_sum == fee_lamports is asserted
    // above, and flush_campaign_fees only ever spends pending_sum() -- the six.
    // So whatever sits in this account above rent and those six counters IS the
    // unclaimed creator share, by construction. Verified against mainnet:
    // total_received 39,214, six slices 18,627, surplus 980, and 5% of 39,214
    // is 1,960 = 980 already paid out + 980 surplus. Exact.
    //
    // claim_creator_fees reads that surplus. A trade now touches one fee
    // account instead of two.

    let mut data = info.try_borrow_mut_data()?;
    let mut slice: &[u8] = &data;
    let mut escrow = Box::new(FeeEscrow::try_deserialize(&mut slice)?);
    require_keys_eq!(escrow.campaign, campaign, LaunchpadError::InvalidFeeEscrow);

    if fee_lamports > 0 {
        escrow.weekly_pending = escrow
            .weekly_pending
            .checked_add(amounts.weekly_league)
            .ok_or(LaunchpadError::MathOverflow)?;
        escrow.monthly_pending = escrow
            .monthly_pending
            .checked_add(amounts.monthly_league)
            .ok_or(LaunchpadError::MathOverflow)?;
        escrow.recruiter_pending = escrow
            .recruiter_pending
            .checked_add(amounts.recruiter)
            .ok_or(LaunchpadError::MathOverflow)?;
        escrow.airdrop_pending = escrow
            .airdrop_pending
            .checked_add(amounts.airdrop)
            .ok_or(LaunchpadError::MathOverflow)?;
        escrow.squad_pending = escrow
            .squad_pending
            .checked_add(amounts.squad)
            .ok_or(LaunchpadError::MathOverflow)?;
        escrow.protocol_pending = escrow
            .protocol_pending
            .checked_add(amounts.protocol)
            .ok_or(LaunchpadError::MathOverflow)?;
        escrow.total_received = escrow
            .total_received
            .checked_add(fee_lamports)
            .ok_or(LaunchpadError::MathOverflow)?;
    }

    let mut cursor = std::io::Cursor::new(&mut data[..]);
    escrow.try_serialize(&mut cursor)?;
    drop(data);

    emit!(FeeSlicesAccrued {
        campaign,
        trader,
        side,
        route_profile,
        fee_lamports,
        weekly_league_lamports: amounts.weekly_league,
        monthly_league_lamports: amounts.monthly_league,
        creator_lamports: amounts.creator,
        recruiter_lamports: amounts.recruiter,
        airdrop_lamports: amounts.airdrop,
        squad_lamports: amounts.squad,
        protocol_lamports: amounts.protocol,
    });
    Ok(())
}

#[inline(never)]
fn accrue_creator_fee_vault(
    info: &AccountInfo,
    campaign: Pubkey,
    trader: Pubkey,
    side: u8,
    route_profile: u8,
    amount_lamports: u64,
) -> Result<()> {
    require_creator_fee_vault(info, campaign)?;
    let mut data = info.try_borrow_mut_data()?;
    let mut slice: &[u8] = &data;
    let mut vault = Box::new(CreatorFeeVault::try_deserialize(&mut slice)?);
    vault.pending_lamports = vault
        .pending_lamports
        .checked_add(amount_lamports)
        .ok_or(LaunchpadError::MathOverflow)?;
    vault.total_received = vault
        .total_received
        .checked_add(amount_lamports)
        .ok_or(LaunchpadError::MathOverflow)?;
    let pending_lamports = vault.pending_lamports;
    let total_received = vault.total_received;
    let creator = vault.creator;
    let mut cursor = std::io::Cursor::new(&mut data[..]);
    vault.try_serialize(&mut cursor)?;
    drop(data);

    emit!(CreatorFeeAccrued {
        campaign,
        creator,
        creator_fee_vault: *info.key,
        trader,
        side,
        route_profile,
        amount_lamports,
        pending_lamports,
        total_received,
    });
    Ok(())
}

#[inline(never)]

#[inline(never)]
fn flush_escrow_lamports(
    escrow_info: &AccountInfo,
    vaults: &[AccountInfo; 6],
    campaign: Pubkey,
    caller: Pubkey,
) -> Result<()> {
    require_keys_eq!(
        *escrow_info.owner,
        crate::ID,
        LaunchpadError::FeeEscrowNotInitialized
    );

    let (weekly, monthly, recruiter, airdrop, squad, protocol, need) = {
        let data = escrow_info.try_borrow_data()?;
        let mut slice: &[u8] = &data;
        let escrow = Box::new(FeeEscrow::try_deserialize(&mut slice)?);
        require_keys_eq!(escrow.campaign, campaign, LaunchpadError::InvalidFeeEscrow);
        let need = pending_sum(&escrow)?;
        (
            escrow.weekly_pending,
            escrow.monthly_pending,
            escrow.recruiter_pending,
            escrow.airdrop_pending,
            escrow.squad_pending,
            escrow.protocol_pending,
            need,
        )
    };
    if need == 0 {
        return Ok(());
    }

    let rent_min = Rent::get()?.minimum_balance(8 + FeeEscrow::INIT_SPACE);
    let spendable = escrow_info.lamports().saturating_sub(rent_min);
    require!(spendable >= need, LaunchpadError::FeeEscrowBalanceMismatch);

    let slices = [weekly, airdrop, monthly, recruiter, squad, protocol];
    {
        let mut escrow_lamports = escrow_info.try_borrow_mut_lamports()?;
        **escrow_lamports = escrow_lamports
            .checked_sub(need)
            .ok_or(LaunchpadError::FeeEscrowBalanceMismatch)?;
    }
    for i in 0..6 {
        if slices[i] == 0 {
            continue;
        }
        let mut dest = vaults[i].try_borrow_mut_lamports()?;
        **dest = dest
            .checked_add(slices[i])
            .ok_or(LaunchpadError::MathOverflow)?;
    }

    {
        let mut data = escrow_info.try_borrow_mut_data()?;
        let mut slice: &[u8] = &data;
        let mut escrow = Box::new(FeeEscrow::try_deserialize(&mut slice)?);
        escrow.weekly_pending = 0;
        escrow.monthly_pending = 0;
        escrow.recruiter_pending = 0;
        escrow.airdrop_pending = 0;
        escrow.squad_pending = 0;
        escrow.protocol_pending = 0;
        escrow.total_flushed = escrow
            .total_flushed
            .checked_add(need)
            .ok_or(LaunchpadError::MathOverflow)?;
        let mut cursor = std::io::Cursor::new(&mut data[..]);
        escrow.try_serialize(&mut cursor)?;
    }

    emit!(FeeEscrowFlushed {
        campaign,
        escrow: *escrow_info.key,
        weekly_league_lamports: weekly,
        monthly_league_lamports: monthly,
        recruiter_lamports: recruiter,
        airdrop_lamports: airdrop,
        squad_lamports: squad,
        protocol_lamports: protocol,
        total_lamports: need,
        caller,
    });
    Ok(())
}

fn pending_sum(escrow: &FeeEscrow) -> Result<u64> {
    escrow
        .weekly_pending
        .checked_add(escrow.monthly_pending)
        .and_then(|v| v.checked_add(escrow.recruiter_pending))
        .and_then(|v| v.checked_add(escrow.airdrop_pending))
        .and_then(|v| v.checked_add(escrow.squad_pending))
        .and_then(|v| v.checked_add(escrow.protocol_pending))
        .ok_or_else(|| error!(LaunchpadError::MathOverflow))
}

#[cfg(test)]
mod tests {

    /// A trade must not touch the creator fee vault at all.
    ///
    /// The creator's slice is the seventh bucket in the fee escrow. The other
    /// six are counters on the escrow struct and cost nothing extra; this one
    /// was tracked on a separate account, so every buy and sell carried that
    /// account writable purely to increment a number -- a 15th account on a
    /// transaction that needs 14, and the one structural difference from the
    /// Kaiju88 buys the wallet guarded without complaint. It briefly moved
    /// lamports there too, which paid two fee destinations inside the trader's
    /// transaction; that was removed first, the account itself second.
    ///
    /// It needs no counter. slices_sum == fee_lamports is asserted on every
    /// trade and flush only spends pending_sum(), so the escrow's surplus above
    /// rent and those six IS the unclaimed creator share. A grep is the honest
    /// test -- the alternative is a running bank and a wallet to tell you it has
    /// stopped trusting you.
    #[test]
    fn a_trade_never_references_the_creator_fee_vault() {
        let source = include_str!("fee_escrow.rs");
        let start = source
            .find("pub fn accrue_fee_escrow(")
            .expect("accrue_fee_escrow must exist");
        let bytes = source.as_bytes();
        let open = start + source[start..].find('{').expect("function body");
        let mut depth = 0usize;
        let mut end = source.len();
        for i in open..source.len() {
            match bytes[i] {
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = i + 1;
                        break;
                    }
                }
                _ => {}
            }
        }
        let body = &source[start..end];
        for forbidden in [
            "creator_fee_vault",
            "accrue_creator_fee_vault",
            "try_borrow_mut_lamports",
            "system_instruction::transfer",
        ] {
            assert!(
                !body.contains(forbidden),
                "accrue_fee_escrow references `{forbidden}`; a trade must touch one fee account, \
                 the escrow, and nothing else",
            );
        }

        // And the trade instructions must not carry the account at all.
        let trade = include_str!("authorized_trade.rs");
        for name in ["BuyTokens<'info>", "SellTokens<'info>"] {
            let s = trade.find(&format!("pub struct {name} {{")).expect(name);
            let e = s + trade[s..].find("\n}\n").expect("struct end");
            assert!(
                !trade[s..e].contains("pub creator_fee_vault"),
                "{name} still carries creator_fee_vault; the trade is 14 accounts, not 15",
            );
        }
    }

    /// The claim is where the creator's lamports actually move, so it has to be
    /// able to reach the escrow they now sit in.
    #[test]
    fn the_claim_can_reach_the_escrow_the_lamports_sit_in() {
        let source = include_str!("fee_escrow.rs");
        let start = source
            .find("pub struct ClaimCreatorFees<'info> {")
            .expect("ClaimCreatorFees must exist");
        let accounts = &source[start..start + source[start..].find("\n}\n").unwrap()];
        assert!(
            accounts.contains("pub fee_escrow: UncheckedAccount<'info>"),
            "ClaimCreatorFees must take the fee escrow; without it the creator cannot be paid",
        );
        assert!(
            accounts.contains("seeds = [FEE_ESCROW_SEED, campaign.key().as_ref()]"),
            "the escrow must be pinned by seeds so a look-alike account cannot be substituted",
        );
    }

    use super::*;
    use crate::{ROUTE_PROFILE_LINKED, ROUTE_PROFILE_OG, ROUTE_PROFILE_UNLINKED};

    #[test]
    fn fee_escrow_account_size_is_stable() {
        assert_eq!(FeeEscrow::INIT_SPACE, 98);
        assert_eq!(8 + FeeEscrow::INIT_SPACE, 106);
    }

    #[test]
    fn creator_fee_vault_account_size_is_stable() {
        assert_eq!(8 + CreatorFeeVault::INIT_SPACE, 98);
    }

    #[test]
    fn trade_slices_sum_to_fee_for_all_profiles() {
        let fee = 10_000u64;
        for profile in [
            ROUTE_PROFILE_LINKED,
            ROUTE_PROFILE_UNLINKED,
            ROUTE_PROFILE_OG,
        ] {
            let amounts = preview_bnb_route(ROUTE_KIND_TRADE, profile, fee).unwrap();
            let sum = amounts.weekly_league
                + amounts.monthly_league
                + amounts.creator
                + amounts.recruiter
                + amounts.airdrop
                + amounts.squad
                + amounts.protocol;
            assert_eq!(sum, fee, "profile {profile}");
            assert_eq!(amounts.creator, 500, "profile {profile}");
        }
    }
}
