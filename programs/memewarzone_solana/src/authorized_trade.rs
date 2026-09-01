//! V4 bonding buy/sell (P1).
//!
//! Buy: exact SOL in → max tokens out (binary search on linear curve).
//! Sell: exact tokens in → SOL out (reverse linear cost).
//! Tokens move vault ↔ trader ATA (mint authority already revoked at create).
//! SOL moves trader ↔ campaign sol_vault PDA.
//! Detached Ed25519 route auth mirrors create when `authorized_trading_required`.

use anchor_lang::{
    prelude::*,
    solana_program::{
        ed25519_program,
        hash::hash,
        program::invoke_signed,
        system_instruction, system_program,
        sysvar::instructions::{
            load_current_index_checked, load_instruction_at_checked, ID as INSTRUCTIONS_SYSVAR_ID,
        },
    },
};
use anchor_spl::token::{self, Transfer};

use crate::{
    authorized_create::{
        Campaign, CampaignSolVault, CAMPAIGN_SEED, SOL_VAULT_SEED, TOKEN_VAULT_SEED,
    },
    campaign_view::{
        self, assert_campaign_data, load_campaign_view, CampaignView, CAMPAIGN_BUYER_COUNT_OFFSET,
        CAMPAIGN_BUY_VOLUME_OFFSET, CAMPAIGN_CREATOR_BOUGHT_OFFSET, CAMPAIGN_CURVE_CLOSED_OFFSET,
        CAMPAIGN_CURVE_SUPPLY_OFFSET, CAMPAIGN_ID_OFFSET, CAMPAIGN_NET_RAISED_OFFSET,
        CAMPAIGN_PAUSED_OFFSET, CAMPAIGN_SELL_VOLUME_OFFSET, CAMPAIGN_SOLD_TOKENS_OFFSET,
    },
    GlobalConfig, LaunchpadError, SetCampaignPause, BPS_DENOMINATOR, CURVE_KIND_LINEAR_V1,
    ECONOMICS_VERSION_V2, ECONOMICS_VERSION_V3, GLOBAL_CONFIG_SEED, RISK_PROFILE_SEED,
    ROUTE_PROFILE_LINKED, ROUTE_PROFILE_OG, ROUTE_PROFILE_UNLINKED,
};

#[cfg(test)]
use crate::ECONOMICS_VERSION_V1;

pub const TRADE_AUTH_DOMAIN: &[u8] = b"MEMEWARZONE_SOLANA_TRADE_V1";
pub const TRADE_AUTH_SCHEMA_VERSION: u16 = 3;
pub const TRADE_AUTH_SEED: &[u8] = b"trade-auth";
pub const TRADE_SIDE_BUY: u8 = 1;
pub const TRADE_SIDE_SELL: u8 = 2;
pub const TRADE_SIDE_FINALIZE: u8 = 3;

