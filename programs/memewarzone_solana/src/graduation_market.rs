//! Atomic Solana graduation into Meteora DAMM v2 with generic approved quote binding.
//!
//! Native SOL graduation remains the direct MEME/WSOL path. Non-native graduation
//! binds an approved quote configuration into the detached route-signer digest,
//! requires the signed acquisition program to appear before Meteora in the same
//! transaction, verifies the resulting MEME/QUOTE pool and permanent lock, sweeps
//! quote residual to a signed recovery account, and only then marks the campaign
//! graduated. Any failed instruction rolls the whole transaction back.

use anchor_lang::{
    prelude::*,
    solana_program::{
        ed25519_program,
        hash::hash,
        program::invoke,
        program_pack::Pack,
        system_instruction,
        sysvar::instructions::{
            load_current_index_checked, load_instruction_at_checked, ID as INSTRUCTIONS_SYSVAR_ID,
        },
    },
};
use anchor_spl::token::{
    self,
    spl_token::{self, state::Account as SplTokenAccount},
    Burn, Token, Transfer,
};

use crate::{
    authorized_create::{CAMPAIGN_SEED, SOL_VAULT_SEED, TOKEN_VAULT_SEED},
    authorized_trade::{route_fee_slices, validate_route_profile_id, TRADE_SIDE_FINALIZE},
    campaign_view::{load_campaign_view, mark_campaign_graduated, CampaignView},
    fee_escrow::{require_fee_escrow_empty, FEE_ESCROW_SEED},
    CreatorProfile, GenerationConfig, GlobalConfig, LaunchpadError, BPS_DENOMINATOR,
    CREATOR_PROFILE_SEED, DEX_ADAPTER_METEORA_DAMM_V2, ECONOMICS_VERSION_V3,
    GENERATION_CONFIG_SEED, GLOBAL_CONFIG_SEED,
};

#[cfg(test)]
use crate::{authorized_create::Campaign, campaign_view::campaign_view_from_campaign};

