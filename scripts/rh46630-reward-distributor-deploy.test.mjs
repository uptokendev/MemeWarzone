import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OWNER,
  assertChainId,
  planRewardDistributorDeploy,
  runRewardDistributorDeploy,
} from './rh46630-reward-distributor-deploy.mjs';

test('46630 dry-run names owner and does not send', () => {
  const plan = planRewardDistributorDeploy({ chainId: 46630 }, {});
  assert.equal(plan.mode, 'dry-run');
  assert.equal(plan.constructor.initialOwner, OWNER);
  assert.equal(plan.sendRequired, false);
});

test('production 4663 throws', () => {
  assert.throws(() => assertChainId(4663), /PRODUCTION_4663_FORBIDDEN/);
  assert.throws(() => planRewardDistributorDeploy({ chainId: 4663 }, {}), /PRODUCTION_4663_FORBIDDEN/);
});

test('missing live flag never deploys', async () => {
  let sent = 0;
  const result = await runRewardDistributorDeploy({
    plan: planRewardDistributorDeploy({}, {}),
    sendDeploy: async () => {
      sent += 1;
      return { address: '0x1111111111111111111111111111111111111111' };
    },
  });
  assert.equal(result.sent, false);
  assert.equal(sent, 0);
});