const ED25519_HEADER_SIZE: usize = 16;
const ED25519_SIGNATURE_SIZE: usize = 64;
const ED25519_PUBLIC_KEY_SIZE: usize = 32;
const ED25519_CURRENT_INSTRUCTION: u16 = u16::MAX;
const SLOPE_NANO_LAMPORT_SCALE: u128 = 1_000_000_000;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct BuyTokensArgs {
    /// Gross SOL the trader pays (includes fee).
    pub lamports_in: u64,
    /// Minimum tokens out after fee-aware quote (slippage).
    pub min_tokens_out: u64,
    pub deadline: i64,
    pub nonce: [u8; 32],
    /// Route-signed native graduation target. 0 = sold-out close only.
    pub native_target_lamports: u64,
    /// Linked / unlinked / OG split. Bound into the trade digest.
    pub route_profile: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct SellTokensArgs {
    /// Exact tokens the trader sells.
    pub tokens_in: u64,
    /// Minimum SOL returned after fee (slippage).
    pub min_lamports_out: u64,
    pub deadline: i64,
    pub nonce: [u8; 32],
    /// Linked / unlinked / OG split. Bound into the trade digest.
    pub route_profile: u8,
}

#[account]
#[derive(InitSpace)]
pub struct TradeAuthorization {
    pub trader: Pubkey,
    pub campaign: Pubkey,
    pub side: u8,
    pub nonce: [u8; 32],
    pub deadline: i64,
    pub used_at: i64,
    pub route_signer: Pubkey,
    pub message_hash: [u8; 32],
    pub schema_version: u16,
    pub bump: u8,
}

#[event]
pub struct TokensBought {
    pub campaign: Pubkey,
    pub trader: Pubkey,
    pub lamports_in: u64,
    pub fee_lamports: u64,
    pub net_lamports: u64,
    pub tokens_out: u64,
    pub sold_tokens_after: u64,
    pub net_raised_after: u64,
}

#[event]
pub struct TokensSold {
    pub campaign: Pubkey,
    pub trader: Pubkey,
    pub tokens_in: u64,
    pub gross_lamports: u64,
    pub fee_lamports: u64,
    pub lamports_out: u64,
    pub sold_tokens_after: u64,
    pub net_raised_after: u64,
}

#[event]
pub struct FeeSlicesRouted {
    pub campaign: Pubkey,
    pub trader: Pubkey,
    pub side: u8,
    pub route_profile: u8,
    pub gross_lamports: u64,
    pub fee_lamports: u64,
    pub weekly_league_lamports: u64,
    pub monthly_league_lamports: u64,
    pub creator_lamports: u64,
    pub recruiter_lamports: u64,
    pub airdrop_lamports: u64,
    pub squad_lamports: u64,
    pub protocol_lamports: u64,
}

// ── Curve math ──────────────────────────────────────────────────────────────
//
// economics_version V1 (legacy): cost = n*base + slope*(sold*n + n*(n-1)/2)
//   base is lamports **per raw token unit** (made early buys tiny for 6-dec mints).
//
// economics_version V2 (BNB parity): LaunchCampaign-style area scaling
//   area(x) = x*base/scale + slope*x^2/(2*scale^2), scale = 10^decimals
//   base/slope are priced **per whole token** (same intent as BNB basePrice=1e9, WAD=1e18).
//   With base=1, decimals=6, 0.01 SOL buys ~10M tokens — meme bonding like BNB/competitors.

pub fn calculate_fee(amount: u64, fee_bps: u16) -> Result<u64> {
    let fee = u128::from(amount)
        .checked_mul(u128::from(fee_bps))
        .ok_or(LaunchpadError::MathOverflow)?
        .checked_div(u128::from(BPS_DENOMINATOR))
        .ok_or(LaunchpadError::MathOverflow)?;
    require!(fee <= u128::from(u64::MAX), LaunchpadError::MathOverflow);
    Ok(fee as u64)
}

fn token_scale(decimals: u8) -> Result<u128> {
    require!(decimals <= 18, LaunchpadError::InvalidGenerationEconomics);
    10u128
        .checked_pow(u32::from(decimals))
        .ok_or_else(|| error!(LaunchpadError::MathOverflow))
}

/// Legacy V1 cost (per raw unit).
pub fn checked_linear_curve_cost_v1(
    base_price_lamports: u64,
    price_slope_lamports: u64,
    start_supply: u64,
    token_amount: u64,
) -> Result<u64> {
    if token_amount == 0 {
        return Ok(0);
    }
    let token_count = u128::from(token_amount);
    let base_cost = token_count
        .checked_mul(u128::from(base_price_lamports))
        .ok_or(LaunchpadError::MathOverflow)?;
    let supply_cost = token_count
        .checked_mul(u128::from(start_supply))
        .ok_or(LaunchpadError::MathOverflow)?;
    let step_sum = token_count
        .checked_mul(
            token_count
                .checked_sub(1)
                .ok_or(LaunchpadError::MathOverflow)?,
        )
        .ok_or(LaunchpadError::MathOverflow)?
        .checked_div(2)
        .ok_or(LaunchpadError::MathOverflow)?;
    let slope_units = supply_cost
        .checked_add(step_sum)
        .ok_or(LaunchpadError::MathOverflow)?;
    let slope_cost = slope_units
        .checked_mul(u128::from(price_slope_lamports))
        .ok_or(LaunchpadError::MathOverflow)?;
    let total = base_cost
        .checked_add(slope_cost)
        .ok_or(LaunchpadError::MathOverflow)?;
    require!(total <= u128::from(u64::MAX), LaunchpadError::MathOverflow);
    Ok(total as u64)
}

/// BNB-parity V2 cost: base/slope per whole token, amounts in raw units.
pub fn checked_linear_curve_cost_v2(
    base_price_lamports: u64,
    price_slope_lamports: u64,
    start_supply: u64,
    token_amount: u64,
    token_decimals: u8,
) -> Result<u64> {
    if token_amount == 0 {
        return Ok(0);
    }
    let scale = token_scale(token_decimals)?;
    let a = u128::from(token_amount);
    let s = u128::from(start_supply);
    let base = u128::from(base_price_lamports);
    let slope = u128::from(price_slope_lamports);

    // linear = a * base / scale  (BNB: x * basePrice / WAD)
    let linear = a
        .checked_mul(base)
        .ok_or(LaunchpadError::MathOverflow)?
        .checked_div(scale)
        .ok_or(LaunchpadError::MathOverflow)?;

    // slope_term = slope * (2*s*a + a*a) / (2 * scale^2)  (BNB area difference)
    let two_sa = s
        .checked_mul(a)
        .ok_or(LaunchpadError::MathOverflow)?
        .checked_mul(2)
        .ok_or(LaunchpadError::MathOverflow)?;
    let a2 = a.checked_mul(a).ok_or(LaunchpadError::MathOverflow)?;
    let numer = two_sa.checked_add(a2).ok_or(LaunchpadError::MathOverflow)?;
    let scale2 = scale
        .checked_mul(scale)
        .ok_or(LaunchpadError::MathOverflow)?;
    let denom = scale2.checked_mul(2).ok_or(LaunchpadError::MathOverflow)?;
    let slope_term = slope
        .checked_mul(numer)
        .ok_or(LaunchpadError::MathOverflow)?
        .checked_div(denom)
        .ok_or(LaunchpadError::MathOverflow)?;

    let total = linear
        .checked_add(slope_term)
        .ok_or(LaunchpadError::MathOverflow)?;
    require!(total <= u128::from(u64::MAX), LaunchpadError::MathOverflow);
    Ok(total as u64)
}

/// BNB-parity V3 cost. base stays lamports/whole-token; slope is stored as
/// nano-lamports/whole-token² so the BNB-equivalent 850 wei slope is representable.
pub fn checked_linear_curve_cost_v3(
    base_price_lamports: u64,
    price_slope_nano_lamports: u64,
    start_supply: u64,
    token_amount: u64,
    token_decimals: u8,
) -> Result<u64> {
    if token_amount == 0 {
        return Ok(0);
    }
    let scale = token_scale(token_decimals)?;
    let a = u128::from(token_amount);
    let s = u128::from(start_supply);
    let base = u128::from(base_price_lamports);
    let slope = u128::from(price_slope_nano_lamports);

    let linear = a
        .checked_mul(base)
        .ok_or(LaunchpadError::MathOverflow)?
        .checked_div(scale)
        .ok_or(LaunchpadError::MathOverflow)?;

    let two_sa = s
        .checked_mul(a)
        .ok_or(LaunchpadError::MathOverflow)?
        .checked_mul(2)
        .ok_or(LaunchpadError::MathOverflow)?;
    let a2 = a.checked_mul(a).ok_or(LaunchpadError::MathOverflow)?;
    let numer = two_sa.checked_add(a2).ok_or(LaunchpadError::MathOverflow)?;
    let scale2 = scale
        .checked_mul(scale)
        .ok_or(LaunchpadError::MathOverflow)?;
    let denom = scale2
        .checked_mul(2)
        .ok_or(LaunchpadError::MathOverflow)?
        .checked_mul(SLOPE_NANO_LAMPORT_SCALE)
        .ok_or(LaunchpadError::MathOverflow)?;
    let slope_term = slope
        .checked_mul(numer)
        .ok_or(LaunchpadError::MathOverflow)?
        .checked_div(denom)
        .ok_or(LaunchpadError::MathOverflow)?;

    let total = linear
        .checked_add(slope_term)
        .ok_or(LaunchpadError::MathOverflow)?;
    require!(total <= u128::from(u64::MAX), LaunchpadError::MathOverflow);
    Ok(total as u64)
}

pub fn checked_linear_curve_cost(
    economics_version: u16,
    base_price_lamports: u64,
    price_slope_lamports: u64,
    start_supply: u64,
    token_amount: u64,
    token_decimals: u8,
) -> Result<u64> {
    if economics_version >= ECONOMICS_VERSION_V3 {
        checked_linear_curve_cost_v3(
            base_price_lamports,
            price_slope_lamports,
            start_supply,
            token_amount,
            token_decimals,
        )
    } else if economics_version >= ECONOMICS_VERSION_V2 {
        checked_linear_curve_cost_v2(
            base_price_lamports,
            price_slope_lamports,
            start_supply,
            token_amount,
            token_decimals,
        )
    } else {
        checked_linear_curve_cost_v1(
            base_price_lamports,
            price_slope_lamports,
            start_supply,
            token_amount,
        )
    }
}

/// Max tokens purchasable with `net_lamports` (exact SOL-in quote).
pub fn quote_buy_tokens(
    economics_version: u16,
    base_price_lamports: u64,
    price_slope_lamports: u64,
    sold_tokens: u64,
    curve_token_supply: u64,
    net_lamports: u64,
    token_decimals: u8,
) -> Result<u64> {
    require!(net_lamports > 0, LaunchpadError::InvalidTradeAmount);
    require!(base_price_lamports > 0, LaunchpadError::InvalidTradeAmount);
    require!(
        sold_tokens < curve_token_supply,
        LaunchpadError::CurveSupplyExhausted
    );

    let remaining = curve_token_supply
        .checked_sub(sold_tokens)
        .ok_or(LaunchpadError::MathOverflow)?;

    // Upper bound for binary search.
    let max_by_base = if economics_version >= ECONOMICS_VERSION_V2 {
        let scale = token_scale(token_decimals)?;
        // n * base / scale <= net  →  n <= net * scale / base
        let n = u128::from(net_lamports)
            .checked_mul(scale)
            .ok_or(LaunchpadError::MathOverflow)?
            .checked_div(u128::from(base_price_lamports))
            .ok_or(LaunchpadError::MathOverflow)?;
        u64::try_from(n.min(u128::from(u64::MAX))).unwrap_or(u64::MAX)
    } else {
        net_lamports
            .checked_div(base_price_lamports)
            .ok_or(LaunchpadError::MathOverflow)?
    };
    require!(max_by_base > 0, LaunchpadError::InvalidTradeAmount);
    let mut high = max_by_base.min(remaining);
    let mut low = 0u64;

    while low < high {
        let mid = low
            .checked_add(
                high.checked_sub(low)
                    .ok_or(LaunchpadError::MathOverflow)?
                    .checked_add(1)
                    .ok_or(LaunchpadError::MathOverflow)?
                    .checked_div(2)
                    .ok_or(LaunchpadError::MathOverflow)?,
            )
            .ok_or(LaunchpadError::MathOverflow)?;
        match checked_linear_curve_cost(
            economics_version,
            base_price_lamports,
            price_slope_lamports,
            sold_tokens,
            mid,
            token_decimals,
        ) {
            Ok(cost) if cost <= net_lamports => low = mid,
            _ => {
                high = mid.checked_sub(1).ok_or(LaunchpadError::MathOverflow)?;
            }
        }
    }
    require!(low > 0, LaunchpadError::InvalidTradeAmount);
    Ok(low)
}

/// V3 exact-SOL-in quote with BNB fee semantics: find the most tokens whose
/// curve cost + fee(curve cost) fits inside the authorized gross input.
pub fn quote_buy_tokens_v3_gross(
    base_price_lamports: u64,
    price_slope_nano_lamports: u64,
    sold_tokens: u64,
    curve_token_supply: u64,
    gross_lamports: u64,
    fee_bps: u16,
    token_decimals: u8,
) -> Result<(u64, u64, u64, u64)> {
    require!(gross_lamports > 0, LaunchpadError::InvalidTradeAmount);
    require!(base_price_lamports > 0, LaunchpadError::InvalidTradeAmount);
    require!(
        sold_tokens < curve_token_supply,
        LaunchpadError::CurveSupplyExhausted
    );

    let scale = token_scale(token_decimals)?;
    let remaining = curve_token_supply
        .checked_sub(sold_tokens)
        .ok_or(LaunchpadError::MathOverflow)?;
    let max_by_base = u128::from(gross_lamports)
        .checked_mul(scale)
        .ok_or(LaunchpadError::MathOverflow)?
        .checked_div(u128::from(base_price_lamports))
        .ok_or(LaunchpadError::MathOverflow)?;
    let mut high = u64::try_from(max_by_base.min(u128::from(u64::MAX)))
        .unwrap_or(u64::MAX)
        .min(remaining);
    let mut low = 0u64;

    while low < high {
        let mid = low
            .checked_add(
                high.checked_sub(low)
                    .ok_or(LaunchpadError::MathOverflow)?
                    .checked_add(1)
                    .ok_or(LaunchpadError::MathOverflow)?
                    .checked_div(2)
                    .ok_or(LaunchpadError::MathOverflow)?,
            )
            .ok_or(LaunchpadError::MathOverflow)?;
        let fits = match checked_linear_curve_cost_v3(
            base_price_lamports,
            price_slope_nano_lamports,
            sold_tokens,
            mid,
            token_decimals,
        ) {
            Ok(curve_cost) => match calculate_fee(curve_cost, fee_bps) {
                Ok(fee) => curve_cost
                    .checked_add(fee)
                    .map(|total| total <= gross_lamports)
                    .unwrap_or(false),
                Err(_) => false,
            },
            Err(_) => false,
        };
        if fits {
            low = mid;
        } else {
            high = mid.checked_sub(1).ok_or(LaunchpadError::MathOverflow)?;
        }
    }

    require!(low > 0, LaunchpadError::InvalidTradeAmount);
    let curve_cost = checked_linear_curve_cost_v3(
        base_price_lamports,
        price_slope_nano_lamports,
        sold_tokens,
        low,
        token_decimals,
    )?;
    let fee = calculate_fee(curve_cost, fee_bps)?;
    let total_spent = curve_cost
        .checked_add(fee)
        .ok_or(LaunchpadError::MathOverflow)?;
    require!(total_spent <= gross_lamports, LaunchpadError::MathOverflow);
    Ok((low, curve_cost, fee, total_spent))
}

/// Gross SOL refund for selling `token_amount` (exact tokens-in quote, pre-fee).
pub fn quote_sell_refund(
    economics_version: u16,
    base_price_lamports: u64,
    price_slope_lamports: u64,
    sold_tokens: u64,
    token_amount: u64,
    token_decimals: u8,
) -> Result<u64> {
    require!(token_amount > 0, LaunchpadError::InvalidTradeAmount);
    require!(
        sold_tokens >= token_amount,
        LaunchpadError::InsufficientSoldTokens
    );
    let post_sell = sold_tokens
        .checked_sub(token_amount)
        .ok_or(LaunchpadError::MathOverflow)?;
    checked_linear_curve_cost(
        economics_version,
        base_price_lamports,
        price_slope_lamports,
        post_sell,
        token_amount,
        token_decimals,
    )
}

// ── Accounts ────────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(args: BuyTokensArgs)]
pub struct BuyTokens<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    /// CHECK: typed load happens in an isolated stack frame.
    #[account(seeds = [GLOBAL_CONFIG_SEED], bump)]
    pub global_config: UncheckedAccount<'info>,
    /// CHECK: campaign PDA; loaded and validated in handler.
    #[account(mut)]
    pub campaign: UncheckedAccount<'info>,
    /// CHECK: mint; validated against campaign.mint.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: token vault PDA holding curve tokens.
    #[account(mut)]
    pub token_vault: UncheckedAccount<'info>,
    /// CHECK: sol vault PDA.
    #[account(mut)]
    pub sol_vault: UncheckedAccount<'info>,
    /// CHECK: trader ATA for mint.
    #[account(mut)]
    pub trader_token_account: UncheckedAccount<'info>,
    /// CHECK: optional risk profile for trader. Missing means unrestricted/no cluster, matching BNB RiskRegistry.
    #[account(seeds = [RISK_PROFILE_SEED, trader.key().as_ref()], bump)]
    pub risk_profile: UncheckedAccount<'info>,
    /// CHECK: cluster PDA for risk.cluster_id. Empty-cluster PDA may be missing.
    pub cluster_profile: UncheckedAccount<'info>,
    /// CHECK: trade-auth PDA (created when trading requires route auth).
    #[account(
        mut,
        seeds = [TRADE_AUTH_SEED, trader.key().as_ref(), args.nonce.as_ref()],
        bump
    )]
    pub trade_authorization: UncheckedAccount<'info>,
    /// CHECK: Instructions sysvar for Ed25519 verify.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
    /// CHECK: SPL Token program.
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: System program.
    pub system_program: UncheckedAccount<'info>,
    /// CHECK: PDA + owner + campaign match in an isolated frame.
    #[account(
        mut,
        seeds = [crate::FEE_ESCROW_SEED, campaign.key().as_ref()],
        bump
    )]
    pub fee_escrow: UncheckedAccount<'info>,
    /// CHECK: campaign-bound creator custody PDA required by the fee freeze.
    #[account(
        mut,
        seeds = [crate::fee_escrow::CREATOR_FEE_VAULT_SEED, campaign.key().as_ref()],
        bump
    )]
    pub creator_fee_vault: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(args: SellTokensArgs)]
