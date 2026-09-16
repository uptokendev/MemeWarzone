import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FEE_RECEIVER,
  OWNER,
  assertChainId,
  planUpvoteTreasuryDeploy,
  runUpvoteTreasuryDeploy,
} from './rh46630-upvote-treasury-deploy.mjs';

test('46630 dry-run names owner and ProtocolRevenueVault feeReceiver', () => {
  const plan = planUpvoteTreasuryDeploy({ chainId: 46630 }, {});
  assert.equal(plan.mode, 'dry-run');
  assert.equal(plan.constructor.initialOwner, OWNER);
  assert.equal(plan.constructor.initialFeeReceiver, FEE_RECEIVER);
  assert.equal(plan.sendRequired, false);
});

test('production 4663 throws', () => {
  assert.throws(() => assertChainId(4663), /PRODUCTION_4663_FORBIDDEN/);
  assert.throws(() => planUpvoteTreasuryDeploy({ chainId: 4663 }, {}), /PRODUCTION_4663_FORBIDDEN/);
});

test('missing live flag never deploys', async () => {
  let sent = 0;
  const result = await runUpvoteTreasuryDeploy({
    plan: planUpvoteTreasuryDeploy({}, {}),
    sendDeploy: async () => {
      sent += 1;
      return { address: '0x1111111111111111111111111111111111111111' };
    },
  });
  assert.equal(result.sent, false);
  assert.equal(result.address, null);
  assert.equal(sent, 0);
});
