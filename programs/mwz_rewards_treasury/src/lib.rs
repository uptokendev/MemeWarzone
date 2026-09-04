use anchor_lang::prelude::*;
use anchor_lang::solana_program::keccak;
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::system_instruction;

declare_id!("2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX");

pub const REWARDS_CONFIG_SEED: &[u8] = b"rewards_config";
pub const LEAGUE_VAULT_SEED: &[u8] = b"league_vault";
pub const AIRDROP_VAULT_SEED: &[u8] = b"airdrop_vault";
pub const LEAGUE_EPOCH_SEED: &[u8] = b"league_epoch";
pub const LEAGUE_CLAIM_SEED: &[u8] = b"league_claim";
pub const AIRDROP_BATCH_SEED: &[u8] = b"airdrop_batch";
pub const AIRDROP_CLAIM_SEED: &[u8] = b"airdrop_claim";
pub const MONTHLY_LEAGUE_VAULT_SEED: &[u8] = b"monthly_league_vault";
pub const RECRUITER_VAULT_SEED: &[u8] = b"recruiter_vault";
pub const SQUAD_VAULT_SEED: &[u8] = b"squad_vault";
pub const PROTOCOL_VAULT_SEED: &[u8] = b"protocol_vault";
pub const ROUTE_STATE_SEED: &[u8] = b"route_state";
pub const RECRUITER_BATCH_SEED: &[u8] = b"recruiter_batch";
pub const RECRUITER_CLAIM_SEED: &[u8] = b"recruiter_claim";
pub const SQUAD_BATCH_SEED: &[u8] = b"squad_batch";
pub const SQUAD_CLAIM_SEED: &[u8] = b"squad_claim";

pub mod route;
pub use route::*;
pub mod arena;
pub use arena::*;
pub mod arena_money_v2;
pub use arena_money_v2::*;

pub const PERIOD_WEEKLY: u8 = 0;
pub const PERIOD_MONTHLY: u8 = 1;

pub const LEAGUE_LEAF_PREFIX: &[u8] = b"MWZ_LEAGUE_LEAF";
pub const AIRDROP_LEAF_PREFIX: &[u8] = b"MWZ_AIRDROP_LEAF";
pub const RECRUITER_LEAF_PREFIX: &[u8] = b"MWZ_RECRUITER_LEAF";
pub const SQUAD_LEAF_PREFIX: &[u8] = b"MWZ_SQUAD_LEAF";

#[program]
pub mod mwz_rewards_treasury {
    use super::*;

    pub fn initialize_arena_money_v2(
        ctx: Context<InitializeArenaMoneyV2>,
        resolver: Pubkey,
        protocol_receiver: Pubkey,
        marketing_receiver: Pubkey,
    ) -> Result<()> {
        initialize_arena_money_v2_handler(ctx, resolver, protocol_receiver, marketing_receiver)
    }

    pub fn set_arena_money_v2_pause(ctx: Context<SetArenaMoneyV2Config>, paused: bool) -> Result<()> {
        set_arena_money_v2_pause_handler(ctx, paused)
    }

    pub fn set_arena_money_v2_receivers(
        ctx: Context<SetArenaMoneyV2Config>,
        resolver: Pubkey,
        protocol_receiver: Pubkey,
        marketing_receiver: Pubkey,
    ) -> Result<()> {
        set_arena_money_v2_receivers_handler(ctx, resolver, protocol_receiver, marketing_receiver)
    }

    pub fn open_competition_pool_v2(
        ctx: Context<OpenCompetitionPoolV2>,
        competition_id: [u8; 32],
        kind: u8,
        asset_a: Pubkey,
        asset_b: Pubkey,
        owner_a: Pubkey,
        owner_b: Pubkey,
        required_entry_lamports: u64,
        opens_at: i64,
        closes_at: i64,
    ) -> Result<()> {
        open_competition_pool_v2_handler(
            ctx,
            competition_id,
            kind,
            asset_a,
            asset_b,
            owner_a,
            owner_b,
            required_entry_lamports,
            opens_at,
            closes_at,
        )
    }

    pub fn deposit_competition_entry_v2(
        ctx: Context<DepositCompetitionEntryV2>,
        competition_id: [u8; 32],
        entry_asset: Pubkey,
    ) -> Result<()> {
        deposit_competition_entry_v2_handler(ctx, competition_id, entry_asset)
    }

    pub fn deposit_competition_boost_v2(
        ctx: Context<DepositCompetitionBoostV2>,
        competition_id: [u8; 32],
        funding_id: [u8; 32],
        gross_lamports: u64,
    ) -> Result<()> {
        deposit_competition_boost_v2_handler(ctx, competition_id, funding_id, gross_lamports)
    }

    pub fn resolve_competition_pool_v2(
        ctx: Context<ResolveCompetitionPoolV2>,
        competition_id: [u8; 32],
        winner_asset: Pubkey,
        winner_wallet: Pubkey,
    ) -> Result<()> {
        resolve_competition_pool_v2_handler(ctx, competition_id, winner_asset, winner_wallet)
    }

    pub fn claim_competition_winner_v2(
        ctx: Context<ClaimCompetitionWinnerV2>,
        competition_id: [u8; 32],
    ) -> Result<()> {
        claim_competition_winner_v2_handler(ctx, competition_id)
    }

    pub fn claim_competition_protocol_v2(
        ctx: Context<ClaimCompetitionProtocolV2>,
        competition_id: [u8; 32],
    ) -> Result<()> {
        claim_competition_protocol_v2_handler(ctx, competition_id)
    }

    pub fn initialize_postgrad_league_treasury_v2(
        ctx: Context<InitializePostGradLeagueTreasuryV2>,
        monthly_receiver: Pubkey,
        quarterly_receiver: Pubkey,
    ) -> Result<()> {
        initialize_postgrad_league_treasury_v2_handler(ctx, monthly_receiver, quarterly_receiver)
    }

    pub fn route_competition_league_v2(
        ctx: Context<RouteCompetitionLeagueV2>,
        competition_id: [u8; 32],
    ) -> Result<()> {
        route_competition_league_v2_handler(ctx, competition_id)
    }

    pub fn claim_monthly_league_v2(ctx: Context<ClaimMonthlyLeagueV2>) -> Result<()> {
        claim_monthly_league_v2_handler(ctx)
    }

    pub fn claim_quarterly_league_v2(ctx: Context<ClaimQuarterlyLeagueV2>) -> Result<()> {
        claim_quarterly_league_v2_handler(ctx)
    }

