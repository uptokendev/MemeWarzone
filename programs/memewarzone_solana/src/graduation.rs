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
pub const GRADUATION_AUTH_SCHEMA_VERSION: u16 = 4;
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
    pub liquidity_lamports: u64,
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
    /// CHECK: PDA-constrained GlobalConfig; handler parses and validates the stored route signer and treasury operator.
    #[account(seeds = [GLOBAL_CONFIG_SEED], bump)]
    pub global_config: UncheckedAccount<'info>,
    /// CHECK: Handler validates ownership, PDA identity, activation, economics, and exact campaign generation binding.
    pub generation_config: UncheckedAccount<'info>,
    /// CHECK: Handler loads the program-owned campaign and validates its deterministic campaign, mint, token-vault, and SOL-vault bindings.
    #[account(mut)]
    pub campaign: UncheckedAccount<'info>,
    /// CHECK: Handler requires this key to equal the mint recorded in the validated campaign.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: Handler requires this key to equal the deterministic token vault recorded in the validated campaign.
    #[account(mut)]
    pub token_vault: UncheckedAccount<'info>,
    /// CHECK: Handler requires this key to equal the deterministic SOL vault recorded in the validated campaign.
    #[account(mut)]
    pub sol_vault: UncheckedAccount<'info>,
    /// CHECK: PDA-constrained FeeEscrow; handler verifies it is the campaign escrow and empty before graduation.
    #[account(seeds = [FEE_ESCROW_SEED, campaign.key().as_ref()], bump)]
    pub fee_escrow: UncheckedAccount<'info>,
    /// CHECK: Handler unpacks this SPL token account and validates campaign mint, authority ownership, and empty staging balance.
    #[account(mut)]
    pub authority_token_account: UncheckedAccount<'info>,
    /// CHECK: Handler derives the exact Meteora MEME/QUOTE pool address and requires the account to be empty before creation.
    pub meteora_pool: UncheckedAccount<'info>,
    /// CHECK: Handler derives the exact Meteora position address and requires the account to be empty before creation.
    pub meteora_position: UncheckedAccount<'info>,
    pub position_nft_mint: Signer<'info>,
    #[account(init, payer = authority, space = 8 + GraduationState::INIT_SPACE, seeds = [GRADUATION_SEED, campaign.key().as_ref()], bump)]
    pub graduation_state: Account<'info, GraduationState>,
    /// CHECK: Address-constrained instructions sysvar; handler parses it to verify Ed25519 authorization and atomic instruction ordering.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ConfirmGraduation<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: PDA-constrained GlobalConfig; handler parses and validates the treasury operator.
    #[account(seeds = [GLOBAL_CONFIG_SEED], bump)]
    pub global_config: UncheckedAccount<'info>,
    /// CHECK: Handler loads the program-owned campaign and validates its deterministic account bindings and lifecycle state.
    #[account(mut)]
    pub campaign: UncheckedAccount<'info>,
    /// CHECK: Handler requires this key to equal the mint recorded in the validated campaign.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: Handler requires this key to equal the deterministic campaign token vault before transfers and burns.
    #[account(mut)]
    pub token_vault: UncheckedAccount<'info>,
    /// CHECK: Handler requires this key to equal the deterministic campaign SOL vault before settlement.
    #[account(mut)]
    pub sol_vault: UncheckedAccount<'info>,
    /// CHECK: Handler unpacks this SPL staging account and validates its campaign mint and authority ownership.
    #[account(mut)]
    pub authority_token_account: UncheckedAccount<'info>,
    /// CHECK: Handler requires this key to equal the creator recorded in the validated campaign.
    #[account(mut)]
    pub creator: UncheckedAccount<'info>,
    /// CHECK: Handler unpacks and validates this SPL token account against the campaign mint and creator owner.
    #[account(mut)]
    pub creator_token_account: UncheckedAccount<'info>,
    /// CHECK: Handler validates the creator-profile PDA, ownership, and wallet binding before updating graduation counters.
    #[account(mut)]
    pub creator_profile: UncheckedAccount<'info>,
    #[account(mut, seeds = [GRADUATION_SEED, campaign.key().as_ref()], bump = graduation_state.bump, has_one = campaign, has_one = authority, has_one = mint)]
    pub graduation_state: Account<'info, GraduationState>,
    /// CHECK: Handler validates Meteora owner, deterministic pool identity, both mints, and vault keys from account data.
    pub meteora_pool: UncheckedAccount<'info>,
    /// CHECK: Handler validates Meteora owner, pool binding, NFT mint, and permanent-liquidity lock state.
    pub meteora_position: UncheckedAccount<'info>,
    /// CHECK: Handler unpacks and validates this SPL pool vault against the launch-token mint and validated pool state.
    pub meteora_token_vault: UncheckedAccount<'info>,
    /// CHECK: Handler unpacks and validates this SPL pool vault against the signed quote mint and validated pool state.
    pub meteora_native_vault: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn begin_graduation_handler(
    ctx: Context<BeginGraduation>,
    args: BeginGraduationArgs,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        args.deadline >= now,
        LaunchpadError::GraduationAuthorizationExpired
    );
    require!(
        args.native_target_lamports > 0 && args.oracle_price_usd_micros > 0,
        LaunchpadError::InvalidGraduationTarget
    );
    validate_route_profile_id(args.finalize_route_profile)?;
    validate_quote_binding(&args)?;
    require_keys_eq!(
        args.position_nft_mint,
        ctx.accounts.position_nft_mint.key(),
        LaunchpadError::InvalidMeteoraPosition
    );
    let (route_signer, treasury_operator) =
        read_graduation_global(&ctx.accounts.global_config.to_account_info())?;
    require_keys_eq!(
        treasury_operator,
        ctx.accounts.authority.key(),
        LaunchpadError::Unauthorized
    );

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
    require_keys_neq!(
        args.quote_mint,
        campaign.mint,
        LaunchpadError::InvalidGraduationAuthorization
    );
    require_fee_escrow_empty(&ctx.accounts.fee_escrow.to_account_info(), campaign_key)?;
    require!(
        args.native_target_lamports
            == native_target_lamports_from_usd(
                campaign.graduation_target_usd_micros,
                args.oracle_price_usd_micros
            )?,
        LaunchpadError::InvalidGraduationTarget
    );
    require!(
        campaign.economics_version >= ECONOMICS_VERSION_V3,
        LaunchpadError::InvalidGenerationEconomics
    );
    require!(
        campaign.dex_adapter == DEX_ADAPTER_METEORA_DAMM_V2,
        LaunchpadError::InvalidDexAdapter
    );
    validate_generation_binding(&campaign, &ctx.accounts.generation_config.to_account_info())?;
    require!(
        campaign.sold_tokens >= campaign.curve_token_supply
            || campaign.net_raised_lamports >= args.native_target_lamports,
        LaunchpadError::GraduationThresholdNotMet
    );
    require!(
        ctx.accounts.meteora_pool.lamports() == 0 && ctx.accounts.meteora_pool.data_is_empty(),
        LaunchpadError::MeteoraPoolAlreadyExists
    );
    require!(
        ctx.accounts.meteora_position.lamports() == 0
            && ctx.accounts.meteora_position.data_is_empty(),
        LaunchpadError::MeteoraPositionAlreadyExists
    );

    let expected_pool = derive_meteora_pool_for_quote(campaign.mint, args.quote_mint);
    require_keys_eq!(
        expected_pool,
        ctx.accounts.meteora_pool.key(),
        LaunchpadError::InvalidMeteoraPool
    );
    let expected_position = derive_meteora_position(args.position_nft_mint);
    require_keys_eq!(
        expected_position,
        ctx.accounts.meteora_position.key(),
        LaunchpadError::InvalidMeteoraPosition
    );
    let staging = unpack_spl_account(&ctx.accounts.authority_token_account.to_account_info())?;
    require_keys_eq!(staging.mint, campaign.mint, LaunchpadError::InvalidCampaign);
    require_keys_eq!(
        staging.owner,
        ctx.accounts.authority.key(),
        LaunchpadError::Unauthorized
    );
    require!(
        staging.amount == 0,
        LaunchpadError::GraduationStagingNotEmpty
    );

    let digest = build_graduation_authorization_digest(
        crate::ID,
        campaign_key,
        campaign.mint,
        ctx.accounts.authority.key(),
        campaign.generation_config,
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
    require!(
        quote.max_liquidity_tokens > 0 && quote.max_liquidity_lamports > 0,
        LaunchpadError::GraduationLiquidityZero
    );
    if is_native_quote(args.quote_mint) {
        require!(
            args.expected_quote_amount == 0 && args.min_quote_amount == 0,
            LaunchpadError::InvalidGraduationAuthorization
        );
    } else {
        require!(
            args.expected_quote_amount >= args.min_quote_amount && args.min_quote_amount > 0,
            LaunchpadError::InvalidGraduationAuthorization
        );
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
        quote_provider_class: state.quote_provider_class
    });
    Ok(())
}

