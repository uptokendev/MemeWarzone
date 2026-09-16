import assert from 'node:assert/strict';
import test from 'node:test';
import { ethers } from 'ethers';

import {
  ARENA_WAR_POOL_TREASURY_V2,
  DEFAULT_POOL_ID,
  DEFAULT_WINNER,
  assertBattleChainId,
  leagueEpochs,
  planResolveClaim,
  runResolveClaim,
} from './t2-battle-resolve-claim-evm-real.mjs';

test('46630 dry-run names attested treasury, live pool, and V2 claimLeague epochs', () => {
  const plan = planResolveClaim({ chainId: 46630 }, {});
  assert.equal(plan.mode, 'dry-run');
  assert.equal(plan.native, 'ETH');
  assert.equal(plan.treasury, ARENA_WAR_POOL_TREASURY_V2);
  assert.equal(plan.poolId, DEFAULT_POOL_ID);
  assert.equal(plan.winnerPayout, DEFAULT_WINNER);
  assert.equal(plan.claimLeague.method, 'claimLeague');
  assert.equal(plan.claimLeague.monthlyEpoch, leagueEpochs().monthlyEpoch);
  assert.equal(plan.claimLeague.quarterlyEpoch, leagueEpochs().quarterlyEpoch);
  assert.equal(plan.sendRequired, false);
});

test('production 4663 throws', () => {
  assert.throws(() => assertBattleChainId(4663), /PRODUCTION_4663_FORBIDDEN/);
  assert.throws(() => planResolveClaim({ chainId: 4663 }, {}), /PRODUCTION_4663_FORBIDDEN/);
});

test('missing live flag never sends', async () => {
  let sends = 0;
  const result = await runResolveClaim({
    plan: planResolveClaim({}, {}),
    sendResolve: async () => { sends += 1; return { txHash: '0x1' }; },
    sendClaimWinner: async () => { sends += 1; return { txHash: '0x2' }; },
    sendClaimProtocol: async () => { sends += 1; return { txHash: '0x3' }; },
    sendClaimLeague: async () => { sends += 1; return { txHash: '0x4' }; },
  });
  assert.equal(result.sent, false);
  assert.equal(sends, 0);
});

test('live gate without resolver and winner keys fails closed', () => {
  assert.throws(() => planResolveClaim({}, { T2_BATTLE_RESOLVE_LIVE: '1' }), /MISSING_RESOLVER_KEY/);
  assert.throws(
    () => planResolveClaim({}, {
      T2_BATTLE_RESOLVE_LIVE: '1',
      ROBINHOOD_TESTNET_DEPLOYER_PRIVATE_KEY: '0x' + '11'.repeat(32),
    }),
    /MISSING_WINNER_KEY/,
  );
});

test('September 2026 league epochs match ArenaMoneyV2 fixture style', () => {
  const epochs = leagueEpochs(new Date('2026-09-16T00:00:00Z'));
  assert.equal(epochs.monthlyEpoch, ethers.id('2026-09'));
  assert.equal(epochs.quarterlyEpoch, ethers.id('2026-Q3'));
});
