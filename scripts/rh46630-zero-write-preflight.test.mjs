import assert from 'node:assert/strict';
import test from 'node:test';
import { ethers } from 'ethers';
import {
  assessLaunchProtection,
  chooseLifecycleAction,
  classifyCreatorEligibility,
  computeFirstBuyValue,
  computeNativeTargetFromUsd,
  decodeRevertData,
} from './rh46630-zero-write-preflight.mjs';

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

test('native target math matches GraduationOracle ceiling behavior and first BUY sizing', () => {
  const target = computeNativeTargetFromUsd(ethers.parseEther('6'), 243893000000n, 8);
  assert.equal(target, 2_460_095_205_684_460n);
  assert.equal(computeFirstBuyValue(target), 492_019_041_136_892n);
});

test('pending launch protection applies to the exact next BUY and detects buy/wallet limits', () => {
  const result = assessLaunchProtection({
    blockNumber: 100n,
    endBlock: 0n,
    pendingBlocks: 20n,
    maxBuyWei: 100n,
    maxWalletWei: 150n,
    protectedBuyWei: 80n,
    costNoFee: 101n,
  });
  assert.equal(result.currentlyActive, false);
  assert.equal(result.willActivateOnNextBuy, true);
  assert.equal(result.appliesToNextBuy, true);
  assert.equal(result.effectiveEndBlock, 120n);
  assert.equal(result.proposedWalletProtectedWei, 181n);
  assert.equal(result.buyLimitExceeded, true);
  assert.equal(result.walletLimitExceeded, true);
});

test('decoder identifies LaunchCampaign and RiskRegistry custom errors', () => {
  const campaignIface = new ethers.Interface(['error LaunchProtectionBuyLimit()', 'error BadRouteAuth()']);
  const riskIface = new ethers.Interface(['error WalletRestricted()', 'error ClusterRestricted()']);
  const decoders = [{ scope: 'LaunchCampaign', iface: campaignIface }, { scope: 'RiskRegistry', iface: riskIface }];

  const launchDecoded = decodeRevertData(campaignIface.encodeErrorResult('LaunchProtectionBuyLimit'), decoders);
  assert.equal(launchDecoded.scope, 'LaunchCampaign');
  assert.equal(launchDecoded.decodedErrorName, 'LaunchProtectionBuyLimit');
  assert.equal(launchDecoded.selector, campaignIface.getError('LaunchProtectionBuyLimit').selector.toLowerCase());

  const riskDecoded = decodeRevertData(riskIface.encodeErrorResult('ClusterRestricted'), decoders);
  assert.equal(riskDecoded.scope, 'RiskRegistry');
  assert.equal(riskDecoded.decodedErrorName, 'ClusterRestricted');
});

test('decoder handles Solidity Error(string) alongside custom errors', () => {
  const payload = `0x08c379a0${ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['routing paused']).slice(2)}`;
  const decoded = decodeRevertData(payload, []);
  assert.equal(decoded.decodedErrorName, 'Error');
  assert.equal(decoded.decodedArguments[0].value, 'routing paused');
});