    pub fn initialize_sponsorship_event_v1(
        ctx: Context<InitializeSponsorshipEventV1>,
        event_id: [u8; 32],
        event_receiver: Pubkey,
        minimum_lamports: u64,
    ) -> Result<()> {
        initialize_sponsorship_event_v1_handler(ctx, event_id, event_receiver, minimum_lamports)
    }

    pub fn pay_sponsorship_v1(
        ctx: Context<PaySponsorshipV1>,
        event_id: [u8; 32],
        payment_id: [u8; 32],
        gross_lamports: u64,
    ) -> Result<()> {
        pay_sponsorship_v1_handler(ctx, event_id, payment_id, gross_lamports)
    }

    pub fn claim_event_prize_v1(
        ctx: Context<ClaimEventPrizeV1>,
        event_id: [u8; 32],
    ) -> Result<()> {
        claim_event_prize_v1_handler(ctx, event_id)
    }

    pub fn claim_sponsorship_marketing_v1(
        ctx: Context<ClaimSponsorshipMarketingV1>,
        event_id: [u8; 32],
    ) -> Result<()> {
        claim_sponsorship_marketing_v1_handler(ctx, event_id)
    }

    pub fn claim_sponsorship_protocol_v1(
        ctx: Context<ClaimSponsorshipProtocolV1>,
        event_id: [u8; 32],
    ) -> Result<()> {
        claim_sponsorship_protocol_v1_handler(ctx, event_id)
    }

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.bump = ctx.bumps.config;
        config.league_vault_bump = ctx.bumps.league_vault;
        config.airdrop_vault_bump = ctx.bumps.airdrop_vault;
        config.claims_enabled = false;
        Ok(())
    }

    pub fn set_claims_enabled(ctx: Context<AuthConfig>, enabled: bool) -> Result<()> {
        ctx.accounts.config.claims_enabled = enabled;
        Ok(())
    }

    pub fn initialize_lanes(
        _ctx: Context<InitializeLanesDeprecated>,
        _operator: Pubkey,
        _native_usd_micros: u64,
    ) -> Result<()> {
        err!(TreasuryError::DeprecatedInstruction)
    }

    pub fn initialize_lanes_v2_primary(
        ctx: Context<InitializeLanesV2Primary>,
        operator: Pubkey,
        native_usd_micros: u64,
    ) -> Result<()> {
        require!(operator != Pubkey::default(), TreasuryError::InvalidOperator);
        require!(native_usd_micros > 0, TreasuryError::InvalidAmount);
        let state = &mut ctx.accounts.route_state;
        state.authority = ctx.accounts.authority.key();
        state.operator = operator;
        state.overflow_treasury = ctx.accounts.protocol_vault.key();
        state.operator_fill_cap_usd_micros = OPERATOR_FILL_CAP_USD_MICROS;
        state.operator_filled_usd_micros = 0;
        state.native_usd_micros = native_usd_micros;
        state.bump = ctx.bumps.route_state;
        Ok(())
    }

    pub fn initialize_lanes_v2_secondary(
        _ctx: Context<InitializeLanesV2Secondary>,
    ) -> Result<()> {
        Ok(())
    }

    pub fn flush_operator_fill(ctx: Context<FlushOperatorFill>) -> Result<()> {
        let rent_min = Rent::get()?.minimum_balance(8 + VaultState::SIZE);
        let vault_lamports = ctx.accounts.protocol_vault.to_account_info().lamports();
        let available = vault_lamports.saturating_sub(rent_min);
        if available == 0 {
            return Ok(());
        }
        let state = &mut ctx.accounts.route_state;
        require_keys_eq!(ctx.accounts.operator.key(), state.operator, TreasuryError::InvalidOperator);
        let (to_operator, _to_vault, new_filled) = split_operator_fill(
            available,
            state.native_usd_micros,
            state.operator_filled_usd_micros,
            state.operator_fill_cap_usd_micros,
        )?;
        if to_operator == 0 {
            return Ok(());
        }
        {
            let vault_info = ctx.accounts.protocol_vault.to_account_info();
            let operator_info = ctx.accounts.operator.to_account_info();
            **vault_info.try_borrow_mut_lamports()? = vault_info
                .lamports()
                .checked_sub(to_operator)
                .ok_or(TreasuryError::InsufficientVaultBalance)?;
            **operator_info.try_borrow_mut_lamports()? = operator_info
                .lamports()
                .checked_add(to_operator)
                .ok_or(TreasuryError::MathOverflow)?;
        }
        state.operator_filled_usd_micros = new_filled;
        Ok(())
    }

    pub fn set_route_params(
        ctx: Context<SetRouteParams>,
        operator: Pubkey,
        overflow_treasury: Pubkey,
        operator_fill_cap_usd_micros: u64,
        native_usd_micros: u64,
    ) -> Result<()> {
        require!(operator_fill_cap_usd_micros > 0, TreasuryError::InvalidAmount);
        let state = &mut ctx.accounts.route_state;
        state.operator = operator;
        state.overflow_treasury = overflow_treasury;
        state.operator_fill_cap_usd_micros = operator_fill_cap_usd_micros;
        state.native_usd_micros = native_usd_micros;
        Ok(())
    }

    pub fn deposit_league(ctx: Context<DepositLeague>, lamports: u64) -> Result<()> {
        require!(lamports > 0, TreasuryError::InvalidAmount);
        invoke(
            &system_instruction::transfer(
                &ctx.accounts.payer.key(),
                &ctx.accounts.league_vault.key(),
                lamports,
            ),
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.league_vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
        Ok(())
    }

    pub fn deposit_airdrop(ctx: Context<DepositAirdrop>, lamports: u64) -> Result<()> {
        require!(lamports > 0, TreasuryError::InvalidAmount);
        invoke(
            &system_instruction::transfer(
                &ctx.accounts.payer.key(),
                &ctx.accounts.airdrop_vault.key(),
                lamports,
            ),
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.airdrop_vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
        Ok(())
    }

    pub fn set_league_epoch_root(
        ctx: Context<SetLeagueEpochRoot>,
        period: u8,
        epoch_start: i64,
        root: [u8; 32],
        total_lamports: u64,
    ) -> Result<()> {
        require!(
            period == PERIOD_WEEKLY || period == PERIOD_MONTHLY,
            TreasuryError::InvalidPeriod
        );
        require!(root != [0u8; 32], TreasuryError::InvalidRoot);
        require!(total_lamports > 0, TreasuryError::InvalidAmount);
        require!(
            ctx.accounts.league_vault.to_account_info().lamports() >= total_lamports,
            TreasuryError::InsufficientVaultBalance
        );

        let epoch = &ctx.accounts.league_epoch;
        if epoch.initialized {
            require!(!epoch.sealed || epoch.root == root, TreasuryError::EpochAlreadySealed);
        }
        let epoch = &mut ctx.accounts.league_epoch;
        epoch.period = period;
        epoch.epoch_start = epoch_start;
        epoch.root = root;
        epoch.total_lamports = total_lamports;
        epoch.claimed_lamports = if epoch.initialized { epoch.claimed_lamports } else { 0 };
        epoch.bump = ctx.bumps.league_epoch;
        epoch.initialized = true;
        epoch.sealed = true;
        emit!(LeagueEpochRootSet {
            period,
            epoch_start,
            root,
            total_lamports,
        });
        Ok(())
    }

    pub fn claim_league(
        ctx: Context<ClaimLeague>,
        period: u8,
        epoch_start: i64,
        category_hash: [u8; 32],
        rank: u8,
        amount_lamports: u64,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        require!(ctx.accounts.config.claims_enabled, TreasuryError::ClaimsDisabled);
        require!(
            period == PERIOD_WEEKLY || period == PERIOD_MONTHLY,
            TreasuryError::InvalidPeriod
        );
        require!(rank >= 1 && rank <= 5, TreasuryError::InvalidRank);
        require!(amount_lamports > 0, TreasuryError::InvalidAmount);

        let epoch = &ctx.accounts.league_epoch;
        require!(epoch.initialized && epoch.sealed, TreasuryError::EpochNotSealed);
        require!(epoch.period == period && epoch.epoch_start == epoch_start, TreasuryError::EpochMismatch);
        require!(
            epoch.claimed_lamports.saturating_add(amount_lamports) <= epoch.total_lamports,
            TreasuryError::EpochBudgetExceeded
        );

        let leaf = league_leaf(
            epoch_start,
            period,
            &category_hash,
            rank,
            &ctx.accounts.winner.key(),
            amount_lamports,
        );
        require!(verify_merkle_proof(leaf, &proof, epoch.root), TreasuryError::InvalidProof);

        let vault_info = ctx.accounts.league_vault.to_account_info();
        let winner_info = ctx.accounts.winner.to_account_info();
        **vault_info.try_borrow_mut_lamports()? = vault_info
            .lamports()
            .checked_sub(amount_lamports)
            .ok_or(TreasuryError::InsufficientVaultBalance)?;
        **winner_info.try_borrow_mut_lamports()? = winner_info
            .lamports()
            .checked_add(amount_lamports)
            .ok_or(TreasuryError::MathOverflow)?;

        let epoch = &mut ctx.accounts.league_epoch;
        epoch.claimed_lamports = epoch
            .claimed_lamports
            .checked_add(amount_lamports)
            .ok_or(TreasuryError::MathOverflow)?;

        let receipt = &mut ctx.accounts.claim_receipt;
        receipt.winner = ctx.accounts.winner.key();
        receipt.period = period;
        receipt.epoch_start = epoch_start;
        receipt.category_hash = category_hash;
        receipt.rank = rank;
        receipt.amount_lamports = amount_lamports;
        receipt.bump = ctx.bumps.claim_receipt;

        emit!(LeagueClaimed {
            winner: ctx.accounts.winner.key(),
            period,
            epoch_start,
            category_hash,
            rank,
            amount_lamports,
        });
        Ok(())
    }

    pub fn set_airdrop_batch_root(
        ctx: Context<SetAirdropBatchRoot>,
        epoch_id: i64,
        root: [u8; 32],
        total_lamports: u64,
        deadline: i64,
    ) -> Result<()> {
        require!(root != [0u8; 32], TreasuryError::InvalidRoot);
        require!(total_lamports > 0, TreasuryError::InvalidAmount);
        require!(
            ctx.accounts.airdrop_vault.to_account_info().lamports() >= total_lamports,
            TreasuryError::InsufficientVaultBalance
        );
        let batch = &mut ctx.accounts.airdrop_batch;
        require!(!batch.initialized, TreasuryError::EpochAlreadySealed);
        batch.epoch_id = epoch_id;
        batch.root = root;
        batch.total_lamports = total_lamports;
        batch.claimed_lamports = 0;
        batch.deadline = deadline;
        batch.bump = ctx.bumps.airdrop_batch;
        batch.initialized = true;
        emit!(AirdropBatchRootSet {
            epoch_id,
            root,
            total_lamports,
            deadline,
        });
        Ok(())
    }

    pub fn claim_airdrop(
        ctx: Context<ClaimAirdrop>,
        epoch_id: i64,
        program_code: u8,
        amount_lamports: u64,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        require!(ctx.accounts.config.claims_enabled, TreasuryError::ClaimsDisabled);
        require!(amount_lamports > 0, TreasuryError::InvalidAmount);
        let now = Clock::get()?.unix_timestamp;
        let batch = &ctx.accounts.airdrop_batch;
        require!(batch.initialized, TreasuryError::EpochNotSealed);
        require!(batch.epoch_id == epoch_id, TreasuryError::EpochMismatch);
        require!(batch.deadline == 0 || now <= batch.deadline, TreasuryError::ClaimExpired);
        require!(
            batch.claimed_lamports.saturating_add(amount_lamports) <= batch.total_lamports,
            TreasuryError::EpochBudgetExceeded
        );

        let leaf = airdrop_leaf(epoch_id, program_code, &ctx.accounts.winner.key(), amount_lamports);
        require!(verify_merkle_proof(leaf, &proof, batch.root), TreasuryError::InvalidProof);

        let vault_info = ctx.accounts.airdrop_vault.to_account_info();
        let winner_info = ctx.accounts.winner.to_account_info();
        **vault_info.try_borrow_mut_lamports()? = vault_info
            .lamports()
            .checked_sub(amount_lamports)
            .ok_or(TreasuryError::InsufficientVaultBalance)?;
        **winner_info.try_borrow_mut_lamports()? = winner_info
            .lamports()
            .checked_add(amount_lamports)
            .ok_or(TreasuryError::MathOverflow)?;

        let batch = &mut ctx.accounts.airdrop_batch;
        batch.claimed_lamports = batch
            .claimed_lamports
            .checked_add(amount_lamports)
            .ok_or(TreasuryError::MathOverflow)?;

        let receipt = &mut ctx.accounts.airdrop_receipt;
        receipt.winner = ctx.accounts.winner.key();
        receipt.epoch_id = epoch_id;
        receipt.program_code = program_code;
        receipt.amount_lamports = amount_lamports;
        receipt.bump = ctx.bumps.airdrop_receipt;

        emit!(AirdropClaimed {
            winner: ctx.accounts.winner.key(),
            epoch_id,
            program_code,
            amount_lamports,
        });
        Ok(())
    }

    pub fn set_recruiter_batch_root(
        ctx: Context<SetRecruiterBatchRoot>,
        epoch_id: i64,
        root: [u8; 32],
        total_lamports: u64,
        deadline: i64,
    ) -> Result<()> {
        set_reward_lane_batch_root(
            &ctx.accounts.recruiter_vault.to_account_info(),
            &mut ctx.accounts.recruiter_batch,
            epoch_id,
            root,
            total_lamports,
            deadline,
            ctx.bumps.recruiter_batch,
        )?;
        emit!(RecruiterBatchRootSet {
            epoch_id,
            root,
            total_lamports,
            deadline,
        });
        Ok(())
    }

    pub fn claim_recruiter(
        ctx: Context<ClaimRecruiter>,
        epoch_id: i64,
        amount_lamports: u64,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        require!(ctx.accounts.config.claims_enabled, TreasuryError::ClaimsDisabled);
        claim_reward_lane(
            &ctx.accounts.recruiter_vault.to_account_info(),
            &ctx.accounts.winner.to_account_info(),
            &mut ctx.accounts.recruiter_batch,
            epoch_id,
            amount_lamports,
            &proof,
            RECRUITER_LEAF_PREFIX,
        )?;
        let receipt = &mut ctx.accounts.claim_receipt;
        receipt.winner = ctx.accounts.winner.key();
        receipt.epoch_id = epoch_id;
        receipt.amount_lamports = amount_lamports;
        receipt.bump = ctx.bumps.claim_receipt;
        emit!(RecruiterClaimed {
            winner: ctx.accounts.winner.key(),
            epoch_id,
            amount_lamports,
        });
        Ok(())
    }

    pub fn set_squad_batch_root(
        ctx: Context<SetSquadBatchRoot>,
        epoch_id: i64,
        root: [u8; 32],
        total_lamports: u64,
        deadline: i64,
    ) -> Result<()> {
        set_reward_lane_batch_root(
            &ctx.accounts.squad_vault.to_account_info(),
            &mut ctx.accounts.squad_batch,
            epoch_id,
            root,
            total_lamports,
            deadline,
            ctx.bumps.squad_batch,
        )?;
        emit!(SquadBatchRootSet {
            epoch_id,
            root,
            total_lamports,
            deadline,
        });
        Ok(())
    }

    pub fn claim_squad(
        ctx: Context<ClaimSquad>,
        epoch_id: i64,
        amount_lamports: u64,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        require!(ctx.accounts.config.claims_enabled, TreasuryError::ClaimsDisabled);
        claim_reward_lane(
            &ctx.accounts.squad_vault.to_account_info(),
            &ctx.accounts.winner.to_account_info(),
            &mut ctx.accounts.squad_batch,
            epoch_id,
            amount_lamports,
            &proof,
            SQUAD_LEAF_PREFIX,
        )?;
        let receipt = &mut ctx.accounts.claim_receipt;
        receipt.winner = ctx.accounts.winner.key();
        receipt.epoch_id = epoch_id;
        receipt.amount_lamports = amount_lamports;
        receipt.bump = ctx.bumps.claim_receipt;
        emit!(SquadClaimed {
            winner: ctx.accounts.winner.key(),
            epoch_id,
            amount_lamports,
        });
        Ok(())
    }

    pub fn initialize_arena(
        ctx: Context<InitializeArena>,
        resolver: Pubkey,
        protocol_receiver: Pubkey,
        mwl_receiver: Pubkey,
    ) -> Result<()> {
        initialize_arena_handler(ctx, resolver, protocol_receiver, mwl_receiver)
    }

    pub fn set_arena_resolver(ctx: Context<SetArenaConfig>, resolver: Pubkey) -> Result<()> {
        set_arena_resolver_handler(ctx, resolver)
    }

    pub fn set_arena_receivers(
        ctx: Context<SetArenaConfig>,
        protocol_receiver: Pubkey,
        mwl_receiver: Pubkey,
    ) -> Result<()> {
        set_arena_receivers_handler(ctx, protocol_receiver, mwl_receiver)
    }

    pub fn set_arena_pause(ctx: Context<SetArenaConfig>, paused: bool) -> Result<()> {
        set_arena_pause_handler(ctx, paused)
    }

    pub fn open_battle_pool(
        ctx: Context<OpenBattlePool>,
        pool_id: [u8; 32],
        owner_a: Pubkey,
        owner_b: Pubkey,
        stake_lamports: u64,
        deposit_deadline: i64,
        resolve_deadline: i64,
    ) -> Result<()> {
        open_battle_pool_handler(
            ctx,
            pool_id,
            owner_a,
            owner_b,
            stake_lamports,
            deposit_deadline,
            resolve_deadline,
        )
    }

    pub fn open_tournament_pool(
        ctx: Context<OpenTournamentPool>,
        pool_id: [u8; 32],
        buy_in_lamports: u64,
        deposit_deadline: i64,
        resolve_deadline: i64,
    ) -> Result<()> {
        open_tournament_pool_handler(ctx, pool_id, buy_in_lamports, deposit_deadline, resolve_deadline)
    }

    pub fn deposit_stake(ctx: Context<DepositStake>, pool_id: [u8; 32]) -> Result<()> {
        deposit_stake_handler(ctx, pool_id)
    }

    pub fn donate_support(
        ctx: Context<DonateSupport>,
        pool_id: [u8; 32],
        amount_lamports: u64,
    ) -> Result<()> {
        donate_support_handler(ctx, pool_id, amount_lamports)
    }

    pub fn deposit_buy_in(ctx: Context<DepositBuyIn>, pool_id: [u8; 32]) -> Result<()> {
        deposit_buy_in_handler(ctx, pool_id)
    }

    pub fn resolve_pool(
        ctx: Context<ResolveArenaPool>,
        pool_id: [u8; 32],
        result_type: u8,
        winner: Pubkey,
        deadline: i64,
        nonce: u64,
    ) -> Result<()> {
        resolve_pool_handler(ctx, pool_id, result_type, winner, deadline, nonce)
    }

    pub fn open_battle_pool_v2(
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
        open_battle_pool_v2_handler(ctx, pool_id, asset_a, asset_b, owner_a, owner_b, required_stake_a, required_stake_b, support_deadline, deposit_deadline, resolve_deadline)
    }

    pub fn open_tournament_pool_v2(
        ctx: Context<OpenTournamentPoolV2>,
        pool_id: [u8; 32],
        buy_in_lamports: u64,
        support_deadline: i64,
        deposit_deadline: i64,
        resolve_deadline: i64,
    ) -> Result<()> {
        open_tournament_pool_v2_handler(ctx, pool_id, buy_in_lamports, support_deadline, deposit_deadline, resolve_deadline)
    }

    pub fn activate_tournament_pool_v2(
        ctx: Context<ActivateTournamentPoolV2>,
        pool_id: [u8; 32],
    ) -> Result<()> {
        activate_tournament_pool_v2_handler(ctx, pool_id)
    }

    pub fn deposit_stake_v2(ctx: Context<DepositStakeV2>, pool_id: [u8; 32]) -> Result<()> {
        deposit_stake_v2_handler(ctx, pool_id)
    }

    pub fn donate_support_v2(
        ctx: Context<DonateSupportV2>,
        pool_id: [u8; 32],
        amount_lamports: u64,
    ) -> Result<()> {
        donate_support_v2_handler(ctx, pool_id, amount_lamports)
    }

    pub fn close_support_v2(ctx: Context<CloseSupportV2>, pool_id: [u8; 32]) -> Result<()> {
        close_support_v2_handler(ctx, pool_id)
    }

    pub fn deposit_buy_in_v2(
        ctx: Context<DepositBuyInV2>,
        pool_id: [u8; 32],
        entry_asset: Pubkey,
    ) -> Result<()> {
        deposit_buy_in_v2_handler(ctx, pool_id, entry_asset)
    }

    pub fn deposit_prize_boost_v2(
        ctx: Context<DepositPrizeBoostV2>,
        pool_id: [u8; 32],
        funding_id: [u8; 32],
        amount_lamports: u64,
    ) -> Result<()> {
        deposit_prize_boost_v2_handler(ctx, pool_id, funding_id, amount_lamports)
    }

    pub fn resolve_pool_v2(
        ctx: Context<ResolveArenaPoolV2>,
        pool_id: [u8; 32],
        result_type: u8,
        winner_side: u8,
        winner_asset: Pubkey,
        winner_wallet: Pubkey,
        outcome_hash: [u8; 32],
        deadline: i64,
        nonce: u64,
    ) -> Result<()> {
        resolve_pool_v2_handler(ctx, pool_id, result_type, winner_side, winner_asset, winner_wallet, outcome_hash, deadline, nonce)
    }

    pub fn cancel_pool_v2(
        ctx: Context<CancelArenaPoolV2>,
        pool_id: [u8; 32],
        reason_code: u8,
        deadline: i64,
        nonce: u64,
    ) -> Result<()> {
        cancel_pool_v2_handler(ctx, pool_id, reason_code, deadline, nonce)
    }

    pub fn refund_buy_in_v2(
        ctx: Context<RefundArenaBuyInV2>,
        pool_id: [u8; 32],
        entry_asset: Pubkey,
    ) -> Result<()> {
        refund_buy_in_v2_handler(ctx, pool_id, entry_asset)
    }

    pub fn refund_prize_boost_v2(
        ctx: Context<RefundPrizeBoostV2>,
        pool_id: [u8; 32],
        funding_id: [u8; 32],
    ) -> Result<()> {
        refund_prize_boost_v2_handler(ctx, pool_id, funding_id)
    }

    pub fn settle_expired_pool(
        ctx: Context<SettleExpiredArenaPool>,
        pool_id: [u8; 32],
    ) -> Result<()> {
        settle_expired_pool_handler(ctx, pool_id)
    }

    pub fn claim_winner(ctx: Context<ClaimArenaWinner>, pool_id: [u8; 32]) -> Result<()> {
        claim_winner_handler(ctx, pool_id)
    }

    pub fn claim_protocol(ctx: Context<ClaimArenaProtocol>, pool_id: [u8; 32]) -> Result<()> {
        claim_protocol_handler(ctx, pool_id)
    }

    pub fn claim_mwl(ctx: Context<ClaimArenaMwl>, pool_id: [u8; 32]) -> Result<()> {
        claim_mwl_handler(ctx, pool_id)
    }

    pub fn refund_stake(ctx: Context<RefundArenaStake>, pool_id: [u8; 32]) -> Result<()> {
        refund_stake_handler(ctx, pool_id)
    }

    pub fn refund_buy_in(ctx: Context<RefundArenaBuyIn>, pool_id: [u8; 32]) -> Result<()> {
        refund_buy_in_handler(ctx, pool_id)
    }
}

#[derive(Accounts)]
pub struct InitializeLanesDeprecated<'info> {
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct InitializeLanesV2Primary<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [REWARDS_CONFIG_SEED],
        bump = config.bump,
        has_one = authority
    )]
    pub config: Box<Account<'info, RewardsConfig>>,
    #[account(
        init,
        payer = authority,
        space = 8 + RouteState::SIZE,
        seeds = [ROUTE_STATE_SEED],
        bump
    )]
    pub route_state: Box<Account<'info, RouteState>>,
    #[account(
        init,
        payer = authority,
        space = 8 + VaultState::SIZE,
        seeds = [MONTHLY_LEAGUE_VAULT_SEED],
        bump
    )]
    pub monthly_league_vault: Box<Account<'info, VaultState>>,
    #[account(
        init,
        payer = authority,
        space = 8 + VaultState::SIZE,
        seeds = [PROTOCOL_VAULT_SEED],
        bump
    )]
    pub protocol_vault: Box<Account<'info, VaultState>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeLanesV2Secondary<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [REWARDS_CONFIG_SEED],
        bump = config.bump,
        has_one = authority
    )]
    pub config: Box<Account<'info, RewardsConfig>>,
    #[account(
        seeds = [ROUTE_STATE_SEED],
        bump = route_state.bump,
        constraint = route_state.authority == authority.key() @ TreasuryError::InvalidOperator
    )]
    pub route_state: Box<Account<'info, RouteState>>,
    #[account(
        init,
        payer = authority,
        space = 8 + VaultState::SIZE,
        seeds = [RECRUITER_VAULT_SEED],
        bump
    )]
    pub recruiter_vault: Box<Account<'info, VaultState>>,
    #[account(
        init,
        payer = authority,
        space = 8 + VaultState::SIZE,
        seeds = [SQUAD_VAULT_SEED],
        bump
    )]
    pub squad_vault: Box<Account<'info, VaultState>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FlushOperatorFill<'info> {
    #[account(mut)]
    pub operator: SystemAccount<'info>,
    #[account(mut, seeds = [ROUTE_STATE_SEED], bump = route_state.bump)]
    pub route_state: Account<'info, RouteState>,
    #[account(mut, seeds = [PROTOCOL_VAULT_SEED], bump)]
    pub protocol_vault: Account<'info, VaultState>,
}

