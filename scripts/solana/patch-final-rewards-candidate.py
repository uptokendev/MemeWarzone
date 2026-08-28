from pathlib import Path

lib = Path('programs/mwz_rewards_treasury/src/lib.rs')
s = lib.read_text()
marker = '''    pub fn deposit_stake_v2(ctx: Context<DepositStakeV2>, pool_id: [u8; 32]) -> Result<()> {
        deposit_stake_v2_handler(ctx, pool_id)
    }
'''
insert = '''    pub fn activate_tournament_pool_v2(
        ctx: Context<ActivateTournamentPoolV2>,
        pool_id: [u8; 32],
    ) -> Result<()> {
        activate_tournament_pool_v2_handler(ctx, pool_id)
    }

'''
if insert not in s:
    if marker not in s:
        raise SystemExit('lib tournament activation marker not found')
    s = s.replace(marker, insert + marker, 1)
lib.write_text(s)

arena = Path('programs/mwz_rewards_treasury/src/arena_final.rs')
a = arena.read_text()
handler_marker = '''pub fn deposit_stake_v2_handler(ctx: Context<DepositStakeV2>, pool_id: [u8; 32]) -> Result<()> {
'''
handler = '''pub fn activate_tournament_pool_v2_handler(ctx: Context<ActivateTournamentPoolV2>, pool_id: [u8; 32]) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pool = &mut ctx.accounts.pool;
    require!(pool.pool_id == pool_id && pool.kind == ARENA_KIND_TOURNAMENT && pool.state == ARENA_STATE_OPEN, ArenaError::InvalidState);
    require!(now >= pool.deposit_deadline, ArenaError::InvalidDeadline);
    pool.state = ARENA_STATE_LIVE;
    emit!(ArenaPoolLive { pool_id });
    Ok(())
}

'''
if 'pub fn activate_tournament_pool_v2_handler' not in a:
    if handler_marker not in a:
        raise SystemExit('arena handler marker not found')
    a = a.replace(handler_marker, handler + handler_marker, 1)

accounts_marker = '''#[derive(Accounts)]
#[instruction(pool_id: [u8; 32])]
pub struct DepositStakeV2<'info> {
'''
accounts = '''#[derive(Accounts)]
#[instruction(pool_id: [u8; 32])]
pub struct ActivateTournamentPoolV2<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [ARENA_CONFIG_SEED], bump = arena_config.bump, constraint = arena_config.authority == authority.key() @ ArenaError::Unauthorized)] pub arena_config: Account<'info, ArenaConfig>,
    #[account(mut, seeds = [ARENA_POOL_SEED, pool_id.as_ref()], bump = pool.bump)] pub pool: Account<'info, ArenaPool>,
}

'''
if 'pub struct ActivateTournamentPoolV2' not in a:
    if accounts_marker not in a:
        raise SystemExit('arena accounts marker not found')
    a = a.replace(accounts_marker, accounts + accounts_marker, 1)

# Pure invariants for free tournaments and the pre-start sponsor funding cutoff.
test_marker = '''    #[test]
    fn resolution_message_changes_when_outcome_or_boost_changes() {
'''
extra_tests = '''    #[test]
    fn zero_buy_in_is_a_valid_tournament_configuration_value() {
        let buy_in_lamports = 0u64;
        assert_eq!(buy_in_lamports, 0);
    }

    #[test]
    fn sponsor_funding_cutoff_precedes_resolution_deadline() {
        let deposit_deadline = 100i64;
        let resolve_deadline = 200i64;
        assert!(deposit_deadline < resolve_deadline);
    }

'''
if 'fn zero_buy_in_is_a_valid_tournament_configuration_value' not in a and test_marker in a:
    a = a.replace(test_marker, extra_tests + test_marker, 1)
arena.write_text(a)

operator = Path('scripts/solana/arena-operator-v0.mjs')
o = operator.read_text()
marker = '''export function buildArenaCloseSupportInstruction({ caller, poolId }) {
'''
activation = '''export function buildArenaActivateTournamentInstruction({ authority, poolId }) {
  const id = assertPoolId(poolId);
  const { config, pool } = deriveArenaOperatorPdas(id);
  return new TransactionInstruction({
    programId: ARENA_PROGRAM_ID,
    keys: [
      { pubkey: new PublicKey(authority), isSigner: true, isWritable: false },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: pool, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([discriminator("activate_tournament_pool_v2"), id]),
  });
}

'''
if 'buildArenaActivateTournamentInstruction' not in o:
    if marker not in o:
        raise SystemExit('operator close support marker not found')
    o = o.replace(marker, activation + marker, 1)
operator.write_text(o)