pub const GRADUATION_SEED: &[u8] = b"graduation";
pub const GRADUATION_AUTH_DOMAIN: &[u8] = b"MEMEWARZONE_SOLANA_GRADUATION_V1";
pub const GRADUATION_AUTH_SCHEMA_VERSION: u16 = 3;
pub const METEORA_CP_AMM_PROGRAM_ID: Pubkey =
    pubkey!("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
pub const GRADUATION_PRICE_TOLERANCE_BPS: u16 = 50;

pub const QUOTE_PROFILE_NATIVE: u8 = 0;
pub const QUOTE_PROFILE_STABLECOIN: u8 = 1;
pub const QUOTE_PROFILE_PROVIDER_RWA: u8 = 2;
pub const QUOTE_PROFILE_MWZ_NATIVE: u8 = 3;
pub const QUOTE_PROFILE_COMMUNITY: u8 = 4;
pub const QUOTE_PROVIDER_NATIVE: u8 = 0;
pub const QUOTE_MAX_SLIPPAGE_BPS: u16 = 300;
pub const QUOTE_MAX_IMPACT_BPS: u16 = 300;
pub const QUOTE_MAX_DEVIATION_BPS: u16 = 150;

const SLOPE_NANO_LAMPORT_SCALE: u128 = 1_000_000_000;
const ED25519_HEADER_SIZE: usize = 16;
const ED25519_SIGNATURE_SIZE: usize = 64;
const ED25519_PUBLIC_KEY_SIZE: usize = 32;
const ED25519_CURRENT_INSTRUCTION: u16 = u16::MAX;
const MAX_ATOMIC_SCAN_INSTRUCTIONS: usize = 64;
const NON_NATIVE_REMAINING_PREFIX: usize = 3;

const METEORA_POOL_TOKEN_A_MINT_OFFSET: usize = 168;
const METEORA_POOL_TOKEN_B_MINT_OFFSET: usize = 200;
const METEORA_POOL_TOKEN_A_VAULT_OFFSET: usize = 232;
const METEORA_POOL_TOKEN_B_VAULT_OFFSET: usize = 264;
const METEORA_POOL_MIN_LEN: usize = 296;

const METEORA_POSITION_POOL_OFFSET: usize = 8;
const METEORA_POSITION_NFT_MINT_OFFSET: usize = 40;
const METEORA_POSITION_UNLOCKED_LIQUIDITY_OFFSET: usize = 152;
const METEORA_POSITION_PERMANENT_LOCKED_LIQUIDITY_OFFSET: usize = 184;
const METEORA_POSITION_MIN_LEN: usize = 200;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct BeginGraduationArgs {
    pub native_target_lamports: u64,
    pub oracle_price_usd_micros: u64,
    pub deadline: i64,
    pub nonce: [u8; 32],
    pub position_nft_mint: Pubkey,
    pub finalize_route_profile: u8,
    /// Exact quote identity chosen by the approved catalog/policy layer.
    pub quote_mint: Pubkey,
    /// Hash of the versioned quote configuration. Never a symbol/name identifier.
    pub quote_config_id: [u8; 32],
    pub quote_policy_version: u16,
    pub quote_profile: u8,
    pub quote_provider_class: u8,
    /// Top-level acquisition program. Default pubkey only for native SOL/WSOL.
    pub acquisition_program: Pubkey,
    /// Quote/USD reference used by the backend safety decision, scaled 1e6.
    pub quote_reference_usd_micros: u64,
    pub quote_decimals: u8,
    /// Expected and minimum quote raw units for the exact-in acquisition.
    pub expected_quote_amount: u64,
    pub min_quote_amount: u64,
    pub max_slippage_bps: u16,
    pub max_impact_bps: u16,
    pub max_deviation_bps: u16,
    /// Protocol-controlled token account receiving any positive-slippage residual.
    pub quote_recovery_account: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct GraduationState {
    pub campaign: Pubkey,
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub meteora_pool: Pubkey,
    pub meteora_position: Pubkey,
    pub position_nft_mint: Pubkey,
    pub native_target_lamports: u64,
    pub oracle_price_usd_micros: u64,
    pub finalize_route_profile: u8,
    pub max_liquidity_tokens: u64,
    pub max_liquidity_lamports: u64,
    pub finalize_fee_lamports: u64,
    pub creator_payout_lamports: u64,
    pub final_spot_nano_lamports: u128,
    pub quote_mint: Pubkey,
    pub quote_config_id: [u8; 32],
    pub quote_policy_version: u16,
    pub quote_profile: u8,
    pub quote_provider_class: u8,
    pub acquisition_program: Pubkey,
    pub quote_reference_usd_micros: u64,
    pub quote_decimals: u8,
    pub expected_quote_amount: u64,
    pub min_quote_amount: u64,
    pub max_slippage_bps: u16,
    pub max_impact_bps: u16,
    pub max_deviation_bps: u16,
    pub quote_recovery_account: Pubkey,
    pub authorization_hash: [u8; 32],
    pub started_at: i64,
    pub finalized_at: i64,
    pub finalized: bool,
    pub bump: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GraduationQuote {
    pub finalize_fee_lamports: u64,
    pub max_liquidity_lamports: u64,
    pub max_liquidity_tokens: u64,
    pub creator_payout_lamports: u64,
    pub final_spot_nano_lamports: u128,
}

#[event]
pub struct GraduationStarted {
    pub campaign: Pubkey,
    pub authority: Pubkey,
    pub meteora_pool: Pubkey,
    pub meteora_position: Pubkey,
    pub position_nft_mint: Pubkey,
    pub native_target_lamports: u64,
    pub oracle_price_usd_micros: u64,
    pub max_liquidity_tokens: u64,
    pub max_liquidity_lamports: u64,
    pub finalize_fee_lamports: u64,
    pub creator_payout_lamports: u64,
    pub final_spot_nano_lamports: u128,
    pub quote_mint: Pubkey,
    pub quote_config_id: [u8; 32],
    pub quote_policy_version: u16,
    pub quote_profile: u8,
    pub quote_provider_class: u8,
}

#[event]
pub struct CampaignGraduated {
    pub campaign: Pubkey,
    pub creator: Pubkey,
    pub mint: Pubkey,
    pub meteora_pool: Pubkey,
    pub meteora_position: Pubkey,
    pub quote_mint: Pubkey,
    pub quote_config_id: [u8; 32],
    pub liquidity_tokens: u64,
    /// Native path: lamports in WSOL vault. Non-native: graduation allocation converted from SOL.
    pub liquidity_lamports: u64,
    /// Raw quote units actually locked in the Meteora pool.
    pub liquidity_quote_raw: u64,
    pub finalize_fee_lamports: u64,
    pub creator_payout_lamports: u64,
    pub burned_unsold_curve_tokens: u64,
    pub burned_unused_liquidity_tokens: u64,
    pub creator_reserve_tokens: u64,
    pub final_spot_nano_lamports: u128,
    pub graduated_at: i64,
}

#[derive(Accounts)]
#[instruction(args: BeginGraduationArgs)]
pub struct BeginGraduation<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [GLOBAL_CONFIG_SEED], bump)]
    pub global_config: UncheckedAccount<'info>,
    pub generation_config: UncheckedAccount<'info>,
    #[account(mut)]
    pub campaign: UncheckedAccount<'info>,
    pub mint: UncheckedAccount<'info>,
    #[account(mut)]
    pub token_vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub sol_vault: UncheckedAccount<'info>,
    #[account(seeds = [FEE_ESCROW_SEED, campaign.key().as_ref()], bump)]
    pub fee_escrow: UncheckedAccount<'info>,
    #[account(mut)]
    pub authority_token_account: UncheckedAccount<'info>,
    pub meteora_pool: UncheckedAccount<'info>,
    pub meteora_position: UncheckedAccount<'info>,
    pub position_nft_mint: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + GraduationState::INIT_SPACE,
        seeds = [GRADUATION_SEED, campaign.key().as_ref()],
        bump
    )]
    pub graduation_state: Account<'info, GraduationState>,
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ConfirmGraduation<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [GLOBAL_CONFIG_SEED], bump)]
    pub global_config: UncheckedAccount<'info>,
    #[account(mut)]
    pub campaign: UncheckedAccount<'info>,
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    #[account(mut)]
    pub token_vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub sol_vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub authority_token_account: UncheckedAccount<'info>,
    #[account(mut)]
    pub creator: UncheckedAccount<'info>,
    #[account(mut)]
    pub creator_token_account: UncheckedAccount<'info>,
    #[account(mut)]
    pub creator_profile: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [GRADUATION_SEED, campaign.key().as_ref()],
        bump = graduation_state.bump,
        has_one = campaign,
        has_one = authority,
        has_one = mint
    )]
    pub graduation_state: Account<'info, GraduationState>,
    pub meteora_pool: UncheckedAccount<'info>,
    pub meteora_position: UncheckedAccount<'info>,
    pub meteora_token_vault: UncheckedAccount<'info>,
    /// Native path: WSOL vault. Non-native path: selected quote vault.
    pub meteora_native_vault: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn begin_graduation_handler(
    ctx: Context<BeginGraduation>,
    args: BeginGraduationArgs,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(args.deadline >= now, LaunchpadError::GraduationAuthorizationExpired);
    require!(args.native_target_lamports > 0, LaunchpadError::InvalidGraduationTarget);
    require!(args.oracle_price_usd_micros > 0, LaunchpadError::InvalidGraduationTarget);
    validate_route_profile_id(args.finalize_route_profile)?;
    validate_quote_binding(&args)?;
    require_keys_eq!(args.position_nft_mint, ctx.accounts.position_nft_mint.key(), LaunchpadError::InvalidMeteoraPosition);

    let (route_signer, treasury_operator) = read_graduation_global(&ctx.accounts.global_config.to_account_info())?;
    require_keys_eq!(treasury_operator, ctx.accounts.authority.key(), LaunchpadError::Unauthorized);

    let campaign_key = ctx.accounts.campaign.key();
    let campaign = load_campaign_view(&ctx.accounts.campaign.to_account_info())?;
    validate_campaign_accounts(
        &campaign,
        campaign_key,
        ctx.accounts.mint.key(),
        ctx.accounts.token_vault.key(),
        ctx.accounts.sol_vault.key(),
    )?;
    require!(!campaign.graduated, LaunchpadError::AlreadyGraduated);
    require!(!campaign.paused, LaunchpadError::CampaignPaused);
    require_keys_neq!(args.quote_mint, campaign.mint, LaunchpadError::InvalidGraduationAuthorization);
    require_fee_escrow_empty(&ctx.accounts.fee_escrow.to_account_info(), campaign_key)?;
    require!(
        args.native_target_lamports == native_target_lamports_from_usd(
            campaign.graduation_target_usd_micros,
            args.oracle_price_usd_micros,
        )?,
        LaunchpadError::InvalidGraduationTarget
    );
    require!(campaign.economics_version >= ECONOMICS_VERSION_V3, LaunchpadError::InvalidGenerationEconomics);
    require!(campaign.dex_adapter == DEX_ADAPTER_METEORA_DAMM_V2, LaunchpadError::InvalidDexAdapter);
    validate_generation_binding(&campaign, &ctx.accounts.generation_config.to_account_info())?;

    let eligible = campaign.sold_tokens >= campaign.curve_token_supply
        || campaign.net_raised_lamports >= args.native_target_lamports;
    require!(eligible, LaunchpadError::GraduationThresholdNotMet);

    require!(ctx.accounts.meteora_pool.lamports() == 0 && ctx.accounts.meteora_pool.data_is_empty(), LaunchpadError::MeteoraPoolAlreadyExists);
    require!(ctx.accounts.meteora_position.lamports() == 0 && ctx.accounts.meteora_position.data_is_empty(), LaunchpadError::MeteoraPositionAlreadyExists);

    let expected_pool = derive_meteora_pool_for_quote(campaign.mint, args.quote_mint);
    require_keys_eq!(expected_pool, ctx.accounts.meteora_pool.key(), LaunchpadError::InvalidMeteoraPool);
    let expected_position = derive_meteora_position(args.position_nft_mint);
    require_keys_eq!(expected_position, ctx.accounts.meteora_position.key(), LaunchpadError::InvalidMeteoraPosition);

    let staging = unpack_spl_account(&ctx.accounts.authority_token_account.to_account_info())?;
    require_keys_eq!(staging.mint, campaign.mint, LaunchpadError::InvalidCampaign);
    require_keys_eq!(staging.owner, ctx.accounts.authority.key(), LaunchpadError::Unauthorized);
    require!(staging.amount == 0, LaunchpadError::GraduationStagingNotEmpty);

    let digest = build_graduation_authorization_digest(
        crate::ID,
        campaign_key,
        campaign.mint,
        ctx.accounts.authority.key(),
        campaign.graduation_target_usd_micros,
        &args,
        expected_pool,
        expected_position,
    );
    verify_detached_graduation_authorization(
        &ctx.accounts.instructions.to_account_info(),
        route_signer,
        &digest,
    )?;
    require_atomic_route_meteora_then_confirm(
        &ctx.accounts.instructions.to_account_info(),
        args.quote_mint,
        args.acquisition_program,
    )?;

    let quote = graduation_quote(&campaign)?;
    require!(quote.max_liquidity_tokens > 0, LaunchpadError::GraduationLiquidityZero);
    require!(quote.max_liquidity_lamports > 0, LaunchpadError::GraduationLiquidityZero);

    let native_quote = is_native_quote(args.quote_mint);
    if native_quote {
        require!(args.expected_quote_amount == 0 && args.min_quote_amount == 0, LaunchpadError::InvalidGraduationAuthorization);
    } else {
        require!(args.expected_quote_amount >= args.min_quote_amount && args.min_quote_amount > 0, LaunchpadError::InvalidGraduationAuthorization);
    }

    let campaign_bump = [campaign.bump];
    let campaign_seeds: &[&[u8]] = &[CAMPAIGN_SEED, campaign.campaign_id.as_ref(), &campaign_bump];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.token_vault.to_account_info(),
                to: ctx.accounts.authority_token_account.to_account_info(),
                authority: ctx.accounts.campaign.to_account_info(),
            },
            &[campaign_seeds],
        ),
        quote.max_liquidity_tokens,
    )?;
    move_program_owned_lamports(
        &ctx.accounts.sol_vault.to_account_info(),
        &ctx.accounts.authority.to_account_info(),
        quote.max_liquidity_lamports,
    )?;

    let state = &mut ctx.accounts.graduation_state;
    state.campaign = campaign_key;
    state.authority = ctx.accounts.authority.key();
    state.mint = campaign.mint;
    state.meteora_pool = expected_pool;
    state.meteora_position = expected_position;
    state.position_nft_mint = args.position_nft_mint;
    state.native_target_lamports = args.native_target_lamports;
    state.oracle_price_usd_micros = args.oracle_price_usd_micros;
    state.finalize_route_profile = args.finalize_route_profile;
    state.max_liquidity_tokens = quote.max_liquidity_tokens;
    state.max_liquidity_lamports = quote.max_liquidity_lamports;
    state.finalize_fee_lamports = quote.finalize_fee_lamports;
    state.creator_payout_lamports = quote.creator_payout_lamports;
    state.final_spot_nano_lamports = quote.final_spot_nano_lamports;
    state.quote_mint = args.quote_mint;
    state.quote_config_id = args.quote_config_id;
    state.quote_policy_version = args.quote_policy_version;
    state.quote_profile = args.quote_profile;
    state.quote_provider_class = args.quote_provider_class;
    state.acquisition_program = args.acquisition_program;
    state.quote_reference_usd_micros = args.quote_reference_usd_micros;
    state.quote_decimals = args.quote_decimals;
    state.expected_quote_amount = args.expected_quote_amount;
    state.min_quote_amount = args.min_quote_amount;
    state.max_slippage_bps = args.max_slippage_bps;
    state.max_impact_bps = args.max_impact_bps;
    state.max_deviation_bps = args.max_deviation_bps;
    state.quote_recovery_account = args.quote_recovery_account;
    state.authorization_hash = digest;
    state.started_at = now;
    state.finalized_at = 0;
    state.finalized = false;
    state.bump = ctx.bumps.graduation_state;

    emit!(GraduationStarted {
        campaign: campaign_key,
        authority: state.authority,
        meteora_pool: state.meteora_pool,
        meteora_position: state.meteora_position,
        position_nft_mint: state.position_nft_mint,
        native_target_lamports: state.native_target_lamports,
        oracle_price_usd_micros: state.oracle_price_usd_micros,
        max_liquidity_tokens: state.max_liquidity_tokens,
        max_liquidity_lamports: state.max_liquidity_lamports,
        finalize_fee_lamports: state.finalize_fee_lamports,
        creator_payout_lamports: state.creator_payout_lamports,
        final_spot_nano_lamports: state.final_spot_nano_lamports,
        quote_mint: state.quote_mint,
        quote_config_id: state.quote_config_id,
        quote_policy_version: state.quote_policy_version,
        quote_profile: state.quote_profile,
        quote_provider_class: state.quote_provider_class,
    });
    Ok(())
}