#[derive(Accounts)]
pub struct SetRouteParams<'info> {
    pub authority: Signer<'info>,
    #[account(
        seeds = [REWARDS_CONFIG_SEED],
        bump = config.bump,
        has_one = authority
    )]
    pub config: Account<'info, RewardsConfig>,
    #[account(
        mut,
        seeds = [ROUTE_STATE_SEED],
        bump = route_state.bump
    )]
    pub route_state: Account<'info, RouteState>,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + RewardsConfig::SIZE,
        seeds = [REWARDS_CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, RewardsConfig>,
    #[account(
        init,
        payer = authority,
        space = 8 + VaultState::SIZE,
        seeds = [LEAGUE_VAULT_SEED],
        bump
    )]
    pub league_vault: Account<'info, VaultState>,
    #[account(
        init,
        payer = authority,
        space = 8 + VaultState::SIZE,
        seeds = [AIRDROP_VAULT_SEED],
        bump
    )]
    pub airdrop_vault: Account<'info, VaultState>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AuthConfig<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [REWARDS_CONFIG_SEED],
        bump = config.bump,
        has_one = authority
    )]
    pub config: Account<'info, RewardsConfig>,
}

#[derive(Accounts)]
pub struct DepositLeague<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [LEAGUE_VAULT_SEED], bump)]
    pub league_vault: Account<'info, VaultState>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositAirdrop<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [AIRDROP_VAULT_SEED], bump)]
    pub airdrop_vault: Account<'info, VaultState>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(period: u8, epoch_start: i64)]
