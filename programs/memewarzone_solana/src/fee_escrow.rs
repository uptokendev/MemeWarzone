//! Per-campaign fee escrow for bonding BUY/SELL.
//!
//! User trades accrue the 2% protocol fee here. Physical six-way routing to
//! rewards vaults happens later via permissionless `flush_campaign_fees`.
//! Slice math stays in `preview_bnb_route` — this module only stores and moves it.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::system_instruction;

use crate::authorized_trade::{
    preview_bnb_route, validate_route_profile_id, TRADE_SIDE_BUY, TRADE_SIDE_FINALIZE,
    TRADE_SIDE_SELL,
};
use crate::campaign_view::CAMPAIGN_ACCOUNT_BYTES;
use crate::{LaunchpadError, ROUTE_KIND_TRADE};

pub const FEE_ESCROW_SEED: &[u8] = b"fee-escrow";
pub const FEE_ESCROW_VERSION: u8 = 1;

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

#[event]
pub struct FeeSlicesAccrued {
    pub campaign: Pubkey,
    pub trader: Pubkey,
    pub side: u8,
    pub route_profile: u8,
    pub fee_lamports: u64,
    pub weekly_league_lamports: u64,
    pub monthly_league_lamports: u64,
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
        .and_then(|v| v.checked_add(amounts.recruiter))
        .and_then(|v| v.checked_add(amounts.airdrop))
        .and_then(|v| v.checked_add(amounts.squad))
        .and_then(|v| v.checked_add(amounts.protocol))
        .ok_or(LaunchpadError::MathOverflow)?;
    require!(slices_sum == fee_lamports, LaunchpadError::InvalidFeeEscrow);

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
        recruiter_lamports: amounts.recruiter,
        airdrop_lamports: amounts.airdrop,
        squad_lamports: amounts.squad,
        protocol_lamports: amounts.protocol,
    });
    Ok(())
}

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
    use super::*;
    use crate::{ROUTE_PROFILE_LINKED, ROUTE_PROFILE_OG, ROUTE_PROFILE_UNLINKED};

    #[test]
    fn fee_escrow_account_size_is_stable() {
        assert_eq!(FeeEscrow::INIT_SPACE, 98);
        assert_eq!(8 + FeeEscrow::INIT_SPACE, 106);
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
                + amounts.recruiter
                + amounts.airdrop
                + amounts.squad
                + amounts.protocol;
            assert_eq!(sum, fee, "profile {profile}");
        }
    }
}