pub fn confirm_graduation_handler<'info>(
    ctx: Context<'_, '_, '_, 'info, ConfirmGraduation<'info>>,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let (_route_signer, treasury_operator) =
        read_graduation_global(&ctx.accounts.global_config.to_account_info())?;
    require_keys_eq!(
        treasury_operator,
        ctx.accounts.authority.key(),
        LaunchpadError::Unauthorized
    );
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
    require_keys_eq!(
        campaign.creator,
        ctx.accounts.creator.key(),
        LaunchpadError::InvalidCampaign
    );
    let state = &ctx.accounts.graduation_state;
    require!(!state.finalized, LaunchpadError::AlreadyGraduated);
    require_keys_eq!(
        state.meteora_pool,
        ctx.accounts.meteora_pool.key(),
        LaunchpadError::InvalidMeteoraPool
    );
    require_keys_eq!(
        state.meteora_position,
        ctx.accounts.meteora_position.key(),
        LaunchpadError::InvalidMeteoraPosition
    );
    validate_meteora_pool(
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
    require_keys_eq!(
        pool_token.mint,
        campaign.mint,
        LaunchpadError::InvalidMeteoraPool
    );
    require_keys_eq!(
        pool_quote.mint,
        state.quote_mint,
        LaunchpadError::InvalidMeteoraPool
    );
    require!(
        pool_token.amount > 0 && pool_quote.amount > 0,
        LaunchpadError::GraduationLiquidityZero
    );
    require!(
        pool_token.amount <= state.max_liquidity_tokens,
        LaunchpadError::GraduationAssetMismatch
    );
    let native_quote = is_native_quote(state.quote_mint);
    if native_quote {
        require!(
            pool_quote.amount <= state.max_liquidity_lamports,
            LaunchpadError::GraduationAssetMismatch
        );
        validate_price_tolerance(
            pool_quote.amount,
            pool_token.amount,
            campaign.token_decimals,
            state.final_spot_nano_lamports,
        )?;
    } else {
        require!(
            pool_quote.amount <= state.expected_quote_amount
                && pool_quote.amount >= state.min_quote_amount,
            LaunchpadError::GraduationAssetMismatch
        );
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
    require_keys_eq!(
        staging.owner,
        ctx.accounts.authority.key(),
        LaunchpadError::Unauthorized
    );
    require!(
        staging
            .amount
            .checked_add(pool_token.amount)
            .ok_or(LaunchpadError::MathOverflow)?
            == state.max_liquidity_tokens,
        LaunchpadError::GraduationAssetMismatch
    );
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
        require!(
            ctx.remaining_accounts.len() >= NON_NATIVE_REMAINING_PREFIX,
            LaunchpadError::InvalidGraduationAuthorization
        );
        let quote_mint_info = &ctx.remaining_accounts[0];
        let authority_quote_info = &ctx.remaining_accounts[1];
        let recovery_info = &ctx.remaining_accounts[2];
        require_keys_eq!(
            *quote_mint_info.key,
            state.quote_mint,
            LaunchpadError::InvalidGraduationAuthorization
        );
        require_keys_eq!(
            *quote_mint_info.owner,
            token::ID,
            LaunchpadError::InvalidGraduationAuthorization
        );
        let authority_quote = unpack_spl_account(authority_quote_info)?;
        let recovery = unpack_spl_account(recovery_info)?;
        require_keys_eq!(
            authority_quote.mint,
            state.quote_mint,
            LaunchpadError::InvalidGraduationAuthorization
        );
        require_keys_eq!(
            authority_quote.owner,
            ctx.accounts.authority.key(),
            LaunchpadError::Unauthorized
        );
        require_keys_eq!(
            recovery.mint,
            state.quote_mint,
            LaunchpadError::InvalidGraduationAuthorization
        );
        require_keys_eq!(
            *recovery_info.key,
            state.quote_recovery_account,
            LaunchpadError::InvalidGraduationAuthorization
        );
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
        state
            .max_liquidity_lamports
            .checked_sub(pool_quote.amount)
            .ok_or(LaunchpadError::MathOverflow)?
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
    let burned_unsold = campaign
        .curve_token_supply
        .checked_sub(campaign.sold_tokens)
        .ok_or(LaunchpadError::MathOverflow)?;
    let burned_unused_liquidity = campaign
        .liquidity_token_supply
        .checked_sub(pool_token.amount)
        .ok_or(LaunchpadError::MathOverflow)?;
    let creator_reserve = campaign.reserve_token_supply;
    let campaign_bump = [campaign.bump];
    let campaign_seeds: &[&[u8]] = &[CAMPAIGN_SEED, campaign.campaign_id.as_ref(), &campaign_bump];
    let burn_total = burned_unsold
        .checked_add(burned_unused_liquidity)
        .ok_or(LaunchpadError::MathOverflow)?;
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
        let creator_token =
            unpack_spl_account(&ctx.accounts.creator_token_account.to_account_info())?;
        require_keys_eq!(
            creator_token.mint,
            campaign.mint,
            LaunchpadError::InvalidCampaign
        );
        require_keys_eq!(
            creator_token.owner,
            campaign.creator,
            LaunchpadError::InvalidCampaign
        );
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
    let creator_payout = state
        .creator_payout_lamports
        .checked_add(unused_native)
        .ok_or(LaunchpadError::MathOverflow)?;
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
    update_creator_profile_after_graduation(
        &ctx.accounts.creator_profile.to_account_info(),
        campaign.creator,
    )?;
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
        graduated_at: now
    });
    Ok(())
}