pub struct SetLeagueEpochRoot<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [REWARDS_CONFIG_SEED],
        bump = config.bump,
        has_one = authority
    )]
    pub config: Account<'info, RewardsConfig>,
    #[account(seeds = [LEAGUE_VAULT_SEED], bump = config.league_vault_bump)]
    pub league_vault: Account<'info, VaultState>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + LeagueEpoch::SIZE,
        seeds = [LEAGUE_EPOCH_SEED, &[period], &epoch_start.to_le_bytes()],
        bump
    )]
    pub league_epoch: Account<'info, LeagueEpoch>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(period: u8, epoch_start: i64, category_hash: [u8; 32], rank: u8)]
pub struct ClaimLeague<'info> {
    #[account(mut)]
    pub winner: Signer<'info>,
    #[account(seeds = [REWARDS_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, RewardsConfig>,
    #[account(mut, seeds = [LEAGUE_VAULT_SEED], bump = config.league_vault_bump)]
    pub league_vault: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [LEAGUE_EPOCH_SEED, &[period], &epoch_start.to_le_bytes()],
        bump = league_epoch.bump
    )]
    pub league_epoch: Account<'info, LeagueEpoch>,
    #[account(
        init,
        payer = winner,
        space = 8 + LeagueClaimReceipt::SIZE,
        seeds = [LEAGUE_CLAIM_SEED, &[period], &epoch_start.to_le_bytes(), category_hash.as_ref(), &[rank]],
        bump
    )]
    pub claim_receipt: Account<'info, LeagueClaimReceipt>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(epoch_id: i64)]
