from pathlib import Path
import re

lib = Path('programs/mwz_rewards_treasury/src/lib.rs')
s = lib.read_text()

fn_pattern = re.compile(r'''    pub fn initialize_lanes\(.*?\n    pub fn flush_operator_fill''', re.S)
fn_replacement = '''    pub fn initialize_lanes(
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

    pub fn flush_operator_fill'''
s, n = fn_pattern.subn(fn_replacement, s, count=1)
if n != 1:
    raise SystemExit('initialize_lanes function block not found')

struct_pattern = re.compile(r'''#\[derive\(Accounts\)\]\npub struct InitializeLanes<'info> \{.*?\n\}\n\n#\[derive\(Accounts\)\]\npub struct FlushOperatorFill''', re.S)
struct_replacement = '''#[derive(Accounts)]
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
pub struct FlushOperatorFill'''
s, n = struct_pattern.subn(struct_replacement, s, count=1)
if n != 1:
    raise SystemExit('InitializeLanes account block not found')

error_marker = '''    #[msg("Operator account does not match route_state.operator.")]
    InvalidOperator,
'''
if error_marker not in s:
    raise SystemExit('Treasury error marker not found')
s = s.replace(error_marker, error_marker + '''    #[msg("Legacy rewards lane initializer is disabled; use initialize_lanes_v2_primary/secondary.")]
    DeprecatedInstruction,
''', 1)
lib.write_text(s)

script = Path('scripts/solana/init-rewards-lanes.mjs')
t = script.read_text()
t = t.replace('createHash("sha256").update("global:initialize_lanes")', 'createHash("sha256").update("global:initialize_lanes_v2_primary")', 1)
old = '''  if (await connection.getAccountInfo(routeState)) {
    console.log("lanes already initialized");
    return;
  }

  const data = Buffer.concat([disc, operator.toBuffer(), u64le(SOL_USD_MICROS)]);
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: routeState, isSigner: false, isWritable: true },
      { pubkey: monthly, isSigner: false, isWritable: true },
      { pubkey: recruiter, isSigner: false, isWritable: true },
      { pubkey: squad, isSigner: false, isWritable: true },
      { pubkey: protocol, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
  const sig = await sendServerV0(connection, payer, [ix], "Rewards lane initialization");
  console.log("initialize_lanes", sig);
'''
new = '''  const routeInfo = await connection.getAccountInfo(routeState);
  const recruiterInfo = await connection.getAccountInfo(recruiter);
  const squadInfo = await connection.getAccountInfo(squad);
  if (routeInfo && recruiterInfo && squadInfo) {
    console.log("lanes already initialized");
    return;
  }

  if (!routeInfo) {
    const data = Buffer.concat([disc, operator.toBuffer(), u64le(SOL_USD_MICROS)]);
    const primary = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: config, isSigner: false, isWritable: false },
        { pubkey: routeState, isSigner: false, isWritable: true },
        { pubkey: monthly, isSigner: false, isWritable: true },
        { pubkey: protocol, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
    const sig = await sendServerV0(connection, payer, [primary], "Rewards lane primary initialization");
    console.log("initialize_lanes_v2_primary", sig);
  }

  if (!recruiterInfo || !squadInfo) {
    const secondaryDisc = crypto.createHash("sha256").update("global:initialize_lanes_v2_secondary").digest().subarray(0, 8);
    const secondary = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: config, isSigner: false, isWritable: false },
        { pubkey: routeState, isSigner: false, isWritable: false },
        { pubkey: recruiter, isSigner: false, isWritable: true },
        { pubkey: squad, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: secondaryDisc,
    });
    const sig = await sendServerV0(connection, payer, [secondary], "Rewards lane secondary initialization");
    console.log("initialize_lanes_v2_secondary", sig);
  }
'''
if old not in t:
    raise SystemExit('init-rewards-lanes script block not found')
script.write_text(t.replace(old, new, 1))

arena = Path('programs/mwz_rewards_treasury/src/arena_final.rs')
a = arena.read_text()
a = a.replace('require!(pool_id != [0u8; 32] && buy_in_lamports > 0, ArenaError::InvalidAmount);', 'require!(pool_id != [0u8; 32], ArenaError::InvalidPoolId);', 1)
a = a.replace('require!(now <= pool.resolve_deadline, ArenaError::DeadlinePassed);\n    transfer_into_vault(\n        &ctx.accounts.funder.to_account_info()', 'require!(now <= pool.deposit_deadline, ArenaError::DeadlinePassed);\n    transfer_into_vault(\n        &ctx.accounts.funder.to_account_info()', 1)
a = a.replace('require!(now >= pool.support_deadline || caller == ctx.accounts.arena_config.authority, ArenaError::SupportStillOpen);', 'require!(now >= pool.support_deadline, ArenaError::SupportStillOpen);', 1)
a = a.replace('''    } else {
        require!(winner_side == ARENA_SIDE_NONE && winner_asset != Pubkey::default() && winner_wallet != Pubkey::default(), ArenaError::InvalidWinner);
        validate_tournament_winner_receipt(
            &ctx.accounts.winner_buy_in_receipt.to_account_info(), pool_id, winner_asset,
            winner_wallet, pool.buy_in_lamports,
        )?;
    }
''', '''    } else {
        require!(winner_side == ARENA_SIDE_NONE && winner_asset != Pubkey::default() && winner_wallet != Pubkey::default(), ArenaError::InvalidWinner);
        if pool.buy_in_lamports > 0 {
            validate_tournament_winner_receipt(
                &ctx.accounts.winner_buy_in_receipt.to_account_info(), pool_id, winner_asset,
                winner_wallet, pool.buy_in_lamports,
            )?;
        }
    }
''', 1)
arena.write_text(a)
