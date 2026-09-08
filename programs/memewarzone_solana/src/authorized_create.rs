use anchor_lang::{
    prelude::*,
    solana_program::{
        ed25519_program,
        hash::hash,
        instruction::Instruction,
        program::{invoke, invoke_signed},
        program_option::COption,
        program_pack::Pack,
        system_instruction,
        sysvar::instructions::{
            load_current_index_checked, load_instruction_at_checked, ID as INSTRUCTIONS_SYSVAR_ID,
        },
    },
};
use anchor_spl::token::{
    self,
    spl_token::{
        self,
        instruction::AuthorityType,
        state::{Account as SplTokenAccount, Mint as SplMint},
    },
    MintTo, SetAuthority,
};

use crate::{
    generation_allows_graduation_target, ClusterProfile, CreatorProfile, GenerationConfig,
    GlobalConfig, LaunchpadError, RiskProfile, BPS_DENOMINATOR, CLUSTER_PROFILE_SEED,
    CREATOR_PROFILE_SEED, CREATOR_TIER_1, EMPTY_CLUSTER_ID, GENERATION_CONFIG_SEED,
    GLOBAL_CONFIG_SEED, RISK_PROFILE_SEED, TIER_1_CREATOR_LOCK_SECONDS, TIER_1_MAX_LIVE_BONDING,
    TIER_COOLDOWN_SECONDS,
};

pub const CAMPAIGN_SEED: &[u8] = b"campaign";
pub const CREATE_AUTH_SEED: &[u8] = b"create-auth";
pub const CAMPAIGN_MINT_SEED: &[u8] = b"campaign-mint";
pub const TOKEN_VAULT_SEED: &[u8] = b"token-vault";
pub const SOL_VAULT_SEED: &[u8] = b"sol-vault";

pub const CREATE_AUTH_DOMAIN: &[u8] = b"MEMEWARZONE_SOLANA_CREATE_V4";
pub const CREATE_AUTH_SCHEMA_VERSION: u16 = 4;
pub const ASSET_INITIALIZATION_VERSION: u16 = 1;

pub const MIN_SCHEDULE_SECONDS: i64 = 300;
pub const MAX_SCHEDULE_SECONDS: i64 = 30 * 24 * 60 * 60;

const DEFAULT_NEW_CREATOR_TRUST_SCORE: u16 = 0;
const DEFAULT_NEW_CREATOR_BUY_CAP_BPS: u16 = 1_000;
const ED25519_HEADER_SIZE: usize = 16;
const ED25519_SIGNATURE_SIZE: usize = 64;
const ED25519_PUBLIC_KEY_SIZE: usize = 32;
const ED25519_CURRENT_INSTRUCTION: u16 = u16::MAX;