pub struct SellTokens<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    /// CHECK: typed load happens in an isolated stack frame.
    #[account(seeds = [GLOBAL_CONFIG_SEED], bump)]
    pub global_config: UncheckedAccount<'info>,
    /// CHECK: campaign PDA.
    #[account(mut)]
    pub campaign: UncheckedAccount<'info>,
    /// CHECK: mint.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: token vault.
    #[account(mut)]
    pub token_vault: UncheckedAccount<'info>,
    /// CHECK: sol vault.
    #[account(mut)]
    pub sol_vault: UncheckedAccount<'info>,
    /// CHECK: trader ATA.
    #[account(mut)]
    pub trader_token_account: UncheckedAccount<'info>,
    /// CHECK: optional risk profile. Missing means unrestricted/no cluster, matching BNB RiskRegistry.
    #[account(seeds = [RISK_PROFILE_SEED, trader.key().as_ref()], bump)]
    pub risk_profile: UncheckedAccount<'info>,
    /// CHECK: cluster PDA for risk.cluster_id. Empty-cluster PDA may be missing.
    pub cluster_profile: UncheckedAccount<'info>,
    /// CHECK: trade-auth PDA.
    #[account(
        mut,
        seeds = [TRADE_AUTH_SEED, trader.key().as_ref(), args.nonce.as_ref()],
        bump
    )]
    pub trade_authorization: UncheckedAccount<'info>,
    /// CHECK: Instructions sysvar.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
    /// CHECK: Token program.
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: System program.
    pub system_program: UncheckedAccount<'info>,
    /// CHECK: PDA + owner + campaign match in an isolated frame.
    #[account(
        mut,
        seeds = [crate::FEE_ESCROW_SEED, campaign.key().as_ref()],
        bump
    )]
    pub fee_escrow: UncheckedAccount<'info>,
    /// CHECK: campaign-bound creator custody PDA required by the fee freeze.
    #[account(
        mut,
        seeds = [crate::fee_escrow::CREATOR_FEE_VAULT_SEED, campaign.key().as_ref()],
        bump
    )]
    pub creator_fee_vault: UncheckedAccount<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct CloseExpiredTradeAuthorizationArgs {
    pub nonce: [u8; 32],
}

#[derive(Accounts)]
#[instruction(args: CloseExpiredTradeAuthorizationArgs)]
pub struct CloseExpiredTradeAuthorization<'info> {
    /// Anyone may pay the cleanup fee. Rent is always refunded to `trader`.
    #[account(mut)]
    pub caller: Signer<'info>,
    /// CHECK: refund destination; must match the stored authorization trader.
    #[account(mut)]
    pub trader: UncheckedAccount<'info>,
    /// CHECK: program-owned trade-auth PDA; closed only after deadline.
    #[account(
        mut,
        seeds = [TRADE_AUTH_SEED, trader.key().as_ref(), args.nonce.as_ref()],
        bump
    )]
    pub trade_authorization: UncheckedAccount<'info>,
}

// ── Handlers ────────────────────────────────────────────────────────────────

struct PreparedBuy {
    campaign_id: [u8; 32],
    campaign_bump: u8,
    fee: u64,
    net: u64,
    lamports_spent: u64,
    tokens_out: u64,
    buy_volume_increment: u64,
    was_zero_sold: bool,
    creator_bought_update: Option<u64>,
}

struct PreparedSell {
    fee: u64,
    gross: u64,
    lamports_out: u64,
}

