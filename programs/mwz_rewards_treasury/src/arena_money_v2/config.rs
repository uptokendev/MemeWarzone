use anchor_lang::prelude::*;

use super::errors::ArenaMoneyV2Error;

pub const ARENA_MONEY_CONFIG_SEED_V2: &[u8] = b"arena_money_config_v2";
pub const ARENA_MONEY_GENERATION_V2: u8 = 2;

#[account]
pub struct ArenaMoneyConfigV2 {
    pub generation: u8,
    pub authority: Pubkey,
    pub resolver: Pubkey,
    pub protocol_receiver: Pubkey,
    pub marketing_receiver: Pubkey,
    pub paused: bool,
    pub bump: u8,
}
impl ArenaMoneyConfigV2 {
    pub const SIZE: usize = 1 + 32 * 4 + 1 + 1;
}

#[derive(Accounts)]
pub struct InitializeArenaMoneyV2<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + ArenaMoneyConfigV2::SIZE,
        seeds = [ARENA_MONEY_CONFIG_SEED_V2],
        bump
    )]
    pub config: Account<'info, ArenaMoneyConfigV2>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetArenaMoneyV2Config<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [ARENA_MONEY_CONFIG_SEED_V2],
        bump = config.bump,
        constraint = config.generation == ARENA_MONEY_GENERATION_V2 @ ArenaMoneyV2Error::GenerationMismatch,
        constraint = config.authority == authority.key() @ ArenaMoneyV2Error::Unauthorized
    )]
    pub config: Account<'info, ArenaMoneyConfigV2>,
}

pub fn initialize_arena_money_v2_handler(
    ctx: Context<InitializeArenaMoneyV2>,
    resolver: Pubkey,
    protocol_receiver: Pubkey,
    marketing_receiver: Pubkey,
) -> Result<()> {
    require!(resolver != Pubkey::default(), ArenaMoneyV2Error::ZeroAddress);
    require!(protocol_receiver != Pubkey::default(), ArenaMoneyV2Error::ZeroAddress);
    require!(marketing_receiver != Pubkey::default(), ArenaMoneyV2Error::ZeroAddress);
    let config = &mut ctx.accounts.config;
    config.generation = ARENA_MONEY_GENERATION_V2;
    config.authority = ctx.accounts.authority.key();
    config.resolver = resolver;
    config.protocol_receiver = protocol_receiver;
    config.marketing_receiver = marketing_receiver;
    config.paused = true;
    config.bump = ctx.bumps.config;
    Ok(())
}

pub fn set_arena_money_v2_pause_handler(ctx: Context<SetArenaMoneyV2Config>, paused: bool) -> Result<()> {
    ctx.accounts.config.paused = paused;
    Ok(())
}

pub fn set_arena_money_v2_receivers_handler(
    ctx: Context<SetArenaMoneyV2Config>,
    resolver: Pubkey,
    protocol_receiver: Pubkey,
    marketing_receiver: Pubkey,
) -> Result<()> {
    require!(resolver != Pubkey::default(), ArenaMoneyV2Error::ZeroAddress);
    require!(protocol_receiver != Pubkey::default(), ArenaMoneyV2Error::ZeroAddress);
    require!(marketing_receiver != Pubkey::default(), ArenaMoneyV2Error::ZeroAddress);
    let config = &mut ctx.accounts.config;
    config.resolver = resolver;
    config.protocol_receiver = protocol_receiver;
    config.marketing_receiver = marketing_receiver;
    Ok(())
}