// BPF stack is limited to 4KB. Avoid large `init` + Account<> work in try_accounts:
// protocol PDAs and campaign-owned accounts are created/loaded in the handler.
#[derive(Accounts)]
#[instruction(args: CreateCampaignArgs)]
pub struct CreateCampaign<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    /// CHECK: global config PDA; owner/data checked when typed in handler.
    #[account(mut, seeds = [GLOBAL_CONFIG_SEED], bump)]
    pub global_config: UncheckedAccount<'info>,
    /// CHECK: generation config; seeds + typed load in handler.
    pub generation_config: UncheckedAccount<'info>,
    /// CHECK: creator profile PDA; created with NewCreator defaults on first successful launch.
    #[account(mut, seeds = [CREATOR_PROFILE_SEED, creator.key().as_ref()], bump)]
    pub creator_profile: UncheckedAccount<'info>,
    /// CHECK: optional risk profile PDA. Missing profile means unrestricted/no cluster, matching BNB RiskRegistry.
    #[account(seeds = [RISK_PROFILE_SEED, creator.key().as_ref()], bump)]
    pub risk_profile: UncheckedAccount<'info>,
    /// CHECK: cluster profile; only deserialized when the wallet has a non-zero risk cluster.
    pub cluster_profile: UncheckedAccount<'info>,
    /// CHECK: campaign PDA; created in handler (avoids huge Account stack in try_accounts).
    #[account(mut, seeds = [CAMPAIGN_SEED, args.campaign_id.as_ref()], bump)]
    pub campaign: UncheckedAccount<'info>,
    /// CHECK: mint PDA; created + initialize_mint in handler (init constraints blow the BPF stack
    /// and corrupted account mapping — GlobalConfig was observed as Instructions sysvar).
    #[account(mut, seeds = [CAMPAIGN_MINT_SEED, args.campaign_id.as_ref()], bump)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: token vault PDA; created + initialize_account in handler.
    #[account(mut, seeds = [TOKEN_VAULT_SEED, args.campaign_id.as_ref()], bump)]
    pub token_vault: UncheckedAccount<'info>,
    /// CHECK: SOL vault PDA; created in handler.
    #[account(mut, seeds = [SOL_VAULT_SEED, args.campaign_id.as_ref()], bump)]
    pub sol_vault: UncheckedAccount<'info>,
    /// CHECK: create-auth PDA; created in handler.
    #[account(
        mut,
        seeds = [CREATE_AUTH_SEED, creator.key().as_ref(), args.nonce.as_ref()],
        bump
    )]
    pub create_authorization: UncheckedAccount<'info>,
    /// CHECK: The address constraint pins this account to the Instructions sysvar.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
    /// CHECK: SPL Token program.
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: System program.
    pub system_program: UncheckedAccount<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct Campaign {
    pub campaign_id: [u8; 32],
    pub generation_id: [u8; 32],
    pub generation_config: Pubkey,
    pub generation_manifest_hash: [u8; 32],
    pub creator: Pubkey,
    pub mint: Pubkey,
    pub token_vault: Pubkey,
    pub sol_vault: Pubkey,
    pub metadata_hash: [u8; 32],
    pub cluster_hash: [u8; 32],
    pub ticker_hash: [u8; 32],
    pub reservation_id_hash: [u8; 32],
    pub reservation_version: u64,
    pub launch_at: i64,
    pub graduation_target_usd_micros: u64,
    pub cluster_kind: u8,
    pub economics_version: u16,
    pub curve_kind: u8,
    pub token_total_supply: u64,
    pub curve_token_supply: u64,
    pub liquidity_token_supply: u64,
    pub reserve_token_supply: u64,
    pub token_decimals: u8,
    pub curve_supply_bps: u16,
    pub liquidity_token_bps: u16,
    pub base_price_lamports: u64,
    pub price_slope_lamports: u64,
    pub buy_fee_bps: u16,
    pub sell_fee_bps: u16,
    pub finalize_fee_bps: u16,
    pub creator_post_finalize_bps: u16,
    pub liquidity_post_finalize_bps: u16,
    pub dex_adapter: u8,
    pub trade_route_profile: [u8; 32],
    pub finalize_route_profile: [u8; 32],
    pub treasury_profile: [u8; 32],
    pub dex_profile: [u8; 32],
    pub oracle_profile: [u8; 32],
    pub creator_buy_lock_until: i64,
    pub creator_buy_cap_bps: u16,
    pub created_at: i64,
    pub sold_tokens: u64,
    pub net_raised_lamports: u64,
    pub total_buy_volume_lamports: u64,
    pub total_sell_volume_lamports: u64,
    pub buyer_count: u64,
    pub creator_bought_tokens: u64,
    pub asset_initialization_version: u16,
    pub mint_authority_revoked: bool,
    pub graduated: bool,
    /// Sticky eligibility lock. Set on the threshold-crossing buy. Not `graduated`.
    pub curve_closed: bool,
    /// Per-campaign emergency pause. Does not affect other campaigns.
    pub paused: bool,
    pub bump: u8,
    pub mint_bump: u8,
    pub token_vault_bump: u8,
    pub sol_vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct CampaignSolVault {
    pub campaign: Pubkey,
    pub generation_id: [u8; 32],
    pub created_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct CreateAuthorization {
    pub creator: Pubkey,
    pub nonce: [u8; 32],
    pub deadline: i64,
    pub used_at: i64,
    pub route_signer: Pubkey,
    pub message_hash: [u8; 32],
    pub schema_version: u16,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct CreateCampaignArgs {
    pub campaign_id: [u8; 32],
    pub metadata_hash: [u8; 32],
    pub cluster_hash: [u8; 32],
    pub ticker_hash: [u8; 32],
    pub reservation_id_hash: [u8; 32],
    pub reservation_version: u64,
    /// Zero means immediate launch. A non-zero value is an immutable scheduled launch time.
    pub launch_at: i64,
    pub graduation_target_usd_micros: u64,
    pub deadline: i64,
    pub nonce: [u8; 32],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TokenAllocation {
    pub curve_tokens: u64,
    pub liquidity_tokens: u64,
    pub reserve_tokens: u64,
}

#[event]
pub struct CampaignCreated {
    pub campaign: Pubkey,
    pub campaign_id: [u8; 32],
    pub generation_id: [u8; 32],
    pub generation_config: Pubkey,
    pub generation_manifest_hash: [u8; 32],
    pub creator: Pubkey,
    pub mint: Pubkey,
    pub token_vault: Pubkey,
    pub sol_vault: Pubkey,
    pub token_total_supply: u64,
    pub curve_token_supply: u64,
    pub liquidity_token_supply: u64,
    pub reserve_token_supply: u64,
    pub mint_authority_revoked: bool,
    pub ticker_hash: [u8; 32],
    pub reservation_id_hash: [u8; 32],
    pub reservation_version: u64,
    pub launch_at: i64,
    pub graduation_target_usd_micros: u64,
    pub cluster_kind: u8,
    pub economics_version: u16,
    pub dex_adapter: u8,
    pub route_signer: Pubkey,
    pub authorization_schema_version: u16,
    pub authorization_hash: [u8; 32],
    pub created_at: i64,
}

fn create_token_program_account<'info>(
    payer: &AccountInfo<'info>,
    account: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    space: usize,
    signer_seeds: &[&[u8]],
    rent: &Rent,
) -> Result<()> {
    require_keys_eq!(
        *token_program.key,
        token::ID,
        LaunchpadError::InvalidCampaign
    );
    require!(account.lamports() == 0, LaunchpadError::InvalidCampaign);
    require!(account.data_is_empty(), LaunchpadError::InvalidCampaign);
    let lamports = rent.minimum_balance(space);
    let ix = system_instruction::create_account(
        payer.key,
        account.key,
        lamports,
        space as u64,
        &token::ID,
    );
    invoke_signed(
        &ix,
        &[payer.clone(), account.clone(), system_program.clone()],
        &[signer_seeds],
    )?;
    Ok(())
}

fn create_program_account<'info>(
    payer: &AccountInfo<'info>,
    account: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    space: usize,
    signer_seeds: &[&[u8]],
) -> Result<()> {
    require!(account.lamports() == 0, LaunchpadError::InvalidCampaign);
    require!(account.data_is_empty(), LaunchpadError::InvalidCampaign);
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(space);
    let ix = system_instruction::create_account(
        payer.key,
        account.key,
        lamports,
        space as u64,
        &crate::ID,
    );
    invoke_signed(
        &ix,
        &[payer.clone(), account.clone(), system_program.clone()],
        &[signer_seeds],
    )?;
    Ok(())
}

fn new_creator_profile(wallet: Pubkey, bump: u8) -> CreatorProfile {
    CreatorProfile {
        wallet,
        tier: CREATOR_TIER_1,
        trust_score: DEFAULT_NEW_CREATOR_TRUST_SCORE,
        live_bonding_count: 0,
        last_launch_timestamp: 0,
        total_launches: 0,
        successful_graduations: 0,
        restricted: false,
        manual_review_required: false,
        creator_buy_cap_bps: DEFAULT_NEW_CREATOR_BUY_CAP_BPS,
        max_live_bonding_count: TIER_1_MAX_LIVE_BONDING,
        cooldown_seconds: TIER_COOLDOWN_SECONDS,
        creator_buy_lock_seconds: TIER_1_CREATOR_LOCK_SECONDS,
        bump,
    }
}

#[inline(never)]
fn ensure_creator_profile<'info>(ctx: &Context<CreateCampaign<'info>>) -> Result<()> {
    let account = ctx.accounts.creator_profile.to_account_info();
    if account.owner == &crate::ID && !account.data_is_empty() {
        return Ok(());
    }
    require!(
        account.lamports() == 0,
        LaunchpadError::InvalidCreatorProfile
    );
    require!(
        account.data_is_empty(),
        LaunchpadError::InvalidCreatorProfile
    );

    let wallet = ctx.accounts.creator.key();
    let bump_seed = [ctx.bumps.creator_profile];
    let seeds: &[&[u8]] = &[CREATOR_PROFILE_SEED, wallet.as_ref(), &bump_seed];
    create_program_account(
        &ctx.accounts.creator.to_account_info(),
        &account,
        &ctx.accounts.system_program.to_account_info(),
        8 + CreatorProfile::INIT_SPACE,
        seeds,
    )?;

    let profile = new_creator_profile(wallet, ctx.bumps.creator_profile);
    let mut data = account.try_borrow_mut_data()?;
    let mut cursor = std::io::Cursor::new(&mut data[..]);
    profile.try_serialize(&mut cursor)?;
    Ok(())
}

pub(crate) fn load_risk_profile_or_default(
    account: &AccountInfo<'_>,
    wallet: Pubkey,
    bump: u8,
) -> Result<RiskProfile> {
    if account.owner == &crate::ID && !account.data_is_empty() {
        let data = account.try_borrow_data()?;
        let mut slice: &[u8] = &data;
        return RiskProfile::try_deserialize(&mut slice);
    }
    require!(account.lamports() == 0, LaunchpadError::InvalidRiskProfile);
    require!(account.data_is_empty(), LaunchpadError::InvalidRiskProfile);
    Ok(RiskProfile {
        wallet,
        risk_level: 0,
        restricted: false,
        cluster_id: EMPTY_CLUSTER_ID,
        manual_review_required: false,
        bump,
    })
}

fn validate_risk_wallet(creator: Pubkey, risk_profile: &RiskProfile) -> Result<()> {
    require_keys_eq!(
        risk_profile.wallet,
        creator,
        LaunchpadError::InvalidRiskProfile
    );
    require!(!risk_profile.restricted, LaunchpadError::WalletRestricted);
    require!(
        !risk_profile.manual_review_required,
        LaunchpadError::CreatorManualReviewRequired
    );
    Ok(())
}

pub fn create_campaign_handler(
    ctx: &mut Context<CreateCampaign>,
    args: &CreateCampaignArgs,
) -> Result<()> {
    // Stack discipline: do heavy loads + auth verify in an isolated #[inline(never)] frame
    // so the main handler stays under the BPF 4KB stack limit.
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    require_keys_eq!(
        *ctx.accounts.token_program.key,
        token::ID,
        LaunchpadError::InvalidCampaign
    );
    require_keys_eq!(
        *ctx.accounts.system_program.key,
        anchor_lang::system_program::ID,
        LaunchpadError::InvalidCampaign
    );

    // BNB CreatorRegistry treats an unknown wallet as NewCreator. Materialize the same
    // Tier-1 defaults atomically on the first successful Solana create. If any later
    // authorization/validation fails, Solana transaction atomicity rolls this creation back.
    ensure_creator_profile(ctx)?;
    let prep = prepare_and_verify_create_auth(ctx, args, now)?;

    let campaign_key = ctx.accounts.campaign.key();
    let mint_key = ctx.accounts.mint.key();
    let token_vault_key = ctx.accounts.token_vault.key();
    let sol_vault_key = ctx.accounts.sol_vault.key();
    let creator_key = ctx.accounts.creator.key();
    let generation_key = ctx.accounts.generation_config.key();

    let campaign_bump_seed = [ctx.bumps.campaign];
    let mint_bump_seed = [ctx.bumps.mint];
    let token_vault_bump_seed = [ctx.bumps.token_vault];
    let sol_vault_bump_seed = [ctx.bumps.sol_vault];
    let create_auth_bump_seed = [ctx.bumps.create_authorization];
    let campaign_seeds: &[&[u8]] = &[
        CAMPAIGN_SEED,
        args.campaign_id.as_ref(),
        &campaign_bump_seed,
    ];
    let mint_seeds: &[&[u8]] = &[
        CAMPAIGN_MINT_SEED,
        args.campaign_id.as_ref(),
        &mint_bump_seed,
    ];
    let token_vault_seeds: &[&[u8]] = &[
        TOKEN_VAULT_SEED,
        args.campaign_id.as_ref(),
        &token_vault_bump_seed,
    ];
    let sol_vault_seeds: &[&[u8]] = &[
        SOL_VAULT_SEED,
        args.campaign_id.as_ref(),
        &sol_vault_bump_seed,
    ];
    let create_auth_seeds: &[&[u8]] = &[
        CREATE_AUTH_SEED,
        creator_key.as_ref(),
        args.nonce.as_ref(),
        &create_auth_bump_seed,
    ];

    let payer_info = ctx.accounts.creator.to_account_info();
    let system_info = ctx.accounts.system_program.to_account_info();
    let token_program_info = ctx.accounts.token_program.to_account_info();
    let mint_info = ctx.accounts.mint.to_account_info();
    let token_vault_info = ctx.accounts.token_vault.to_account_info();
    let campaign_info = ctx.accounts.campaign.to_account_info();
    let rent = Rent::get()?;

    create_token_program_account(
        &payer_info,
        &mint_info,
        &system_info,
        &token_program_info,
        SplMint::LEN,
        mint_seeds,
        &rent,
    )?;
    invoke(
        &spl_token::instruction::initialize_mint2(
            &token::ID,
            &mint_key,
            &campaign_key,
            None,
            prep.token_decimals,
        )?,
        &[mint_info.clone()],
    )?;

    create_token_program_account(
        &payer_info,
        &token_vault_info,
        &system_info,
        &token_program_info,
        SplTokenAccount::LEN,
        token_vault_seeds,
        &rent,
    )?;
    invoke(
        &spl_token::instruction::initialize_account3(
            &token::ID,
            &token_vault_key,
            &mint_key,
            &campaign_key,
        )?,
        &[token_vault_info.clone(), mint_info.clone()],
    )?;

    create_program_account(
        &payer_info,
        &campaign_info,
        &system_info,
        8 + Campaign::INIT_SPACE,
        campaign_seeds,
    )?;
    create_program_account(
        &payer_info,
        &ctx.accounts.sol_vault.to_account_info(),
        &system_info,
        8 + CampaignSolVault::INIT_SPACE,
        sol_vault_seeds,
    )?;
    create_program_account(
        &payer_info,
        &ctx.accounts.create_authorization.to_account_info(),
        &system_info,
        8 + CreateAuthorization::INIT_SPACE,
        create_auth_seeds,
    )?;

    // Write campaign body in isolated frame (GenerationConfig + Campaign are large).
    write_campaign_body(
        ctx,
        args,
        &prep,
        now,
        generation_key,
        campaign_key,
        mint_key,
        token_vault_key,
        sol_vault_key,
        creator_key,
    )?;

    let campaign_signer = &[campaign_seeds];
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: mint_info.clone(),
                to: token_vault_info.clone(),
                authority: campaign_info.clone(),
            },
            campaign_signer,
        ),
        prep.token_total_supply,
    )?;

    {
        let mint_state = {
            let data = mint_info.try_borrow_data()?;
            SplMint::unpack(&data)?
        };
        let vault_state = {
            let data = token_vault_info.try_borrow_data()?;
            SplTokenAccount::unpack(&data)?
        };
        require!(
            mint_state.supply == prep.token_total_supply,
            LaunchpadError::InvalidCampaign
        );
        require!(
            vault_state.amount == prep.token_total_supply,
            LaunchpadError::InvalidCampaign
        );
        require!(
            mint_state.decimals == prep.token_decimals,
            LaunchpadError::InvalidCampaign
        );
        require!(
            mint_state.mint_authority == COption::Some(campaign_key),
            LaunchpadError::InvalidCampaign
        );
        require!(
            mint_state.freeze_authority == COption::None,
            LaunchpadError::InvalidCampaign
        );
        require_keys_eq!(vault_state.mint, mint_key, LaunchpadError::InvalidCampaign);
        require_keys_eq!(
            vault_state.owner,
            campaign_key,
            LaunchpadError::InvalidCampaign
        );
    }

    token::set_authority(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            SetAuthority {
                account_or_mint: mint_info.clone(),
                current_authority: campaign_info.clone(),
            },
            campaign_signer,
        ),
        AuthorityType::MintTokens,
        None,
    )?;

    verify_mint_authority_revoked(&mint_info)?;
    write_create_authorization(
        &ctx.accounts.create_authorization.to_account_info(),
        creator_key,
        args.nonce,
        args.deadline,
        now,
        prep.route_signer,
        prep.authorization_hash,
        ctx.bumps.create_authorization,
    )?;
    bump_creator_launch_stats(&ctx.accounts.creator_profile.to_account_info(), now)?;

    emit_campaign_created(
        ctx,
        args,
        &prep,
        now,
        generation_key,
        campaign_key,
        mint_key,
        token_vault_key,
        sol_vault_key,
        creator_key,
    )?;

    Ok(())
}

