import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXPECTED_UPDATER,
  assertUpdaterIdentity,
  parseHonestPrice,
  planOracleFreshnessGate,
  validateRefreshedSnapshot,
} from './rh46630-oracle-freshness-gate.mjs';

test('fresh oracle requires no refresh transaction and lifecycle may continue', () => {
  assert.deepEqual(
    planOracleFreshnessGate({ latestTimestamp: 10_000n, updatedAt: 9_500n }),
    { age: 500n, refreshTxCount: 0, lifecycleMayContinueAfterGate: true },
  );
});

test('stale oracle requires exactly one refresh then lifecycle may continue', () => {
  assert.deepEqual(
    planOracleFreshnessGate({ latestTimestamp: 10_000n, updatedAt: 9_100n }),
    { age: 900n, refreshTxCount: 1, lifecycleMayContinueAfterGate: true },
  );
  assert.deepEqual(
    validateRefreshedSnapshot({
      beforeUpdatedAt: 9_100n,
      afterUpdatedAt: 10_001n,
      afterAnswer: 251000000000n,
      decimals: 8,
      latestTimestamp: 10_010n,
      receiptStatus: 1,
    }),
    { age: 9n, needsRefresh: false },
  );
});

test('bad updater fails closed', () => {
  assert.throws(
    () => assertUpdaterIdentity({ signerAddress: '0x0000000000000000000000000000000000000001', onchainUpdater: EXPECTED_UPDATER }),
    /ORACLE_UPDATER_SIGNER_MISMATCH/,
  );
});

test('bad or zero operator price fails closed', () => {
  assert.throws(() => parseHonestPrice('0'), /ORACLE_PRICE_MUST_BE_POSITIVE/);
  assert.throws(() => parseHonestPrice('not-a-price'), /ORACLE_PRICE_MUST_BE_POSITIVE_INTEGER/);
});

test('mined refresh that remains stale fails closed', () => {
  assert.throws(
    () => validateRefreshedSnapshot({
      beforeUpdatedAt: 8_000n,
      afterUpdatedAt: 8_100n,
      afterAnswer: 251000000000n,
      decimals: 8,
      latestTimestamp: 9_000n,
      receiptStatus: 1,
    }),
    /ORACLE_REFRESH_STILL_STALE_900/,
  );
});
