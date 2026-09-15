import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyCreatorEligibility, chooseLifecycleAction } from './rh46630-zero-write-preflight.mjs';

const now = 1_000_000n;

test('eligible fresh creator may CREATE when no resumable campaign exists', () => {
  const result = classifyCreatorEligibility({ allowed: true, restricted: false, manualReviewRequired: false, lastLaunchTimestamp: 0n, cooldownSeconds: 86400n, liveBondingCount: 0n, maxLiveBonding: 3n, now });
  assert.equal(result.reason, 'ELIGIBLE');
  assert.deepEqual(chooseLifecycleAction({ creatorAllowed: true, existingCampaign: { resumable: false } }), { mode: 'CREATE_NEW', resumeExistingCampaign: false, createRequired: true, resumeStep: 'CREATE' });
});

test('liveBondingCount cap reached classifies LIVE_COUNT and fails CREATE closed', () => {
  const result = classifyCreatorEligibility({ allowed: false, restricted: false, manualReviewRequired: false, lastLaunchTimestamp: 0n, cooldownSeconds: 86400n, liveBondingCount: 3n, maxLiveBonding: 3n, now });
  assert.equal(result.reason, 'LIVE_COUNT');
  assert.throws(() => chooseLifecycleAction({ creatorAllowed: false, existingCampaign: { resumable: false } }), /CREATE_REQUIRED_BUT_CREATOR_NOT_ELIGIBLE/);
});

test('active cooldown classifies COOLDOWN', () => {
  const result = classifyCreatorEligibility({ allowed: false, restricted: false, manualReviewRequired: false, lastLaunchTimestamp: now - 100n, cooldownSeconds: 86400n, liveBondingCount: 1n, maxLiveBonding: 3n, now });
  assert.equal(result.reason, 'COOLDOWN');
  assert.equal(result.cooldownEndsAt, now - 100n + 86400n);
});

test('restricted creator classifies RESTRICTED before other gates', () => {
  const result = classifyCreatorEligibility({ allowed: false, restricted: true, manualReviewRequired: false, lastLaunchTimestamp: now - 100n, cooldownSeconds: 86400n, liveBondingCount: 3n, maxLiveBonding: 3n, now });
  assert.equal(result.reason, 'RESTRICTED');
});

test('manual review classifies REVIEW', () => {
  const result = classifyCreatorEligibility({ allowed: false, restricted: false, manualReviewRequired: true, lastLaunchTimestamp: 0n, cooldownSeconds: 86400n, liveBondingCount: 0n, maxLiveBonding: 3n, now });
  assert.equal(result.reason, 'REVIEW');
});

test('existing healthy campaign is resumed even when new CREATE is currently ineligible', () => {
  assert.deepEqual(
    chooseLifecycleAction({ creatorAllowed: false, existingCampaign: { resumable: true, resumeStep: 'BUY_SELL_THEN_BOND_TO_GRADUATION' } }),
    { mode: 'RESUME_EXISTING', resumeExistingCampaign: true, createRequired: false, resumeStep: 'BUY_SELL_THEN_BOND_TO_GRADUATION' }
  );
});
