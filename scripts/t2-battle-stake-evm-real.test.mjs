import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARENA_WAR_POOL_TREASURY_V2,
  ARENA_WAR_POOL_TREASURY_V2_RUNTIME_HASH,
  assertBattleChainId,
  battlePoolId,
  liveRequested,
  planBattleStake,
  runBattleStake,
} from './t2-battle-stake-evm-real.mjs';

const OWNER_A = '0x1111111111111111111111111111111111111111';
const OWNER_B = '0x2222222222222222222222222222222222222222';

function baseInput(overrides = {}) {
  return {
    chainId: 46630,
    battleId: 'battle-cert-1',
    ownerA: OWNER_A,
    ownerB: OWNER_B,
    stakeAmount: 10n ** 15n,
    now: 1_800_000_000,
    ...overrides,
  };
}

test('46630 attested treasury is accepted and names ETH depositStake', () => {
  const plan = planBattleStake(baseInput(), {});
  assert.equal(plan.mode, 'dry-run');
  assert.equal(plan.chainId, 46630);
  assert.equal(plan.native, 'ETH');
  assert.equal(plan.treasury, ARENA_WAR_POOL_TREASURY_V2);
  assert.equal(plan.runtimeHash, ARENA_WAR_POOL_TREASURY_V2_RUNTIME_HASH);
  assert.equal(plan.poolId, battlePoolId('battle-cert-1'));
  assert.equal(plan.openBattlePool.method, 'openBattlePool');
  assert.equal(plan.depositStake.method, 'depositStake');
  assert.equal(plan.depositStake.value, String(10n ** 15n));
  assert.equal(plan.sendRequired, false);
});

test('production Robinhood chain 4663 throws', () => {
  assert.throws(() => assertBattleChainId(4663), /PRODUCTION_4663_FORBIDDEN/);
  assert.throws(() => planBattleStake(baseInput({ chainId: 4663 }), {}), /PRODUCTION_4663_FORBIDDEN/);
});

test('missing T2_BATTLE_STAKE_LIVE flag never sends', async () => {
  let opens = 0;
  let deposits = 0;
  const result = await runBattleStake({
    env: {},
    plan: planBattleStake(baseInput(), {}),
    sendOpen: async () => {
      opens += 1;
      return { txHash: '0xopen' };
    },
    sendDepositA: async () => {
      deposits += 1;
      return { txHash: '0xa' };
    },
    sendDepositB: async () => {
      deposits += 1;
      return { txHash: '0xb' };
    },
  });
  assert.equal(result.sent, false);
  assert.equal(opens, 0);
  assert.equal(deposits, 0);
  assert.equal(liveRequested({}), false);
});

test('live gate without both owner keys fails closed before send', () => {
  assert.throws(
    () => planBattleStake(baseInput(), { T2_BATTLE_STAKE_LIVE: '1' }),
    /MISSING_OWNER_KEYS/,
  );
  assert.throws(
    () => planBattleStake(baseInput(), {
      T2_BATTLE_STAKE_LIVE: '1',
      T2_BATTLE_OWNER_A_PRIVATE_KEY: '0x' + '11'.repeat(32),
    }),
    /MISSING_OWNER_KEYS/,
  );
});
