use anchor_lang::prelude::*;

declare_id!("3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt");

pub const GLOBAL_CONFIG_SEED: &[u8] = b"global";
pub const GENERATION_CONFIG_SEED: &[u8] = b"generation";
pub const CREATOR_PROFILE_SEED: &[u8] = b"creator";
pub const RISK_PROFILE_SEED: &[u8] = b"risk";
pub const CLUSTER_PROFILE_SEED: &[u8] = b"cluster";
pub const EMPTY_GENERATION_ID: [u8; 32] = [0; 32];
pub const EMPTY_CLUSTER_ID: [u8; 32] = [0; 32];

/// Post-grad DEX product lock: Meteora DAMM v2 only.
pub const DEX_ADAPTER_METEORA_DAMM_V2: u8 = 1;
/// Historical enum value — not accepted by generation validation (no Raydium product path).
pub const DEX_ADAPTER_RAYDIUM_CPMM: u8 = 2;

pub const CLUSTER_KIND_DEVNET: u8 = 1;
pub const CLUSTER_KIND_MAINNET_BETA: u8 = 2;

pub const GRADUATION_TIER_6_USD_MASK: u8 = 1 << 0;
pub const GRADUATION_TIER_15K_USD_MASK: u8 = 1 << 1;
pub const GRADUATION_TIER_30K_USD_MASK: u8 = 1 << 2;
pub const GRADUATION_TIER_50K_USD_MASK: u8 = 1 << 3;
pub const GRADUATION_TIER_PRODUCTION_MASK: u8 =
    GRADUATION_TIER_15K_USD_MASK | GRADUATION_TIER_30K_USD_MASK | GRADUATION_TIER_50K_USD_MASK;
pub const GRADUATION_TIER_ALL_MASK: u8 =
    GRADUATION_TIER_6_USD_MASK | GRADUATION_TIER_PRODUCTION_MASK;

pub const GRADUATION_TARGET_6_USD_MICROS: u64 = 6_000_000;
pub const GRADUATION_TARGET_15K_USD_MICROS: u64 = 15_000_000_000;
pub const GRADUATION_TARGET_30K_USD_MICROS: u64 = 30_000_000_000;
pub const GRADUATION_TARGET_50K_USD_MICROS: u64 = 50_000_000_000;

pub const ECONOMICS_VERSION_V1: u16 = 1;
/// Whole-token linear curve used by the legacy flat Devnet V2 generation.
pub const ECONOMICS_VERSION_V2: u16 = 2;
/// BNB-parity fixed-point curve. price_slope_lamports is nano-lamports per whole-token².
pub const ECONOMICS_VERSION_V3: u16 = 3;
pub const CURVE_KIND_LINEAR_V1: u8 = 1;
pub const MAX_TOKEN_DECIMALS: u8 = 9;
pub const BPS_DENOMINATOR: u16 = 10_000;
pub const LOCKED_BUY_FEE_BPS: u16 = 200;
pub const LOCKED_SELL_FEE_BPS: u16 = 200;
pub const LOCKED_FINALIZE_FEE_BPS: u16 = 200;
/// Carved from the 200 bps protocol fee — not an extra tax on the trader.
pub const LEAGUE_FEE_BPS: u16 = 75;
pub const LEAGUE_VAULT_SEED: &[u8] = b"league_vault";
pub const AIRDROP_VAULT_SEED: &[u8] = b"airdrop_vault";
pub const MONTHLY_LEAGUE_VAULT_SEED: &[u8] = b"monthly_league_vault";
pub const RECRUITER_VAULT_SEED: &[u8] = b"recruiter_vault";
pub const SQUAD_VAULT_SEED: &[u8] = b"squad_vault";
pub const PROTOCOL_VAULT_SEED: &[u8] = b"protocol_vault";
pub const ROUTE_KIND_TRADE: u8 = 0;
pub const ROUTE_KIND_FINALIZE: u8 = 1;
pub const ROUTE_PROFILE_LINKED: u8 = 0;
pub const ROUTE_PROFILE_UNLINKED: u8 = 1;
pub const ROUTE_PROFILE_OG: u8 = 2;

pub fn rewards_treasury_program_id() -> Pubkey {
    pubkey!("2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX")
}
pub const LOCKED_CREATOR_POST_FINALIZE_BPS: u16 = 2_000;
pub const LOCKED_LIQUIDITY_POST_FINALIZE_BPS: u16 = 8_000;

pub const CREATOR_TIER_1: u8 = 1;
pub const CREATOR_TIER_2: u8 = 2;
pub const CREATOR_TIER_3: u8 = 3;
pub const TRUST_SCORE_MAX: u16 = 10_000;
pub const CREATOR_BUY_CAP_BPS_MAX: u16 = 10_000;
pub const RISK_LEVEL_MIN: u8 = 0;
pub const RISK_LEVEL_MAX: u8 = 3;

pub const TIER_COOLDOWN_SECONDS: u32 = 86_400;
pub const TIER_1_MAX_LIVE_BONDING: u16 = 3;
pub const TIER_2_MAX_LIVE_BONDING: u16 = 5;
pub const TIER_3_MAX_LIVE_BONDING: u16 = 10;
pub const TIER_1_CREATOR_LOCK_SECONDS: u32 = 86_400;
pub const TIER_2_CREATOR_LOCK_SECONDS: u32 = 21_600;
pub const TIER_3_CREATOR_LOCK_SECONDS: u32 = 3_600;

pub mod authorized_create;
pub use authorized_create::*;

pub mod campaign_view;

pub mod authorized_trade;
pub use authorized_trade::*;

pub mod fee_escrow;
pub use fee_escrow::*;

pub mod graduation;
pub use graduation::*;

#[program]
pub mod memewarzone_solana {
    use super::*;

    pub fn initialize_global_config(
        ctx: Context<InitializeGlobalConfig>,
        authorities: GlobalAuthorities,
    ) -> Result<()> {
        validate_authorities(&authorities)?;

        let global = &mut ctx.accounts.global_config;
        global.admin = authorities.admin;
        global.pauser = authorities.pauser;
        global.tier_admin = authorities.tier_admin;
        global.risk_admin = authorities.risk_admin;
        global.route_signer = authorities.route_signer;
        global.reward_operator = authorities.reward_operator;
        global.treasury_operator = authorities.treasury_operator;
        global.generation_operator = authorities.generation_operator;
        global.active_generation_id = EMPTY_GENERATION_ID;
        global.generation_count = 0;
        global.paused = false;
        global.create_paused = true;
        global.buy_paused = true;
        global.sell_paused = true;
        global.graduation_paused = true;
        global.claims_paused = true;
        global.route_authorization_required = true;
        global.authorized_trading_required = true;
        global.security_defaults_locked = false;
        global.bump = ctx.bumps.global_config;

        emit!(GlobalConfigInitialized {
            admin: global.admin,
            pauser: global.pauser,
            route_signer: global.route_signer,
        });
        Ok(())
    }

    pub fn set_pause_flags(ctx: Context<SetPauseFlags>, flags: PauseFlags) -> Result<()> {
        let global = &mut ctx.accounts.global_config;
        require_pause_authority(global, ctx.accounts.authority.key())?;

        global.paused = flags.paused;
        global.create_paused = flags.create_paused;
        global.buy_paused = flags.buy_paused;
        global.sell_paused = flags.sell_paused;
        global.graduation_paused = flags.graduation_paused;
        global.claims_paused = flags.claims_paused;

        emit!(PauseFlagsUpdated {
            authority: ctx.accounts.authority.key(),
            paused: global.paused,
            create_paused: global.create_paused,
            buy_paused: global.buy_paused,
            sell_paused: global.sell_paused,
            graduation_paused: global.graduation_paused,
            claims_paused: global.claims_paused,
        });
        Ok(())
    }

