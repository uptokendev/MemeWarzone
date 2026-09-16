import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARENA_WAR_POOL_TREASURY_V2,
  assertTournamentChainId,
  planTournamentOpenBuyIn,
  runTournamentOpenBuyIn,
  tournamentPoolId,
} from './t2-tournament-open-buyin-evm-real.mjs';

function baseInput(overrides = {}) {
  return {
    chainId: 46630,
    tournamentId: 'rh46630-vote-t2-1',
    buyInAmount: 10n ** 15n,
    now: 1_800_000_000,
    ...overrides,
  };
}

test('46630 dry-run names attested V2 treasury, ETH, and tournamentPoolId', () => {
  const plan = planTournamentOpenBuyIn(baseInput(), {});
  assert.equal(plan.mode, 'dry-run');
  assert.equal(plan.native, 'ETH');
  assert.equal(plan.treasury, ARENA_WAR_POOL_TREASURY_V2);
  assert.equal(plan.poolId, tournamentPoolId('rh46630-vote-t2-1'));
  assert.equal(plan.openTournamentPool.method, 'openTournamentPool');
  assert.equal(plan.depositBuyIn.method, 'depositBuyIn');
  assert.equal(plan.setTournamentLive.method, 'setTournamentLive');
  assert.equal(plan.sendRequired, false);
});

test('production 4663 throws', () => {
  assert.throws(() => assertTournamentChainId(4663), /PRODUCTION_4663_FORBIDDEN/);
  assert.throws(() => planTournamentOpenBuyIn(baseInput({ chainId: 4663 }), {}), /PRODUCTION_4663_FORBIDDEN/);
});

test('missing live flag never sends', async () => {
  let sends = 0;
  const result = await runTournamentOpenBuyIn({
    plan: planTournamentOpenBuyIn(baseInput(), {}),
    sendOpen: async () => { sends += 1; return { txHash: '0x1' }; },
    sendBuyIn: async () => { sends += 1; return { txHash: '0x2' }; },
    sendLive: async () => { sends += 1; return { txHash: '0x3' }; },
  });
  assert.equal(result.sent, false);
  assert.equal(sends, 0);
});

test('live gate without creator and buyer keys fails closed', () => {
  assert.throws(() => planTournamentOpenBuyIn(baseInput(), { T2_TOURNAMENT_OPEN_LIVE: '1' }), /MISSING_TOURNAMENT_KEYS/);
});