struct CreateAuthPrep {
    route_signer: Pubkey,
    authorization_hash: [u8; 32],
    launch_at: i64,
    creator_buy_cap_bps: u16,
    creator_buy_lock_until: i64,
    token_decimals: u8,
    token_total_supply: u64,
    allocation: TokenAllocation,
}

#[inline(never)]
fn prepare_and_verify_create_auth<'info>(
    ctx: &Context<CreateCampaign<'info>>,
    args: &CreateCampaignArgs,
    now: i64,
) -> Result<CreateAuthPrep> {
    let generation_key = ctx.accounts.generation_config.key();
    let cluster_key = ctx.accounts.cluster_profile.key();
    let campaign_key = ctx.accounts.campaign.key();
    let mint_key = ctx.accounts.mint.key();
    let token_vault_key = ctx.accounts.token_vault.key();
    let sol_vault_key = ctx.accounts.sol_vault.key();
    let token_program_key = ctx.accounts.token_program.key();
    let creator_key = ctx.accounts.creator.key();

    let launch_at = validate_create_args(args, now)?;

    let route_signer = {
        let data = ctx.accounts.global_config.try_borrow_data()?;
        let mut slice: &[u8] = &data;
        let global_config = GlobalConfig::try_deserialize(&mut slice)?;
        require_create_enabled(&global_config)?;
        {
            let data = ctx.accounts.generation_config.try_borrow_data()?;
            let mut slice: &[u8] = &data;
            let generation_config = GenerationConfig::try_deserialize(&mut slice)?;
            validate_campaign_generation(&global_config, generation_key, &generation_config)?;
        }
        global_config.route_signer
    };

    let data = ctx.accounts.generation_config.try_borrow_data()?;
    let mut slice: &[u8] = &data;
    let generation_config = GenerationConfig::try_deserialize(&mut slice)?;
    {
        let (expected_generation, _) = Pubkey::find_program_address(
            &[
                GENERATION_CONFIG_SEED,
                generation_config.generation_id.as_ref(),
            ],
            &crate::ID,
        );
        require_keys_eq!(
            generation_key,
            expected_generation,
            LaunchpadError::InvalidCampaign
        );
    }
    validate_graduation_target(&generation_config, args.graduation_target_usd_micros)?;
    require!(
        generation_config.token_decimals > 0,
        LaunchpadError::InvalidCampaign
    );

    let (creator_buy_lock_seconds, creator_buy_cap_bps) = {
        let data = ctx.accounts.creator_profile.try_borrow_data()?;
        let mut slice: &[u8] = &data;
        let creator_profile = CreatorProfile::try_deserialize(&mut slice)?;
        validate_creator_can_launch(&creator_profile, now)?;
        (
            creator_profile.creator_buy_lock_seconds,
            creator_profile.creator_buy_cap_bps,
        )
    };

    let risk_cluster_id = {
        let risk_profile = load_risk_profile_or_default(
            &ctx.accounts.risk_profile.to_account_info(),
            creator_key,
            ctx.bumps.risk_profile,
        )?;
        validate_risk_wallet(creator_key, &risk_profile)?;

        if risk_profile.cluster_id == EMPTY_CLUSTER_ID {
            // BNB RiskRegistry: an unknown/unclustered wallet is allowed unless it is
            // explicitly restricted. Bind the deterministic zero-cluster PDA but do not
            // require it to exist or deserialize it.
            let (expected_cluster, _) = Pubkey::find_program_address(
                &[CLUSTER_PROFILE_SEED, EMPTY_CLUSTER_ID.as_ref()],
                &crate::ID,
            );
            require_keys_eq!(
                cluster_key,
                expected_cluster,
                LaunchpadError::InvalidCampaign
            );
        } else {
            let data = ctx.accounts.cluster_profile.try_borrow_data()?;
            let mut slice: &[u8] = &data;
            let cluster_profile = ClusterProfile::try_deserialize(&mut slice)?;
            let (expected_cluster, _) = Pubkey::find_program_address(
                &[CLUSTER_PROFILE_SEED, risk_profile.cluster_id.as_ref()],
                &crate::ID,
            );
            require_keys_eq!(
                cluster_key,
                expected_cluster,
                LaunchpadError::InvalidCampaign
            );
            validate_create_risk_profiles(creator_key, &risk_profile, &cluster_profile)?;
        }
        risk_profile.cluster_id
    };

    let creator_buy_lock_until = launch_at
        .checked_add(i64::from(creator_buy_lock_seconds))
        .ok_or(LaunchpadError::MathOverflow)?;
    let allocation = calculate_token_allocation(
        generation_config.token_total_supply,
        generation_config.curve_supply_bps,
        generation_config.liquidity_token_bps,
    )?;
    let token_decimals = generation_config.token_decimals;
    let token_total_supply = generation_config.token_total_supply;

    let authorization_message = build_create_authorization_message(
        crate::id(),
        generation_key,
        &generation_config,
        creator_key,
        risk_cluster_id,
        creator_buy_lock_seconds,
        creator_buy_cap_bps,
        campaign_key,
        mint_key,
        token_vault_key,
        sol_vault_key,
        token_program_key,
        args,
    );
    let authorization_hash = hash(&authorization_message).to_bytes();

    verify_detached_create_authorization(
        &ctx.accounts.instructions.to_account_info(),
        route_signer,
        &authorization_hash,
    )?;

    Ok(CreateAuthPrep {
        route_signer,
        authorization_hash,
        launch_at,
        creator_buy_cap_bps,
        creator_buy_lock_until,
        token_decimals,
        token_total_supply,
        allocation,
    })
}