pub fn confirm_graduation_handler(ctx: Context<ConfirmGraduation>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let (_route_signer, treasury_operator) = read_graduation_global(&ctx.accounts.global_config.to_account_info())?;
    require_keys_eq!(treasury_operator, ctx.accounts.authority.key(), LaunchpadError::Unauthorized);

    let campaign_key = ctx.accounts.campaign.key();
    let campaign = load_campaign_view(&ctx.accounts.campaign.to_account_info())?;
    validate_campaign_accounts(
        &campaign,
        campaign_key,
        ctx.accounts.mint.key(),
        ctx.accounts.token_vault.key(),
        ctx.accounts.sol_vault.key(),
    )?;
    require!(!campaign.graduated, LaunchpadError::AlreadyGraduated);
    require!(!campaign.paused, LaunchpadError::CampaignPaused);
    require_keys_eq!(campaign.creator, ctx.accounts.creator.key(), LaunchpadError::InvalidCampaign);

    let state = &ctx.accounts.graduation_state;
    require!(!state.finalized, LaunchpadError::AlreadyGraduated);
    require_keys_eq!(state.meteora_pool, ctx.accounts.meteora_pool.key(), LaunchpadError::InvalidMeteoraPool);
    require_keys_eq!(state.meteora_position, ctx.accounts.meteora_position.key(), LaunchpadError::InvalidMeteoraPosition);

    let _pool = validate_meteora_pool(
        &ctx.accounts.meteora_pool.to_account_info(),
        campaign.mint,
        state.quote_mint,
        ctx.accounts.meteora_token_vault.key(),
        ctx.accounts.meteora_native_vault.key(),
    )?;
    validate_meteora_position(
        &ctx.accounts.meteora_position.to_account_info(),
        state.meteora_pool,
        state.position_nft_mint,
    )?;

    let pool_token = unpack_spl_account(&ctx.accounts.meteora_token_vault.to_account_info())?;
    let pool_quote = unpack_spl_account(&ctx.accounts.meteora_native_vault.to_account_info())?;
    require_keys_eq!(pool_token.mint, campaign.mint, LaunchpadError::InvalidMeteoraPool);
    require_keys_eq!(pool_quote.mint, state.quote_mint, LaunchpadError::InvalidMeteoraPool);
    require!(pool_token.amount > 0 && pool_quote.amount > 0, LaunchpadError::GraduationLiquidityZero);
    require!(pool_token.amount <= state.max_liquidity_tokens, LaunchpadError::GraduationAssetMismatch);

    let native_quote = is_native_quote(state.quote_mint);
    if native_quote {
        require!(pool_quote.amount <= state.max_liquidity_lamports, LaunchpadError::GraduationAssetMismatch);
        validate_price_tolerance(
            pool_quote.amount,
            pool_token.amount,
            campaign.token_decimals,
            state.final_spot_nano_lamports,
        )?;
    } else {
        require!(pool_quote.amount <= state.expected_quote_amount, LaunchpadError::GraduationAssetMismatch);
        require!(pool_quote.amount >= state.min_quote_amount, LaunchpadError::GraduationAssetMismatch);
        validate_quote_pool_deviation(
            pool_quote.amount,
            pool_token.amount,
            campaign.token_decimals,
            state.quote_decimals,
            state.final_spot_nano_lamports,
            state.oracle_price_usd_micros,
            state.quote_reference_usd_micros,
            state.max_deviation_bps,
        )?;
    }

    let staging = unpack_spl_account(&ctx.accounts.authority_token_account.to_account_info())?;
    require_keys_eq!(staging.mint, campaign.mint, LaunchpadError::InvalidCampaign);
    require_keys_eq!(staging.owner, ctx.accounts.authority.key(), LaunchpadError::Unauthorized);
    let staged_plus_pool = staging.amount.checked_add(pool_token.amount).ok_or(LaunchpadError::MathOverflow)?;
    require!(staged_plus_pool == state.max_liquidity_tokens, LaunchpadError::GraduationAssetMismatch);

    if staging.amount > 0 {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.authority_token_account.to_account_info(),
                    to: ctx.accounts.token_vault.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            staging.amount,
        )?;
    }

    let reward_accounts: &[AccountInfo] = if native_quote {
        ctx.remaining_accounts
    } else {
        require!(ctx.remaining_accounts.len() >= NON_NATIVE_REMAINING_PREFIX, LaunchpadError::InvalidGraduationAuthorization);
        let quote_mint_info = &ctx.remaining_accounts[0];
        let authority_quote_info = &ctx.remaining_accounts[1];
        let recovery_info = &ctx.remaining_accounts[2];
        require_keys_eq!(*quote_mint_info.key, state.quote_mint, LaunchpadError::InvalidGraduationAuthorization);
        require_keys_eq!(*quote_mint_info.owner, token::ID, LaunchpadError::InvalidGraduationAuthorization);
        let authority_quote = unpack_spl_account(authority_quote_info)?;
        let recovery = unpack_spl_account(recovery_info)?;
        require_keys_eq!(authority_quote.mint, state.quote_mint, LaunchpadError::InvalidGraduationAuthorization);
        require_keys_eq!(authority_quote.owner, ctx.accounts.authority.key(), LaunchpadError::Unauthorized);
        require_keys_eq!(recovery.mint, state.quote_mint, LaunchpadError::InvalidGraduationAuthorization);
        require_keys_eq!(*recovery_info.key, state.quote_recovery_account, LaunchpadError::InvalidGraduationAuthorization);
        if authority_quote.amount > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: authority_quote_info.clone(),
                        to: recovery_info.clone(),
                        authority: ctx.accounts.authority.to_account_info(),
                    },
                ),
                authority_quote.amount,
            )?;
        }
        &ctx.remaining_accounts[NON_NATIVE_REMAINING_PREFIX..]
    };

    let unused_native = if native_quote {
        state.max_liquidity_lamports.checked_sub(pool_quote.amount).ok_or(LaunchpadError::MathOverflow)?
    } else {
        0
    };
    if unused_native > 0 {
        invoke(
            &system_instruction::transfer(
                &ctx.accounts.authority.key(),
                &ctx.accounts.sol_vault.key(),
                unused_native,
            ),
            &[
                ctx.accounts.authority.to_account_info(),
                ctx.accounts.sol_vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
    }

    let burned_unsold = campaign.curve_token_supply.checked_sub(campaign.sold_tokens).ok_or(LaunchpadError::MathOverflow)?;
    let burned_unused_liquidity = campaign.liquidity_token_supply.checked_sub(pool_token.amount).ok_or(LaunchpadError::MathOverflow)?;
    let creator_reserve = campaign.reserve_token_supply;
    let campaign_bump = [campaign.bump];
    let campaign_seeds: &[&[u8]] = &[CAMPAIGN_SEED, campaign.campaign_id.as_ref(), &campaign_bump];

    let burn_total = burned_unsold.checked_add(burned_unused_liquidity).ok_or(LaunchpadError::MathOverflow)?;
    if burn_total > 0 {
        token::burn(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.token_vault.to_account_info(),
                    authority: ctx.accounts.campaign.to_account_info(),
                },
                &[campaign_seeds],
            ),
            burn_total,
        )?;
    }

    if creator_reserve > 0 {
        let creator_token = unpack_spl_account(&ctx.accounts.creator_token_account.to_account_info())?;
        require_keys_eq!(creator_token.mint, campaign.mint, LaunchpadError::InvalidCampaign);
        require_keys_eq!(creator_token.owner, campaign.creator, LaunchpadError::InvalidCampaign);
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.token_vault.to_account_info(),
                    to: ctx.accounts.creator_token_account.to_account_info(),
                    authority: ctx.accounts.campaign.to_account_info(),
                },
                &[campaign_seeds],
            ),
            creator_reserve,
        )?;
    }

    let creator_payout = state.creator_payout_lamports.checked_add(unused_native).ok_or(LaunchpadError::MathOverflow)?;
    route_fee_slices(
        reward_accounts,
        &ctx.accounts.sol_vault.to_account_info(),
        campaign_key,
        ctx.accounts.authority.key(),
        TRADE_SIDE_FINALIZE,
        state.finalize_fee_lamports,
        state.finalize_route_profile,
    )?;
    move_program_owned_lamports(
        &ctx.accounts.sol_vault.to_account_info(),
        &ctx.accounts.creator.to_account_info(),
        creator_payout,
    )?;

    mark_campaign_graduated(&ctx.accounts.campaign.to_account_info())?;
    update_creator_profile_after_graduation(&ctx.accounts.creator_profile.to_account_info(), campaign.creator)?;

    let state = &mut ctx.accounts.graduation_state;
    state.finalized = true;
    state.finalized_at = now;

    emit!(CampaignGraduated {
        campaign: campaign_key,
        creator: campaign.creator,
        mint: campaign.mint,
        meteora_pool: state.meteora_pool,
        meteora_position: state.meteora_position,
        quote_mint: state.quote_mint,
        quote_config_id: state.quote_config_id,
        liquidity_tokens: pool_token.amount,
        liquidity_lamports: state.max_liquidity_lamports,
        liquidity_quote_raw: pool_quote.amount,
        finalize_fee_lamports: state.finalize_fee_lamports,
        creator_payout_lamports: creator_payout,
        burned_unsold_curve_tokens: burned_unsold,
        burned_unused_liquidity_tokens: burned_unused_liquidity,
        creator_reserve_tokens: creator_reserve,
        final_spot_nano_lamports: state.final_spot_nano_lamports,
        graduated_at: now,
    });
    Ok(())
}