    pub fn set_campaign_pause(ctx: Context<SetCampaignPause>, paused: bool) -> Result<()> {
        authorized_trade::set_campaign_pause_handler(ctx, paused)
    }

    pub fn update_global_authorities(
        ctx: Context<UpdateGlobalAuthorities>,
        authorities: GlobalAuthorities,
    ) -> Result<()> {
        let global = &mut ctx.accounts.global_config;
        require_admin(global, ctx.accounts.admin.key())?;
        validate_authorities(&authorities)?;

        global.admin = authorities.admin;
        global.pauser = authorities.pauser;
        global.tier_admin = authorities.tier_admin;
        global.risk_admin = authorities.risk_admin;
        global.route_signer = authorities.route_signer;
        global.reward_operator = authorities.reward_operator;
        global.treasury_operator = authorities.treasury_operator;
        global.generation_operator = authorities.generation_operator;

        emit!(GlobalAuthoritiesUpdated {
            admin: global.admin,
            pauser: global.pauser,
            tier_admin: global.tier_admin,
            risk_admin: global.risk_admin,
            route_signer: global.route_signer,
            reward_operator: global.reward_operator,
            treasury_operator: global.treasury_operator,
            generation_operator: global.generation_operator,
        });
        Ok(())
    }

    pub fn lock_security_defaults(ctx: Context<LockSecurityDefaults>) -> Result<()> {
        let global = &mut ctx.accounts.global_config;
        require_admin(global, ctx.accounts.admin.key())?;
        require!(
            !global.security_defaults_locked,
            LaunchpadError::SecurityDefaultsAlreadyLocked
        );

        global.route_authorization_required = true;
        global.authorized_trading_required = true;
        global.security_defaults_locked = true;

        emit!(SecurityDefaultsLocked {
            admin: ctx.accounts.admin.key(),
            route_authorization_required: global.route_authorization_required,
            authorized_trading_required: global.authorized_trading_required,
        });
        Ok(())
    }

    pub fn initialize_generation_config(
        ctx: Context<InitializeGenerationConfig>,
        settings: GenerationSettings,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let generation_config_key = ctx.accounts.generation_config.key();
        let global = &mut ctx.accounts.global_config;
        require_generation_authority(global, ctx.accounts.authority.key())?;
        validate_generation_settings(global, &settings)?;

        if settings.active_creation {
            require!(
                is_empty_generation_id(global.active_generation_id),
                LaunchpadError::ActiveCreationGenerationExists
            );
            global.active_generation_id = settings.generation_id;
        }

        let generation = &mut ctx.accounts.generation_config;
        generation.generation_id = settings.generation_id;
        generation.program_id = crate::id();
        generation.config_pda = generation_config_key;
        generation.start_slot = clock.slot;
        generation.cluster_kind = settings.cluster_kind;
        generation.allowed_graduation_tier_mask = settings.allowed_graduation_tier_mask;
        generation.economics_version = settings.economics_version;
        generation.curve_kind = settings.curve_kind;
        generation.token_total_supply = settings.token_total_supply;
        generation.token_decimals = settings.token_decimals;
        generation.curve_supply_bps = settings.curve_supply_bps;
        generation.liquidity_token_bps = settings.liquidity_token_bps;
        generation.base_price_lamports = settings.base_price_lamports;
        generation.price_slope_lamports = settings.price_slope_lamports;
        generation.buy_fee_bps = settings.buy_fee_bps;
        generation.sell_fee_bps = settings.sell_fee_bps;
        generation.finalize_fee_bps = settings.finalize_fee_bps;
        generation.creator_post_finalize_bps = settings.creator_post_finalize_bps;
        generation.liquidity_post_finalize_bps = settings.liquidity_post_finalize_bps;
        generation.dex_adapter = settings.dex_adapter;
        generation.trade_route_profile = settings.trade_route_profile;
        generation.finalize_route_profile = settings.finalize_route_profile;
        generation.treasury_profile = settings.treasury_profile;
        generation.dex_profile = settings.dex_profile;
        generation.oracle_profile = settings.oracle_profile;
        generation.active_creation = settings.active_creation;
        generation.support_enabled = settings.support_enabled;
        generation.manifest_hash = settings.manifest_hash;
        generation.route_authorization_required = true;
        generation.authorized_trading_required = true;
        generation.bump = ctx.bumps.generation_config;

        global.generation_count = global
            .generation_count
            .checked_add(1)
            .ok_or(LaunchpadError::MathOverflow)?;

        emit!(GenerationConfigInitialized {
            generation_id: generation.generation_id,
            program_id: generation.program_id,
            config_pda: generation.config_pda,
            start_slot: generation.start_slot,
            cluster_kind: generation.cluster_kind,
            allowed_graduation_tier_mask: generation.allowed_graduation_tier_mask,
            economics_version: generation.economics_version,
            curve_kind: generation.curve_kind,
            dex_adapter: generation.dex_adapter,
            manifest_hash: generation.manifest_hash,
            active_creation: generation.active_creation,
            support_enabled: generation.support_enabled,
        });
        Ok(())
    }

    pub fn set_generation_support(
        ctx: Context<SetGenerationSupport>,
        support_enabled: bool,
        active_creation: bool,
    ) -> Result<()> {
        let global = &mut ctx.accounts.global_config;
        require_generation_authority(global, ctx.accounts.authority.key())?;

        let generation = &mut ctx.accounts.generation_config;
        global.active_generation_id = resolve_generation_support_update(
            global.active_generation_id,
            generation.generation_id,
            support_enabled,
            active_creation,
        )?;
        generation.support_enabled = support_enabled;
        generation.active_creation = active_creation;

        emit!(GenerationSupportUpdated {
            generation_id: generation.generation_id,
            support_enabled: generation.support_enabled,
            active_creation: generation.active_creation,
        });
        Ok(())
    }

    pub fn create_campaign(
        mut ctx: Context<CreateCampaign>,
        args: CreateCampaignArgs,
    ) -> Result<()> {
        authorized_create::create_campaign_handler(&mut ctx, &args)
    }

    pub fn sync_creator_profile(
        ctx: Context<SyncCreatorProfile>,
        update: CreatorProfileUpdate,
    ) -> Result<()> {
        let global = &ctx.accounts.global_config;
        require_tier_authority(global, ctx.accounts.authority.key())?;
        validate_creator_profile_update(&update)?;

        let limits = tier_limits(update.tier)?;
        let creator_profile = &mut ctx.accounts.creator_profile;
        creator_profile.wallet = update.wallet;
        creator_profile.tier = update.tier;
        creator_profile.trust_score = update.trust_score;
        creator_profile.live_bonding_count = update.live_bonding_count;
        creator_profile.last_launch_timestamp = update.last_launch_timestamp;
        creator_profile.total_launches = update.total_launches;
        creator_profile.successful_graduations = update.successful_graduations;
        creator_profile.restricted = update.restricted;
        creator_profile.manual_review_required = update.manual_review_required;
        creator_profile.creator_buy_cap_bps = update.creator_buy_cap_bps;
        creator_profile.max_live_bonding_count = limits.max_live_bonding_count;
        creator_profile.cooldown_seconds = limits.cooldown_seconds;
        creator_profile.creator_buy_lock_seconds = limits.creator_buy_lock_seconds;
        creator_profile.bump = ctx.bumps.creator_profile;

        emit!(CreatorProfileSynced {
            wallet: creator_profile.wallet,
            tier: creator_profile.tier,
            live_bonding_count: creator_profile.live_bonding_count,
            restricted: creator_profile.restricted,
            manual_review_required: creator_profile.manual_review_required,
        });
        Ok(())
    }