pub struct SetAirdropBatchRoot<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [REWARDS_CONFIG_SEED],
        bump = config.bump,
        has_one = authority
    )]
    pub config: Account<'info, RewardsConfig>,
    #[account(seeds = [AIRDROP_VAULT_SEED], bump = config.airdrop_vault_bump)]
    pub airdrop_vault: Account<'info, VaultState>,
    #[account(
        init,
        payer = authority,
        space = 8 + AirdropBatch::SIZE,
        seeds = [AIRDROP_BATCH_SEED, &epoch_id.to_le_bytes()],
        bump
    )]
    pub airdrop_batch: Account<'info, AirdropBatch>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(epoch_id: i64, program_code: u8)]
pub struct ClaimAirdrop<'info> {
    #[account(mut)]
    pub winner: Signer<'info>,
    #[account(seeds = [REWARDS_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, RewardsConfig>,
    #[account(mut, seeds = [AIRDROP_VAULT_SEED], bump = config.airdrop_vault_bump)]
    pub airdrop_vault: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [AIRDROP_BATCH_SEED, &epoch_id.to_le_bytes()],
        bump = airdrop_batch.bump
    )]
    pub airdrop_batch: Account<'info, AirdropBatch>,
    #[account(
        init,
        payer = winner,
        space = 8 + AirdropClaimReceipt::SIZE,
        seeds = [AIRDROP_CLAIM_SEED, &epoch_id.to_le_bytes(), &[program_code], winner.key().as_ref()],
        bump
    )]
    pub airdrop_receipt: Account<'info, AirdropClaimReceipt>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(epoch_id: i64)]