pub fn final_spot_nano_lamports(campaign: &CampaignView) -> Result<u128> {
    require!(campaign.economics_version >= ECONOMICS_VERSION_V3, LaunchpadError::InvalidGenerationEconomics);
    let scale = token_scale(campaign.token_decimals)?;
    let base = u128::from(campaign.base_price_lamports)
        .checked_mul(SLOPE_NANO_LAMPORT_SCALE)
        .ok_or(LaunchpadError::MathOverflow)?;
    let slope = u128::from(campaign.price_slope_lamports)
        .checked_mul(u128::from(campaign.sold_tokens))
        .ok_or(LaunchpadError::MathOverflow)?
        .checked_div(scale)
        .ok_or(LaunchpadError::MathOverflow)?;
    base.checked_add(slope).ok_or_else(|| error!(LaunchpadError::MathOverflow))
}

pub fn graduation_quote(campaign: &CampaignView) -> Result<GraduationQuote> {
    let spot = final_spot_nano_lamports(campaign)?;
    require!(spot > 0, LaunchpadError::GraduationLiquidityZero);
    let finalize_fee = bps_amount(campaign.net_raised_lamports, campaign.finalize_fee_bps)?;
    let remaining = campaign.net_raised_lamports.checked_sub(finalize_fee).ok_or(LaunchpadError::MathOverflow)?;
    let target_liquidity = bps_amount(remaining, campaign.liquidity_post_finalize_bps)?;
    require!(target_liquidity > 0, LaunchpadError::GraduationLiquidityZero);

    let scale = token_scale(campaign.token_decimals)?;
    let desired_tokens = u128::from(target_liquidity)
        .checked_mul(scale).ok_or(LaunchpadError::MathOverflow)?
        .checked_mul(SLOPE_NANO_LAMPORT_SCALE).ok_or(LaunchpadError::MathOverflow)?
        .checked_div(spot).ok_or(LaunchpadError::MathOverflow)?;
    let max_tokens = desired_tokens.min(u128::from(campaign.liquidity_token_supply));
    require!(max_tokens > 0, LaunchpadError::GraduationLiquidityZero);
    let max_tokens_u64 = u64::try_from(max_tokens).map_err(|_| error!(LaunchpadError::MathOverflow))?;
    let liquidity_lamports = if desired_tokens <= u128::from(campaign.liquidity_token_supply) {
        target_liquidity
    } else {
        let denominator = scale.checked_mul(SLOPE_NANO_LAMPORT_SCALE).ok_or(LaunchpadError::MathOverflow)?;
        let used = max_tokens.checked_mul(spot).ok_or(LaunchpadError::MathOverflow)?
            .checked_div(denominator).ok_or(LaunchpadError::MathOverflow)?;
        u64::try_from(used).map_err(|_| error!(LaunchpadError::MathOverflow))?
    };
    require!(liquidity_lamports > 0, LaunchpadError::GraduationLiquidityZero);
    let creator_payout = remaining.checked_sub(liquidity_lamports).ok_or(LaunchpadError::MathOverflow)?;
    Ok(GraduationQuote {
        finalize_fee_lamports: finalize_fee,
        max_liquidity_lamports: liquidity_lamports,
        max_liquidity_tokens: max_tokens_u64,
        creator_payout_lamports: creator_payout,
        final_spot_nano_lamports: spot,
    })
}

