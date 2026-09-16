import assert from 'node:assert/strict';
import test from 'node:test';
import { ethers } from 'ethers';

import {
  IDENTITIES,
  assertChainId,
  classifyCode,
  readInventory,
} from './rh46630-v3-identity-inventory.mjs';

test('production 4663 throws', () => {
  assert.throws(() => assertChainId(4663), /PRODUCTION_4663_FORBIDDEN/);
});

test('empty bytecode is MISSING', () => {
  const row = classifyCode('0x', IDENTITIES.weth.runtimeHash);
  assert.equal(row.verdict, 'MISSING');
  assert.equal(row.hasCode, false);
});

test('matching runtime hash is PRESENT', () => {
  const code = '0x1234';
  const row = classifyCode(code, ethers.keccak256(code));
  assert.equal(row.verdict, 'PRESENT');
  assert.equal(row.hasCode, true);
});

test('readInventory includes UPVoteTreasury identity', async () => {
  assert.equal(IDENTITIES.upvoteTreasury.address, '0x670256a51020477e4E96d7D7a94ac1783F1B1789');
  const report = await readInventory({
    chainId: 46630,
    getCode: async () => '0x',
  });
  assert.equal(report.upvoteTreasury.address, IDENTITIES.upvoteTreasury.address);
  assert.equal(report.upvoteTreasury.verdict, 'MISSING');
  assert.equal(report.chainId, 46630);
});