pub fn final_spot_nano_lamports(campaign: &CampaignView) -> Result<u128> {
    require!(
        campaign.economics_version >= ECONOMICS_VERSION_V3,
        LaunchpadError::InvalidGenerationEconomics
    );
    let scale = token_scale(campaign.token_decimals)?;
    let base = u128::from(campaign.base_price_lamports)
        .checked_mul(SLOPE_NANO_LAMPORT_SCALE)
        .ok_or(LaunchpadError::MathOverflow)?;
    let slope = u128::from(campaign.price_slope_lamports)
        .checked_mul(u128::from(campaign.sold_tokens))
        .ok_or(LaunchpadError::MathOverflow)?
        .checked_div(scale)
        .ok_or(LaunchpadError::MathOverflow)?;
    base.checked_add(slope)
        .ok_or_else(|| error!(LaunchpadError::MathOverflow))
}

pub fn graduation_quote(campaign: &CampaignView) -> Result<GraduationQuote> {
    let spot = final_spot_nano_lamports(campaign)?;
    require!(spot > 0, LaunchpadError::GraduationLiquidityZero);
    let finalize_fee = bps_amount(campaign.net_raised_lamports, campaign.finalize_fee_bps)?;
    let remaining = campaign
        .net_raised_lamports
        .checked_sub(finalize_fee)
        .ok_or(LaunchpadError::MathOverflow)?;
    let target_liquidity = bps_amount(remaining, campaign.liquidity_post_finalize_bps)?;
    require!(
        target_liquidity > 0,
        LaunchpadError::GraduationLiquidityZero
    );
    let scale = token_scale(campaign.token_decimals)?;
    let desired_tokens = u128::from(target_liquidity)
        .checked_mul(scale)
        .ok_or(LaunchpadError::MathOverflow)?
        .checked_mul(SLOPE_NANO_LAMPORT_SCALE)
        .ok_or(LaunchpadError::MathOverflow)?
        .checked_div(spot)
        .ok_or(LaunchpadError::MathOverflow)?;
    let max_tokens = desired_tokens.min(u128::from(campaign.liquidity_token_supply));
    require!(max_tokens > 0, LaunchpadError::GraduationLiquidityZero);
    let max_tokens_u64 =
        u64::try_from(max_tokens).map_err(|_| error!(LaunchpadError::MathOverflow))?;
    let liquidity_lamports = if desired_tokens <= u128::from(campaign.liquidity_token_supply) {
        target_liquidity
    } else {
        let denominator = scale
            .checked_mul(SLOPE_NANO_LAMPORT_SCALE)
            .ok_or(LaunchpadError::MathOverflow)?;
        let used = max_tokens
            .checked_mul(spot)
            .ok_or(LaunchpadError::MathOverflow)?
            .checked_div(denominator)
            .ok_or(LaunchpadError::MathOverflow)?;
        u64::try_from(used).map_err(|_| error!(LaunchpadError::MathOverflow))?
    };
    require!(
        liquidity_lamports > 0,
        LaunchpadError::GraduationLiquidityZero
    );
    let creator_payout = remaining
        .checked_sub(liquidity_lamports)
        .ok_or(LaunchpadError::MathOverflow)?;
    Ok(GraduationQuote {
        finalize_fee_lamports: finalize_fee,
        max_liquidity_lamports: liquidity_lamports,
        max_liquidity_tokens: max_tokens_u64,
        creator_payout_lamports: creator_payout,
        final_spot_nano_lamports: spot,
    })
}