fn validate_quote_binding(args: &BeginGraduationArgs) -> Result<()> {
    require!(args.quote_config_id != [0; 32], LaunchpadError::InvalidGraduationAuthorization);
    require!(args.quote_policy_version > 0, LaunchpadError::InvalidGraduationAuthorization);
    require!(args.quote_decimals <= 18, LaunchpadError::InvalidGraduationAuthorization);
    if is_native_quote(args.quote_mint) {
        require!(args.quote_profile == QUOTE_PROFILE_NATIVE, LaunchpadError::InvalidGraduationAuthorization);
        require!(args.quote_provider_class == QUOTE_PROVIDER_NATIVE, LaunchpadError::InvalidGraduationAuthorization);
        require_keys_eq!(args.acquisition_program, Pubkey::default(), LaunchpadError::InvalidGraduationAuthorization);
        require_keys_eq!(args.quote_recovery_account, Pubkey::default(), LaunchpadError::InvalidGraduationAuthorization);
        require!(args.quote_reference_usd_micros == args.oracle_price_usd_micros, LaunchpadError::InvalidGraduationAuthorization);
        require!(args.quote_decimals == 9, LaunchpadError::InvalidGraduationAuthorization);
        require!(args.max_slippage_bps == 0 && args.max_impact_bps == 0 && args.max_deviation_bps == 0, LaunchpadError::InvalidGraduationAuthorization);
    } else {
        require!(
            args.quote_profile >= QUOTE_PROFILE_STABLECOIN && args.quote_profile <= QUOTE_PROFILE_COMMUNITY,
            LaunchpadError::InvalidGraduationAuthorization
        );
        require!(args.quote_provider_class != QUOTE_PROVIDER_NATIVE, LaunchpadError::InvalidGraduationAuthorization);
        require_keys_neq!(args.acquisition_program, Pubkey::default(), LaunchpadError::InvalidGraduationAuthorization);
        require_keys_neq!(args.acquisition_program, METEORA_CP_AMM_PROGRAM_ID, LaunchpadError::InvalidGraduationAuthorization);
        require_keys_neq!(args.acquisition_program, crate::ID, LaunchpadError::InvalidGraduationAuthorization);
        require_keys_neq!(args.quote_recovery_account, Pubkey::default(), LaunchpadError::InvalidGraduationAuthorization);
        require!(args.quote_reference_usd_micros > 0, LaunchpadError::InvalidGraduationAuthorization);
        require!(args.expected_quote_amount > 0 && args.min_quote_amount > 0, LaunchpadError::InvalidGraduationAuthorization);
        require!(args.min_quote_amount <= args.expected_quote_amount, LaunchpadError::InvalidGraduationAuthorization);
        require!(args.max_slippage_bps > 0 && args.max_slippage_bps <= QUOTE_MAX_SLIPPAGE_BPS, LaunchpadError::InvalidGraduationAuthorization);
        require!(args.max_impact_bps <= QUOTE_MAX_IMPACT_BPS, LaunchpadError::InvalidGraduationAuthorization);
        require!(args.max_deviation_bps > 0 && args.max_deviation_bps <= QUOTE_MAX_DEVIATION_BPS, LaunchpadError::InvalidGraduationAuthorization);
    }
    Ok(())
}

fn is_native_quote(quote_mint: Pubkey) -> bool {
    quote_mint == spl_token::native_mint::ID
}

fn validate_price_tolerance(
    native_lamports: u64,
    token_raw: u64,
    token_decimals: u8,
    expected_spot_nano: u128,
) -> Result<()> {
    require!(native_lamports > 0 && token_raw > 0, LaunchpadError::GraduationLiquidityZero);
    require!(expected_spot_nano > 0, LaunchpadError::GraduationPriceDrift);
    let scale = token_scale(token_decimals)?;
    let actual = u128::from(native_lamports)
        .checked_mul(scale).ok_or(LaunchpadError::MathOverflow)?
        .checked_mul(SLOPE_NANO_LAMPORT_SCALE).ok_or(LaunchpadError::MathOverflow)?
        .checked_div(u128::from(token_raw)).ok_or(LaunchpadError::MathOverflow)?;
    let diff = actual.abs_diff(expected_spot_nano);
    let drift_bps = diff.checked_mul(u128::from(BPS_DENOMINATOR)).ok_or(LaunchpadError::MathOverflow)?
        .checked_div(expected_spot_nano).ok_or(LaunchpadError::MathOverflow)?;
    require!(drift_bps <= u128::from(GRADUATION_PRICE_TOLERANCE_BPS), LaunchpadError::GraduationPriceDrift);
    Ok(())
}

fn validate_quote_pool_deviation(
    quote_raw: u64,
    token_raw: u64,
    token_decimals: u8,
    quote_decimals: u8,
    final_spot_nano: u128,
    sol_usd_micros: u64,
    quote_usd_micros: u64,
    max_deviation_bps: u16,
) -> Result<()> {
    require!(quote_raw > 0 && token_raw > 0, LaunchpadError::GraduationLiquidityZero);
    require!(final_spot_nano > 0 && sol_usd_micros > 0 && quote_usd_micros > 0, LaunchpadError::GraduationPriceDrift);
    let token_scale = token_scale(token_decimals)?;
    let quote_scale = token_scale(quote_decimals)?;

    let expected_quote_per_whole = final_spot_nano
        .checked_mul(u128::from(sol_usd_micros)).ok_or(LaunchpadError::MathOverflow)?
        .checked_div(1_000_000_000_000_000_000u128).ok_or(LaunchpadError::MathOverflow)?
        .checked_mul(quote_scale).ok_or(LaunchpadError::MathOverflow)?
        .checked_div(u128::from(quote_usd_micros)).ok_or(LaunchpadError::MathOverflow)?;
    require!(expected_quote_per_whole > 0, LaunchpadError::GraduationPriceDrift);
    let actual_quote_per_whole = u128::from(quote_raw)
        .checked_mul(token_scale).ok_or(LaunchpadError::MathOverflow)?
        .checked_div(u128::from(token_raw)).ok_or(LaunchpadError::MathOverflow)?;
    let diff = actual_quote_per_whole.abs_diff(expected_quote_per_whole);
    let drift_bps = diff.checked_mul(u128::from(BPS_DENOMINATOR)).ok_or(LaunchpadError::MathOverflow)?
        .checked_div(expected_quote_per_whole).ok_or(LaunchpadError::MathOverflow)?;
    require!(drift_bps <= u128::from(max_deviation_bps), LaunchpadError::GraduationPriceDrift);
    Ok(())
}

#[inline(never)]
fn read_graduation_global(info: &AccountInfo) -> Result<(Pubkey, Pubkey)> {
    require_keys_eq!(*info.owner, crate::ID, LaunchpadError::Unauthorized);
    let data = info.try_borrow_data()?;
    let mut slice: &[u8] = &data;
    let global = Box::new(GlobalConfig::try_deserialize(&mut slice)?);
    require!(!global.paused, LaunchpadError::LaunchpadPaused);
    require!(!global.graduation_paused, LaunchpadError::GraduationPaused);
    Ok((global.route_signer, global.treasury_operator))
}

#[inline(never)]
fn validate_generation_binding(campaign: &CampaignView, generation_info: &AccountInfo) -> Result<()> {
    require_keys_eq!(campaign.generation_config, *generation_info.key, LaunchpadError::InvalidGeneration);
    let (expected, _) = Pubkey::find_program_address(
        &[GENERATION_CONFIG_SEED, campaign.generation_id.as_ref()],
        &crate::ID,
    );
    require_keys_eq!(*generation_info.key, expected, LaunchpadError::InvalidGeneration);
    require_keys_eq!(*generation_info.owner, crate::ID, LaunchpadError::InvalidGeneration);
    let data = generation_info.try_borrow_data()?;
    let mut slice: &[u8] = &data;
    let generation = Box::new(GenerationConfig::try_deserialize(&mut slice)?);
    require!(campaign.generation_id == generation.generation_id, LaunchpadError::InvalidGeneration);
    require!(generation.support_enabled, LaunchpadError::InvalidGeneration);
    require!(generation.dex_adapter == DEX_ADAPTER_METEORA_DAMM_V2, LaunchpadError::InvalidDexAdapter);
    Ok(())
}

fn validate_campaign_accounts(
    campaign: &CampaignView,
    campaign_key: Pubkey,
    mint: Pubkey,
    token_vault: Pubkey,
    sol_vault: Pubkey,
) -> Result<()> {
    require_keys_eq!(campaign.mint, mint, LaunchpadError::InvalidCampaign);
    require_keys_eq!(campaign.token_vault, token_vault, LaunchpadError::InvalidCampaign);
    require_keys_eq!(campaign.sol_vault, sol_vault, LaunchpadError::InvalidCampaign);
    let (expected_campaign, _) = Pubkey::find_program_address(&[CAMPAIGN_SEED, campaign.campaign_id.as_ref()], &crate::ID);
    require_keys_eq!(campaign_key, expected_campaign, LaunchpadError::InvalidCampaign);
    let (expected_token_vault, _) = Pubkey::find_program_address(&[TOKEN_VAULT_SEED, campaign.campaign_id.as_ref()], &crate::ID);
    let (expected_sol_vault, _) = Pubkey::find_program_address(&[SOL_VAULT_SEED, campaign.campaign_id.as_ref()], &crate::ID);
    require_keys_eq!(token_vault, expected_token_vault, LaunchpadError::InvalidCampaign);
    require_keys_eq!(sol_vault, expected_sol_vault, LaunchpadError::InvalidCampaign);
    Ok(())
}