    pub fn sync_risk_profile(
        ctx: Context<SyncRiskProfile>,
        update: RiskProfileUpdate,
    ) -> Result<()> {
        let global = &ctx.accounts.global_config;
        require_risk_authority(global, ctx.accounts.authority.key())?;
        validate_risk_profile_update(&update)?;

        let risk_profile = &mut ctx.accounts.risk_profile;
        risk_profile.wallet = update.wallet;
        risk_profile.risk_level = update.risk_level;
        risk_profile.restricted = update.restricted;
        risk_profile.cluster_id = update.cluster_id;
        risk_profile.manual_review_required = update.manual_review_required;
        risk_profile.bump = ctx.bumps.risk_profile;

        emit!(RiskProfileSynced {
            wallet: risk_profile.wallet,
            risk_level: risk_profile.risk_level,
            restricted: risk_profile.restricted,
            cluster_id: risk_profile.cluster_id,
            manual_review_required: risk_profile.manual_review_required,
        });
        Ok(())
    }

    pub fn sync_cluster_profile(
        ctx: Context<SyncClusterProfile>,
        update: ClusterProfileUpdate,
    ) -> Result<()> {
        let global = &ctx.accounts.global_config;
        require_risk_authority(global, ctx.accounts.authority.key())?;
        validate_cluster_profile_update(&update)?;

        let cluster_profile = &mut ctx.accounts.cluster_profile;
        cluster_profile.cluster_id = update.cluster_id;
        cluster_profile.size = update.size;
        cluster_profile.risk_level = update.risk_level;
        cluster_profile.restricted = update.restricted;
        cluster_profile.bump = ctx.bumps.cluster_profile;

        emit!(ClusterProfileSynced {
            cluster_id: cluster_profile.cluster_id,
            size: cluster_profile.size,
            risk_level: cluster_profile.risk_level,
            restricted: cluster_profile.restricted,
        });
        Ok(())
    }

    /// Exact SOL in (gross) → tokens out from vault. Fee taken from gross; net buys on curve.
    pub fn buy_tokens(ctx: Context<BuyTokens>, args: BuyTokensArgs) -> Result<()> {
        buy_tokens_handler(ctx, args)
    }

    /// Exact tokens in → SOL out from sol vault. Gross refund from curve; fee retained in vault.
    pub fn sell_tokens(ctx: Context<SellTokens>, args: SellTokensArgs) -> Result<()> {
        sell_tokens_handler(ctx, args)
    }

    /// Permissionless rent-payer init of the per-campaign fee escrow PDA.
    pub fn initialize_fee_escrow(ctx: Context<InitializeFeeEscrow>) -> Result<()> {
        initialize_fee_escrow_handler(ctx)
    }

    /// Permissionless rent-payer init of the per-campaign creator fee vault PDA.
    pub fn initialize_creator_fee_vault(ctx: Context<InitializeCreatorFeeVault>) -> Result<()> {
        initialize_creator_fee_vault_handler(ctx)
    }

    /// Permissionless flush of accrued fee slices to canonical rewards vaults.
    pub fn flush_campaign_fees(ctx: Context<FlushCampaignFees>) -> Result<()> {
        flush_campaign_fees_handler(ctx)
    }

    /// Creator-only claim from the isolated per-campaign creator fee vault PDA.
    pub fn claim_creator_fees(ctx: Context<ClaimCreatorFees>) -> Result<()> {
        claim_creator_fees_handler(ctx)
    }

    /// Permissionless close of an expired TradeAuthorization PDA. Rent always returns to trader.
    pub fn close_expired_trade_authorization(
        ctx: Context<CloseExpiredTradeAuthorization>,
        args: CloseExpiredTradeAuthorizationArgs,
    ) -> Result<()> {
        close_expired_trade_authorization_handler(ctx, args)
    }

    /// Starts an atomic graduation transaction and stages only the bounded DAMM v2 liquidity.
    pub fn begin_graduation(
        ctx: Context<BeginGraduation>,
        args: BeginGraduationArgs,
    ) -> Result<()> {
        begin_graduation_handler(ctx, args)
    }

    /// Verifies the deterministic DAMM v2 pool + permanently locked position, then finalizes Campaign.
    pub fn confirm_graduation(ctx: Context<ConfirmGraduation>) -> Result<()> {
        confirm_graduation_handler(ctx)
    }
}

#[derive(Accounts)]
pub struct InitializeGlobalConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + GlobalConfig::INIT_SPACE,
        seeds = [GLOBAL_CONFIG_SEED],
        bump
    )]
    pub global_config: Account<'info, GlobalConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPauseFlags<'info> {
    #[account(mut, seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, GlobalConfig>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetCampaignPause<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, GlobalConfig>,
    /// CHECK: campaign PDA; deserialized and pause-bit written in the handler.
    #[account(mut)]
    pub campaign: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct UpdateGlobalAuthorities<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, GlobalConfig>,
}

#[derive(Accounts)]
pub struct LockSecurityDefaults<'info> {
    #[account(mut, seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, GlobalConfig>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(settings: GenerationSettings)]
pub struct InitializeGenerationConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, GlobalConfig>,
    #[account(
        init,
        payer = authority,
        space = 8 + GenerationConfig::INIT_SPACE,
        seeds = [GENERATION_CONFIG_SEED, settings.generation_id.as_ref()],
        bump
    )]
    pub generation_config: Account<'info, GenerationConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetGenerationSupport<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, GlobalConfig>,
    #[account(
        mut,
        seeds = [GENERATION_CONFIG_SEED, generation_config.generation_id.as_ref()],
        bump = generation_config.bump
    )]
    pub generation_config: Account<'info, GenerationConfig>,
}

#[derive(Accounts)]
#[instruction(update: CreatorProfileUpdate)]
pub struct SyncCreatorProfile<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, GlobalConfig>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + CreatorProfile::INIT_SPACE,
        seeds = [CREATOR_PROFILE_SEED, update.wallet.as_ref()],
        bump
    )]
    pub creator_profile: Account<'info, CreatorProfile>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(update: RiskProfileUpdate)]
pub struct SyncRiskProfile<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, GlobalConfig>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + RiskProfile::INIT_SPACE,
        seeds = [RISK_PROFILE_SEED, update.wallet.as_ref()],
        bump
    )]
    pub risk_profile: Account<'info, RiskProfile>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(update: ClusterProfileUpdate)]