fn validate_quote_binding(args: &BeginGraduationArgs) -> Result<()> {
    require!(
        args.quote_config_id != [0; 32]
            && args.quote_policy_version > 0
            && args.quote_decimals <= 18,
        LaunchpadError::InvalidGraduationAuthorization
    );
    if is_native_quote(args.quote_mint) {
        require!(
            args.quote_profile == QUOTE_PROFILE_NATIVE
                && args.quote_provider_class == QUOTE_PROVIDER_NATIVE,
            LaunchpadError::InvalidGraduationAuthorization
        );
        require_keys_eq!(
            args.acquisition_program,
            Pubkey::default(),
            LaunchpadError::InvalidGraduationAuthorization
        );
        require_keys_eq!(
            args.quote_recovery_account,
            Pubkey::default(),
            LaunchpadError::InvalidGraduationAuthorization
        );
        require!(
            args.quote_reference_usd_micros == args.oracle_price_usd_micros
                && args.quote_decimals == 9,
            LaunchpadError::InvalidGraduationAuthorization
        );
        require!(
            args.max_slippage_bps == 0 && args.max_impact_bps == 0 && args.max_deviation_bps == 0,
            LaunchpadError::InvalidGraduationAuthorization
        );
    } else {
        require!(
            args.quote_profile >= QUOTE_PROFILE_STABLECOIN
                && args.quote_profile <= QUOTE_PROFILE_COMMUNITY
                && args.quote_provider_class != QUOTE_PROVIDER_NATIVE,
            LaunchpadError::InvalidGraduationAuthorization
        );
        require_keys_neq!(
            args.acquisition_program,
            Pubkey::default(),
            LaunchpadError::InvalidGraduationAuthorization
        );
        require_keys_neq!(
            args.acquisition_program,
            METEORA_CP_AMM_PROGRAM_ID,
            LaunchpadError::InvalidGraduationAuthorization
        );
        require_keys_neq!(
            args.acquisition_program,
            crate::ID,
            LaunchpadError::InvalidGraduationAuthorization
        );
        require_keys_neq!(
            args.quote_recovery_account,
            Pubkey::default(),
            LaunchpadError::InvalidGraduationAuthorization
        );
        require!(
            args.quote_reference_usd_micros > 0
                && args.expected_quote_amount > 0
                && args.min_quote_amount > 0
                && args.min_quote_amount <= args.expected_quote_amount,
            LaunchpadError::InvalidGraduationAuthorization
        );
        require!(
            args.max_slippage_bps > 0
                && args.max_slippage_bps <= QUOTE_MAX_SLIPPAGE_BPS
                && args.max_impact_bps <= QUOTE_MAX_IMPACT_BPS
                && args.max_deviation_bps > 0
                && args.max_deviation_bps <= QUOTE_MAX_DEVIATION_BPS,
            LaunchpadError::InvalidGraduationAuthorization
        );
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
    require!(
        native_lamports > 0 && token_raw > 0 && expected_spot_nano > 0,
        LaunchpadError::GraduationPriceDrift
    );
    let scale = token_scale(token_decimals)?;
    let actual = u128::from(native_lamports)
        .checked_mul(scale)
        .ok_or(LaunchpadError::MathOverflow)?
        .checked_mul(SLOPE_NANO_LAMPORT_SCALE)
        .ok_or(LaunchpadError::MathOverflow)?
        .checked_div(u128::from(token_raw))
        .ok_or(LaunchpadError::MathOverflow)?;
    let drift_bps = actual
        .abs_diff(expected_spot_nano)
        .checked_mul(u128::from(BPS_DENOMINATOR))
        .ok_or(LaunchpadError::MathOverflow)?
        .checked_div(expected_spot_nano)
        .ok_or(LaunchpadError::MathOverflow)?;
    require!(
        drift_bps <= u128::from(GRADUATION_PRICE_TOLERANCE_BPS),
        LaunchpadError::GraduationPriceDrift
    );
    Ok(())
}

fn gcd_u128(mut a: u128, mut b: u128) -> u128 {
    while b != 0 {
        let remainder = a % b;
        a = b;
        b = remainder;
    }
    a
}

fn mul_div_reduced<const N: usize, const D: usize>(
    mut numerators: [u128; N],
    mut denominators: [u128; D],
) -> Result<u128> {
    for denominator in &mut denominators {
        require!(*denominator > 0, LaunchpadError::GraduationPriceDrift);
        for numerator in &mut numerators {
            let common = gcd_u128(*numerator, *denominator);
            if common > 1 {
                *numerator /= common;
                *denominator /= common;
            }
        }
    }
    let numerator = numerators.into_iter().try_fold(1u128, |acc, value| {
        acc.checked_mul(value).ok_or(LaunchpadError::MathOverflow)
    })?;
    let denominator = denominators.into_iter().try_fold(1u128, |acc, value| {
        acc.checked_mul(value).ok_or(LaunchpadError::MathOverflow)
    })?;
    numerator
        .checked_div(denominator)
        .ok_or_else(|| error!(LaunchpadError::MathOverflow))
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
    require!(
        quote_raw > 0
            && token_raw > 0
            && final_spot_nano > 0
            && sol_usd_micros > 0
            && quote_usd_micros > 0,
        LaunchpadError::GraduationPriceDrift
    );

    // Compare both ratios at high fixed-point precision without performing an
    // early integer division. Cross-cancelling denominator factors first keeps
    // legitimate sub-raw-unit quote/token ratios representable and bounds u128
    // multiplication pressure. No floating point is used.
    const RATIO_SCALE: u128 = 1_000_000_000_000;
    const NANO_LAMPORTS_PER_SOL: u128 = 1_000_000_000_000_000_000;
    let actual_scaled = mul_div_reduced(
        [
            u128::from(quote_raw),
            token_scale(token_decimals)?,
            RATIO_SCALE,
        ],
        [u128::from(token_raw)],
    )?;
    let expected_scaled = mul_div_reduced(
        [
            final_spot_nano,
            u128::from(sol_usd_micros),
            token_scale(quote_decimals)?,
            RATIO_SCALE,
        ],
        [NANO_LAMPORTS_PER_SOL, u128::from(quote_usd_micros)],
    )?;
    require!(expected_scaled > 0, LaunchpadError::GraduationPriceDrift);

    let drift_bps = actual_scaled
        .abs_diff(expected_scaled)
        .checked_mul(u128::from(BPS_DENOMINATOR))
        .ok_or(LaunchpadError::MathOverflow)?
        .checked_div(expected_scaled)
        .ok_or(LaunchpadError::MathOverflow)?;
    require!(
        drift_bps <= u128::from(max_deviation_bps),
        LaunchpadError::GraduationPriceDrift
    );
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
fn validate_generation_binding(campaign: &CampaignView, info: &AccountInfo) -> Result<()> {
    require_keys_eq!(
        campaign.generation_config,
        *info.key,
        LaunchpadError::InvalidGeneration
    );
    let (expected, _) = Pubkey::find_program_address(
        &[GENERATION_CONFIG_SEED, campaign.generation_id.as_ref()],
        &crate::ID,
    );
    require_keys_eq!(*info.key, expected, LaunchpadError::InvalidGeneration);
    require_keys_eq!(*info.owner, crate::ID, LaunchpadError::InvalidGeneration);
    let data = info.try_borrow_data()?;
    let mut slice: &[u8] = &data;
    let generation = Box::new(GenerationConfig::try_deserialize(&mut slice)?);
    require!(
        campaign.generation_id == generation.generation_id && generation.support_enabled,
        LaunchpadError::InvalidGeneration
    );
    require!(
        generation.dex_adapter == DEX_ADAPTER_METEORA_DAMM_V2,
        LaunchpadError::InvalidDexAdapter
    );
    Ok(())
}
fn validate_campaign_accounts(
    c: &CampaignView,
    key: Pubkey,
    mint: Pubkey,
    token_vault: Pubkey,
    sol_vault: Pubkey,
) -> Result<()> {
    require_keys_eq!(c.mint, mint, LaunchpadError::InvalidCampaign);
    require_keys_eq!(c.token_vault, token_vault, LaunchpadError::InvalidCampaign);
    require_keys_eq!(c.sol_vault, sol_vault, LaunchpadError::InvalidCampaign);
    let (ec, _) =
        Pubkey::find_program_address(&[CAMPAIGN_SEED, c.campaign_id.as_ref()], &crate::ID);
    let (et, _) =
        Pubkey::find_program_address(&[TOKEN_VAULT_SEED, c.campaign_id.as_ref()], &crate::ID);
    let (es, _) =
        Pubkey::find_program_address(&[SOL_VAULT_SEED, c.campaign_id.as_ref()], &crate::ID);
    require_keys_eq!(key, ec, LaunchpadError::InvalidCampaign);
    require_keys_eq!(token_vault, et, LaunchpadError::InvalidCampaign);
    require_keys_eq!(sol_vault, es, LaunchpadError::InvalidCampaign);
    Ok(())
}
fn validate_meteora_pool(
    info: &AccountInfo,
    launch: Pubkey,
    quote: Pubkey,
    supplied_launch_vault: Pubkey,
    supplied_quote_vault: Pubkey,
) -> Result<(Pubkey, Pubkey, Pubkey, Pubkey)> {
    require_keys_eq!(
        *info.owner,
        METEORA_CP_AMM_PROGRAM_ID,
        LaunchpadError::InvalidMeteoraPool
    );
    let expected_pool = derive_meteora_pool_for_quote(launch, quote);
    require_keys_eq!(*info.key, expected_pool, LaunchpadError::InvalidMeteoraPool);
    let data = info.try_borrow_data()?;
    require!(
        data.len() >= METEORA_POOL_MIN_LEN,
        LaunchpadError::InvalidMeteoraPool
    );
    let a = read_pubkey(&data, METEORA_POOL_TOKEN_A_MINT_OFFSET)?;
    let b = read_pubkey(&data, METEORA_POOL_TOKEN_B_MINT_OFFSET)?;
    let va = read_pubkey(&data, METEORA_POOL_TOKEN_A_VAULT_OFFSET)?;
    let vb = read_pubkey(&data, METEORA_POOL_TOKEN_B_VAULT_OFFSET)?;
    require!(
        (a == launch && b == quote) || (a == quote && b == launch),
        LaunchpadError::InvalidMeteoraPool
    );
    let el = derive_meteora_token_vault(launch, expected_pool);
    let eq = derive_meteora_token_vault(quote, expected_pool);
    require_keys_eq!(
        supplied_launch_vault,
        el,
        LaunchpadError::InvalidMeteoraPool
    );
    require_keys_eq!(supplied_quote_vault, eq, LaunchpadError::InvalidMeteoraPool);
    if a == launch {
        require_keys_eq!(va, el, LaunchpadError::InvalidMeteoraPool);
        require_keys_eq!(vb, eq, LaunchpadError::InvalidMeteoraPool);
    } else {
        require_keys_eq!(vb, el, LaunchpadError::InvalidMeteoraPool);
        require_keys_eq!(va, eq, LaunchpadError::InvalidMeteoraPool);
    }
    Ok((a, b, va, vb))
}
fn validate_meteora_position(info: &AccountInfo, pool: Pubkey, nft: Pubkey) -> Result<()> {
    require_keys_eq!(
        *info.owner,
        METEORA_CP_AMM_PROGRAM_ID,
        LaunchpadError::InvalidMeteoraPosition
    );
    require_keys_eq!(
        *info.key,
        derive_meteora_position(nft),
        LaunchpadError::InvalidMeteoraPosition
    );
    let data = info.try_borrow_data()?;
    require!(
        data.len() >= METEORA_POSITION_MIN_LEN,
        LaunchpadError::InvalidMeteoraPosition
    );
    require_keys_eq!(
        read_pubkey(&data, METEORA_POSITION_POOL_OFFSET)?,
        pool,
        LaunchpadError::InvalidMeteoraPosition
    );
    require_keys_eq!(
        read_pubkey(&data, METEORA_POSITION_NFT_MINT_OFFSET)?,
        nft,
        LaunchpadError::InvalidMeteoraPosition
    );
    require!(
        read_u128(&data, METEORA_POSITION_UNLOCKED_LIQUIDITY_OFFSET)? == 0
            && read_u128(&data, METEORA_POSITION_PERMANENT_LOCKED_LIQUIDITY_OFFSET)? > 0,
        LaunchpadError::MeteoraLiquidityNotLocked
    );
    Ok(())
}
pub fn derive_meteora_pool(launch: Pubkey) -> Pubkey {
    derive_meteora_pool_for_quote(launch, spl_token::native_mint::ID)
}
pub fn derive_meteora_pool_for_quote(launch: Pubkey, quote: Pubkey) -> Pubkey {
    let (a, b) = ordered_pubkeys(launch, quote);
    Pubkey::find_program_address(
        &[b"cpool", a.as_ref(), b.as_ref()],
        &METEORA_CP_AMM_PROGRAM_ID,
    )
    .0
}
pub fn derive_meteora_position(nft: Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"position", nft.as_ref()], &METEORA_CP_AMM_PROGRAM_ID).0
}
pub fn derive_meteora_token_vault(mint: Pubkey, pool: Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[b"token_vault", mint.as_ref(), pool.as_ref()],
        &METEORA_CP_AMM_PROGRAM_ID,
    )
    .0
}
fn ordered_pubkeys(a: Pubkey, b: Pubkey) -> (Pubkey, Pubkey) {
    if a.to_bytes() > b.to_bytes() {
        (a, b)
    } else {
        (b, a)
    }
}
fn build_graduation_authorization_digest(
    program_id: Pubkey,
    campaign: Pubkey,
    mint: Pubkey,
    authority: Pubkey,
    generation_config: Pubkey,
    target: u64,
    args: &BeginGraduationArgs,
    pool: Pubkey,
    position: Pubkey,
) -> [u8; 32] {
    let mut m = Vec::with_capacity(640);
    m.extend_from_slice(GRADUATION_AUTH_DOMAIN);
    m.extend_from_slice(&GRADUATION_AUTH_SCHEMA_VERSION.to_le_bytes());
    m.extend_from_slice(program_id.as_ref());
    m.extend_from_slice(campaign.as_ref());
    m.extend_from_slice(mint.as_ref());
    m.extend_from_slice(authority.as_ref());
    m.extend_from_slice(generation_config.as_ref());
    m.extend_from_slice(&target.to_le_bytes());
    m.extend_from_slice(&args.native_target_lamports.to_le_bytes());
    m.extend_from_slice(&args.oracle_price_usd_micros.to_le_bytes());
    m.extend_from_slice(pool.as_ref());
    m.extend_from_slice(position.as_ref());
    m.extend_from_slice(args.position_nft_mint.as_ref());
    m.extend_from_slice(&args.deadline.to_le_bytes());
    m.extend_from_slice(&args.nonce);
    m.push(args.finalize_route_profile);
    m.extend_from_slice(args.quote_mint.as_ref());
    m.extend_from_slice(&args.quote_config_id);
    m.extend_from_slice(&args.quote_policy_version.to_le_bytes());
    m.push(args.quote_profile);
    m.push(args.quote_provider_class);
    m.extend_from_slice(args.acquisition_program.as_ref());
    m.extend_from_slice(&args.quote_reference_usd_micros.to_le_bytes());
    m.push(args.quote_decimals);
    m.extend_from_slice(&args.expected_quote_amount.to_le_bytes());
    m.extend_from_slice(&args.min_quote_amount.to_le_bytes());
    m.extend_from_slice(&args.max_slippage_bps.to_le_bytes());
    m.extend_from_slice(&args.max_impact_bps.to_le_bytes());
    m.extend_from_slice(&args.max_deviation_bps.to_le_bytes());
    m.extend_from_slice(args.quote_recovery_account.as_ref());
    hash(&m).to_bytes()
}
pub fn native_target_lamports_from_usd(target: u64, price: u64) -> Result<u64> {
    require!(
        target > 0 && price > 0,
        LaunchpadError::InvalidGraduationTarget
    );
    let n = u128::from(target)
        .checked_mul(1_000_000_000)
        .ok_or(LaunchpadError::MathOverflow)?
        .checked_add(u128::from(price))
        .ok_or(LaunchpadError::MathOverflow)?
        .checked_sub(1)
        .ok_or(LaunchpadError::MathOverflow)?;
    let v = n
        .checked_div(u128::from(price))
        .ok_or(LaunchpadError::MathOverflow)?;
    require!(
        v > 0 && v <= u128::from(u64::MAX),
        LaunchpadError::InvalidGraduationTarget
    );
    Ok(v as u64)
}
fn verify_detached_graduation_authorization(
    info: &AccountInfo,
    signer: Pubkey,
    msg: &[u8; 32],
) -> Result<()> {
    let current = load_current_index_checked(info)
        .map_err(|_| error!(LaunchpadError::InvalidGraduationAuthorization))?;
    require!(current > 0, LaunchpadError::InvalidGraduationAuthorization);
    let ix = load_instruction_at_checked(
        usize::from(
            current
                .checked_sub(1)
                .ok_or(LaunchpadError::InvalidGraduationAuthorization)?,
        ),
        info,
    )
    .map_err(|_| error!(LaunchpadError::InvalidGraduationAuthorization))?;
    require_keys_eq!(
        ix.program_id,
        ed25519_program::ID,
        LaunchpadError::InvalidGraduationAuthorization
    );
    require!(
        ix.accounts.is_empty(),
        LaunchpadError::InvalidGraduationAuthorization
    );
    let p = parse_single_ed25519_instruction(&ix.data)?;
    require!(
        p.public_key == signer.as_ref() && p.message == msg,
        LaunchpadError::InvalidGraduationAuthorization
    );
    Ok(())
}
fn require_atomic_route_meteora_then_confirm(
    info: &AccountInfo,
    quote: Pubkey,
    acquisition: Pubkey,
) -> Result<()> {
    let current = usize::from(
        load_current_index_checked(info)
            .map_err(|_| error!(LaunchpadError::GraduationAtomicityRequired))?,
    );
    let h = hash(b"global:confirm_graduation").to_bytes();
    let disc = &h[..8];
    let need = !is_native_quote(quote);
    let mut acquired = !need;
    let mut meteora = false;
    for i in (current + 1)..(current + MAX_ATOMIC_SCAN_INSTRUCTIONS) {
        let ix = match load_instruction_at_checked(i, info) {
            Ok(v) => v,
            Err(_) => break,
        };
        if need && ix.program_id == acquisition {
            require!(!meteora, LaunchpadError::GraduationAtomicityRequired);
            acquired = true;
            continue;
        }
        if ix.program_id == METEORA_CP_AMM_PROGRAM_ID {
            require!(acquired, LaunchpadError::GraduationAtomicityRequired);
            meteora = true;
            continue;
        }
        if ix.program_id == crate::ID && ix.data.len() >= 8 && &ix.data[..8] == disc {
            require!(
                acquired && meteora,
                LaunchpadError::GraduationAtomicityRequired
            );
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
    require!(
        data.len() >= ED25519_HEADER_SIZE && data[0] == 1 && data[1] == 0,
        LaunchpadError::InvalidGraduationAuthorization
    );
    let so = read_u16(data, 2)?;
    let si = read_u16(data, 4)?;
    let po = read_u16(data, 6)?;
    let pi = read_u16(data, 8)?;
    let mo = read_u16(data, 10)?;
    let ms = read_u16(data, 12)?;
    let mi = read_u16(data, 14)?;
    require!(
        si == ED25519_CURRENT_INSTRUCTION
            && pi == ED25519_CURRENT_INSTRUCTION
            && mi == ED25519_CURRENT_INSTRUCTION,
        LaunchpadError::InvalidGraduationAuthorization
    );
    checked_slice(data, so, ED25519_SIGNATURE_SIZE)?;
    Ok(ParsedEd25519Instruction {
        public_key: checked_slice(data, po, ED25519_PUBLIC_KEY_SIZE)?,
        message: checked_slice(data, mo, usize::from(ms))?,
    })
}
fn unpack_spl_account(info: &AccountInfo) -> Result<SplTokenAccount> {
    require_keys_eq!(*info.owner, token::ID, LaunchpadError::InvalidCampaign);
    SplTokenAccount::unpack(&info.try_borrow_data()?)
        .map_err(|_| error!(LaunchpadError::InvalidCampaign))
}
fn update_creator_profile_after_graduation(info: &AccountInfo, creator: Pubkey) -> Result<()> {
    let (expected, _) =
        Pubkey::find_program_address(&[CREATOR_PROFILE_SEED, creator.as_ref()], &crate::ID);
    require_keys_eq!(*info.key, expected, LaunchpadError::InvalidCreatorProfile);
    require_keys_eq!(
        *info.owner,
        crate::ID,
        LaunchpadError::InvalidCreatorProfile
    );
    let mut data = info.try_borrow_mut_data()?;
    let mut slice: &[u8] = &data;
    let mut p = CreatorProfile::try_deserialize(&mut slice)?;
    require_keys_eq!(p.wallet, creator, LaunchpadError::InvalidCreatorProfile);
    p.live_bonding_count = p
        .live_bonding_count
        .checked_sub(1)
        .ok_or(LaunchpadError::MathOverflow)?;
    p.successful_graduations = p
        .successful_graduations
        .checked_add(1)
        .ok_or(LaunchpadError::MathOverflow)?;
    let mut c = std::io::Cursor::new(&mut data[..]);
    p.try_serialize(&mut c)
}
fn move_program_owned_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    require_keys_eq!(*from.owner, crate::ID, LaunchpadError::InvalidCampaign);
    let floor = Rent::get()?.minimum_balance(from.data_len());
    let remain = from
        .lamports()
        .checked_sub(amount)
        .ok_or(LaunchpadError::InsufficientVaultBalance)?;
    require!(remain >= floor, LaunchpadError::InsufficientVaultBalance);
    **from.try_borrow_mut_lamports()? = remain;
    **to.try_borrow_mut_lamports()? = to
        .lamports()
        .checked_add(amount)
        .ok_or(LaunchpadError::MathOverflow)?;
    Ok(())
}
fn token_scale(decimals: u8) -> Result<u128> {
    require!(decimals <= 18, LaunchpadError::InvalidGenerationEconomics);
    10u128
        .checked_pow(u32::from(decimals))
        .ok_or_else(|| error!(LaunchpadError::MathOverflow))
}
fn bps_amount(amount: u64, bps: u16) -> Result<u64> {
    let v = u128::from(amount)
        .checked_mul(u128::from(bps))
        .ok_or(LaunchpadError::MathOverflow)?
        .checked_div(u128::from(BPS_DENOMINATOR))
        .ok_or(LaunchpadError::MathOverflow)?;
    u64::try_from(v).map_err(|_| error!(LaunchpadError::MathOverflow))
}
fn read_pubkey(data: &[u8], offset: usize) -> Result<Pubkey> {
    let b = checked_bytes(data, offset, 32)?;
    let a: [u8; 32] = b
        .try_into()
        .map_err(|_| error!(LaunchpadError::InvalidMeteoraPool))?;
    Ok(Pubkey::new_from_array(a))
}
fn read_u128(data: &[u8], offset: usize) -> Result<u128> {
    let b = checked_bytes(data, offset, 16)?;
    let a: [u8; 16] = b
        .try_into()
        .map_err(|_| error!(LaunchpadError::InvalidMeteoraPosition))?;
    Ok(u128::from_le_bytes(a))
}
fn checked_bytes(data: &[u8], offset: usize, len: usize) -> Result<&[u8]> {
    let end = offset
        .checked_add(len)
        .ok_or(LaunchpadError::MathOverflow)?;
    require!(end <= data.len(), LaunchpadError::InvalidMeteoraPool);
    Ok(&data[offset..end])
}
fn read_u16(data: &[u8], offset: usize) -> Result<u16> {
    let b = checked_bytes(data, offset, 2)?;
    Ok(u16::from_le_bytes([b[0], b[1]]))
}
fn checked_slice(data: &[u8], offset: u16, len: usize) -> Result<&[u8]> {
    checked_bytes(data, usize::from(offset), len)
        .map_err(|_| error!(LaunchpadError::InvalidGraduationAuthorization))
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
        let a = final_spot_nano_lamports(&campaign_view_from_campaign(&c)).unwrap();
        c.sold_tokens = 1_000_000_000_000;
        let b = final_spot_nano_lamports(&campaign_view_from_campaign(&c)).unwrap();
        assert!(b > a);
        assert_eq!(a, 1_000_000_000)
    }
    #[test]
    fn graduation_quote_conserves_net_principal() {
        let v = campaign_view_from_campaign(&campaign_for_quote());
        let q = graduation_quote(&v).unwrap();
        assert_eq!(
            q.finalize_fee_lamports + q.max_liquidity_lamports + q.creator_payout_lamports,
            v.net_raised_lamports
        )
    }
    #[test]
    fn native_pool_derivation_regression_is_unchanged() {
        let m = Pubkey::new_unique();
        assert_eq!(
            derive_meteora_pool(m),
            derive_meteora_pool_for_quote(m, spl_token::native_mint::ID)
        )
    }
    #[test]
    fn quote_pool_derivation_is_generic_and_deterministic() {
        let m = Pubkey::new_unique();
        let q = Pubkey::new_unique();
        assert_eq!(
            derive_meteora_pool_for_quote(m, q),
            derive_meteora_pool_for_quote(m, q)
        );
        assert_ne!(derive_meteora_pool_for_quote(m, q), derive_meteora_pool(m))
    }
    #[test]
    fn native_quote_binding_requires_direct_native_profile() {
        let a = native_args();
        assert!(validate_quote_binding(&a).is_ok());
        let mut b = a;
        b.quote_profile = QUOTE_PROFILE_STABLECOIN;
        assert!(validate_quote_binding(&b).is_err())
    }
    #[test]
    fn ordinary_approved_quote_is_not_mint_hardcoded() {
        let mut a = native_args();
        a.quote_mint = Pubkey::new_unique();
        a.quote_profile = QUOTE_PROFILE_STABLECOIN;
        a.quote_provider_class = 1;
        a.acquisition_program = Pubkey::new_unique();
        a.quote_reference_usd_micros = 1_000_000;
        a.quote_decimals = 6;
        a.expected_quote_amount = 20_000_000;
        a.min_quote_amount = 19_900_000;
        a.max_slippage_bps = 50;
        a.max_impact_bps = 25;
        a.max_deviation_bps = 100;
        a.quote_recovery_account = Pubkey::new_unique();
        assert!(validate_quote_binding(&a).is_ok());
        a.quote_profile = QUOTE_PROFILE_PROVIDER_RWA;
        a.quote_config_id = [15; 32];
        assert!(validate_quote_binding(&a).is_ok())
    }
    #[test]
    fn unsafe_quote_limits_fail_closed() {
        let mut a = native_args();
        a.quote_mint = Pubkey::new_unique();
        a.quote_profile = QUOTE_PROFILE_STABLECOIN;
        a.quote_provider_class = 1;
        a.acquisition_program = Pubkey::new_unique();
        a.quote_reference_usd_micros = 1_000_000;
        a.quote_decimals = 6;
        a.expected_quote_amount = 20_000_000;
        a.min_quote_amount = 19_000_000;
        a.max_slippage_bps = QUOTE_MAX_SLIPPAGE_BPS + 1;
        a.max_impact_bps = 25;
        a.max_deviation_bps = 100;
        a.quote_recovery_account = Pubkey::new_unique();
        assert!(validate_quote_binding(&a).is_err())
    }
    #[test]
    fn price_tolerance_accepts_exact_ratio_and_rejects_large_drift() {
        assert!(validate_price_tolerance(50, 10_000_000, 6, 5_000_000_000).is_ok());
        assert!(validate_price_tolerance(60, 10_000_000, 6, 5_000_000_000).is_err())
    }
    #[test]
    fn graduation_authorization_binds_exact_generation() {
        let args = BeginGraduationArgs {
            native_target_lamports: 200_000_000_000,
            oracle_price_usd_micros: 150_000_000,
            deadline: 1_900_000_000,
            nonce: [12u8; 32],
            position_nft_mint: Pubkey::new_from_array([7u8; 32]),
            finalize_route_profile: 1,
            quote_mint: Pubkey::new_from_array([8u8; 32]),
            quote_config_id: [11u8; 32],
            quote_policy_version: 7,
            quote_profile: 1,
            quote_provider_class: 1,
            acquisition_program: Pubkey::new_from_array([9u8; 32]),
            quote_reference_usd_micros: 1_000_000,
            quote_decimals: 6,
            expected_quote_amount: 123_456_789,
            min_quote_amount: 120_000_000,
            max_slippage_bps: 100,
            max_impact_bps: 100,
            max_deviation_bps: 100,
            quote_recovery_account: Pubkey::new_from_array([10u8; 32]),
        };
        let exact = build_graduation_authorization_digest(
            Pubkey::new_from_array([0u8; 32]),
            Pubkey::new_from_array([1u8; 32]),
            Pubkey::new_from_array([2u8; 32]),
            Pubkey::new_from_array([3u8; 32]),
            Pubkey::new_from_array([4u8; 32]),
            30_000_000_000,
            &args,
            Pubkey::new_from_array([5u8; 32]),
            Pubkey::new_from_array([6u8; 32]),
        );
        assert_eq!(
            exact,
            [
                212, 43, 6, 198, 126, 184, 102, 231, 52, 54, 221, 59, 12, 119, 171, 53, 171, 83,
                229, 118, 225, 159, 15, 65, 23, 197, 228, 40, 104, 47, 219, 197
            ]
        );

        let substituted = build_graduation_authorization_digest(
            Pubkey::new_from_array([0u8; 32]),
            Pubkey::new_from_array([1u8; 32]),
            Pubkey::new_from_array([2u8; 32]),
            Pubkey::new_from_array([3u8; 32]),
            Pubkey::new_from_array([13u8; 32]),
            30_000_000_000,
            &args,
            Pubkey::new_from_array([5u8; 32]),
            Pubkey::new_from_array([6u8; 32]),
        );
        assert_ne!(substituted, exact);
    }

    #[test]
    fn quote_deviation_accepts_sub_raw_unit_and_rejects_excessive_drift() {
        assert!(validate_quote_pool_deviation(
            150,
            1_000_000_000_000,
            9,
            6,
            1_000_000_000,
            150_000_000,
            1_000_000,
            1,
        )
        .is_ok());
        assert!(validate_quote_pool_deviation(
            180,
            1_000_000_000_000,
            9,
            6,
            1_000_000_000,
            150_000_000,
            1_000_000,
            100,
        )
        .is_err());
    }

    #[test]
    fn native_target_matches_ceil_usd_conversion() {
        assert_eq!(
            native_target_lamports_from_usd(6_000_000, 150_000_000).unwrap(),
            40_000_000
        );
        assert!(native_target_lamports_from_usd(6_000_000, 0).is_err())
    }
}