fn validate_meteora_pool(
    pool_info: &AccountInfo,
    launch_mint: Pubkey,
    quote_mint: Pubkey,
    supplied_launch_vault: Pubkey,
    supplied_quote_vault: Pubkey,
) -> Result<(Pubkey, Pubkey, Pubkey, Pubkey)> {
    require_keys_eq!(*pool_info.owner, METEORA_CP_AMM_PROGRAM_ID, LaunchpadError::InvalidMeteoraPool);
    let expected_pool = derive_meteora_pool_for_quote(launch_mint, quote_mint);
    require_keys_eq!(*pool_info.key, expected_pool, LaunchpadError::InvalidMeteoraPool);
    let data = pool_info.try_borrow_data()?;
    require!(data.len() >= METEORA_POOL_MIN_LEN, LaunchpadError::InvalidMeteoraPool);
    let token_a = read_pubkey(&data, METEORA_POOL_TOKEN_A_MINT_OFFSET)?;
    let token_b = read_pubkey(&data, METEORA_POOL_TOKEN_B_MINT_OFFSET)?;
    let vault_a = read_pubkey(&data, METEORA_POOL_TOKEN_A_VAULT_OFFSET)?;
    let vault_b = read_pubkey(&data, METEORA_POOL_TOKEN_B_VAULT_OFFSET)?;
    let pair_ok = (token_a == launch_mint && token_b == quote_mint)
        || (token_a == quote_mint && token_b == launch_mint);
    require!(pair_ok, LaunchpadError::InvalidMeteoraPool);

    let expected_launch_vault = derive_meteora_token_vault(launch_mint, expected_pool);
    let expected_quote_vault = derive_meteora_token_vault(quote_mint, expected_pool);
    require_keys_eq!(supplied_launch_vault, expected_launch_vault, LaunchpadError::InvalidMeteoraPool);
    require_keys_eq!(supplied_quote_vault, expected_quote_vault, LaunchpadError::InvalidMeteoraPool);
    if token_a == launch_mint {
        require_keys_eq!(vault_a, expected_launch_vault, LaunchpadError::InvalidMeteoraPool);
        require_keys_eq!(vault_b, expected_quote_vault, LaunchpadError::InvalidMeteoraPool);
    } else {
        require_keys_eq!(vault_b, expected_launch_vault, LaunchpadError::InvalidMeteoraPool);
        require_keys_eq!(vault_a, expected_quote_vault, LaunchpadError::InvalidMeteoraPool);
    }
    Ok((token_a, token_b, vault_a, vault_b))
}

fn validate_meteora_position(
    position_info: &AccountInfo,
    expected_pool: Pubkey,
    expected_nft_mint: Pubkey,
) -> Result<()> {
    require_keys_eq!(*position_info.owner, METEORA_CP_AMM_PROGRAM_ID, LaunchpadError::InvalidMeteoraPosition);
    let expected_position = derive_meteora_position(expected_nft_mint);
    require_keys_eq!(*position_info.key, expected_position, LaunchpadError::InvalidMeteoraPosition);
    let data = position_info.try_borrow_data()?;
    require!(data.len() >= METEORA_POSITION_MIN_LEN, LaunchpadError::InvalidMeteoraPosition);
    require_keys_eq!(read_pubkey(&data, METEORA_POSITION_POOL_OFFSET)?, expected_pool, LaunchpadError::InvalidMeteoraPosition);
    require_keys_eq!(read_pubkey(&data, METEORA_POSITION_NFT_MINT_OFFSET)?, expected_nft_mint, LaunchpadError::InvalidMeteoraPosition);
    let unlocked = read_u128(&data, METEORA_POSITION_UNLOCKED_LIQUIDITY_OFFSET)?;
    let permanent = read_u128(&data, METEORA_POSITION_PERMANENT_LOCKED_LIQUIDITY_OFFSET)?;
    require!(unlocked == 0, LaunchpadError::MeteoraLiquidityNotLocked);
    require!(permanent > 0, LaunchpadError::MeteoraLiquidityNotLocked);
    Ok(())
}

pub fn derive_meteora_pool(launch_mint: Pubkey) -> Pubkey {
    derive_meteora_pool_for_quote(launch_mint, spl_token::native_mint::ID)
}

pub fn derive_meteora_pool_for_quote(launch_mint: Pubkey, quote_mint: Pubkey) -> Pubkey {
    let (first, second) = ordered_pubkeys(launch_mint, quote_mint);
    Pubkey::find_program_address(&[b"cpool", first.as_ref(), second.as_ref()], &METEORA_CP_AMM_PROGRAM_ID).0
}

pub fn derive_meteora_position(position_nft_mint: Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"position", position_nft_mint.as_ref()], &METEORA_CP_AMM_PROGRAM_ID).0
}

pub fn derive_meteora_token_vault(mint: Pubkey, pool: Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"token_vault", mint.as_ref(), pool.as_ref()], &METEORA_CP_AMM_PROGRAM_ID).0
}

fn ordered_pubkeys(a: Pubkey, b: Pubkey) -> (Pubkey, Pubkey) {
    if a.to_bytes() > b.to_bytes() { (a, b) } else { (b, a) }
}

fn build_graduation_authorization_digest(
    program_id: Pubkey,
    campaign: Pubkey,
    mint: Pubkey,
    authority: Pubkey,
    graduation_target_usd_micros: u64,
    args: &BeginGraduationArgs,
    meteora_pool: Pubkey,
    meteora_position: Pubkey,
) -> [u8; 32] {
    let mut message = Vec::with_capacity(640);
    message.extend_from_slice(GRADUATION_AUTH_DOMAIN);
    message.extend_from_slice(&GRADUATION_AUTH_SCHEMA_VERSION.to_le_bytes());
    message.extend_from_slice(program_id.as_ref());
    message.extend_from_slice(campaign.as_ref());
    message.extend_from_slice(mint.as_ref());
    message.extend_from_slice(authority.as_ref());
    message.extend_from_slice(&graduation_target_usd_micros.to_le_bytes());
    message.extend_from_slice(&args.native_target_lamports.to_le_bytes());
    message.extend_from_slice(&args.oracle_price_usd_micros.to_le_bytes());
    message.extend_from_slice(meteora_pool.as_ref());
    message.extend_from_slice(meteora_position.as_ref());
    message.extend_from_slice(args.position_nft_mint.as_ref());
    message.extend_from_slice(&args.deadline.to_le_bytes());
    message.extend_from_slice(&args.nonce);
    message.push(args.finalize_route_profile);
    message.extend_from_slice(args.quote_mint.as_ref());
    message.extend_from_slice(&args.quote_config_id);
    message.extend_from_slice(&args.quote_policy_version.to_le_bytes());
    message.push(args.quote_profile);
    message.push(args.quote_provider_class);
    message.extend_from_slice(args.acquisition_program.as_ref());
    message.extend_from_slice(&args.quote_reference_usd_micros.to_le_bytes());
    message.push(args.quote_decimals);
    message.extend_from_slice(&args.expected_quote_amount.to_le_bytes());
    message.extend_from_slice(&args.min_quote_amount.to_le_bytes());
    message.extend_from_slice(&args.max_slippage_bps.to_le_bytes());
    message.extend_from_slice(&args.max_impact_bps.to_le_bytes());
    message.extend_from_slice(&args.max_deviation_bps.to_le_bytes());
    message.extend_from_slice(args.quote_recovery_account.as_ref());
    hash(&message).to_bytes()
}