pub struct SetRecruiterBatchRoot<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [REWARDS_CONFIG_SEED],
        bump = config.bump,
        has_one = authority
    )]
    pub config: Account<'info, RewardsConfig>,
    #[account(seeds = [RECRUITER_VAULT_SEED], bump)]
    pub recruiter_vault: Account<'info, VaultState>,
    #[account(
        init,
        payer = authority,
        space = 8 + RewardLaneBatch::SIZE,
        seeds = [RECRUITER_BATCH_SEED, &epoch_id.to_le_bytes()],
        bump
    )]
    pub recruiter_batch: Account<'info, RewardLaneBatch>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(epoch_id: i64)]
pub struct ClaimRecruiter<'info> {
    #[account(mut)]
    pub winner: Signer<'info>,
    #[account(seeds = [REWARDS_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, RewardsConfig>,
    #[account(mut, seeds = [RECRUITER_VAULT_SEED], bump)]
    pub recruiter_vault: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [RECRUITER_BATCH_SEED, &epoch_id.to_le_bytes()],
        bump = recruiter_batch.bump
    )]
    pub recruiter_batch: Account<'info, RewardLaneBatch>,
    #[account(
        init,
        payer = winner,
        space = 8 + RewardLaneClaimReceipt::SIZE,
        seeds = [RECRUITER_CLAIM_SEED, &epoch_id.to_le_bytes(), winner.key().as_ref()],
        bump
    )]
    pub claim_receipt: Account<'info, RewardLaneClaimReceipt>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(epoch_id: i64)]