pub fn buy_tokens_handler(ctx: Context<BuyTokens>, args: BuyTokensArgs) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(args.lamports_in > 0, LaunchpadError::InvalidTradeAmount);
    require!(
        args.deadline >= now,
        LaunchpadError::TradeAuthorizationExpired
    );
    require_keys_eq!(
        *ctx.accounts.token_program.key,
        token::ID,
        LaunchpadError::InvalidCampaign
    );

    let trader = ctx.accounts.trader.key();
    let campaign_key = ctx.accounts.campaign.key();
    let mint_key = ctx.accounts.mint.key();
    let token_vault_key = ctx.accounts.token_vault.key();
    let sol_vault_key = ctx.accounts.sol_vault.key();
    let trade_auth_bump = ctx.bumps.trade_authorization;
    let (route_signer, auth_required) =
        read_trade_global(&ctx.accounts.global_config.to_account_info(), true)?;

    let prepared = prepare_buy(
        &ctx.accounts.campaign.to_account_info(),
        &ctx.accounts.instructions.to_account_info(),
        trader,
        campaign_key,
        mint_key,
        token_vault_key,
        sol_vault_key,
        now,
        route_signer,
        auth_required,
        &args,
    )?;
    let campaign_id = prepared.campaign_id;
    let campaign_bump = prepared.campaign_bump;
    let fee = prepared.fee;
    let net = prepared.net;
    let lamports_spent = prepared.lamports_spent;
    let tokens_out = prepared.tokens_out;
    let buy_volume_increment = prepared.buy_volume_increment;
    let was_zero_sold = prepared.was_zero_sold;
    let creator_bought_update = prepared.creator_bought_update;

    if auth_required {
        let digest = build_trade_authorization_digest(
            crate::id(),
            campaign_key,
            mint_key,
            trader,
            TRADE_SIDE_BUY,
            args.lamports_in,
            args.min_tokens_out,
            args.deadline,
            &args.nonce,
            args.native_target_lamports,
            args.route_profile,
        );
        create_trade_auth_account(
            &ctx.accounts.trader.to_account_info(),
            &ctx.accounts.trade_authorization.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            trader,
            campaign_key,
            TRADE_SIDE_BUY,
            &args.nonce,
            args.deadline,
            now,
            route_signer,
            digest,
            trade_auth_bump,
        )?;
    }

    crate::fee_escrow::require_fee_escrow(
        &ctx.accounts.fee_escrow.to_account_info(),
        campaign_key,
        ctx.bumps.fee_escrow,
    )?;
    crate::fee_escrow::require_creator_fee_vault(
        &ctx.accounts.creator_fee_vault.to_account_info(),
        campaign_key,
    )?;
    crate::fee_escrow::transfer_buy_net_and_fee(
        &ctx.accounts.trader.to_account_info(),
        &ctx.accounts.sol_vault.to_account_info(),
        &ctx.accounts.fee_escrow.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        net,
        fee,
        lamports_spent,
    )?;
    crate::fee_escrow::accrue_fee_escrow(
        &ctx.accounts.fee_escrow.to_account_info(),
        &ctx.accounts.creator_fee_vault.to_account_info(),
        campaign_key,
        trader,
        TRADE_SIDE_BUY,
        fee,
        args.route_profile,
    )?;

    let bump_seed = [campaign_bump];
    let seeds: &[&[u8]] = &[CAMPAIGN_SEED, campaign_id.as_ref(), &bump_seed];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.token_vault.to_account_info(),
                to: ctx.accounts.trader_token_account.to_account_info(),
                authority: ctx.accounts.campaign.to_account_info(),
            },
            &[seeds],
        ),
        tokens_out,
    )?;

    let (sold_after, net_after) = apply_buy_state(
        &ctx.accounts.campaign.to_account_info(),
        tokens_out,
        net,
        buy_volume_increment,
        was_zero_sold,
        creator_bought_update,
        args.native_target_lamports,
    )?;

    emit!(TokensBought {
        campaign: campaign_key,
        trader,
        lamports_in: lamports_spent,
        fee_lamports: fee,
        net_lamports: net,
        tokens_out,
        sold_tokens_after: sold_after,
        net_raised_after: net_after,
    });
    Ok(())
}

pub fn sell_tokens_handler(ctx: Context<SellTokens>, args: SellTokensArgs) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(args.tokens_in > 0, LaunchpadError::InvalidTradeAmount);
    require!(
        args.deadline >= now,
        LaunchpadError::TradeAuthorizationExpired
    );
    require_keys_eq!(
        *ctx.accounts.token_program.key,
        token::ID,
        LaunchpadError::InvalidCampaign
    );

    let trader = ctx.accounts.trader.key();
    let campaign_key = ctx.accounts.campaign.key();
    let mint_key = ctx.accounts.mint.key();
    let token_vault_key = ctx.accounts.token_vault.key();
    let sol_vault_key = ctx.accounts.sol_vault.key();
    let trade_auth_bump = ctx.bumps.trade_authorization;
    let (route_signer, auth_required) =
        read_trade_global(&ctx.accounts.global_config.to_account_info(), false)?;

    let prepared = prepare_sell(
        &ctx.accounts.campaign.to_account_info(),
        &ctx.accounts.instructions.to_account_info(),
        trader,
        campaign_key,
        mint_key,
        token_vault_key,
        sol_vault_key,
        now,
        route_signer,
        auth_required,
        &args,
    )?;
    let fee = prepared.fee;
    let gross = prepared.gross;
    let lamports_out = prepared.lamports_out;

    if auth_required {
        let digest = build_trade_authorization_digest(
            crate::id(),
            campaign_key,
            mint_key,
            trader,
            TRADE_SIDE_SELL,
            args.tokens_in,
            args.min_lamports_out,
            args.deadline,
            &args.nonce,
            0,
            args.route_profile,
        );
        create_trade_auth_account(
            &ctx.accounts.trader.to_account_info(),
            &ctx.accounts.trade_authorization.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            trader,
            campaign_key,
            TRADE_SIDE_SELL,
            &args.nonce,
            args.deadline,
            now,
            route_signer,
            digest,
            trade_auth_bump,
        )?;
    }

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.trader_token_account.to_account_info(),
                to: ctx.accounts.token_vault.to_account_info(),
                authority: ctx.accounts.trader.to_account_info(),
            },
        ),
        args.tokens_in,
    )?;

    crate::fee_escrow::require_fee_escrow(
        &ctx.accounts.fee_escrow.to_account_info(),
        campaign_key,
        ctx.bumps.fee_escrow,
    )?;
    crate::fee_escrow::require_creator_fee_vault(
        &ctx.accounts.creator_fee_vault.to_account_info(),
        campaign_key,
    )?;
    crate::fee_escrow::credit_sell_net_and_fee(
        &ctx.accounts.sol_vault.to_account_info(),
        &ctx.accounts.trader.to_account_info(),
        &ctx.accounts.fee_escrow.to_account_info(),
        lamports_out,
        fee,
        gross,
    )?;
    crate::fee_escrow::accrue_fee_escrow(
        &ctx.accounts.fee_escrow.to_account_info(),
        &ctx.accounts.creator_fee_vault.to_account_info(),
        campaign_key,
        trader,
        TRADE_SIDE_SELL,
        fee,
        args.route_profile,
    )?;

    let (sold_after, net_after) = apply_sell_state(
        &ctx.accounts.campaign.to_account_info(),
        args.tokens_in,
        gross,
    )?;

    emit!(TokensSold {
        campaign: campaign_key,
        trader,
        tokens_in: args.tokens_in,
        gross_lamports: gross,
        fee_lamports: fee,
        lamports_out,
        sold_tokens_after: sold_after,
        net_raised_after: net_after,
    });
    Ok(())
}

// ── Helpers ─────────────────────────────────────────────────────────────────

#[inline(never)]
fn read_trade_global(info: &AccountInfo, is_buy: bool) -> Result<(Pubkey, bool)> {
    require_keys_eq!(*info.owner, crate::ID, LaunchpadError::Unauthorized);
    let data = info.try_borrow_data()?;
    let mut slice: &[u8] = &data;
    let global = Box::new(GlobalConfig::try_deserialize(&mut slice)?);
    require!(!global.paused, LaunchpadError::LaunchpadPaused);
    // Backend policy is authoritative only because every executable trade must
    // still carry the locked MemeWarzone route authorization on-chain.
    require!(
        global.security_defaults_locked,
        LaunchpadError::InvalidTradeAuthorization
    );
    require!(
        global.authorized_trading_required,
        LaunchpadError::InvalidTradeAuthorization
    );
    if is_buy {
        require!(!global.buy_paused, LaunchpadError::BuysPaused);
    } else {
        require!(!global.sell_paused, LaunchpadError::SellsPaused);
    }
    Ok((global.route_signer, global.authorized_trading_required))
}

type TradeCampaignSnapshot = CampaignView;

#[inline(never)]
fn load_trade_campaign_snapshot(info: &AccountInfo) -> Result<TradeCampaignSnapshot> {
    load_campaign_view(info)
}

#[inline(never)]
fn validate_trade_snapshot_accounts(
    campaign: &TradeCampaignSnapshot,
    campaign_key: Pubkey,
    mint_key: Pubkey,
    token_vault_key: Pubkey,
    sol_vault_key: Pubkey,
) -> Result<()> {
    require_keys_eq!(campaign.mint, mint_key, LaunchpadError::InvalidCampaign);
    require_keys_eq!(
        campaign.token_vault,
        token_vault_key,
        LaunchpadError::InvalidCampaign
    );
    require_keys_eq!(
        campaign.sol_vault,
        sol_vault_key,
        LaunchpadError::InvalidCampaign
    );
    let (expected_campaign, _) =
        Pubkey::find_program_address(&[CAMPAIGN_SEED, campaign.campaign_id.as_ref()], &crate::ID);
    require_keys_eq!(
        campaign_key,
        expected_campaign,
        LaunchpadError::InvalidCampaign
    );
    let (expected_vault, _) = Pubkey::find_program_address(
        &[TOKEN_VAULT_SEED, campaign.campaign_id.as_ref()],
        &crate::ID,
    );
    require_keys_eq!(
        token_vault_key,
        expected_vault,
        LaunchpadError::InvalidCampaign
    );
    let (expected_sol, _) =
        Pubkey::find_program_address(&[SOL_VAULT_SEED, campaign.campaign_id.as_ref()], &crate::ID);
    require_keys_eq!(sol_vault_key, expected_sol, LaunchpadError::InvalidCampaign);
    Ok(())
}