pub fn native_target_lamports_from_usd(
    graduation_target_usd_micros: u64,
    oracle_price_usd_micros: u64,
) -> Result<u64> {
    require!(graduation_target_usd_micros > 0 && oracle_price_usd_micros > 0, LaunchpadError::InvalidGraduationTarget);
    let numer = u128::from(graduation_target_usd_micros)
        .checked_mul(1_000_000_000).ok_or(LaunchpadError::MathOverflow)?
        .checked_add(u128::from(oracle_price_usd_micros)).ok_or(LaunchpadError::MathOverflow)?
        .checked_sub(1).ok_or(LaunchpadError::MathOverflow)?;
    let native = numer.checked_div(u128::from(oracle_price_usd_micros)).ok_or(LaunchpadError::MathOverflow)?;
    require!(native > 0 && native <= u128::from(u64::MAX), LaunchpadError::InvalidGraduationTarget);
    Ok(native as u64)
}

fn verify_detached_graduation_authorization(
    instructions_sysvar: &AccountInfo,
    expected_route_signer: Pubkey,
    expected_message: &[u8; 32],
) -> Result<()> {
    let current_index = load_current_index_checked(instructions_sysvar)
        .map_err(|_| error!(LaunchpadError::InvalidGraduationAuthorization))?;
    require!(current_index > 0, LaunchpadError::InvalidGraduationAuthorization);
    let ed25519_index = current_index.checked_sub(1).ok_or(LaunchpadError::InvalidGraduationAuthorization)?;
    let instruction = load_instruction_at_checked(usize::from(ed25519_index), instructions_sysvar)
        .map_err(|_| error!(LaunchpadError::InvalidGraduationAuthorization))?;
    require_keys_eq!(instruction.program_id, ed25519_program::ID, LaunchpadError::InvalidGraduationAuthorization);
    require!(instruction.accounts.is_empty(), LaunchpadError::InvalidGraduationAuthorization);
    let parsed = parse_single_ed25519_instruction(&instruction.data)?;
    require!(parsed.public_key == expected_route_signer.as_ref(), LaunchpadError::InvalidGraduationAuthorization);
    require!(parsed.message == expected_message, LaunchpadError::InvalidGraduationAuthorization);
    Ok(())
}

fn require_atomic_route_meteora_then_confirm(
    instructions_sysvar: &AccountInfo,
    quote_mint: Pubkey,
    acquisition_program: Pubkey,
) -> Result<()> {
    let current_index = usize::from(
        load_current_index_checked(instructions_sysvar)
            .map_err(|_| error!(LaunchpadError::GraduationAtomicityRequired))?,
    );
    let confirm_hash = hash(b"global:confirm_graduation").to_bytes();
    let confirm_discriminator = &confirm_hash[..8];
    let requires_acquisition = !is_native_quote(quote_mint);
    let mut saw_acquisition = !requires_acquisition;
    let mut saw_meteora = false;
    for index in (current_index + 1)..(current_index + MAX_ATOMIC_SCAN_INSTRUCTIONS) {
        let instruction = match load_instruction_at_checked(index, instructions_sysvar) {
            Ok(ix) => ix,
            Err(_) => break,
        };
        if requires_acquisition && instruction.program_id == acquisition_program {
            require!(!saw_meteora, LaunchpadError::GraduationAtomicityRequired);
            saw_acquisition = true;
            continue;
        }
        if instruction.program_id == METEORA_CP_AMM_PROGRAM_ID {
            require!(saw_acquisition, LaunchpadError::GraduationAtomicityRequired);
            saw_meteora = true;
            continue;
        }
        if instruction.program_id == crate::ID
            && instruction.data.len() >= 8
            && &instruction.data[..8] == confirm_discriminator
        {
            require!(saw_acquisition && saw_meteora, LaunchpadError::GraduationAtomicityRequired);
            return Ok(());
        }
    }
    err!(LaunchpadError::GraduationAtomicityRequired)
}

struct ParsedEd25519Instruction<'a> {
    public_key: &'a [u8],
    message: &'a [u8],
}

fn parse_single_ed25519_instruction(data: &[u8]) -> Result<ParsedEd25519Instruction<'_>> {
    require!(data.len() >= ED25519_HEADER_SIZE, LaunchpadError::InvalidGraduationAuthorization);
    require!(data[0] == 1 && data[1] == 0, LaunchpadError::InvalidGraduationAuthorization);
    let signature_offset = read_u16(data, 2)?;
    let signature_instruction_index = read_u16(data, 4)?;
    let public_key_offset = read_u16(data, 6)?;
    let public_key_instruction_index = read_u16(data, 8)?;
    let message_data_offset = read_u16(data, 10)?;
    let message_data_size = read_u16(data, 12)?;
    let message_instruction_index = read_u16(data, 14)?;
    require!(
        signature_instruction_index == ED25519_CURRENT_INSTRUCTION
            && public_key_instruction_index == ED25519_CURRENT_INSTRUCTION
            && message_instruction_index == ED25519_CURRENT_INSTRUCTION,
        LaunchpadError::InvalidGraduationAuthorization
    );
    checked_slice(data, signature_offset, ED25519_SIGNATURE_SIZE)?;
    let public_key = checked_slice(data, public_key_offset, ED25519_PUBLIC_KEY_SIZE)?;
    let message = checked_slice(data, message_data_offset, usize::from(message_data_size))?;
    Ok(ParsedEd25519Instruction { public_key, message })
}

fn unpack_spl_account(info: &AccountInfo) -> Result<SplTokenAccount> {
    require_keys_eq!(*info.owner, token::ID, LaunchpadError::InvalidCampaign);
    SplTokenAccount::unpack(&info.try_borrow_data()?).map_err(|_| error!(LaunchpadError::InvalidCampaign))
}

fn update_creator_profile_after_graduation(info: &AccountInfo, creator: Pubkey) -> Result<()> {
    let (expected, _) = Pubkey::find_program_address(&[CREATOR_PROFILE_SEED, creator.as_ref()], &crate::ID);
    require_keys_eq!(*info.key, expected, LaunchpadError::InvalidCreatorProfile);
    require_keys_eq!(*info.owner, crate::ID, LaunchpadError::InvalidCreatorProfile);
    let mut data = info.try_borrow_mut_data()?;
    let mut slice: &[u8] = &data;
    let mut profile = CreatorProfile::try_deserialize(&mut slice)?;
    require_keys_eq!(profile.wallet, creator, LaunchpadError::InvalidCreatorProfile);
    profile.live_bonding_count = profile.live_bonding_count.checked_sub(1).ok_or(LaunchpadError::MathOverflow)?;
    profile.successful_graduations = profile.successful_graduations.checked_add(1).ok_or(LaunchpadError::MathOverflow)?;
    let mut cursor = std::io::Cursor::new(&mut data[..]);
    profile.try_serialize(&mut cursor)
}

fn move_program_owned_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    if amount == 0 { return Ok(()); }
    require_keys_eq!(*from.owner, crate::ID, LaunchpadError::InvalidCampaign);
    let rent_floor = Rent::get()?.minimum_balance(from.data_len());
    let remaining = from.lamports().checked_sub(amount).ok_or(LaunchpadError::InsufficientVaultBalance)?;
    require!(remaining >= rent_floor, LaunchpadError::InsufficientVaultBalance);
    **from.try_borrow_mut_lamports()? = remaining;
    **to.try_borrow_mut_lamports()? = to.lamports().checked_add(amount).ok_or(LaunchpadError::MathOverflow)?;
    Ok(())
}

fn token_scale(decimals: u8) -> Result<u128> {
    require!(decimals <= 18, LaunchpadError::InvalidGenerationEconomics);
    10u128.checked_pow(u32::from(decimals)).ok_or_else(|| error!(LaunchpadError::MathOverflow))
}

fn bps_amount(amount: u64, bps: u16) -> Result<u64> {
    let value = u128::from(amount)
        .checked_mul(u128::from(bps)).ok_or(LaunchpadError::MathOverflow)?
        .checked_div(u128::from(BPS_DENOMINATOR)).ok_or(LaunchpadError::MathOverflow)?;
    u64::try_from(value).map_err(|_| error!(LaunchpadError::MathOverflow))
}

fn read_pubkey(data: &[u8], offset: usize) -> Result<Pubkey> {
    let bytes = checked_bytes(data, offset, 32)?;
    let array: [u8; 32] = bytes.try_into().map_err(|_| error!(LaunchpadError::InvalidMeteoraPool))?;
    Ok(Pubkey::new_from_array(array))
}

fn read_u128(data: &[u8], offset: usize) -> Result<u128> {
    let bytes = checked_bytes(data, offset, 16)?;
    let array: [u8; 16] = bytes.try_into().map_err(|_| error!(LaunchpadError::InvalidMeteoraPosition))?;
    Ok(u128::from_le_bytes(array))
}

