import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WEEKLY_LEAGUE_VAULT,
  assertChainId,
  liveRequested,
  planLeagueReceivers,
  runLeagueReceivers,
} from './rh46630-league-v2-set-receivers.mjs';

const DEPLOYER = '0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714';

test('46630 dry-run proposes weekly TreasuryVaultV2 for both receivers', () => {
  const plan = planLeagueReceivers({
    chainId: 46630,
    monthlyReceiver: DEPLOYER,
    quarterlyReceiver: DEPLOYER,
  }, {});
  assert.equal(plan.mode, 'dry-run');
  assert.equal(plan.proposed.monthlyReceiver, WEEKLY_LEAGUE_VAULT);
  assert.equal(plan.proposed.quarterlyReceiver, WEEKLY_LEAGUE_VAULT);
  assert.equal(plan.sendRequired, false);
  assert.equal(plan.matches.all, false);
});

test('production 4663 throws', () => {
  assert.throws(() => assertChainId(4663), /PRODUCTION_4663_FORBIDDEN/);
  assert.throws(() => planLeagueReceivers({ chainId: 4663, monthlyReceiver: DEPLOYER, quarterlyReceiver: DEPLOYER }, {}), /PRODUCTION_4663_FORBIDDEN/);
});

test('missing live flag never sends', async () => {
  let sent = 0;
  const result = await runLeagueReceivers({
    plan: planLeagueReceivers({ chainId: 46630, monthlyReceiver: DEPLOYER, quarterlyReceiver: DEPLOYER }, {}),
    sendSetReceivers: async () => { sent += 1; return { txHash: '0x1' }; },
  });
  assert.equal(result.sent, false);
  assert.equal(sent, 0);
  assert.equal(liveRequested({}), false);
});

test('already matching receivers is a no-op even when live-gated', async () => {
  let sent = 0;
  const plan = planLeagueReceivers({
    chainId: 46630,
    monthlyReceiver: WEEKLY_LEAGUE_VAULT,
    quarterlyReceiver: WEEKLY_LEAGUE_VAULT,
  }, { RH46630_LEAGUE_SET_RECEIVERS: '1' });
  assert.equal(plan.sendRequired, false);
  const result = await runLeagueReceivers({
    plan,
    sendSetReceivers: async () => { sent += 1; return { txHash: '0x1' }; },
  });
  assert.equal(result.sent, false);
  assert.equal(sent, 0);
});