#[inline(never)]
fn prepare_buy(
    campaign_info: &AccountInfo,
    instructions: &AccountInfo,
    trader: Pubkey,
    campaign_key: Pubkey,
    mint_key: Pubkey,
    token_vault_key: Pubkey,
    sol_vault_key: Pubkey,
    now: i64,
    route_signer: Pubkey,
    auth_required: bool,
    args: &BuyTokensArgs,
) -> Result<PreparedBuy> {
    let campaign = load_trade_campaign_snapshot(campaign_info)?;
    validate_trade_snapshot_accounts(
        &campaign,
        campaign_key,
        mint_key,
        token_vault_key,
        sol_vault_key,
    )?;
    require!(!campaign.graduated, LaunchpadError::AlreadyGraduated);
    require!(!campaign.curve_closed, LaunchpadError::CurveClosed);
    require!(!campaign.paused, LaunchpadError::CampaignPaused);
    require!(now >= campaign.launch_at, LaunchpadError::TradingNotOpen);
    require!(
        campaign.curve_kind == CURVE_KIND_LINEAR_V1,
        LaunchpadError::InvalidCampaign
    );
    validate_route_profile_id(args.route_profile)?;

    let economics_version = campaign.economics_version;
    let base_price = campaign.base_price_lamports;
    let slope = campaign.price_slope_lamports;
    let sold = campaign.sold_tokens;
    let supply = campaign.curve_token_supply;
    let buy_fee_bps = campaign.buy_fee_bps;
    let decimals = campaign.token_decimals;
    let creator = campaign.creator;
    let lock_until = campaign.creator_buy_lock_until;
    let cap_bps = campaign.creator_buy_cap_bps;
    let creator_bought = campaign.creator_bought_tokens;
    let campaign_id = campaign.campaign_id;
    let campaign_bump = campaign.bump;
    let campaign_mint = campaign.mint;
    drop(campaign);

    if auth_required {
        verify_buy_authorization(
            instructions,
            route_signer,
            campaign_key,
            campaign_mint,
            trader,
            args,
        )?;
    }

    let (tokens_out, net, fee, lamports_spent) = quote_buy_prepared(
        economics_version,
        base_price,
        slope,
        sold,
        supply,
        args.lamports_in,
        buy_fee_bps,
        decimals,
    )?;
    require!(
        tokens_out >= args.min_tokens_out,
        LaunchpadError::SlippageExceeded
    );

    let mut creator_bought_update = None;
    if trader == creator {
        require!(now >= lock_until, LaunchpadError::CreatorBuyLocked);
        if cap_bps > 0 {
            let cap_tokens = u128::from(supply)
                .checked_mul(u128::from(cap_bps))
                .ok_or(LaunchpadError::MathOverflow)?
                .checked_div(u128::from(BPS_DENOMINATOR))
                .ok_or(LaunchpadError::MathOverflow)?;
            let next = u128::from(creator_bought)
                .checked_add(u128::from(tokens_out))
                .ok_or(LaunchpadError::MathOverflow)?;
            require!(next <= cap_tokens, LaunchpadError::CreatorBuyCap);
            creator_bought_update = Some(next as u64);
        }
    }

    Ok(PreparedBuy {
        campaign_id,
        campaign_bump,
        fee,
        net,
        lamports_spent,
        tokens_out,
        buy_volume_increment: if economics_version >= ECONOMICS_VERSION_V3 {
            net
        } else {
            lamports_spent
        },
        was_zero_sold: sold == 0,
        creator_bought_update,
    })
}

#[inline(never)]
fn prepare_sell(
    campaign_info: &AccountInfo,
    instructions: &AccountInfo,
    trader: Pubkey,
    campaign_key: Pubkey,
    mint_key: Pubkey,
    token_vault_key: Pubkey,
    sol_vault_key: Pubkey,
    now: i64,
    route_signer: Pubkey,
    auth_required: bool,
    args: &SellTokensArgs,
) -> Result<PreparedSell> {
    let campaign = load_trade_campaign_snapshot(campaign_info)?;
    validate_trade_snapshot_accounts(
        &campaign,
        campaign_key,
        mint_key,
        token_vault_key,
        sol_vault_key,
    )?;
    require!(!campaign.graduated, LaunchpadError::AlreadyGraduated);
    require!(!campaign.curve_closed, LaunchpadError::CurveClosed);
    require!(!campaign.paused, LaunchpadError::CampaignPaused);
    require!(now >= campaign.launch_at, LaunchpadError::TradingNotOpen);
    require!(
        campaign.curve_kind == CURVE_KIND_LINEAR_V1,
        LaunchpadError::InvalidCampaign
    );
    validate_route_profile_id(args.route_profile)?;

    let economics_version = campaign.economics_version;
    let base_price = campaign.base_price_lamports;
    let slope = campaign.price_slope_lamports;
    let sold = campaign.sold_tokens;
    let decimals = campaign.token_decimals;
    let sell_fee_bps = campaign.sell_fee_bps;
    let net_raised = campaign.net_raised_lamports;
    let campaign_mint = campaign.mint;
    drop(campaign);

    if auth_required {
        verify_sell_authorization(
            instructions,
            route_signer,
            campaign_key,
            campaign_mint,
            trader,
            args,
        )?;
    }

    let gross = quote_sell_refund(
        economics_version,
        base_price,
        slope,
        sold,
        args.tokens_in,
        decimals,
    )?;
    let fee = calculate_fee(gross, sell_fee_bps)?;
    let lamports_out = gross.checked_sub(fee).ok_or(LaunchpadError::MathOverflow)?;
    require!(
        lamports_out >= args.min_lamports_out,
        LaunchpadError::SlippageExceeded
    );
    require!(
        net_raised >= gross,
        LaunchpadError::InsufficientVaultBalance
    );
    Ok(PreparedSell {
        fee,
        gross,
        lamports_out,
    })
}

#[inline(never)]
fn apply_buy_state(
    campaign_info: &AccountInfo,
    tokens_out: u64,
    net: u64,
    buy_volume_increment: u64,
    was_zero_sold: bool,
    creator_bought_update: Option<u64>,
    native_target_lamports: u64,
) -> Result<(u64, u64)> {
    require_keys_eq!(
        *campaign_info.owner,
        crate::ID,
        LaunchpadError::InvalidCampaign
    );
    let mut data = campaign_info.try_borrow_mut_data()?;
    assert_campaign_data(&data)?;
    let sold_after = campaign_view::read_u64(&data, CAMPAIGN_SOLD_TOKENS_OFFSET)?
        .checked_add(tokens_out)
        .ok_or(LaunchpadError::MathOverflow)?;
    let net_after = campaign_view::read_u64(&data, CAMPAIGN_NET_RAISED_OFFSET)?
        .checked_add(net)
        .ok_or(LaunchpadError::MathOverflow)?;
    let buy_volume = campaign_view::read_u64(&data, CAMPAIGN_BUY_VOLUME_OFFSET)?
        .checked_add(buy_volume_increment)
        .ok_or(LaunchpadError::MathOverflow)?;
    campaign_view::write_u64(&mut data, CAMPAIGN_SOLD_TOKENS_OFFSET, sold_after)?;
    campaign_view::write_u64(&mut data, CAMPAIGN_NET_RAISED_OFFSET, net_after)?;
    campaign_view::write_u64(&mut data, CAMPAIGN_BUY_VOLUME_OFFSET, buy_volume)?;
    if was_zero_sold {
        let buyers = campaign_view::read_u64(&data, CAMPAIGN_BUYER_COUNT_OFFSET)?
            .checked_add(1)
            .ok_or(LaunchpadError::MathOverflow)?;
        campaign_view::write_u64(&mut data, CAMPAIGN_BUYER_COUNT_OFFSET, buyers)?;
    }
    if let Some(value) = creator_bought_update {
        campaign_view::write_u64(&mut data, CAMPAIGN_CREATOR_BOUGHT_OFFSET, value)?;
    }
    let curve_supply = campaign_view::read_u64(&data, CAMPAIGN_CURVE_SUPPLY_OFFSET)?;
    if should_close_curve(sold_after, curve_supply, net_after, native_target_lamports) {
        campaign_view::write_u8(&mut data, CAMPAIGN_CURVE_CLOSED_OFFSET, 1)?;
    }
    Ok((sold_after, net_after))
}

#[inline(never)]
fn apply_sell_state(campaign_info: &AccountInfo, tokens_in: u64, gross: u64) -> Result<(u64, u64)> {
    require_keys_eq!(
        *campaign_info.owner,
        crate::ID,
        LaunchpadError::InvalidCampaign
    );
    let mut data = campaign_info.try_borrow_mut_data()?;
    assert_campaign_data(&data)?;
    let sold_after = campaign_view::read_u64(&data, CAMPAIGN_SOLD_TOKENS_OFFSET)?
        .checked_sub(tokens_in)
        .ok_or(LaunchpadError::MathOverflow)?;
    let net_after = campaign_view::read_u64(&data, CAMPAIGN_NET_RAISED_OFFSET)?
        .checked_sub(gross)
        .ok_or(LaunchpadError::MathOverflow)?;
    let sell_volume = campaign_view::read_u64(&data, CAMPAIGN_SELL_VOLUME_OFFSET)?
        .checked_add(gross)
        .ok_or(LaunchpadError::MathOverflow)?;
    campaign_view::write_u64(&mut data, CAMPAIGN_SOLD_TOKENS_OFFSET, sold_after)?;
    campaign_view::write_u64(&mut data, CAMPAIGN_NET_RAISED_OFFSET, net_after)?;
    campaign_view::write_u64(&mut data, CAMPAIGN_SELL_VOLUME_OFFSET, sell_volume)?;
    Ok((sold_after, net_after))
}