pub struct SetSquadBatchRoot<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [REWARDS_CONFIG_SEED],
        bump = config.bump,
        has_one = authority
    )]
    pub config: Account<'info, RewardsConfig>,
    #[account(seeds = [SQUAD_VAULT_SEED], bump)]
    pub squad_vault: Account<'info, VaultState>,
    #[account(
        init,
        payer = authority,
        space = 8 + RewardLaneBatch::SIZE,
        seeds = [SQUAD_BATCH_SEED, &epoch_id.to_le_bytes()],
        bump
    )]
    pub squad_batch: Account<'info, RewardLaneBatch>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(epoch_id: i64)]
pub struct ClaimSquad<'info> {
    #[account(mut)]
    pub winner: Signer<'info>,
    #[account(seeds = [REWARDS_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, RewardsConfig>,
    #[account(mut, seeds = [SQUAD_VAULT_SEED], bump)]
    pub squad_vault: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [SQUAD_BATCH_SEED, &epoch_id.to_le_bytes()],
        bump = squad_batch.bump
    )]
    pub squad_batch: Account<'info, RewardLaneBatch>,
    #[account(
        init,
        payer = winner,
        space = 8 + RewardLaneClaimReceipt::SIZE,
        seeds = [SQUAD_CLAIM_SEED, &epoch_id.to_le_bytes(), winner.key().as_ref()],
        bump
    )]
    pub claim_receipt: Account<'info, RewardLaneClaimReceipt>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct RewardsConfig {
    pub authority: Pubkey,
    pub bump: u8,
    pub league_vault_bump: u8,
    pub airdrop_vault_bump: u8,
    pub claims_enabled: bool,
}

impl RewardsConfig {
    pub const SIZE: usize = 32 + 1 + 1 + 1 + 1;
}

#[account]
pub struct RouteState {
    pub authority: Pubkey,
    pub operator: Pubkey,
    pub overflow_treasury: Pubkey,
    pub operator_fill_cap_usd_micros: u64,
    pub operator_filled_usd_micros: u64,
    pub native_usd_micros: u64,
    pub bump: u8,
}

impl RouteState {
    pub const SIZE: usize = 32 + 32 + 32 + 8 + 8 + 8 + 1;
}

#[account]
pub struct VaultState {
    pub kind: u8,
}

impl VaultState {
    pub const SIZE: usize = 1;
}

#[account]
pub struct LeagueEpoch {
    pub period: u8,
    pub epoch_start: i64,
    pub root: [u8; 32],
    pub total_lamports: u64,
    pub claimed_lamports: u64,
    pub bump: u8,
    pub initialized: bool,
    pub sealed: bool,
}

impl LeagueEpoch {
    pub const SIZE: usize = 1 + 8 + 32 + 8 + 8 + 1 + 1 + 1;
}

#[account]
pub struct LeagueClaimReceipt {
    pub winner: Pubkey,
    pub period: u8,
    pub epoch_start: i64,
    pub category_hash: [u8; 32],
    pub rank: u8,
    pub amount_lamports: u64,
    pub bump: u8,
}

impl LeagueClaimReceipt {
    pub const SIZE: usize = 32 + 1 + 8 + 32 + 1 + 8 + 1;
}

#[account]
pub struct AirdropBatch {
    pub epoch_id: i64,
    pub root: [u8; 32],
    pub total_lamports: u64,
    pub claimed_lamports: u64,
    pub deadline: i64,
    pub bump: u8,
    pub initialized: bool,
}

impl AirdropBatch {
    pub const SIZE: usize = 8 + 32 + 8 + 8 + 8 + 1 + 1;
}

#[account]
pub struct AirdropClaimReceipt {
    pub winner: Pubkey,
    pub epoch_id: i64,
    pub program_code: u8,
    pub amount_lamports: u64,
    pub bump: u8,
}

impl AirdropClaimReceipt {
    pub const SIZE: usize = 32 + 8 + 1 + 8 + 1;
}

#[account]
pub struct RewardLaneBatch {
    pub epoch_id: i64,
    pub root: [u8; 32],
    pub total_lamports: u64,
    pub claimed_lamports: u64,
    pub deadline: i64,
    pub bump: u8,
    pub initialized: bool,
}

impl RewardLaneBatch {
    pub const SIZE: usize = 8 + 32 + 8 + 8 + 8 + 1 + 1;
}

#[account]
pub struct RewardLaneClaimReceipt {
    pub winner: Pubkey,
    pub epoch_id: i64,
    pub amount_lamports: u64,
    pub bump: u8,
}

impl RewardLaneClaimReceipt {
    pub const SIZE: usize = 32 + 8 + 8 + 1;
}

#[event]
pub struct LeagueEpochRootSet {
    pub period: u8,
    pub epoch_start: i64,
    pub root: [u8; 32],
    pub total_lamports: u64,
}

#[event]
pub struct LeagueClaimed {
    pub winner: Pubkey,
    pub period: u8,
    pub epoch_start: i64,
    pub category_hash: [u8; 32],
    pub rank: u8,
    pub amount_lamports: u64,
}

#[event]
pub struct AirdropBatchRootSet {
    pub epoch_id: i64,
    pub root: [u8; 32],
    pub total_lamports: u64,
    pub deadline: i64,
}

#[event]
pub struct AirdropClaimed {
    pub winner: Pubkey,
    pub epoch_id: i64,
    pub program_code: u8,
    pub amount_lamports: u64,
}

#[event]
pub struct RecruiterBatchRootSet {
    pub epoch_id: i64,
    pub root: [u8; 32],
    pub total_lamports: u64,
    pub deadline: i64,
}

#[event]
pub struct RecruiterClaimed {
    pub winner: Pubkey,
    pub epoch_id: i64,
    pub amount_lamports: u64,
}

#[event]
pub struct SquadBatchRootSet {
    pub epoch_id: i64,
    pub root: [u8; 32],
    pub total_lamports: u64,
    pub deadline: i64,
}

#[event]
pub struct SquadClaimed {
    pub winner: Pubkey,
    pub epoch_id: i64,
    pub amount_lamports: u64,
}

