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

test('readInventory reports upvote treasury missing even when V3 stack is present', async () => {
  const codes = Object.fromEntries(
    Object.entries(IDENTITIES).map(([name, ident]) => [ident.address.toLowerCase(), '0x' + name]),
  );
  const report = await readInventory({
    chainId: 46630,
    getCode: async (address) => {
      const code = codes[address.toLowerCase()];
      return `0x${Buffer.from(code).toString('hex')}`;
    },
  });
  // hashes will mismatch dummy code → INCOMPLETE is fine; upvote is always MISSING
  assert.equal(report.upvoteTreasury.verdict, 'MISSING');
  assert.equal(report.upvoteTreasury.hasCode, false);
  assert.equal(report.chainId, 46630);
});