#[inline(never)]
pub(crate) fn route_fee_slices(
    remaining: &[AccountInfo],
    sol_vault: &AccountInfo,
    campaign: Pubkey,
    trader: Pubkey,
    side: u8,
    gross_lamports: u64,
    route_profile: u8,
) -> Result<()> {
    if side == TRADE_SIDE_FINALIZE {
        require!(remaining.len() >= 6, LaunchpadError::InvalidRewardsVault);
    } else {
        require!(remaining.len() >= 7, LaunchpadError::InvalidRewardsVault);
    }
    validate_route_profile_id(route_profile)?;
    let kind = if side == TRADE_SIDE_FINALIZE {
        crate::ROUTE_KIND_FINALIZE
    } else {
        crate::ROUTE_KIND_TRADE
    };
    // Trades pass the taxable curve amount and take 200 bps here.
    // Finalize already computed the protocol fee and must split that exact amount.
    let fee_lamports = if side == TRADE_SIDE_FINALIZE {
        gross_lamports
    } else {
        calculate_fee(gross_lamports, crate::LOCKED_BUY_FEE_BPS)?
    };
    let amounts = preview_bnb_route(kind, route_profile, fee_lamports)?;
    let creator_fee_vault = if side == TRADE_SIDE_FINALIZE {
        None
    } else {
        crate::fee_escrow::require_creator_fee_vault(&remaining[6], campaign)?;
        require!(
            remaining[6].is_writable,
            LaunchpadError::InvalidRewardsVault
        );
        Some(&remaining[6])
    };
    if fee_lamports == 0 {
        validate_reward_vaults(remaining)?;
        return Ok(());
    }
    let expected = expected_reward_vaults();
    let slices = [
        amounts.weekly_league,
        amounts.airdrop,
        amounts.monthly_league,
        amounts.recruiter,
        amounts.squad,
        amounts.protocol,
    ];
    let mut need = amounts.creator;
    for i in 0..6 {
        require_keys_eq!(
            *remaining[i].key,
            expected[i],
            LaunchpadError::InvalidRewardsVault
        );
        require!(
            remaining[i].is_writable,
            LaunchpadError::InvalidRewardsVault
        );
        require!(
            remaining[i].lamports() > 0,
            LaunchpadError::InvalidRewardsVault
        );
        need = need
            .checked_add(slices[i])
            .ok_or(LaunchpadError::MathOverflow)?;
    }
    if need == 0 {
        return Ok(());
    }
    {
        let mut vault_lamports = sol_vault.try_borrow_mut_lamports()?;
        **vault_lamports = vault_lamports
            .checked_sub(need)
            .ok_or(LaunchpadError::MathOverflow)?;
    }
    for i in 0..6 {
        if slices[i] == 0 {
            continue;
        }
        let mut dest = remaining[i].try_borrow_mut_lamports()?;
        **dest = dest
            .checked_add(slices[i])
            .ok_or(LaunchpadError::MathOverflow)?;
    }
    if let Some(info) = creator_fee_vault {
        let mut dest = info.try_borrow_mut_lamports()?;
        **dest = dest
            .checked_add(amounts.creator)
            .ok_or(LaunchpadError::MathOverflow)?;
    }

    emit!(FeeSlicesRouted {
        campaign,
        trader,
        side,
        route_profile,
        gross_lamports,
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

pub(crate) struct BnbRouteAmounts {
    pub(crate) weekly_league: u64,
    pub(crate) monthly_league: u64,
    pub(crate) creator: u64,
    pub(crate) recruiter: u64,
    pub(crate) airdrop: u64,
    pub(crate) squad: u64,
    pub(crate) protocol: u64,
}

pub(crate) fn preview_bnb_route(kind: u8, profile: u8, fee_amount: u64) -> Result<BnbRouteAmounts> {
    let (league_bps, creator_bps, recruiter_bps, airdrop_bps, squad_bps) =
        if kind == crate::ROUTE_KIND_TRADE {
            match profile {
                0 => (3750u16, 500u16, 1250u16, 0u16, 250u16),
                2 => (3750, 500, 1500, 0, 250),
                _ => (3750, 500, 0, 1500, 0),
            }
        } else {
            match profile {
                0 => (0u16, 0u16, 1500u16, 0u16, 250u16),
                2 => (0, 0, 1750, 0, 250),
                _ => (0, 0, 0, 1750, 0),
            }
        };
    let league = calculate_fee(fee_amount, league_bps)?;
    let weekly = calculate_fee(league, 3_000)?;
    let monthly = league.saturating_sub(weekly);
    let creator = calculate_fee(fee_amount, creator_bps)?;
    let recruiter = calculate_fee(fee_amount, recruiter_bps)?;
    let airdrop = calculate_fee(fee_amount, airdrop_bps)?;
    let squad = calculate_fee(fee_amount, squad_bps)?;
    let used = weekly
        .saturating_add(monthly)
        .saturating_add(creator)
        .saturating_add(recruiter)
        .saturating_add(airdrop)
        .saturating_add(squad);
    Ok(BnbRouteAmounts {
        weekly_league: weekly,
        monthly_league: monthly,
        creator,
        recruiter,
        airdrop,
        squad,
        protocol: fee_amount.saturating_sub(used),
    })
}

pub(crate) fn validate_route_profile_id(profile: u8) -> Result<()> {
    require!(
        profile == ROUTE_PROFILE_LINKED
            || profile == ROUTE_PROFILE_UNLINKED
            || profile == ROUTE_PROFILE_OG,
        LaunchpadError::InvalidRouteProfile
    );
    Ok(())
}

pub(crate) fn expected_reward_vaults() -> [Pubkey; 6] {
    let treasury = crate::rewards_treasury_program_id();
    [
        Pubkey::find_program_address(&[crate::LEAGUE_VAULT_SEED], &treasury).0,
        Pubkey::find_program_address(&[crate::AIRDROP_VAULT_SEED], &treasury).0,
        Pubkey::find_program_address(&[crate::MONTHLY_LEAGUE_VAULT_SEED], &treasury).0,
        Pubkey::find_program_address(&[crate::RECRUITER_VAULT_SEED], &treasury).0,
        Pubkey::find_program_address(&[crate::SQUAD_VAULT_SEED], &treasury).0,
        Pubkey::find_program_address(&[crate::PROTOCOL_VAULT_SEED], &treasury).0,
    ]
}

fn validate_reward_vaults(remaining: &[AccountInfo]) -> Result<()> {
    let expected = expected_reward_vaults();
    for i in 0..6 {
        require_keys_eq!(
            *remaining[i].key,
            expected[i],
            LaunchpadError::InvalidRewardsVault
        );
        require!(
            remaining[i].is_writable,
            LaunchpadError::InvalidRewardsVault
        );
        require!(
            remaining[i].lamports() > 0,
            LaunchpadError::InvalidRewardsVault
        );
    }
    Ok(())
}

#[inline(never)]
fn verify_buy_authorization(
    instructions: &AccountInfo,
    route_signer: Pubkey,
    campaign_key: Pubkey,
    mint: Pubkey,
    trader: Pubkey,
    args: &BuyTokensArgs,
) -> Result<()> {
    let digest = build_trade_authorization_digest(
        crate::id(),
        campaign_key,
        mint,
        trader,
        TRADE_SIDE_BUY,
        args.lamports_in,
        args.min_tokens_out,
        args.deadline,
        &args.nonce,
        args.native_target_lamports,
        args.route_profile,
    );
    verify_detached_trade_authorization(instructions, route_signer, &digest)
}

#[inline(never)]
fn verify_sell_authorization(
    instructions: &AccountInfo,
    route_signer: Pubkey,
    campaign_key: Pubkey,
    mint: Pubkey,
    trader: Pubkey,
    args: &SellTokensArgs,
) -> Result<()> {
    let digest = build_trade_authorization_digest(
        crate::id(),
        campaign_key,
        mint,
        trader,
        TRADE_SIDE_SELL,
        args.tokens_in,
        args.min_lamports_out,
        args.deadline,
        &args.nonce,
        0,
        args.route_profile,
    );
    verify_detached_trade_authorization(instructions, route_signer, &digest)
}

#[inline(never)]
fn quote_buy_prepared(
    economics_version: u16,
    base_price: u64,
    slope: u64,
    sold: u64,
    supply: u64,
    lamports_in: u64,
    buy_fee_bps: u16,
    decimals: u8,
) -> Result<(u64, u64, u64, u64)> {
    if economics_version >= ECONOMICS_VERSION_V3 {
        let (tokens, curve_cost, curve_fee, total_spent) = quote_buy_tokens_v3_gross(
            base_price,
            slope,
            sold,
            supply,
            lamports_in,
            buy_fee_bps,
            decimals,
        )?;
        Ok((tokens, curve_cost, curve_fee, total_spent))
    } else {
        let legacy_fee = calculate_fee(lamports_in, buy_fee_bps)?;
        let legacy_net = lamports_in
            .checked_sub(legacy_fee)
            .ok_or(LaunchpadError::MathOverflow)?;
        require!(legacy_net > 0, LaunchpadError::InvalidTradeAmount);
        let tokens = quote_buy_tokens(
            economics_version,
            base_price,
            slope,
            sold,
            supply,
            legacy_net,
            decimals,
        )?;
        Ok((tokens, legacy_net, legacy_fee, lamports_in))
    }
}

pub fn set_campaign_pause_handler(ctx: Context<SetCampaignPause>, paused: bool) -> Result<()> {
    let global = &ctx.accounts.global_config;
    if ctx.accounts.authority.key() != global.admin && ctx.accounts.authority.key() != global.pauser
    {
        return err!(LaunchpadError::Unauthorized);
    }
    let campaign_key = ctx.accounts.campaign.key();
    let campaign_info = ctx.accounts.campaign.to_account_info();
    require_keys_eq!(
        *campaign_info.owner,
        crate::ID,
        LaunchpadError::InvalidCampaign
    );
    let mut data = campaign_info.try_borrow_mut_data()?;
    assert_campaign_data(&data)?;
    let campaign_id = campaign_view::read_32(&data, CAMPAIGN_ID_OFFSET)?;
    let (expected_campaign, _) =
        Pubkey::find_program_address(&[CAMPAIGN_SEED, campaign_id.as_ref()], &crate::ID);
    require_keys_eq!(
        campaign_key,
        expected_campaign,
        LaunchpadError::InvalidCampaign
    );
    campaign_view::write_u8(&mut data, CAMPAIGN_PAUSED_OFFSET, u8::from(paused))?;
    emit!(crate::CampaignPauseUpdated {
        campaign: campaign_key,
        authority: ctx.accounts.authority.key(),
        paused,
    });
    Ok(())
}

fn validate_trade_accounts(
    campaign: &Campaign,
    campaign_key: Pubkey,
    mint_key: Pubkey,
    token_vault_key: Pubkey,
    sol_vault_key: Pubkey,
) -> Result<()> {
    require_keys_eq!(campaign.mint, mint_key, LaunchpadError::InvalidCampaign);
    require_keys_eq!(
        campaign.token_vault,
        token_vault_key,
        LaunchpadError::InvalidCampaign
    );
    require_keys_eq!(
        campaign.sol_vault,
        sol_vault_key,
        LaunchpadError::InvalidCampaign
    );
    let (expected_campaign, _) =
        Pubkey::find_program_address(&[CAMPAIGN_SEED, campaign.campaign_id.as_ref()], &crate::ID);
    require_keys_eq!(
        campaign_key,
        expected_campaign,
        LaunchpadError::InvalidCampaign
    );
    let (expected_vault, _) = Pubkey::find_program_address(
        &[TOKEN_VAULT_SEED, campaign.campaign_id.as_ref()],
        &crate::ID,
    );
    require_keys_eq!(
        token_vault_key,
        expected_vault,
        LaunchpadError::InvalidCampaign
    );
    let (expected_sol, _) =
        Pubkey::find_program_address(&[SOL_VAULT_SEED, campaign.campaign_id.as_ref()], &crate::ID);
    require_keys_eq!(sol_vault_key, expected_sol, LaunchpadError::InvalidCampaign);
    let _ = CampaignSolVault::INIT_SPACE; // keep type linked
    Ok(())
}

pub(crate) fn should_close_curve(
    sold_tokens: u64,
    curve_token_supply: u64,
    net_raised_lamports: u64,
    native_target_lamports: u64,
) -> bool {
    sold_tokens >= curve_token_supply
        || (native_target_lamports > 0 && net_raised_lamports >= native_target_lamports)
}

fn build_trade_authorization_digest(
    program_id: Pubkey,
    campaign: Pubkey,
    mint: Pubkey,
    trader: Pubkey,
    side: u8,
    amount_in: u64,
    min_out: u64,
    deadline: i64,
    nonce: &[u8; 32],
    native_target_lamports: u64,
    route_profile: u8,
) -> [u8; 32] {
    let mut message = Vec::with_capacity(265);
    message.extend_from_slice(TRADE_AUTH_DOMAIN);
    message.extend_from_slice(&TRADE_AUTH_SCHEMA_VERSION.to_le_bytes());
    message.extend_from_slice(program_id.as_ref());
    message.extend_from_slice(campaign.as_ref());
    message.extend_from_slice(mint.as_ref());
    message.extend_from_slice(trader.as_ref());
    message.push(side);
    message.extend_from_slice(&amount_in.to_le_bytes());
    message.extend_from_slice(&min_out.to_le_bytes());
    message.extend_from_slice(&deadline.to_le_bytes());
    message.extend_from_slice(nonce.as_ref());
    message.extend_from_slice(&native_target_lamports.to_le_bytes());
    message.push(route_profile);
    hash(&message).to_bytes()
}

fn verify_detached_trade_authorization(
    instructions_sysvar: &AccountInfo,
    expected_route_signer: Pubkey,
    expected_message: &[u8; 32],
) -> Result<()> {
    let current_index = load_current_index_checked(instructions_sysvar)
        .map_err(|_| error!(LaunchpadError::InvalidTradeAuthorization))?;
    require!(current_index > 0, LaunchpadError::InvalidTradeAuthorization);
    let ed25519_index = current_index
        .checked_sub(1)
        .ok_or(LaunchpadError::InvalidTradeAuthorization)?;
    let instruction = load_instruction_at_checked(usize::from(ed25519_index), instructions_sysvar)
        .map_err(|_| error!(LaunchpadError::InvalidTradeAuthorization))?;
    require_keys_eq!(
        instruction.program_id,
        ed25519_program::ID,
        LaunchpadError::InvalidTradeAuthorization
    );
    require!(
        instruction.accounts.is_empty(),
        LaunchpadError::InvalidTradeAuthorization
    );
    let parsed = parse_single_ed25519_instruction(&instruction.data)?;
    require!(
        parsed.public_key == expected_route_signer.as_ref(),
        LaunchpadError::InvalidTradeAuthorization
    );
    require!(
        parsed.message == expected_message,
        LaunchpadError::InvalidTradeAuthorization
    );
    Ok(())
}

struct ParsedEd25519Instruction<'a> {
    public_key: &'a [u8],
    message: &'a [u8],
}

fn parse_single_ed25519_instruction(data: &[u8]) -> Result<ParsedEd25519Instruction<'_>> {
    require!(
        data.len() >= ED25519_HEADER_SIZE,
        LaunchpadError::InvalidTradeAuthorization
    );
    require!(data[0] == 1, LaunchpadError::InvalidTradeAuthorization);
    require!(data[1] == 0, LaunchpadError::InvalidTradeAuthorization);

    let signature_offset = read_u16(data, 2)?;
    let signature_instruction_index = read_u16(data, 4)?;
    let public_key_offset = read_u16(data, 6)?;
    let public_key_instruction_index = read_u16(data, 8)?;
    let message_data_offset = read_u16(data, 10)?;
    let message_data_size = read_u16(data, 12)?;
    let message_instruction_index = read_u16(data, 14)?;

    require!(
        signature_instruction_index == ED25519_CURRENT_INSTRUCTION,
        LaunchpadError::InvalidTradeAuthorization
    );
    require!(
        public_key_instruction_index == ED25519_CURRENT_INSTRUCTION,
        LaunchpadError::InvalidTradeAuthorization
    );
    require!(
        message_instruction_index == ED25519_CURRENT_INSTRUCTION,
        LaunchpadError::InvalidTradeAuthorization
    );

    checked_slice(data, signature_offset, ED25519_SIGNATURE_SIZE)?;
    let public_key = checked_slice(data, public_key_offset, ED25519_PUBLIC_KEY_SIZE)?;
    let message = checked_slice(data, message_data_offset, usize::from(message_data_size))?;
    Ok(ParsedEd25519Instruction {
        public_key,
        message,
    })
}

fn read_u16(data: &[u8], offset: usize) -> Result<u16> {
    let end = offset.checked_add(2).ok_or(LaunchpadError::MathOverflow)?;
    require!(end <= data.len(), LaunchpadError::InvalidTradeAuthorization);
    Ok(u16::from_le_bytes([data[offset], data[offset + 1]]))
}

pub fn close_expired_trade_authorization_handler(
    ctx: Context<CloseExpiredTradeAuthorization>,
    args: CloseExpiredTradeAuthorizationArgs,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let auth_info = ctx.accounts.trade_authorization.to_account_info();
    require_keys_eq!(
        *auth_info.owner,
        crate::ID,
        LaunchpadError::InvalidTradeAuthorization
    );
    require!(
        auth_info.data_len() == 8 + TradeAuthorization::INIT_SPACE,
        LaunchpadError::InvalidTradeAuthorization
    );
    let auth = {
        let data = auth_info.try_borrow_data()?;
        let mut slice: &[u8] = &data;
        TradeAuthorization::try_deserialize(&mut slice)?
    };
    require_keys_eq!(
        auth.trader,
        ctx.accounts.trader.key(),
        LaunchpadError::InvalidTradeAuthorization
    );
    require!(
        auth.nonce == args.nonce,
        LaunchpadError::InvalidTradeAuthorization
    );
    require!(
        auth.bump == ctx.bumps.trade_authorization,
        LaunchpadError::InvalidTradeAuthorization
    );
    require!(
        now > auth.deadline,
        LaunchpadError::TradeAuthorizationNotExpired
    );

    let refund = auth_info.lamports();
    let trader_info = ctx.accounts.trader.to_account_info();
    let trader_lamports = trader_info.lamports();
    **trader_info.try_borrow_mut_lamports()? = trader_lamports
        .checked_add(refund)
        .ok_or(LaunchpadError::MathOverflow)?;
    **auth_info.try_borrow_mut_lamports()? = 0;
    auth_info.assign(&system_program::ID);
    auth_info.realloc(0, false)?;
    Ok(())
}

fn checked_slice(data: &[u8], offset: u16, len: usize) -> Result<&[u8]> {
    let start = usize::from(offset);
    let end = start.checked_add(len).ok_or(LaunchpadError::MathOverflow)?;
    require!(end <= data.len(), LaunchpadError::InvalidTradeAuthorization);
    Ok(&data[start..end])
}

fn create_trade_auth_account<'info>(
    payer: &AccountInfo<'info>,
    account: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    trader: Pubkey,
    campaign: Pubkey,
    side: u8,
    nonce: &[u8; 32],
    deadline: i64,
    used_at: i64,
    route_signer: Pubkey,
    message_hash: [u8; 32],
    bump: u8,
) -> Result<()> {
    require!(
        account.lamports() == 0,
        LaunchpadError::InvalidTradeAuthorization
    );
    require!(
        account.data_is_empty(),
        LaunchpadError::InvalidTradeAuthorization
    );
    let space = 8 + TradeAuthorization::INIT_SPACE;
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(space);
    let seeds: &[&[u8]] = &[TRADE_AUTH_SEED, trader.as_ref(), nonce.as_ref(), &[bump]];
    invoke_signed(
        &system_instruction::create_account(
            payer.key,
            account.key,
            lamports,
            space as u64,
            &crate::ID,
        ),
        &[payer.clone(), account.clone(), system_program.clone()],
        &[seeds],
    )?;
    let body = TradeAuthorization {
        trader,
        campaign,
        side,
        nonce: *nonce,
        deadline,
        used_at,
        route_signer,
        message_hash,
        schema_version: TRADE_AUTH_SCHEMA_VERSION,
        bump,
    };
    let mut data = account.try_borrow_mut_data()?;
    let mut cursor = std::io::Cursor::new(&mut data[..]);
    body.try_serialize(&mut cursor)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linear_cost_base_only_v1() {
        // V1: 10 raw units at base 1000, slope 0 → 10_000 lamports
        let cost = checked_linear_curve_cost(ECONOMICS_VERSION_V1, 1000, 0, 0, 10, 6).unwrap();
        assert_eq!(cost, 10_000);
    }

    #[test]
    fn linear_cost_v2_bnb_parity_first_token() {
        // V2: base=1 lamport per whole token, 6 decimals → 1 full token costs 1 lamport
        let one_token = 1_000_000u64;
        let cost = checked_linear_curve_cost(ECONOMICS_VERSION_V2, 1, 0, 0, one_token, 6).unwrap();
        assert_eq!(cost, 1);
    }

    #[test]
    fn quote_buy_v2_point_zero_one_sol() {
        // 0.01 SOL net; base=1 lamport/whole token, slope=0 → ~9.8M whole tokens.
        let net = 9_800_000u64;
        let supply = 840_000_000_000_000u64; // 840M @ 6 dec (84% of 1B)
        let tokens = quote_buy_tokens(ECONOMICS_VERSION_V2, 1, 0, 0, supply, net, 6).unwrap();
        // ~net * 1e6 / base = 9.8e12 raw ≈ 9.8e6 whole tokens
        assert!(tokens > 1_000_000_000_000); // > 1M whole tokens
        let cost = checked_linear_curve_cost(ECONOMICS_VERSION_V2, 1, 0, 0, tokens, 6).unwrap();
        assert!(cost <= net);
        assert_eq!(tokens, 9_800_000_000_000);
    }

    #[test]
    fn quote_buy_v3_same_size_buy_gets_fewer_tokens() {
        let gross = 1_000_000u64; // 0.001 SOL
        let supply = 840_000_000_000_000u64;
        let (first_tokens, first_cost, first_fee, first_total) =
            quote_buy_tokens_v3_gross(1, 850, 0, supply, gross, 200, 6).unwrap();
        let (second_tokens, _, _, second_total) =
            quote_buy_tokens_v3_gross(1, 850, first_tokens, supply, gross, 200, 6).unwrap();

        assert!(first_tokens > 0);
        assert!(second_tokens > 0);
        assert!(second_tokens < first_tokens);
        assert_eq!(first_total, first_cost + first_fee);
        assert!(first_total <= gross);
        assert!(second_total <= gross);

        let refund =
            quote_sell_refund(ECONOMICS_VERSION_V3, 1, 850, first_tokens, first_tokens, 6).unwrap();
        assert_eq!(refund, first_cost);
    }

    #[test]
    fn quote_buy_roundtrip_v1() {
        let base = 1000u64;
        let slope = 10u64;
        let sold = 0u64;
        let net = 50_000u64;
        let tokens =
            quote_buy_tokens(ECONOMICS_VERSION_V1, base, slope, sold, 1_000_000, net, 6).unwrap();
        let cost =
            checked_linear_curve_cost(ECONOMICS_VERSION_V1, base, slope, sold, tokens, 6).unwrap();
        assert!(cost <= net);
        if tokens + 1 <= 1_000_000 {
            let over =
                checked_linear_curve_cost(ECONOMICS_VERSION_V1, base, slope, sold, tokens + 1, 6)
                    .unwrap();
            assert!(over > net);
        }
    }

    #[test]
    fn sell_is_reverse_of_buy_path_v1() {
        let base = 1000u64;
        let slope = 10u64;
        let buy_tokens = 100u64;
        let cost =
            checked_linear_curve_cost(ECONOMICS_VERSION_V1, base, slope, 0, buy_tokens, 6).unwrap();
        let refund =
            quote_sell_refund(ECONOMICS_VERSION_V1, base, slope, buy_tokens, buy_tokens, 6)
                .unwrap();
        assert_eq!(cost, refund);
    }

    #[test]
    fn raise_target_overshoot_closes_curve_without_graduating() {
        assert!(should_close_curve(1_000, 1_000_000, 6_000_000, 5_868_940));
        assert!(!should_close_curve(1_000, 1_000_000, 5_000_000, 5_868_940));
    }

    #[test]
    fn sold_out_closes_curve_without_native_target() {
        assert!(should_close_curve(1_000_000, 1_000_000, 1, 0));
        assert!(!should_close_curve(999_999, 1_000_000, 1, 0));
    }

    #[test]
    fn zero_native_target_does_not_close_on_raise() {
        assert!(!should_close_curve(1, 1_000_000, u64::MAX, 0));
    }

    #[test]
    fn new_campaign_account_is_720_bytes() {
        assert_eq!(8 + Campaign::INIT_SPACE, 720);
    }

    #[test]
    fn unlinked_trade_route_sends_recruiter_slice_to_airdrop() {
        let fee = 10_000u64;
        let unlinked =
            preview_bnb_route(crate::ROUTE_KIND_TRADE, ROUTE_PROFILE_UNLINKED, fee).unwrap();
        let linked = preview_bnb_route(crate::ROUTE_KIND_TRADE, ROUTE_PROFILE_LINKED, fee).unwrap();
        assert_eq!(unlinked.recruiter, 0);
        assert_eq!(unlinked.squad, 0);
        assert_eq!(unlinked.creator, 500);
        assert!(unlinked.airdrop > 0);
        assert_eq!(linked.creator, 500);
        assert!(linked.recruiter > 0);
        assert_eq!(linked.airdrop, 0);
        assert_eq!(
            unlinked.weekly_league
                + unlinked.monthly_league
                + unlinked.creator
                + unlinked.airdrop
                + unlinked.protocol,
            fee
        );
    }

    #[test]
    fn finalize_route_keeps_creator_zero() {
        let fee = 10_000u64;
        for profile in [
            ROUTE_PROFILE_LINKED,
            ROUTE_PROFILE_UNLINKED,
            ROUTE_PROFILE_OG,
        ] {
            let finalize = preview_bnb_route(crate::ROUTE_KIND_FINALIZE, profile, fee).unwrap();
            assert_eq!(finalize.creator, 0, "profile {profile}");
            assert_eq!(
                finalize.weekly_league
                    + finalize.monthly_league
                    + finalize.creator
                    + finalize.recruiter
                    + finalize.airdrop
                    + finalize.squad
                    + finalize.protocol,
                fee,
                "profile {profile}"
            );
        }
    }

    #[test]
    fn invalid_route_profile_is_rejected() {
        assert!(validate_route_profile_id(3).is_err());
        assert!(validate_route_profile_id(ROUTE_PROFILE_LINKED).is_ok());
        assert!(validate_route_profile_id(ROUTE_PROFILE_UNLINKED).is_ok());
        assert!(validate_route_profile_id(ROUTE_PROFILE_OG).is_ok());
    }
}