#[inline(never)]
fn verify_mint_authority_revoked(mint_info: &AccountInfo<'_>) -> Result<()> {
    let mint_state_after = {
        let data = mint_info.try_borrow_data()?;
        SplMint::unpack(&data)?
    };
    require!(
        mint_state_after.mint_authority == COption::None,
        LaunchpadError::InvalidCampaign
    );
    require!(
        mint_state_after.freeze_authority == COption::None,
        LaunchpadError::InvalidCampaign
    );
    Ok(())
}

#[inline(never)]
fn write_create_authorization(
    account: &AccountInfo<'_>,
    creator: Pubkey,
    nonce: [u8; 32],
    deadline: i64,
    used_at: i64,
    route_signer: Pubkey,
    message_hash: [u8; 32],
    bump: u8,
) -> Result<()> {
    let create_authorization = CreateAuthorization {
        creator,
        nonce,
        deadline,
        used_at,
        route_signer,
        message_hash,
        schema_version: CREATE_AUTH_SCHEMA_VERSION,
        bump,
    };
    let mut data = account.try_borrow_mut_data()?;
    let mut cursor = std::io::Cursor::new(&mut data[..]);
    create_authorization.try_serialize(&mut cursor)?;
    Ok(())
}

#[inline(never)]
fn bump_creator_launch_stats(account: &AccountInfo<'_>, now: i64) -> Result<()> {
    let mut data = account.try_borrow_mut_data()?;
    let mut slice: &[u8] = &data;
    let mut creator_profile = CreatorProfile::try_deserialize(&mut slice)?;
    creator_profile.live_bonding_count = creator_profile
        .live_bonding_count
        .checked_add(1)
        .ok_or(LaunchpadError::MathOverflow)?;
    creator_profile.total_launches = creator_profile
        .total_launches
        .checked_add(1)
        .ok_or(LaunchpadError::MathOverflow)?;
    creator_profile.last_launch_timestamp = now;
    let mut cursor = std::io::Cursor::new(&mut data[..]);
    creator_profile.try_serialize(&mut cursor)?;
    Ok(())
}

#[inline(never)]
fn load_generation_config(account: &AccountInfo<'_>) -> Result<Box<GenerationConfig>> {
    let data = account.try_borrow_data()?;
    let mut slice: &[u8] = &data;
    Ok(Box::new(GenerationConfig::try_deserialize(&mut slice)?))
}

#[inline(never)]
fn assemble_campaign(
    generation: &GenerationConfig,
    args: &CreateCampaignArgs,
    prep: &CreateAuthPrep,
    now: i64,
    generation_key: Pubkey,
    creator_key: Pubkey,
    mint_key: Pubkey,
    token_vault_key: Pubkey,
    sol_vault_key: Pubkey,
    campaign_bump: u8,
    mint_bump: u8,
    token_vault_bump: u8,
    sol_vault_bump: u8,
) -> Box<Campaign> {
    Box::new(Campaign {
        campaign_id: args.campaign_id,
        generation_id: generation.generation_id,
        generation_config: generation_key,
        generation_manifest_hash: generation.manifest_hash,
        creator: creator_key,
        mint: mint_key,
        token_vault: token_vault_key,
        sol_vault: sol_vault_key,
        metadata_hash: args.metadata_hash,
        cluster_hash: args.cluster_hash,
        ticker_hash: args.ticker_hash,
        reservation_id_hash: args.reservation_id_hash,
        reservation_version: args.reservation_version,
        launch_at: prep.launch_at,
        graduation_target_usd_micros: args.graduation_target_usd_micros,
        cluster_kind: generation.cluster_kind,
        economics_version: generation.economics_version,
        curve_kind: generation.curve_kind,
        token_total_supply: generation.token_total_supply,
        curve_token_supply: prep.allocation.curve_tokens,
        liquidity_token_supply: prep.allocation.liquidity_tokens,
        reserve_token_supply: prep.allocation.reserve_tokens,
        token_decimals: generation.token_decimals,
        curve_supply_bps: generation.curve_supply_bps,
        liquidity_token_bps: generation.liquidity_token_bps,
        base_price_lamports: generation.base_price_lamports,
        price_slope_lamports: generation.price_slope_lamports,
        buy_fee_bps: generation.buy_fee_bps,
        sell_fee_bps: generation.sell_fee_bps,
        finalize_fee_bps: generation.finalize_fee_bps,
        creator_post_finalize_bps: generation.creator_post_finalize_bps,
        liquidity_post_finalize_bps: generation.liquidity_post_finalize_bps,
        dex_adapter: generation.dex_adapter,
        trade_route_profile: generation.trade_route_profile,
        finalize_route_profile: generation.finalize_route_profile,
        treasury_profile: generation.treasury_profile,
        dex_profile: generation.dex_profile,
        oracle_profile: generation.oracle_profile,
        creator_buy_lock_until: prep.creator_buy_lock_until,
        creator_buy_cap_bps: prep.creator_buy_cap_bps,
        created_at: now,
        sold_tokens: 0,
        net_raised_lamports: 0,
        total_buy_volume_lamports: 0,
        total_sell_volume_lamports: 0,
        buyer_count: 0,
        creator_bought_tokens: 0,
        asset_initialization_version: ASSET_INITIALIZATION_VERSION,
        // Written true up front: mint authority is revoked later in this same atomic tx.
        // Re-deserializing Campaign in the parent frame overflowed BPF stack frame 9.
        mint_authority_revoked: true,
        graduated: false,
        curve_closed: false,
        paused: false,
        bump: campaign_bump,
        mint_bump,
        token_vault_bump,
        sol_vault_bump,
    })
}

#[inline(never)]
fn write_campaign_body<'info>(
    ctx: &Context<CreateCampaign<'info>>,
    args: &CreateCampaignArgs,
    prep: &CreateAuthPrep,
    now: i64,
    generation_key: Pubkey,
    campaign_key: Pubkey,
    mint_key: Pubkey,
    token_vault_key: Pubkey,
    sol_vault_key: Pubkey,
    creator_key: Pubkey,
) -> Result<()> {
    let generation = load_generation_config(&ctx.accounts.generation_config.to_account_info())?;
    let campaign = assemble_campaign(
        &generation,
        args,
        prep,
        now,
        generation_key,
        creator_key,
        mint_key,
        token_vault_key,
        sol_vault_key,
        ctx.bumps.campaign,
        ctx.bumps.mint,
        ctx.bumps.token_vault,
        ctx.bumps.sol_vault,
    );
    {
        let mut data = ctx.accounts.campaign.try_borrow_mut_data()?;
        let mut cursor = std::io::Cursor::new(&mut data[..]);
        campaign.try_serialize(&mut cursor)?;
    }
    let sol_vault = CampaignSolVault {
        campaign: campaign_key,
        generation_id: generation.generation_id,
        created_at: now,
        bump: ctx.bumps.sol_vault,
    };
    {
        let mut data = ctx.accounts.sol_vault.try_borrow_mut_data()?;
        let mut cursor = std::io::Cursor::new(&mut data[..]);
        sol_vault.try_serialize(&mut cursor)?;
    }
    Ok(())
}

#[inline(never)]
fn emit_campaign_created<'info>(
    ctx: &Context<CreateCampaign<'info>>,
    args: &CreateCampaignArgs,
    prep: &CreateAuthPrep,
    now: i64,
    generation_key: Pubkey,
    campaign_key: Pubkey,
    mint_key: Pubkey,
    token_vault_key: Pubkey,
    sol_vault_key: Pubkey,
    creator_key: Pubkey,
) -> Result<()> {
    let generation = load_generation_config(&ctx.accounts.generation_config.to_account_info())?;
    emit_campaign_created_body(
        &generation,
        args,
        prep,
        now,
        generation_key,
        campaign_key,
        mint_key,
        token_vault_key,
        sol_vault_key,
        creator_key,
    )
}