fn checked_bytes(data: &[u8], offset: usize, len: usize) -> Result<&[u8]> {
    let end = offset.checked_add(len).ok_or(LaunchpadError::MathOverflow)?;
    require!(end <= data.len(), LaunchpadError::InvalidMeteoraPool);
    Ok(&data[offset..end])
}

fn read_u16(data: &[u8], offset: usize) -> Result<u16> {
    let bytes = checked_bytes(data, offset, 2)?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn checked_slice(data: &[u8], offset: u16, len: usize) -> Result<&[u8]> {
    checked_bytes(data, usize::from(offset), len).map_err(|_| error!(LaunchpadError::InvalidGraduationAuthorization))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn campaign_for_quote() -> Campaign {
        Campaign {
            campaign_id: [1; 32],
            generation_id: [2; 32],
            generation_config: Pubkey::new_unique(),
            generation_manifest_hash: [3; 32],
            creator: Pubkey::new_unique(),
            mint: Pubkey::new_unique(),
            token_vault: Pubkey::new_unique(),
            sol_vault: Pubkey::new_unique(),
            metadata_hash: [4; 32],
            cluster_hash: [5; 32],
            ticker_hash: [6; 32],
            reservation_id_hash: [7; 32],
            reservation_version: 1,
            launch_at: 0,
            graduation_target_usd_micros: 6_000_000,
            cluster_kind: 1,
            economics_version: ECONOMICS_VERSION_V3,
            curve_kind: 1,
            token_total_supply: 1_000_000_000_000_000,
            curve_token_supply: 840_000_000_000_000,
            liquidity_token_supply: 140_000_000_000_000,
            reserve_token_supply: 20_000_000_000_000,
            token_decimals: 6,
            curve_supply_bps: 8400,
            liquidity_token_bps: 1400,
            base_price_lamports: 1,
            price_slope_lamports: 850,
            buy_fee_bps: 200,
            sell_fee_bps: 200,
            finalize_fee_bps: 200,
            creator_post_finalize_bps: 2000,
            liquidity_post_finalize_bps: 8000,
            dex_adapter: DEX_ADAPTER_METEORA_DAMM_V2,
            trade_route_profile: [8; 32],
            finalize_route_profile: [9; 32],
            treasury_profile: [10; 32],
            dex_profile: [11; 32],
            oracle_profile: [12; 32],
            creator_buy_lock_until: 0,
            creator_buy_cap_bps: 1000,
            created_at: 0,
            sold_tokens: 10_000_000_000_000,
            net_raised_lamports: 40_000_000,
            total_buy_volume_lamports: 40_000_000,
            total_sell_volume_lamports: 0,
            buyer_count: 1,
            creator_bought_tokens: 0,
            asset_initialization_version: 1,
            mint_authority_revoked: true,
            graduated: false,
            curve_closed: false,
            paused: false,
            bump: 255,
            mint_bump: 254,
            token_vault_bump: 253,
            sol_vault_bump: 252,
        }
    }

    fn native_args() -> BeginGraduationArgs {
        BeginGraduationArgs {
            native_target_lamports: 40_000_000,
            oracle_price_usd_micros: 150_000_000,
            deadline: 1_900_000_000,
            nonce: [13; 32],
            position_nft_mint: Pubkey::new_unique(),
            finalize_route_profile: 1,
            quote_mint: spl_token::native_mint::ID,
            quote_config_id: [14; 32],
            quote_policy_version: 1,
            quote_profile: QUOTE_PROFILE_NATIVE,
            quote_provider_class: QUOTE_PROVIDER_NATIVE,
            acquisition_program: Pubkey::default(),
            quote_reference_usd_micros: 150_000_000,
            quote_decimals: 9,
            expected_quote_amount: 0,
            min_quote_amount: 0,
            max_slippage_bps: 0,
            max_impact_bps: 0,
            max_deviation_bps: 0,
            quote_recovery_account: Pubkey::default(),
        }
    }

    #[test]
    fn v3_spot_rises_with_sold_supply() {
        let mut c = campaign_for_quote();
        c.sold_tokens = 0;
        let first = final_spot_nano_lamports(&campaign_view_from_campaign(&c)).unwrap();
        c.sold_tokens = 1_000_000_000_000;
        let second = final_spot_nano_lamports(&campaign_view_from_campaign(&c)).unwrap();
        assert!(second > first);
        assert_eq!(first, 1_000_000_000);
    }

    #[test]
    fn graduation_quote_conserves_net_principal() {
        let c = campaign_for_quote();
        let view = campaign_view_from_campaign(&c);
        let q = graduation_quote(&view).unwrap();
        assert!(q.max_liquidity_tokens > 0);
        assert!(q.max_liquidity_lamports > 0);
        assert_eq!(q.finalize_fee_lamports + q.max_liquidity_lamports + q.creator_payout_lamports, view.net_raised_lamports);
    }

    #[test]
    fn native_pool_derivation_regression_is_unchanged() {
        let mint = Pubkey::new_unique();
        assert_eq!(derive_meteora_pool(mint), derive_meteora_pool_for_quote(mint, spl_token::native_mint::ID));
    }

    #[test]
    fn quote_pool_derivation_is_generic_and_deterministic() {
        let mint = Pubkey::new_unique();
        let quote = Pubkey::new_unique();
        let first = derive_meteora_pool_for_quote(mint, quote);
        assert_eq!(first, derive_meteora_pool_for_quote(mint, quote));
        assert_ne!(first, derive_meteora_pool(mint));
    }

    #[test]
    fn native_quote_binding_requires_direct_native_profile() {
        let args = native_args();
        assert!(validate_quote_binding(&args).is_ok());
        let mut bad = args;
        bad.quote_profile = QUOTE_PROFILE_STABLECOIN;
        assert!(validate_quote_binding(&bad).is_err());
    }

    #[test]
    fn ordinary_approved_quote_is_not_mint_hardcoded() {
        let mut args = native_args();
        args.quote_mint = Pubkey::new_unique();
        args.quote_profile = QUOTE_PROFILE_STABLECOIN;
        args.quote_provider_class = 1;
        args.acquisition_program = Pubkey::new_unique();
        args.quote_reference_usd_micros = 1_000_000;
        args.quote_decimals = 6;
        args.expected_quote_amount = 20_000_000;
        args.min_quote_amount = 19_900_000;
        args.max_slippage_bps = 50;
        args.max_impact_bps = 25;
        args.max_deviation_bps = 100;
        args.quote_recovery_account = Pubkey::new_unique();
        assert!(validate_quote_binding(&args).is_ok());

        args.quote_profile = QUOTE_PROFILE_PROVIDER_RWA;
        args.quote_config_id = [15; 32];
        assert!(validate_quote_binding(&args).is_ok());
    }

    #[test]
    fn unsafe_quote_limits_fail_closed() {
        let mut args = native_args();
        args.quote_mint = Pubkey::new_unique();
        args.quote_profile = QUOTE_PROFILE_STABLECOIN;
        args.quote_provider_class = 1;
        args.acquisition_program = Pubkey::new_unique();
        args.quote_reference_usd_micros = 1_000_000;
        args.quote_decimals = 6;
        args.expected_quote_amount = 20_000_000;
        args.min_quote_amount = 19_000_000;
        args.max_slippage_bps = QUOTE_MAX_SLIPPAGE_BPS + 1;
        args.max_impact_bps = 25;
        args.max_deviation_bps = 100;
        args.quote_recovery_account = Pubkey::new_unique();
        assert!(validate_quote_binding(&args).is_err());
    }

    #[test]
    fn price_tolerance_accepts_exact_ratio_and_rejects_large_drift() {
        assert!(validate_price_tolerance(50, 10_000_000, 6, 5_000_000_000).is_ok());
        assert!(validate_price_tolerance(60, 10_000_000, 6, 5_000_000_000).is_err());
    }

    #[test]
    fn native_target_matches_ceil_usd_conversion() {
        assert_eq!(native_target_lamports_from_usd(6_000_000, 150_000_000).unwrap(), 40_000_000);
        assert!(native_target_lamports_from_usd(6_000_000, 0).is_err());
    }
}