#[error_code]
pub enum TreasuryError {
    #[msg("Invalid period.")]
    InvalidPeriod,
    #[msg("Invalid merkle root.")]
    InvalidRoot,
    #[msg("Invalid amount.")]
    InvalidAmount,
    #[msg("Invalid rank.")]
    InvalidRank,
    #[msg("Claims are not enabled yet.")]
    ClaimsDisabled,
    #[msg("Reward vault has insufficient SOL.")]
    InsufficientVaultBalance,
    #[msg("Epoch is already sealed with a different root.")]
    EpochAlreadySealed,
    #[msg("Epoch is not sealed.")]
    EpochNotSealed,
    #[msg("Epoch accounts do not match the instruction.")]
    EpochMismatch,
    #[msg("Merkle proof is invalid.")]
    InvalidProof,
    #[msg("Claim would exceed the sealed epoch budget.")]
    EpochBudgetExceeded,
    #[msg("Reward claim window has expired.")]
    ClaimExpired,
    #[msg("Arithmetic overflow.")]
    MathOverflow,
    #[msg("Operator account does not match route_state.operator.")]
    InvalidOperator,
    #[msg("Legacy rewards lane initializer is disabled; use initialize_lanes_v2_primary/secondary.")]
    DeprecatedInstruction,
}

pub fn league_leaf(
    epoch_start: i64,
    period: u8,
    category_hash: &[u8; 32],
    rank: u8,
    winner: &Pubkey,
    amount_lamports: u64,
) -> [u8; 32] {
    let mut bytes = Vec::with_capacity(LEAGUE_LEAF_PREFIX.len() + 8 + 1 + 32 + 1 + 32 + 8);
    bytes.extend_from_slice(LEAGUE_LEAF_PREFIX);
    bytes.extend_from_slice(&epoch_start.to_le_bytes());
    bytes.push(period);
    bytes.extend_from_slice(category_hash);
    bytes.push(rank);
    bytes.extend_from_slice(winner.as_ref());
    bytes.extend_from_slice(&amount_lamports.to_le_bytes());
    keccak::hash(&bytes).0
}

pub fn airdrop_leaf(epoch_id: i64, program_code: u8, winner: &Pubkey, amount_lamports: u64) -> [u8; 32] {
    let mut bytes = Vec::with_capacity(AIRDROP_LEAF_PREFIX.len() + 8 + 1 + 32 + 8);
    bytes.extend_from_slice(AIRDROP_LEAF_PREFIX);
    bytes.extend_from_slice(&epoch_id.to_le_bytes());
    bytes.push(program_code);
    bytes.extend_from_slice(winner.as_ref());
    bytes.extend_from_slice(&amount_lamports.to_le_bytes());
    keccak::hash(&bytes).0
}

pub fn reward_lane_leaf(prefix: &[u8], epoch_id: i64, winner: &Pubkey, amount_lamports: u64) -> [u8; 32] {
    let mut bytes = Vec::with_capacity(prefix.len() + 8 + 32 + 8);
    bytes.extend_from_slice(prefix);
    bytes.extend_from_slice(&epoch_id.to_le_bytes());
    bytes.extend_from_slice(winner.as_ref());
    bytes.extend_from_slice(&amount_lamports.to_le_bytes());
    keccak::hash(&bytes).0
}

fn set_reward_lane_batch_root(
    vault_info: &AccountInfo,
    batch: &mut Account<RewardLaneBatch>,
    epoch_id: i64,
    root: [u8; 32],
    total_lamports: u64,
    deadline: i64,
    bump: u8,
) -> Result<()> {
    require!(root != [0u8; 32], TreasuryError::InvalidRoot);
    require!(total_lamports > 0, TreasuryError::InvalidAmount);
    let now = Clock::get()?.unix_timestamp;
    require!(deadline == 0 || deadline > now, TreasuryError::ClaimExpired);
    let rent_min = Rent::get()?.minimum_balance(8 + VaultState::SIZE);
    let available = vault_info.lamports().saturating_sub(rent_min);
    require!(available >= total_lamports, TreasuryError::InsufficientVaultBalance);
    require!(!batch.initialized, TreasuryError::EpochAlreadySealed);
    batch.epoch_id = epoch_id;
    batch.root = root;
    batch.total_lamports = total_lamports;
    batch.claimed_lamports = 0;
    batch.deadline = deadline;
    batch.bump = bump;
    batch.initialized = true;
    Ok(())
}

fn claim_reward_lane(
    vault_info: &AccountInfo,
    winner_info: &AccountInfo,
    batch: &mut Account<RewardLaneBatch>,
    epoch_id: i64,
    amount_lamports: u64,
    proof: &[[u8; 32]],
    prefix: &[u8],
) -> Result<()> {
    require!(amount_lamports > 0, TreasuryError::InvalidAmount);
    let now = Clock::get()?.unix_timestamp;
    require!(batch.initialized, TreasuryError::EpochNotSealed);
    require!(batch.epoch_id == epoch_id, TreasuryError::EpochMismatch);
    require!(batch.deadline == 0 || now <= batch.deadline, TreasuryError::ClaimExpired);
    require!(
        batch.claimed_lamports.saturating_add(amount_lamports) <= batch.total_lamports,
        TreasuryError::EpochBudgetExceeded
    );
    let winner = winner_info.key();
    let leaf = reward_lane_leaf(prefix, epoch_id, &winner, amount_lamports);
    require!(verify_merkle_proof(leaf, proof, batch.root), TreasuryError::InvalidProof);

    **vault_info.try_borrow_mut_lamports()? = vault_info
        .lamports()
        .checked_sub(amount_lamports)
        .ok_or(TreasuryError::InsufficientVaultBalance)?;
    **winner_info.try_borrow_mut_lamports()? = winner_info
        .lamports()
        .checked_add(amount_lamports)
        .ok_or(TreasuryError::MathOverflow)?;
    batch.claimed_lamports = batch
        .claimed_lamports
        .checked_add(amount_lamports)
        .ok_or(TreasuryError::MathOverflow)?;
    Ok(())
}

pub fn verify_merkle_proof(leaf: [u8; 32], proof: &[[u8; 32]], root: [u8; 32]) -> bool {
    let mut computed = leaf;
    for sibling in proof {
        computed = hash_pair(&computed, sibling);
    }
    computed == root
}

fn hash_pair(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let (left, right) = if a <= b { (a, b) } else { (b, a) };
    let mut bytes = [0u8; 64];
    bytes[..32].copy_from_slice(left);
    bytes[32..].copy_from_slice(right);
    keccak::hash(&bytes).0
}