pub struct SyncClusterProfile<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [GLOBAL_CONFIG_SEED], bump = global_config.bump)]
    pub global_config: Account<'info, GlobalConfig>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + ClusterProfile::INIT_SPACE,
        seeds = [CLUSTER_PROFILE_SEED, update.cluster_id.as_ref()],
        bump
    )]
    pub cluster_profile: Account<'info, ClusterProfile>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct GlobalConfig {
    pub admin: Pubkey,
    pub pauser: Pubkey,
    pub tier_admin: Pubkey,
    pub risk_admin: Pubkey,
    pub route_signer: Pubkey,
    pub reward_operator: Pubkey,
    pub treasury_operator: Pubkey,
    pub generation_operator: Pubkey,
    pub active_generation_id: [u8; 32],
    pub generation_count: u64,
    pub paused: bool,
    pub create_paused: bool,
    pub buy_paused: bool,
    pub sell_paused: bool,
    pub graduation_paused: bool,
    pub claims_paused: bool,
    pub route_authorization_required: bool,
    pub authorized_trading_required: bool,
    pub security_defaults_locked: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct GenerationConfig {
    pub generation_id: [u8; 32],
    pub program_id: Pubkey,
    pub config_pda: Pubkey,
    pub start_slot: u64,
    pub cluster_kind: u8,
    pub allowed_graduation_tier_mask: u8,
    pub economics_version: u16,
    pub curve_kind: u8,
    pub token_total_supply: u64,
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
    pub active_creation: bool,
    pub support_enabled: bool,
    pub manifest_hash: [u8; 32],
    pub route_authorization_required: bool,
    pub authorized_trading_required: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct CreatorProfile {
    pub wallet: Pubkey,
    pub tier: u8,
    pub trust_score: u16,
    pub live_bonding_count: u16,
    pub last_launch_timestamp: i64,
    pub total_launches: u64,
    pub successful_graduations: u64,
    pub restricted: bool,
    pub manual_review_required: bool,
    pub creator_buy_cap_bps: u16,
    pub max_live_bonding_count: u16,
    pub cooldown_seconds: u32,
    pub creator_buy_lock_seconds: u32,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct RiskProfile {
    pub wallet: Pubkey,
    pub risk_level: u8,
    pub restricted: bool,
    pub cluster_id: [u8; 32],
    pub manual_review_required: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ClusterProfile {
    pub cluster_id: [u8; 32],
    pub size: u32,
    pub risk_level: u8,
    pub restricted: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct GlobalAuthorities {
    pub admin: Pubkey,
    pub pauser: Pubkey,
    pub tier_admin: Pubkey,
    pub risk_admin: Pubkey,
    pub route_signer: Pubkey,
    pub reward_operator: Pubkey,
    pub treasury_operator: Pubkey,
    pub generation_operator: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct PauseFlags {
    pub paused: bool,
    pub create_paused: bool,
    pub buy_paused: bool,
    pub sell_paused: bool,
    pub graduation_paused: bool,
    pub claims_paused: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct GenerationSettings {
    pub generation_id: [u8; 32],
    pub cluster_kind: u8,
    pub allowed_graduation_tier_mask: u8,
    pub economics_version: u16,
    pub curve_kind: u8,
    pub token_total_supply: u64,
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
    pub active_creation: bool,
    pub support_enabled: bool,
    pub manifest_hash: [u8; 32],
    pub route_authorization_required: bool,
    pub authorized_trading_required: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct CreatorProfileUpdate {
    pub wallet: Pubkey,
    pub tier: u8,
    pub trust_score: u16,
    pub live_bonding_count: u16,
    pub last_launch_timestamp: i64,
    pub total_launches: u64,
    pub successful_graduations: u64,
    pub restricted: bool,
    pub manual_review_required: bool,
    pub creator_buy_cap_bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct RiskProfileUpdate {
    pub wallet: Pubkey,
    pub risk_level: u8,
    pub restricted: bool,
    pub cluster_id: [u8; 32],
    pub manual_review_required: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct ClusterProfileUpdate {
    pub cluster_id: [u8; 32],
    pub size: u32,
    pub risk_level: u8,
    pub restricted: bool,
}

#[derive(Clone, Copy)]
pub struct CreatorTierLimits {
    pub max_live_bonding_count: u16,
    pub cooldown_seconds: u32,
    pub creator_buy_lock_seconds: u32,
}

#[event]
pub struct GlobalConfigInitialized {
    pub admin: Pubkey,
    pub pauser: Pubkey,
    pub route_signer: Pubkey,
}

#[event]
pub struct PauseFlagsUpdated {
    pub authority: Pubkey,
    pub paused: bool,
    pub create_paused: bool,
    pub buy_paused: bool,
    pub sell_paused: bool,
    pub graduation_paused: bool,
    pub claims_paused: bool,
}

#[event]
pub struct CampaignPauseUpdated {
    pub campaign: Pubkey,
    pub authority: Pubkey,
    pub paused: bool,
}

#[event]
pub struct GlobalAuthoritiesUpdated {
    pub admin: Pubkey,
    pub pauser: Pubkey,
    pub tier_admin: Pubkey,
    pub risk_admin: Pubkey,
    pub route_signer: Pubkey,
    pub reward_operator: Pubkey,
    pub treasury_operator: Pubkey,
    pub generation_operator: Pubkey,
}

#[event]
pub struct SecurityDefaultsLocked {
    pub admin: Pubkey,
    pub route_authorization_required: bool,
    pub authorized_trading_required: bool,
}

#[event]
pub struct GenerationConfigInitialized {
    pub generation_id: [u8; 32],
    pub program_id: Pubkey,
    pub config_pda: Pubkey,
    pub start_slot: u64,
    pub cluster_kind: u8,
    pub allowed_graduation_tier_mask: u8,
    pub economics_version: u16,
    pub curve_kind: u8,
    pub dex_adapter: u8,
    pub manifest_hash: [u8; 32],
    pub active_creation: bool,
    pub support_enabled: bool,
}

#[event]
pub struct GenerationSupportUpdated {
    pub generation_id: [u8; 32],
    pub support_enabled: bool,
    pub active_creation: bool,
}

#[event]
pub struct CreatorProfileSynced {
    pub wallet: Pubkey,
    pub tier: u8,
    pub live_bonding_count: u16,
    pub restricted: bool,
    pub manual_review_required: bool,
}

#[event]
pub struct RiskProfileSynced {
    pub wallet: Pubkey,
    pub risk_level: u8,
    pub restricted: bool,
    pub cluster_id: [u8; 32],
    pub manual_review_required: bool,
}

#[event]
pub struct ClusterProfileSynced {
    pub cluster_id: [u8; 32],
    pub size: u32,
    pub risk_level: u8,
    pub restricted: bool,
}

fn validate_authorities(authorities: &GlobalAuthorities) -> Result<()> {
    require_keys_neq!(
        authorities.admin,
        Pubkey::default(),
        LaunchpadError::InvalidAuthority
    );
    require_keys_neq!(
        authorities.pauser,
        Pubkey::default(),
        LaunchpadError::InvalidAuthority
    );
    require_keys_neq!(
        authorities.tier_admin,
        Pubkey::default(),
        LaunchpadError::InvalidAuthority
    );
    require_keys_neq!(
        authorities.risk_admin,
        Pubkey::default(),
        LaunchpadError::InvalidAuthority
    );
    require_keys_neq!(
        authorities.route_signer,
        Pubkey::default(),
        LaunchpadError::InvalidAuthority
    );
    require_keys_neq!(
        authorities.reward_operator,
        Pubkey::default(),
        LaunchpadError::InvalidAuthority
    );
    require_keys_neq!(
        authorities.treasury_operator,
        Pubkey::default(),
        LaunchpadError::InvalidAuthority
    );
    require_keys_neq!(
        authorities.generation_operator,
        Pubkey::default(),
        LaunchpadError::InvalidAuthority
    );
    Ok(())
}

fn require_admin(global: &GlobalConfig, authority: Pubkey) -> Result<()> {
    require_keys_eq!(global.admin, authority, LaunchpadError::Unauthorized);
    Ok(())
}

fn require_pause_authority(global: &GlobalConfig, authority: Pubkey) -> Result<()> {
    if authority == global.admin || authority == global.pauser {
        return Ok(());
    }
    err!(LaunchpadError::Unauthorized)
}

fn require_generation_authority(global: &GlobalConfig, authority: Pubkey) -> Result<()> {
    if authority == global.admin || authority == global.generation_operator {
        return Ok(());
    }
    err!(LaunchpadError::Unauthorized)
}

fn require_tier_authority(global: &GlobalConfig, authority: Pubkey) -> Result<()> {
    if authority == global.admin || authority == global.tier_admin {
        return Ok(());
    }
    err!(LaunchpadError::Unauthorized)
}

fn require_risk_authority(global: &GlobalConfig, authority: Pubkey) -> Result<()> {
    if authority == global.admin || authority == global.risk_admin {
        return Ok(());
    }
    err!(LaunchpadError::Unauthorized)
}

fn validate_generation_settings(
    global: &GlobalConfig,
    settings: &GenerationSettings,
) -> Result<()> {
    require!(
        settings.generation_id != EMPTY_GENERATION_ID,
        LaunchpadError::InvalidGeneration
    );
    require!(
        settings.manifest_hash != [0; 32],
        LaunchpadError::InvalidGenerationManifest
    );
    validate_generation_cluster_and_tiers(
        settings.cluster_kind,
        settings.allowed_graduation_tier_mask,
    )?;
    validate_generation_economics(settings)?;
    require!(
        is_supported_dex_adapter(settings.dex_adapter),
        LaunchpadError::InvalidDexAdapter
    );
    validate_generation_profiles(settings)?;
    require!(
        settings.support_enabled || !settings.active_creation,
        LaunchpadError::ActiveGenerationMustBeSupported
    );
    require!(
        settings.route_authorization_required,
        LaunchpadError::SecurityDefaultsCannotBeWeakened
    );
    require!(
        settings.authorized_trading_required,
        LaunchpadError::SecurityDefaultsCannotBeWeakened
    );
    if global.security_defaults_locked {
        require!(
            global.route_authorization_required,
            LaunchpadError::SecurityDefaultsCannotBeWeakened
        );
        require!(
            global.authorized_trading_required,
            LaunchpadError::SecurityDefaultsCannotBeWeakened
        );
    }
    Ok(())
}

fn validate_generation_cluster_and_tiers(cluster_kind: u8, tier_mask: u8) -> Result<()> {
    require!(
        cluster_kind == CLUSTER_KIND_DEVNET || cluster_kind == CLUSTER_KIND_MAINNET_BETA,
        LaunchpadError::InvalidGenerationCluster
    );
    require!(tier_mask != 0, LaunchpadError::InvalidGraduationTierMask);
    require!(
        tier_mask & !GRADUATION_TIER_ALL_MASK == 0,
        LaunchpadError::InvalidGraduationTierMask
    );

    if cluster_kind == CLUSTER_KIND_DEVNET {
        require!(
            tier_mask & GRADUATION_TIER_6_USD_MASK != 0,
            LaunchpadError::InvalidGraduationTierMask
        );
    } else {
        require!(
            tier_mask & GRADUATION_TIER_6_USD_MASK == 0,
            LaunchpadError::InvalidGraduationTierMask
        );
        require!(
            tier_mask & GRADUATION_TIER_PRODUCTION_MASK != 0,
            LaunchpadError::InvalidGraduationTierMask
        );
    }
    Ok(())
}

fn validate_generation_economics(settings: &GenerationSettings) -> Result<()> {
    require!(
        settings.economics_version == ECONOMICS_VERSION_V1
            || settings.economics_version == ECONOMICS_VERSION_V2
            || settings.economics_version == ECONOMICS_VERSION_V3,
        LaunchpadError::InvalidGenerationEconomics
    );
    require!(
        settings.curve_kind == CURVE_KIND_LINEAR_V1,
        LaunchpadError::InvalidGenerationEconomics
    );
    require!(
        settings.token_total_supply > 0,
        LaunchpadError::InvalidGenerationEconomics
    );
    require!(
        settings.token_decimals <= MAX_TOKEN_DECIMALS,
        LaunchpadError::InvalidGenerationEconomics
    );
    require!(
        settings.curve_supply_bps > 0 && settings.curve_supply_bps < BPS_DENOMINATOR,
        LaunchpadError::InvalidGenerationEconomics
    );
    require!(
        settings.liquidity_token_bps > 0,
        LaunchpadError::InvalidGenerationEconomics
    );
    let token_allocation_bps = u32::from(settings.curve_supply_bps)
        .checked_add(u32::from(settings.liquidity_token_bps))
        .ok_or(LaunchpadError::MathOverflow)?;
    require!(
        token_allocation_bps <= u32::from(BPS_DENOMINATOR),
        LaunchpadError::InvalidGenerationEconomics
    );
    require!(
        settings.base_price_lamports > 0,
        LaunchpadError::InvalidGenerationEconomics
    );
    // Preserve the already-deployed V2 flat generation, but all new BNB-parity
    // V3 generations require a non-zero fixed-point slope (same invariant as BNB).
    if settings.economics_version == ECONOMICS_VERSION_V1
        || settings.economics_version >= ECONOMICS_VERSION_V3
    {
        require!(
            settings.price_slope_lamports > 0,
            LaunchpadError::InvalidGenerationEconomics
        );
    }
    require!(
        settings.buy_fee_bps == LOCKED_BUY_FEE_BPS,
        LaunchpadError::InvalidGenerationEconomics
    );
    require!(
        settings.sell_fee_bps == LOCKED_SELL_FEE_BPS,
        LaunchpadError::InvalidGenerationEconomics
    );
    require!(
        settings.finalize_fee_bps == LOCKED_FINALIZE_FEE_BPS,
        LaunchpadError::InvalidGenerationEconomics
    );
    require!(
        settings.creator_post_finalize_bps == LOCKED_CREATOR_POST_FINALIZE_BPS,
        LaunchpadError::InvalidGenerationEconomics
    );
    require!(
        settings.liquidity_post_finalize_bps == LOCKED_LIQUIDITY_POST_FINALIZE_BPS,
        LaunchpadError::InvalidGenerationEconomics
    );
    let post_finalize_bps = u32::from(settings.creator_post_finalize_bps)
        .checked_add(u32::from(settings.liquidity_post_finalize_bps))
        .ok_or(LaunchpadError::MathOverflow)?;
    require!(
        post_finalize_bps == u32::from(BPS_DENOMINATOR),
        LaunchpadError::InvalidGenerationEconomics
    );
    Ok(())
}

fn validate_generation_profiles(settings: &GenerationSettings) -> Result<()> {
    require!(
        settings.trade_route_profile != [0; 32],
        LaunchpadError::InvalidGenerationProfile
    );
    require!(
        settings.finalize_route_profile != [0; 32],
        LaunchpadError::InvalidGenerationProfile
    );
    require!(
        settings.treasury_profile != [0; 32],
        LaunchpadError::InvalidGenerationProfile
    );
    require!(
        settings.dex_profile != [0; 32],
        LaunchpadError::InvalidGenerationProfile
    );
    require!(
        settings.oracle_profile != [0; 32],
        LaunchpadError::InvalidGenerationProfile
    );
    Ok(())
}

fn validate_creator_profile_update(update: &CreatorProfileUpdate) -> Result<()> {
    require_keys_neq!(
        update.wallet,
        Pubkey::default(),
        LaunchpadError::InvalidCreatorProfile
    );
    require!(
        update.trust_score <= TRUST_SCORE_MAX,
        LaunchpadError::InvalidCreatorProfile
    );
    require!(
        update.creator_buy_cap_bps <= CREATOR_BUY_CAP_BPS_MAX,
        LaunchpadError::CreatorBuyCapTooHigh
    );

    let limits = tier_limits(update.tier)?;
    require!(
        update.live_bonding_count <= limits.max_live_bonding_count,
        LaunchpadError::CreatorLiveBondingLimitExceeded
    );
    Ok(())
}

fn validate_risk_profile_update(update: &RiskProfileUpdate) -> Result<()> {
    require_keys_neq!(
        update.wallet,
        Pubkey::default(),
        LaunchpadError::InvalidRiskProfile
    );
    validate_risk_level(update.risk_level)?;
    Ok(())
}

fn validate_cluster_profile_update(update: &ClusterProfileUpdate) -> Result<()> {
    require!(
        update.cluster_id != EMPTY_CLUSTER_ID,
        LaunchpadError::InvalidCluster
    );
    require!(update.size > 0, LaunchpadError::InvalidCluster);
    validate_risk_level(update.risk_level)?;
    Ok(())
}

fn validate_risk_level(risk_level: u8) -> Result<()> {
    require!(
        risk_level >= RISK_LEVEL_MIN && risk_level <= RISK_LEVEL_MAX,
        LaunchpadError::InvalidRiskLevel
    );
    Ok(())
}

fn tier_limits(tier: u8) -> Result<CreatorTierLimits> {
    match tier {
        CREATOR_TIER_1 => Ok(CreatorTierLimits {
            max_live_bonding_count: TIER_1_MAX_LIVE_BONDING,
            cooldown_seconds: TIER_COOLDOWN_SECONDS,
            creator_buy_lock_seconds: TIER_1_CREATOR_LOCK_SECONDS,
        }),
        CREATOR_TIER_2 => Ok(CreatorTierLimits {
            max_live_bonding_count: TIER_2_MAX_LIVE_BONDING,
            cooldown_seconds: TIER_COOLDOWN_SECONDS,
            creator_buy_lock_seconds: TIER_2_CREATOR_LOCK_SECONDS,
        }),
        CREATOR_TIER_3 => Ok(CreatorTierLimits {
            max_live_bonding_count: TIER_3_MAX_LIVE_BONDING,
            cooldown_seconds: TIER_COOLDOWN_SECONDS,
            creator_buy_lock_seconds: TIER_3_CREATOR_LOCK_SECONDS,
        }),
        _ => err!(LaunchpadError::InvalidCreatorTier),
    }
}

fn resolve_generation_support_update(
    current_active: [u8; 32],
    generation_id: [u8; 32],
    support_enabled: bool,
    active_creation: bool,
) -> Result<[u8; 32]> {
    require!(
        support_enabled || !active_creation,
        LaunchpadError::ActiveGenerationMustBeSupported
    );

    if active_creation {
        require!(
            is_empty_generation_id(current_active) || current_active == generation_id,
            LaunchpadError::ActiveCreationGenerationExists
        );
        return Ok(generation_id);
    }

    if current_active == generation_id {
        return Ok(EMPTY_GENERATION_ID);
    }

    Ok(current_active)
}

fn is_supported_dex_adapter(dex_adapter: u8) -> bool {
    dex_adapter == DEX_ADAPTER_METEORA_DAMM_V2
}

fn is_empty_generation_id(generation_id: [u8; 32]) -> bool {
    generation_id == EMPTY_GENERATION_ID
}

pub(crate) fn graduation_tier_bit(target_usd_micros: u64) -> Option<u8> {
    match target_usd_micros {
        GRADUATION_TARGET_6_USD_MICROS => Some(GRADUATION_TIER_6_USD_MASK),
        GRADUATION_TARGET_15K_USD_MICROS => Some(GRADUATION_TIER_15K_USD_MASK),
        GRADUATION_TARGET_30K_USD_MICROS => Some(GRADUATION_TIER_30K_USD_MASK),
        GRADUATION_TARGET_50K_USD_MICROS => Some(GRADUATION_TIER_50K_USD_MASK),
        _ => None,
    }
}

pub(crate) fn generation_allows_graduation_target(
    generation: &GenerationConfig,
    target_usd_micros: u64,
) -> bool {
    graduation_tier_bit(target_usd_micros)
        .map(|bit| generation.allowed_graduation_tier_mask & bit != 0)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_global_config() -> GlobalConfig {
        GlobalConfig {
            admin: Pubkey::new_unique(),
            pauser: Pubkey::new_unique(),
            tier_admin: Pubkey::new_unique(),
            risk_admin: Pubkey::new_unique(),
            route_signer: Pubkey::new_unique(),
            reward_operator: Pubkey::new_unique(),
            treasury_operator: Pubkey::new_unique(),
            generation_operator: Pubkey::new_unique(),
            active_generation_id: EMPTY_GENERATION_ID,
            generation_count: 0,
            paused: false,
            create_paused: true,
            buy_paused: true,
            sell_paused: true,
            graduation_paused: true,
            claims_paused: true,
            route_authorization_required: true,
            authorized_trading_required: true,
            security_defaults_locked: false,
            bump: 255,
        }
    }

    fn test_generation_settings() -> GenerationSettings {
        GenerationSettings {
            generation_id: [7; 32],
            cluster_kind: CLUSTER_KIND_DEVNET,
            allowed_graduation_tier_mask: GRADUATION_TIER_ALL_MASK,
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
            active_creation: false,
            support_enabled: true,
            manifest_hash: [9; 32],
            route_authorization_required: true,
            authorized_trading_required: true,
        }
    }

    fn test_generation_config(settings: &GenerationSettings) -> GenerationConfig {
        GenerationConfig {
            generation_id: settings.generation_id,
            program_id: crate::id(),
            config_pda: Pubkey::new_unique(),
            start_slot: 42,
            cluster_kind: settings.cluster_kind,
            allowed_graduation_tier_mask: settings.allowed_graduation_tier_mask,
            economics_version: settings.economics_version,
            curve_kind: settings.curve_kind,
            token_total_supply: settings.token_total_supply,
            token_decimals: settings.token_decimals,
            curve_supply_bps: settings.curve_supply_bps,
            liquidity_token_bps: settings.liquidity_token_bps,
            base_price_lamports: settings.base_price_lamports,
            price_slope_lamports: settings.price_slope_lamports,
            buy_fee_bps: settings.buy_fee_bps,
            sell_fee_bps: settings.sell_fee_bps,
            finalize_fee_bps: settings.finalize_fee_bps,
            creator_post_finalize_bps: settings.creator_post_finalize_bps,
            liquidity_post_finalize_bps: settings.liquidity_post_finalize_bps,
            dex_adapter: settings.dex_adapter,
            trade_route_profile: settings.trade_route_profile,
            finalize_route_profile: settings.finalize_route_profile,
            treasury_profile: settings.treasury_profile,
            dex_profile: settings.dex_profile,
            oracle_profile: settings.oracle_profile,
            active_creation: settings.active_creation,
            support_enabled: settings.support_enabled,
            manifest_hash: settings.manifest_hash,
            route_authorization_required: true,
            authorized_trading_required: true,
            bump: 254,
        }
    }

    fn test_creator_update(tier: u8, live_bonding_count: u16) -> CreatorProfileUpdate {
        CreatorProfileUpdate {
            wallet: Pubkey::new_unique(),
            tier,
            trust_score: 7_500,
            live_bonding_count,
            last_launch_timestamp: 1_700_000_000,
            total_launches: 10,
            successful_graduations: 2,
            restricted: false,
            manual_review_required: false,
            creator_buy_cap_bps: 1_000,
        }
    }

    fn test_risk_update(risk_level: u8) -> RiskProfileUpdate {
        RiskProfileUpdate {
            wallet: Pubkey::new_unique(),
            risk_level,
            restricted: false,
            cluster_id: [4; 32],
            manual_review_required: false,
        }
    }

    fn test_cluster_update(risk_level: u8, size: u32) -> ClusterProfileUpdate {
        ClusterProfileUpdate {
            cluster_id: [5; 32],
            size,
            risk_level,
            restricted: false,
        }
    }

    #[test]
    fn generation_settings_accept_meteora_only_dex_adapter() {
        let global = test_global_config();
        let mut settings = test_generation_settings();

        settings.dex_adapter = DEX_ADAPTER_METEORA_DAMM_V2;
        assert!(validate_generation_settings(&global, &settings).is_ok());

        // Product lock: no Raydium / multi-DEX path.
        settings.dex_adapter = DEX_ADAPTER_RAYDIUM_CPMM;
        assert!(validate_generation_settings(&global, &settings).is_err());
    }

    #[test]
    fn generation_settings_reject_weakened_route_defaults() {
        let global = test_global_config();
        let mut settings = test_generation_settings();

        settings.route_authorization_required = false;
        assert!(validate_generation_settings(&global, &settings).is_err());

        settings.route_authorization_required = true;
        settings.authorized_trading_required = false;
        assert!(validate_generation_settings(&global, &settings).is_err());
    }

    #[test]
    fn devnet_generation_requires_six_dollar_tier() {
        let global = test_global_config();
        let mut settings = test_generation_settings();
        settings.allowed_graduation_tier_mask = GRADUATION_TIER_PRODUCTION_MASK;
        assert!(validate_generation_settings(&global, &settings).is_err());
    }

    #[test]
    fn mainnet_generation_rejects_six_dollar_tier() {
        let global = test_global_config();
        let mut settings = test_generation_settings();
        settings.cluster_kind = CLUSTER_KIND_MAINNET_BETA;
        settings.allowed_graduation_tier_mask = GRADUATION_TIER_ALL_MASK;
        assert!(validate_generation_settings(&global, &settings).is_err());
    }

    #[test]
    fn mainnet_generation_accepts_production_tiers() {
        let global = test_global_config();
        let mut settings = test_generation_settings();
        settings.cluster_kind = CLUSTER_KIND_MAINNET_BETA;
        settings.allowed_graduation_tier_mask = GRADUATION_TIER_PRODUCTION_MASK;
        assert!(validate_generation_settings(&global, &settings).is_ok());
    }

    #[test]
    fn generation_settings_reject_unknown_tier_bits() {
        let global = test_global_config();
        let mut settings = test_generation_settings();
        settings.allowed_graduation_tier_mask |= 1 << 7;
        assert!(validate_generation_settings(&global, &settings).is_err());
    }

    #[test]
    fn generation_economics_v3_requires_fixed_point_slope() {
        let global = test_global_config();
        let mut settings = test_generation_settings();
        settings.economics_version = ECONOMICS_VERSION_V3;
        settings.price_slope_lamports = 850;
        assert!(validate_generation_settings(&global, &settings).is_ok());

        settings.price_slope_lamports = 0;
        assert!(validate_generation_settings(&global, &settings).is_err());
    }

    #[test]
    fn generation_economics_reject_fee_drift() {
        let global = test_global_config();
        let mut settings = test_generation_settings();
        settings.buy_fee_bps = LOCKED_BUY_FEE_BPS + 1;
        assert!(validate_generation_settings(&global, &settings).is_err());
    }

    #[test]
    fn generation_economics_reject_token_allocation_overflow() {
        let global = test_global_config();
        let mut settings = test_generation_settings();
        settings.curve_supply_bps = 9_500;
        settings.liquidity_token_bps = 1_000;
        assert!(validate_generation_settings(&global, &settings).is_err());
    }

    #[test]
    fn generation_settings_reject_zero_profile() {
        let global = test_global_config();
        let mut settings = test_generation_settings();
        settings.oracle_profile = [0; 32];
        assert!(validate_generation_settings(&global, &settings).is_err());
    }

    #[test]
    fn generation_target_resolution_uses_allowlist_mask() {
        let settings = test_generation_settings();
        let mut generation = test_generation_config(&settings);
        generation.allowed_graduation_tier_mask = GRADUATION_TIER_6_USD_MASK;
        assert!(generation_allows_graduation_target(
            &generation,
            GRADUATION_TARGET_6_USD_MICROS
        ));
        assert!(!generation_allows_graduation_target(
            &generation,
            GRADUATION_TARGET_30K_USD_MICROS
        ));
    }

    #[test]
    fn support_update_rejects_second_active_generation() {
        let current_active = [1; 32];
        let second_generation = [2; 32];
        assert!(
            resolve_generation_support_update(current_active, second_generation, true, true)
                .is_err()
        );
    }

    #[test]
    fn support_update_deactivation_clears_current_generation() {
        let generation_id = [1; 32];
        let next_active =
            resolve_generation_support_update(generation_id, generation_id, true, false).unwrap();
        assert_eq!(next_active, EMPTY_GENERATION_ID);
    }

    #[test]
    fn creator_tiers_apply_plan_limits() {
        let tier_1 = tier_limits(CREATOR_TIER_1).unwrap();
        assert_eq!(tier_1.max_live_bonding_count, 3);
        assert_eq!(tier_1.cooldown_seconds, 86_400);
        assert_eq!(tier_1.creator_buy_lock_seconds, 86_400);

        let tier_2 = tier_limits(CREATOR_TIER_2).unwrap();
        assert_eq!(tier_2.max_live_bonding_count, 5);
        assert_eq!(tier_2.creator_buy_lock_seconds, 21_600);

        let tier_3 = tier_limits(CREATOR_TIER_3).unwrap();
        assert_eq!(tier_3.max_live_bonding_count, 10);
        assert_eq!(tier_3.creator_buy_lock_seconds, 3_600);
    }

    #[test]
    fn creator_profile_rejects_invalid_tier() {
        let update = test_creator_update(4, 0);
        assert!(validate_creator_profile_update(&update).is_err());
    }

    #[test]
    fn creator_profile_rejects_oversized_live_count() {
        let update = test_creator_update(CREATOR_TIER_1, TIER_1_MAX_LIVE_BONDING + 1);
        assert!(validate_creator_profile_update(&update).is_err());
    }

    #[test]
    fn risk_profile_rejects_invalid_risk_level() {
        let update = test_risk_update(RISK_LEVEL_MAX + 1);
        assert!(validate_risk_profile_update(&update).is_err());
    }

    #[test]
    fn cluster_profile_rejects_empty_cluster() {
        let mut update = test_cluster_update(RISK_LEVEL_MAX, 12);
        update.cluster_id = EMPTY_CLUSTER_ID;
        assert!(validate_cluster_profile_update(&update).is_err());
    }

    #[test]
    fn cluster_profile_rejects_zero_size() {
        let update = test_cluster_update(RISK_LEVEL_MAX, 0);
        assert!(validate_cluster_profile_update(&update).is_err());
    }
}

#[error_code]
pub enum LaunchpadError {
    #[msg("The signer is not authorized for this Solana launchpad action.")]
    Unauthorized,
    #[msg("Authority addresses must be set before initializing the launchpad.")]
    InvalidAuthority,
    #[msg("Security defaults have already been locked and cannot be weakened.")]
    SecurityDefaultsAlreadyLocked,
    #[msg("Security defaults cannot be weakened for Solana launchpad generations.")]
    SecurityDefaultsCannotBeWeakened,
    #[msg("Generation ID, seed, or configuration is invalid.")]
    InvalidGeneration,
    #[msg("Generation program ID must match this deployed program.")]
    InvalidGenerationProgram,
    #[msg("Generation manifest hash is missing or invalid.")]
    InvalidGenerationManifest,
    #[msg("Generation cluster kind must be devnet or mainnet-beta.")]
    InvalidGenerationCluster,
    #[msg("Generation graduation-tier allowlist is invalid for its cluster.")]
    InvalidGraduationTierMask,
    #[msg("Generation curve, supply, or fee economics are invalid.")]
    InvalidGenerationEconomics,
    #[msg("Generation route, treasury, DEX, or oracle profile is invalid.")]
    InvalidGenerationProfile,
    #[msg("Exactly one Solana generation can be active for creation.")]
    ActiveCreationGenerationExists,
    #[msg("An active creation generation must remain support-enabled.")]
    ActiveGenerationMustBeSupported,
    #[msg("Unsupported Solana DEX adapter mode.")]
    InvalidDexAdapter,
    #[msg("Creator tier must be 1, 2, or 3.")]
    InvalidCreatorTier,
    #[msg("Creator profile data is invalid.")]
    InvalidCreatorProfile,
    #[msg("Creator live bonding count exceeds the configured tier limit.")]
    CreatorLiveBondingLimitExceeded,
    #[msg("Creator buy cap exceeds the maximum basis-point value.")]
    CreatorBuyCapTooHigh,
    #[msg("Wallet risk profile data is invalid.")]
    InvalidRiskProfile,
    #[msg("Risk level is outside the supported range.")]
    InvalidRiskLevel,
    #[msg("Cluster profile data is invalid.")]
    InvalidCluster,
    #[msg("The Solana launchpad is paused.")]
    LaunchpadPaused,
    #[msg("Solana campaign creation is paused.")]
    CreatePaused,
    #[msg("Create authorization is missing, expired, replayed, or malformed.")]
    InvalidCreateAuthorization,
    #[msg("Create authorization deadline has expired.")]
    CreateAuthorizationExpired,
    #[msg("Campaign data is invalid.")]
    InvalidCampaign,
    #[msg("Campaign metadata hash is invalid.")]
    InvalidMetadata,
    #[msg("The selected graduation target is not allowed by this generation.")]
    GraduationTargetNotAllowed,
    #[msg("Route profile hash is invalid.")]
    InvalidRouteProfile,
    #[msg("Create authorization nonce is invalid.")]
    InvalidNonce,
    #[msg("The selected generation is not active for campaign creation.")]
    CampaignGenerationInactive,
    #[msg("Creator has reached the live bonding launch limit.")]
    CreatorLaunchLimitExceeded,
    #[msg("Creator launch cooldown is still active.")]
    CreatorCooldownActive,
    #[msg("Creator is restricted from launching campaigns.")]
    CreatorRestricted,
    #[msg("Creator requires manual review before launching campaigns.")]
    CreatorManualReviewRequired,
    #[msg("Wallet is restricted from launching campaigns.")]
    WalletRestricted,
    #[msg("Wallet cluster is restricted from launching campaigns.")]
    ClusterRestricted,
    #[msg("Arithmetic overflow while updating Solana launchpad state.")]
    MathOverflow,
    #[msg("Solana bonding buys are paused.")]
    BuysPaused,
    #[msg("Solana bonding sells are paused.")]
    SellsPaused,
    #[msg("Campaign trading has not opened yet (launch_at).")]
    TradingNotOpen,
    #[msg("Campaign has already graduated.")]
    AlreadyGraduated,
    #[msg("Trade amount is invalid.")]
    InvalidTradeAmount,
    #[msg("Curve supply is exhausted for further buys.")]
    CurveSupplyExhausted,
    #[msg("Not enough sold tokens to support this sell.")]
    InsufficientSoldTokens,
    #[msg("Slippage limit exceeded for this trade.")]
    SlippageExceeded,
    #[msg("Insufficient net raised / vault balance for this sell.")]
    InsufficientVaultBalance,
    #[msg("Creator buy lock is still active.")]
    CreatorBuyLocked,
    #[msg("Creator buy cap would be exceeded.")]
    CreatorBuyCap,
    #[msg("Trade authorization is missing, expired, replayed, or malformed.")]
    InvalidTradeAuthorization,
    #[msg("Trade authorization deadline has expired.")]
    TradeAuthorizationExpired,
    #[msg("Trade authorization deadline has not expired yet.")]
    TradeAuthorizationNotExpired,
    #[msg("Solana campaign graduation is paused.")]
    GraduationPaused,
    #[msg("Signed graduation authorization is missing, malformed, or does not match this transaction.")]
    InvalidGraduationAuthorization,
    #[msg("Signed graduation authorization has expired.")]
    GraduationAuthorizationExpired,
    #[msg("Signed native graduation target is invalid.")]
    InvalidGraduationTarget,
    #[msg("Campaign has not reached the signed native graduation target or exhausted the bonding curve.")]
    GraduationThresholdNotMet,
    #[msg(
        "Graduation must create/lock Meteora DAMM v2 and confirm in the same Solana transaction."
    )]
    GraduationAtomicityRequired,
    #[msg("The deterministic Meteora DAMM v2 customizable pool is invalid.")]
    InvalidMeteoraPool,
    #[msg("The deterministic Meteora DAMM v2 position is invalid.")]
    InvalidMeteoraPosition,
    #[msg("The Meteora DAMM v2 pool already exists before graduation begins.")]
    MeteoraPoolAlreadyExists,
    #[msg("The Meteora DAMM v2 position already exists before graduation begins.")]
    MeteoraPositionAlreadyExists,
    #[msg("Meteora graduation liquidity was not permanently locked.")]
    MeteoraLiquidityNotLocked,
    #[msg("Graduation staging token account must be empty before liquidity is released.")]
    GraduationStagingNotEmpty,
    #[msg("Graduation liquidity amount resolved to zero.")]
    GraduationLiquidityZero,
    #[msg("Graduation assets did not reconcile with the deterministic Meteora pool.")]
    GraduationAssetMismatch,
    #[msg("Meteora initial pool price drifted beyond the allowed bonding-curve tolerance.")]
    GraduationPriceDrift,
    #[msg("Bonding curve is closed after the graduation threshold. Awaiting Meteora.")]
    CurveClosed,
    #[msg("League or airdrop vault PDA is missing or does not match the rewards treasury.")]
    InvalidRewardsVault,
    #[msg("This campaign is paused.")]
    CampaignPaused,
    #[msg("Campaign fee escrow is missing or not initialized.")]
    FeeEscrowNotInitialized,
    #[msg("Campaign fee escrow PDA or campaign binding is invalid.")]
    InvalidFeeEscrow,
    #[msg("Campaign fee escrow still has unflushed pending fees.")]
    FeeEscrowPendingNonzero,
    #[msg("Campaign fee escrow cannot cover its pending liabilities.")]
    FeeEscrowBalanceMismatch,
}