#[inline(never)]
fn emit_campaign_created_body(
    generation: &GenerationConfig,
    args: &CreateCampaignArgs,
    prep: &CreateAuthPrep,
    now: i64,
    generation_key: Pubkey,
    campaign_key: Pubkey,
    mint_key: Pubkey,
    token_vault_key: Pubkey,
    sol_vault_key: Pubkey,
    creator_key: Pubkey,
) -> Result<()> {
    emit!(CampaignCreated {
        campaign: campaign_key,
        campaign_id: args.campaign_id,
        generation_id: generation.generation_id,
        generation_config: generation_key,
        generation_manifest_hash: generation.manifest_hash,
        creator: creator_key,
        mint: mint_key,
        token_vault: token_vault_key,
        sol_vault: sol_vault_key,
        token_total_supply: prep.token_total_supply,
        curve_token_supply: prep.allocation.curve_tokens,
        liquidity_token_supply: prep.allocation.liquidity_tokens,
        reserve_token_supply: prep.allocation.reserve_tokens,
        mint_authority_revoked: true,
        ticker_hash: args.ticker_hash,
        reservation_id_hash: args.reservation_id_hash,
        reservation_version: args.reservation_version,
        launch_at: prep.launch_at,
        graduation_target_usd_micros: args.graduation_target_usd_micros,
        cluster_kind: generation.cluster_kind,
        economics_version: generation.economics_version,
        dex_adapter: generation.dex_adapter,
        route_signer: prep.route_signer,
        authorization_schema_version: CREATE_AUTH_SCHEMA_VERSION,
        authorization_hash: prep.authorization_hash,
        created_at: now,
    });
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn build_create_authorization_message(
    program_id: Pubkey,
    generation_config_key: Pubkey,
    generation: &GenerationConfig,
    creator: Pubkey,
    risk_cluster_id: [u8; 32],
    creator_buy_lock_seconds: u32,
    creator_buy_cap_bps: u16,
    campaign: Pubkey,
    mint: Pubkey,
    token_vault: Pubkey,
    sol_vault: Pubkey,
    token_program: Pubkey,
    args: &CreateCampaignArgs,
) -> Vec<u8> {
    let mut message = Vec::with_capacity(896);
    message.extend_from_slice(CREATE_AUTH_DOMAIN);
    message.extend_from_slice(&CREATE_AUTH_SCHEMA_VERSION.to_le_bytes());
    message.extend_from_slice(program_id.as_ref());
    message.extend_from_slice(args.cluster_hash.as_ref());

    message.extend_from_slice(generation.generation_id.as_ref());
    message.extend_from_slice(generation_config_key.as_ref());
    message.extend_from_slice(generation.program_id.as_ref());
    message.extend_from_slice(generation.config_pda.as_ref());
    message.extend_from_slice(&generation.start_slot.to_le_bytes());
    message.push(generation.cluster_kind);
    message.push(generation.allowed_graduation_tier_mask);
    message.extend_from_slice(&generation.economics_version.to_le_bytes());
    message.push(generation.curve_kind);
    message.extend_from_slice(&generation.token_total_supply.to_le_bytes());
    message.push(generation.token_decimals);
    message.extend_from_slice(&generation.curve_supply_bps.to_le_bytes());
    message.extend_from_slice(&generation.liquidity_token_bps.to_le_bytes());
    message.extend_from_slice(&generation.base_price_lamports.to_le_bytes());
    message.extend_from_slice(&generation.price_slope_lamports.to_le_bytes());
    message.extend_from_slice(&generation.buy_fee_bps.to_le_bytes());
    message.extend_from_slice(&generation.sell_fee_bps.to_le_bytes());
    message.extend_from_slice(&generation.finalize_fee_bps.to_le_bytes());
    message.extend_from_slice(&generation.creator_post_finalize_bps.to_le_bytes());
    message.extend_from_slice(&generation.liquidity_post_finalize_bps.to_le_bytes());
    message.push(generation.dex_adapter);
    message.extend_from_slice(generation.trade_route_profile.as_ref());
    message.extend_from_slice(generation.finalize_route_profile.as_ref());
    message.extend_from_slice(generation.treasury_profile.as_ref());
    message.extend_from_slice(generation.dex_profile.as_ref());
    message.extend_from_slice(generation.oracle_profile.as_ref());
    message.extend_from_slice(generation.manifest_hash.as_ref());
    message.push(u8::from(generation.route_authorization_required));
    message.push(u8::from(generation.authorized_trading_required));

    message.extend_from_slice(creator.as_ref());
    message.extend_from_slice(risk_cluster_id.as_ref());
    message.extend_from_slice(&creator_buy_lock_seconds.to_le_bytes());
    message.extend_from_slice(&creator_buy_cap_bps.to_le_bytes());
    message.extend_from_slice(args.campaign_id.as_ref());
    message.extend_from_slice(campaign.as_ref());
    message.extend_from_slice(mint.as_ref());
    message.extend_from_slice(token_vault.as_ref());
    message.extend_from_slice(sol_vault.as_ref());
    message.extend_from_slice(token_program.as_ref());
    message.extend_from_slice(args.metadata_hash.as_ref());
    message.extend_from_slice(args.ticker_hash.as_ref());
    message.extend_from_slice(args.reservation_id_hash.as_ref());
    message.extend_from_slice(&args.reservation_version.to_le_bytes());
    message.extend_from_slice(&args.launch_at.to_le_bytes());
    message.extend_from_slice(&args.graduation_target_usd_micros.to_le_bytes());
    message.extend_from_slice(args.nonce.as_ref());
    message.extend_from_slice(&args.deadline.to_le_bytes());
    message
}

pub fn calculate_token_allocation(
    total_supply: u64,
    curve_supply_bps: u16,
    liquidity_token_bps: u16,
) -> Result<TokenAllocation> {
    require!(total_supply > 0, LaunchpadError::InvalidCampaign);

    let denominator = u128::from(BPS_DENOMINATOR);
    let curve_tokens = u64::try_from(
        u128::from(total_supply)
            .checked_mul(u128::from(curve_supply_bps))
            .ok_or(LaunchpadError::MathOverflow)?
            / denominator,
    )
    .map_err(|_| error!(LaunchpadError::MathOverflow))?;
    let liquidity_tokens = u64::try_from(
        u128::from(total_supply)
            .checked_mul(u128::from(liquidity_token_bps))
            .ok_or(LaunchpadError::MathOverflow)?
            / denominator,
    )
    .map_err(|_| error!(LaunchpadError::MathOverflow))?;
    let reserve_tokens = total_supply
        .checked_sub(curve_tokens)
        .and_then(|remaining| remaining.checked_sub(liquidity_tokens))
        .ok_or(LaunchpadError::MathOverflow)?;

    require!(curve_tokens > 0, LaunchpadError::InvalidCampaign);
    require!(liquidity_tokens > 0, LaunchpadError::InvalidCampaign);
    require!(
        curve_tokens
            .checked_add(liquidity_tokens)
            .and_then(|value| value.checked_add(reserve_tokens))
            == Some(total_supply),
        LaunchpadError::InvalidCampaign
    );

    Ok(TokenAllocation {
        curve_tokens,
        liquidity_tokens,
        reserve_tokens,
    })
}

pub(crate) fn verify_detached_create_authorization(
    instructions_account: &AccountInfo<'_>,
    expected_route_signer: Pubkey,
    expected_message: &[u8],
) -> Result<()> {
    let current_index = load_current_index_checked(instructions_account)
        .map_err(|_| error!(LaunchpadError::InvalidCreateAuthorization))?;
    require!(
        current_index > 0,
        LaunchpadError::InvalidCreateAuthorization
    );

    let current_instruction =
        load_instruction_at_checked(usize::from(current_index), instructions_account)
            .map_err(|_| error!(LaunchpadError::InvalidCreateAuthorization))?;
    require_keys_eq!(
        current_instruction.program_id,
        crate::id(),
        LaunchpadError::InvalidCreateAuthorization
    );

    let verification_instruction =
        load_instruction_at_checked(usize::from(current_index - 1), instructions_account)
            .map_err(|_| error!(LaunchpadError::InvalidCreateAuthorization))?;

    validate_ed25519_instruction(
        &verification_instruction,
        expected_route_signer,
        expected_message,
    )
}

pub(crate) fn validate_ed25519_instruction(
    instruction: &Instruction,
    expected_route_signer: Pubkey,
    expected_message: &[u8],
) -> Result<()> {
    require_keys_eq!(
        instruction.program_id,
        ed25519_program::id(),
        LaunchpadError::InvalidCreateAuthorization
    );
    require!(
        instruction.accounts.is_empty(),
        LaunchpadError::InvalidCreateAuthorization
    );

    let parsed = parse_single_ed25519_instruction(&instruction.data)?;
    require!(
        parsed.public_key == expected_route_signer.as_ref(),
        LaunchpadError::InvalidCreateAuthorization
    );
    require!(
        parsed.message == expected_message,
        LaunchpadError::InvalidCreateAuthorization
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
        LaunchpadError::InvalidCreateAuthorization
    );
    require!(data[0] == 1, LaunchpadError::InvalidCreateAuthorization);
    require!(data[1] == 0, LaunchpadError::InvalidCreateAuthorization);

    let signature_offset = read_u16(data, 2)?;
    let signature_instruction_index = read_u16(data, 4)?;
    let public_key_offset = read_u16(data, 6)?;
    let public_key_instruction_index = read_u16(data, 8)?;
    let message_data_offset = read_u16(data, 10)?;
    let message_data_size = read_u16(data, 12)?;
    let message_instruction_index = read_u16(data, 14)?;

    require!(
        signature_instruction_index == ED25519_CURRENT_INSTRUCTION,
        LaunchpadError::InvalidCreateAuthorization
    );
    require!(
        public_key_instruction_index == ED25519_CURRENT_INSTRUCTION,
        LaunchpadError::InvalidCreateAuthorization
    );
    require!(
        message_instruction_index == ED25519_CURRENT_INSTRUCTION,
        LaunchpadError::InvalidCreateAuthorization
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
    require!(
        end <= data.len(),
        LaunchpadError::InvalidCreateAuthorization
    );
    Ok(u16::from_le_bytes([data[offset], data[offset + 1]]))
}

fn checked_slice(data: &[u8], offset: u16, len: usize) -> Result<&[u8]> {
    let start = usize::from(offset);
    let end = start.checked_add(len).ok_or(LaunchpadError::MathOverflow)?;
    require!(
        end <= data.len(),
        LaunchpadError::InvalidCreateAuthorization
    );
    Ok(&data[start..end])
}

pub(crate) fn require_create_enabled(global: &GlobalConfig) -> Result<()> {
    require!(!global.paused, LaunchpadError::LaunchpadPaused);
    require!(!global.create_paused, LaunchpadError::CreatePaused);
    require!(
        global.route_authorization_required,
        LaunchpadError::InvalidCreateAuthorization
    );
    Ok(())
}

pub(crate) fn validate_create_args(args: &CreateCampaignArgs, now: i64) -> Result<i64> {
    require!(args.campaign_id != [0; 32], LaunchpadError::InvalidCampaign);
    require!(
        args.metadata_hash != [0; 32],
        LaunchpadError::InvalidMetadata
    );
    require!(
        args.cluster_hash != [0; 32],
        LaunchpadError::InvalidCampaign
    );
    require!(args.ticker_hash != [0; 32], LaunchpadError::InvalidCampaign);
    require!(
        args.reservation_id_hash != [0; 32],
        LaunchpadError::InvalidCampaign
    );
    require!(
        args.reservation_version > 0,
        LaunchpadError::InvalidCampaign
    );
    require!(args.nonce != [0; 32], LaunchpadError::InvalidNonce);
    require!(
        args.deadline >= now,
        LaunchpadError::CreateAuthorizationExpired
    );

    resolve_launch_at(args.launch_at, now)
}

fn validate_graduation_target(generation: &GenerationConfig, target_usd_micros: u64) -> Result<()> {
    require!(
        generation_allows_graduation_target(generation, target_usd_micros),
        LaunchpadError::GraduationTargetNotAllowed
    );
    Ok(())
}

fn resolve_launch_at(requested_launch_at: i64, now: i64) -> Result<i64> {
    if requested_launch_at == 0 {
        return Ok(now);
    }

    let minimum = now
        .checked_add(MIN_SCHEDULE_SECONDS)
        .ok_or(LaunchpadError::MathOverflow)?;
    let maximum = now
        .checked_add(MAX_SCHEDULE_SECONDS)
        .ok_or(LaunchpadError::MathOverflow)?;

    require!(
        requested_launch_at >= minimum,
        LaunchpadError::InvalidCampaign
    );
    require!(
        requested_launch_at <= maximum,
        LaunchpadError::InvalidCampaign
    );
    Ok(requested_launch_at)
}

pub(crate) fn validate_campaign_generation(
    global: &GlobalConfig,
    generation_key: Pubkey,
    generation: &GenerationConfig,
) -> Result<()> {
    require_keys_eq!(
        generation.program_id,
        crate::id(),
        LaunchpadError::InvalidGenerationProgram
    );
    require_keys_eq!(
        generation.config_pda,
        generation_key,
        LaunchpadError::InvalidGeneration
    );
    require!(
        generation.support_enabled,
        LaunchpadError::CampaignGenerationInactive
    );
    require!(
        generation.active_creation,
        LaunchpadError::CampaignGenerationInactive
    );
    require!(
        global.active_generation_id == generation.generation_id,
        LaunchpadError::CampaignGenerationInactive
    );
    require!(
        generation.route_authorization_required,
        LaunchpadError::InvalidCreateAuthorization
    );
    require!(
        generation.authorized_trading_required,
        LaunchpadError::InvalidCreateAuthorization
    );
    Ok(())
}

pub(crate) fn validate_creator_can_launch(profile: &CreatorProfile, now: i64) -> Result<()> {
    require!(!profile.restricted, LaunchpadError::CreatorRestricted);
    require!(
        !profile.manual_review_required,
        LaunchpadError::CreatorManualReviewRequired
    );
    require!(
        profile.live_bonding_count < profile.max_live_bonding_count,
        LaunchpadError::CreatorLaunchLimitExceeded
    );

    if profile.last_launch_timestamp > 0 {
        let next_allowed = profile
            .last_launch_timestamp
            .checked_add(i64::from(profile.cooldown_seconds))
            .ok_or(LaunchpadError::MathOverflow)?;
        require!(now >= next_allowed, LaunchpadError::CreatorCooldownActive);
    }

    Ok(())
}

pub(crate) fn validate_create_risk_profiles(
    creator: Pubkey,
    risk_profile: &RiskProfile,
    cluster_profile: &ClusterProfile,
) -> Result<()> {
    validate_risk_wallet(creator, risk_profile)?;
    require!(
        risk_profile.cluster_id != EMPTY_CLUSTER_ID,
        LaunchpadError::InvalidCluster
    );
    require!(
        cluster_profile.cluster_id == risk_profile.cluster_id,
        LaunchpadError::InvalidCluster
    );
    require!(
        !cluster_profile.restricted,
        LaunchpadError::ClusterRestricted
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        CLUSTER_KIND_DEVNET, CLUSTER_KIND_MAINNET_BETA, CREATOR_TIER_1, CURVE_KIND_LINEAR_V1,
        DEX_ADAPTER_METEORA_DAMM_V2, ECONOMICS_VERSION_V1, EMPTY_GENERATION_ID,
        GRADUATION_TARGET_30K_USD_MICROS, GRADUATION_TARGET_50K_USD_MICROS,
        GRADUATION_TARGET_6_USD_MICROS, GRADUATION_TIER_6_USD_MASK, GRADUATION_TIER_ALL_MASK,
        GRADUATION_TIER_PRODUCTION_MASK, LOCKED_BUY_FEE_BPS, LOCKED_CREATOR_POST_FINALIZE_BPS,
        LOCKED_FINALIZE_FEE_BPS, LOCKED_LIQUIDITY_POST_FINALIZE_BPS, LOCKED_SELL_FEE_BPS,
        TIER_1_MAX_LIVE_BONDING,
    };

    fn test_global(route_signer: Pubkey, active_generation_id: [u8; 32]) -> GlobalConfig {
        GlobalConfig {
            admin: Pubkey::new_unique(),
            pauser: Pubkey::new_unique(),
            tier_admin: Pubkey::new_unique(),
            risk_admin: Pubkey::new_unique(),
            route_signer,
            reward_operator: Pubkey::new_unique(),
            treasury_operator: Pubkey::new_unique(),
            generation_operator: Pubkey::new_unique(),
            active_generation_id,
            generation_count: 1,
            paused: false,
            create_paused: false,
            buy_paused: true,
            sell_paused: true,
            graduation_paused: true,
            claims_paused: true,
            route_authorization_required: true,
            authorized_trading_required: true,
            security_defaults_locked: true,
            bump: 255,
        }
    }

    fn test_generation(
        generation_id: [u8; 32],
        config_pda: Pubkey,
        cluster_kind: u8,
        tier_mask: u8,
    ) -> GenerationConfig {
        GenerationConfig {
            generation_id,
            program_id: crate::id(),
            config_pda,
            start_slot: 42,
            cluster_kind,
            allowed_graduation_tier_mask: tier_mask,
            economics_version: ECONOMICS_VERSION_V1,
            curve_kind: CURVE_KIND_LINEAR_V1,
            token_total_supply: 1_000_000_000_000_000,
            token_decimals: 6,
            curve_supply_bps: 8_000,
            liquidity_token_bps: 1_000,
            base_price_lamports: 1_000,
            price_slope_lamports: 10,
            buy_fee_bps: LOCKED_BUY_FEE_BPS,
            sell_fee_bps: LOCKED_SELL_FEE_BPS,
            finalize_fee_bps: LOCKED_FINALIZE_FEE_BPS,
            creator_post_finalize_bps: LOCKED_CREATOR_POST_FINALIZE_BPS,
            liquidity_post_finalize_bps: LOCKED_LIQUIDITY_POST_FINALIZE_BPS,
            dex_adapter: DEX_ADAPTER_METEORA_DAMM_V2,
            trade_route_profile: [1; 32],
            finalize_route_profile: [2; 32],
            treasury_profile: [3; 32],
            dex_profile: [4; 32],
            oracle_profile: [5; 32],
            active_creation: true,
            support_enabled: true,
            manifest_hash: [9; 32],
            route_authorization_required: true,
            authorized_trading_required: true,
            bump: 254,
        }
    }

    fn test_creator_profile(wallet: Pubkey) -> CreatorProfile {
        CreatorProfile {
            wallet,
            tier: CREATOR_TIER_1,
            trust_score: 7_000,
            live_bonding_count: 0,
            last_launch_timestamp: 0,
            total_launches: 0,
            successful_graduations: 0,
            restricted: false,
            manual_review_required: false,
            creator_buy_cap_bps: 1_000,
            max_live_bonding_count: TIER_1_MAX_LIVE_BONDING,
            cooldown_seconds: 86_400,
            creator_buy_lock_seconds: 86_400,
            bump: 253,
        }
    }

    fn test_risk_profile(wallet: Pubkey, cluster_id: [u8; 32]) -> RiskProfile {
        RiskProfile {
            wallet,
            risk_level: 1,
            restricted: false,
            cluster_id,
            manual_review_required: false,
            bump: 252,
        }
    }

    fn test_cluster_profile(cluster_id: [u8; 32]) -> ClusterProfile {
        ClusterProfile {
            cluster_id,
            size: 2,
            risk_level: 1,
            restricted: false,
            bump: 251,
        }
    }

    fn test_create_args(deadline: i64) -> CreateCampaignArgs {
        CreateCampaignArgs {
            campaign_id: [1; 32],
            metadata_hash: [2; 32],
            cluster_hash: [3; 32],
            ticker_hash: [4; 32],
            reservation_id_hash: [5; 32],
            reservation_version: 7,
            launch_at: 0,
            graduation_target_usd_micros: GRADUATION_TARGET_30K_USD_MICROS,
            deadline,
            nonce: [11; 32],
        }
    }

    fn test_asset_addresses(campaign_id: [u8; 32]) -> (Pubkey, Pubkey, Pubkey, Pubkey) {
        let (campaign, _) =
            Pubkey::find_program_address(&[CAMPAIGN_SEED, campaign_id.as_ref()], &crate::id());
        let (mint, _) =
            Pubkey::find_program_address(&[CAMPAIGN_MINT_SEED, campaign_id.as_ref()], &crate::id());
        let (token_vault, _) =
            Pubkey::find_program_address(&[TOKEN_VAULT_SEED, campaign_id.as_ref()], &crate::id());
        let (sol_vault, _) =
            Pubkey::find_program_address(&[SOL_VAULT_SEED, campaign_id.as_ref()], &crate::id());
        (campaign, mint, token_vault, sol_vault)
    }

    fn build_test_message(
        generation_key: Pubkey,
        generation: &GenerationConfig,
        creator: Pubkey,
        args: &CreateCampaignArgs,
    ) -> Vec<u8> {
        let (campaign, mint, token_vault, sol_vault) = test_asset_addresses(args.campaign_id);
        build_create_authorization_message(
            crate::id(),
            generation_key,
            generation,
            creator,
            [12; 32],
            86_400,
            1_000,
            campaign,
            mint,
            token_vault,
            sol_vault,
            anchor_spl::token::ID,
            args,
        )
    }

    fn build_test_ed25519_instruction(route_signer: Pubkey, message: &[u8]) -> Instruction {
        let signature_offset = ED25519_HEADER_SIZE as u16;
        let public_key_offset = signature_offset + ED25519_SIGNATURE_SIZE as u16;
        let message_data_offset = public_key_offset + ED25519_PUBLIC_KEY_SIZE as u16;
        let message_data_size = u16::try_from(message.len()).unwrap();

        let mut data = Vec::with_capacity(usize::from(message_data_offset) + message.len());
        data.push(1);
        data.push(0);
        data.extend_from_slice(&signature_offset.to_le_bytes());
        data.extend_from_slice(&ED25519_CURRENT_INSTRUCTION.to_le_bytes());
        data.extend_from_slice(&public_key_offset.to_le_bytes());
        data.extend_from_slice(&ED25519_CURRENT_INSTRUCTION.to_le_bytes());
        data.extend_from_slice(&message_data_offset.to_le_bytes());
        data.extend_from_slice(&message_data_size.to_le_bytes());
        data.extend_from_slice(&ED25519_CURRENT_INSTRUCTION.to_le_bytes());
        data.extend_from_slice(&[42; ED25519_SIGNATURE_SIZE]);
        data.extend_from_slice(route_signer.as_ref());
        data.extend_from_slice(message);

        Instruction {
            program_id: ed25519_program::id(),
            accounts: Vec::new(),
            data,
        }
    }

    #[test]
    fn create_v3_removes_creator_supplied_mint() {
        let args = test_create_args(200);
        assert_eq!(args.campaign_id, [1; 32]);
        assert_eq!(CREATE_AUTH_SCHEMA_VERSION, 4);
        assert_eq!(CREATE_AUTH_DOMAIN, b"MEMEWARZONE_SOLANA_CREATE_V4");
    }

    #[test]
    fn new_creator_defaults_match_bnb_new_creator_rules() {
        let wallet = Pubkey::new_unique();
        let profile = new_creator_profile(wallet, 200);
        assert_eq!(profile.wallet, wallet);
        assert_eq!(profile.tier, CREATOR_TIER_1);
        assert_eq!(profile.trust_score, 0);
        assert_eq!(profile.live_bonding_count, 0);
        assert_eq!(profile.max_live_bonding_count, TIER_1_MAX_LIVE_BONDING);
        assert_eq!(profile.cooldown_seconds, 86_400);
        assert_eq!(profile.creator_buy_lock_seconds, 86_400);
        assert!(!profile.restricted);
        assert!(!profile.manual_review_required);
    }

    #[test]
    fn implicit_risk_defaults_match_bnb_unknown_wallet() {
        let wallet = Pubkey::new_unique();
        let profile = RiskProfile {
            wallet,
            risk_level: 0,
            restricted: false,
            cluster_id: EMPTY_CLUSTER_ID,
            manual_review_required: false,
            bump: 1,
        };
        assert!(validate_risk_wallet(wallet, &profile).is_ok());
        assert_eq!(profile.cluster_id, EMPTY_CLUSTER_ID);
    }

    #[test]
    fn deterministic_asset_pdas_are_distinct() {
        let (campaign, mint, token_vault, sol_vault) = test_asset_addresses([1; 32]);
        assert_ne!(campaign, mint);
        assert_ne!(campaign, token_vault);
        assert_ne!(campaign, sol_vault);
        assert_ne!(mint, token_vault);
        assert_ne!(mint, sol_vault);
        assert_ne!(token_vault, sol_vault);
    }

    #[test]
    fn token_allocation_accounts_for_full_supply() {
        let allocation = calculate_token_allocation(1_000_000, 8_000, 1_000).unwrap();
        assert_eq!(allocation.curve_tokens, 800_000);
        assert_eq!(allocation.liquidity_tokens, 100_000);
        assert_eq!(allocation.reserve_tokens, 100_000);
        assert_eq!(
            allocation.curve_tokens + allocation.liquidity_tokens + allocation.reserve_tokens,
            1_000_000
        );
    }

    #[test]
    fn token_allocation_preserves_rounding_dust_in_reserve() {
        let allocation = calculate_token_allocation(101, 8_000, 1_000).unwrap();
        assert_eq!(allocation.curve_tokens, 80);
        assert_eq!(allocation.liquidity_tokens, 10);
        assert_eq!(allocation.reserve_tokens, 11);
    }

    #[test]
    fn create_args_reject_empty_metadata_hash() {
        let mut args = test_create_args(200);
        args.metadata_hash = [0; 32];
        assert!(validate_create_args(&args, 100).is_err());
    }

    #[test]
    fn create_args_reject_expired_deadline() {
        let args = test_create_args(99);
        assert!(validate_create_args(&args, 100).is_err());
    }

    #[test]
    fn create_args_reject_empty_nonce() {
        let mut args = test_create_args(200);
        args.nonce = [0; 32];
        assert!(validate_create_args(&args, 100).is_err());
    }

    #[test]
    fn devnet_generation_accepts_six_dollar_target() {
        let generation_key = Pubkey::new_unique();
        let generation = test_generation(
            [8; 32],
            generation_key,
            CLUSTER_KIND_DEVNET,
            GRADUATION_TIER_ALL_MASK,
        );
        assert!(validate_graduation_target(&generation, GRADUATION_TARGET_6_USD_MICROS).is_ok());
    }

    #[test]
    fn mainnet_generation_rejects_six_dollar_target() {
        let generation_key = Pubkey::new_unique();
        let generation = test_generation(
            [8; 32],
            generation_key,
            CLUSTER_KIND_MAINNET_BETA,
            GRADUATION_TIER_PRODUCTION_MASK,
        );
        assert!(validate_graduation_target(&generation, GRADUATION_TARGET_6_USD_MICROS).is_err());
    }

    #[test]
    fn generation_target_mask_rejects_unselected_production_tier() {
        let generation_key = Pubkey::new_unique();
        let generation = test_generation(
            [8; 32],
            generation_key,
            CLUSTER_KIND_DEVNET,
            GRADUATION_TIER_6_USD_MASK,
        );
        assert!(validate_graduation_target(&generation, GRADUATION_TARGET_30K_USD_MICROS).is_err());
    }

    #[test]
    fn immediate_launch_resolves_to_current_clock() {
        let args = test_create_args(200);
        assert_eq!(validate_create_args(&args, 100).unwrap(), 100);
    }

    #[test]
    fn scheduled_launch_enforces_five_minute_minimum() {
        let mut args = test_create_args(1_000);
        args.launch_at = 399;
        assert!(validate_create_args(&args, 100).is_err());

        args.launch_at = 400;
        assert_eq!(validate_create_args(&args, 100).unwrap(), 400);
    }

    #[test]
    fn scheduled_launch_enforces_thirty_day_maximum() {
        let mut args = test_create_args(4_000_000);
        args.launch_at = 100 + MAX_SCHEDULE_SECONDS + 1;
        assert!(validate_create_args(&args, 100).is_err());
    }

    #[test]
    fn campaign_generation_requires_active_supported_generation_and_self_key() {
        let generation_id = [8; 32];
        let generation_key = Pubkey::new_unique();
        let global = test_global(Pubkey::new_unique(), generation_id);
        let generation = test_generation(
            generation_id,
            generation_key,
            CLUSTER_KIND_DEVNET,
            GRADUATION_TIER_ALL_MASK,
        );
        assert!(validate_campaign_generation(&global, generation_key, &generation).is_ok());
        assert!(validate_campaign_generation(&global, Pubkey::new_unique(), &generation).is_err());

        let inactive_global = test_global(Pubkey::new_unique(), EMPTY_GENERATION_ID);
        assert!(
            validate_campaign_generation(&inactive_global, generation_key, &generation).is_err()
        );
    }

    #[test]
    fn detached_authorization_accepts_exact_signer_and_payload() {
        let route_signer = Pubkey::new_unique();
        let message = b"meme-warzone-create-payload";
        let instruction = build_test_ed25519_instruction(route_signer, message);
        assert!(validate_ed25519_instruction(&instruction, route_signer, message).is_ok());
    }

    #[test]
    fn detached_authorization_rejects_wrong_signer() {
        let route_signer = Pubkey::new_unique();
        let instruction = build_test_ed25519_instruction(route_signer, b"payload");
        assert!(
            validate_ed25519_instruction(&instruction, Pubkey::new_unique(), b"payload").is_err()
        );
    }

    #[test]
    fn detached_authorization_rejects_modified_payload() {
        let route_signer = Pubkey::new_unique();
        let instruction = build_test_ed25519_instruction(route_signer, b"payload");
        assert!(validate_ed25519_instruction(&instruction, route_signer, b"changed").is_err());
    }

    #[test]
    fn detached_authorization_rejects_cross_instruction_offsets() {
        let route_signer = Pubkey::new_unique();
        let mut instruction = build_test_ed25519_instruction(route_signer, b"payload");
        instruction.data[4..6].copy_from_slice(&0u16.to_le_bytes());
        assert!(validate_ed25519_instruction(&instruction, route_signer, b"payload").is_err());
    }

    #[test]
    fn authorization_payload_binds_timer_ticker_reservation_and_target() {
        let creator = Pubkey::new_unique();
        let generation_key = Pubkey::new_unique();
        let generation = test_generation(
            [8; 32],
            generation_key,
            CLUSTER_KIND_DEVNET,
            GRADUATION_TIER_ALL_MASK,
        );
        let args = test_create_args(1_000);
        let baseline = build_test_message(generation_key, &generation, creator, &args);

        let mut changed = args;
        changed.ticker_hash = [13; 32];
        assert_ne!(
            baseline,
            build_test_message(generation_key, &generation, creator, &changed)
        );

        changed = args;
        changed.reservation_version += 1;
        assert_ne!(
            baseline,
            build_test_message(generation_key, &generation, creator, &changed)
        );

        changed = args;
        changed.launch_at = 1_700_000_000;
        assert_ne!(
            baseline,
            build_test_message(generation_key, &generation, creator, &changed)
        );

        changed = args;
        changed.graduation_target_usd_micros = GRADUATION_TARGET_50K_USD_MICROS;
        assert_ne!(
            baseline,
            build_test_message(generation_key, &generation, creator, &changed)
        );
    }

    #[test]
    fn authorization_payload_binds_generation_economics_and_profiles() {
        let creator = Pubkey::new_unique();
        let generation_key = Pubkey::new_unique();
        let generation = test_generation(
            [8; 32],
            generation_key,
            CLUSTER_KIND_DEVNET,
            GRADUATION_TIER_ALL_MASK,
        );
        let args = test_create_args(1_000);
        let baseline = build_test_message(generation_key, &generation, creator, &args);

        let mut changed_generation = test_generation(
            [8; 32],
            generation_key,
            CLUSTER_KIND_DEVNET,
            GRADUATION_TIER_ALL_MASK,
        );
        changed_generation.price_slope_lamports += 1;
        assert_ne!(
            baseline,
            build_test_message(generation_key, &changed_generation, creator, &args)
        );

        let mut changed_generation = test_generation(
            [8; 32],
            generation_key,
            CLUSTER_KIND_DEVNET,
            GRADUATION_TIER_ALL_MASK,
        );
        changed_generation.treasury_profile = [99; 32];
        assert_ne!(
            baseline,
            build_test_message(generation_key, &changed_generation, creator, &args)
        );
    }

    #[test]
    fn authorization_payload_binds_all_asset_accounts() {
        let creator = Pubkey::new_unique();
        let generation_key = Pubkey::new_unique();
        let generation = test_generation(
            [8; 32],
            generation_key,
            CLUSTER_KIND_DEVNET,
            GRADUATION_TIER_ALL_MASK,
        );
        let args = test_create_args(1_000);
        let (campaign, mint, token_vault, sol_vault) = test_asset_addresses(args.campaign_id);
        let baseline = build_create_authorization_message(
            crate::id(),
            generation_key,
            &generation,
            creator,
            [12; 32],
            86_400,
            1_000,
            campaign,
            mint,
            token_vault,
            sol_vault,
            anchor_spl::token::ID,
            &args,
        );

        for changed_accounts in [
            (Pubkey::new_unique(), mint, token_vault, sol_vault),
            (campaign, Pubkey::new_unique(), token_vault, sol_vault),
            (campaign, mint, Pubkey::new_unique(), sol_vault),
            (campaign, mint, token_vault, Pubkey::new_unique()),
        ] {
            let changed = build_create_authorization_message(
                crate::id(),
                generation_key,
                &generation,
                creator,
                [12; 32],
                86_400,
                1_000,
                changed_accounts.0,
                changed_accounts.1,
                changed_accounts.2,
                changed_accounts.3,
                anchor_spl::token::ID,
                &args,
            );
            assert_ne!(baseline, changed);
        }
    }

    #[test]
    fn authorization_payload_binds_canonical_token_program() {
        let creator = Pubkey::new_unique();
        let generation_key = Pubkey::new_unique();
        let generation = test_generation(
            [8; 32],
            generation_key,
            CLUSTER_KIND_DEVNET,
            GRADUATION_TIER_ALL_MASK,
        );
        let args = test_create_args(1_000);
        let (campaign, mint, token_vault, sol_vault) = test_asset_addresses(args.campaign_id);
        let baseline = build_test_message(generation_key, &generation, creator, &args);
        let changed = build_create_authorization_message(
            crate::id(),
            generation_key,
            &generation,
            creator,
            [12; 32],
            86_400,
            1_000,
            campaign,
            mint,
            token_vault,
            sol_vault,
            Pubkey::new_unique(),
            &args,
        );
        assert_ne!(baseline, changed);
    }

    #[test]
    fn creator_launch_rejects_live_count_at_limit() {
        let wallet = Pubkey::new_unique();
        let mut profile = test_creator_profile(wallet);
        profile.live_bonding_count = profile.max_live_bonding_count;
        assert!(validate_creator_can_launch(&profile, 1_700_000_000).is_err());
    }

    #[test]
    fn creator_launch_rejects_active_cooldown() {
        let wallet = Pubkey::new_unique();
        let mut profile = test_creator_profile(wallet);
        profile.last_launch_timestamp = 1_700_000_000;
        assert!(validate_creator_can_launch(&profile, 1_700_010_000).is_err());
    }

    #[test]
    fn creator_launch_rejects_restricted_creator() {
        let wallet = Pubkey::new_unique();
        let mut profile = test_creator_profile(wallet);
        profile.restricted = true;
        assert!(validate_creator_can_launch(&profile, 1_700_100_000).is_err());
    }

    #[test]
    fn risk_profiles_reject_restricted_wallet() {
        let wallet = Pubkey::new_unique();
        let cluster_id = [6; 32];
        let mut risk = test_risk_profile(wallet, cluster_id);
        risk.restricted = true;
        let cluster = test_cluster_profile(cluster_id);
        assert!(validate_create_risk_profiles(wallet, &risk, &cluster).is_err());
    }

    #[test]
    fn risk_profiles_reject_restricted_cluster() {
        let wallet = Pubkey::new_unique();
        let cluster_id = [6; 32];
        let risk = test_risk_profile(wallet, cluster_id);
        let mut cluster = test_cluster_profile(cluster_id);
        cluster.restricted = true;
        assert!(validate_create_risk_profiles(wallet, &risk, &cluster).is_err());
    }

    #[test]
    fn risk_profiles_require_matching_cluster() {
        let wallet = Pubkey::new_unique();
        let risk = test_risk_profile(wallet, [6; 32]);
        let cluster = test_cluster_profile([7; 32]);
        assert!(validate_create_risk_profiles(wallet, &risk, &cluster).is_err());
    }
}
