import test from 'node:test';
import assert from 'node:assert/strict';
import { splitLeagueGross, validateMwlProvenance, insertMwlProvenance } from './arenaMwlFinancialProvenance.mjs';

const bsc = {
  chainId: 97,
  txHash: `0x${'11'.repeat(32)}`,
  sourceId: `0x${'22'.repeat(32)}`,
  sourceKind: 'competition',
  authorityAddress: `0x${'33'.repeat(20)}`,
  eventIndex: 4,
  grossAmount: '1001',
  monthlyAmount: '600',
  quarterlyAmount: '401',
};

const sol = {
  chainId: 101,
  txHash: '5fakesignaturebutnonempty',
  sourceId: 'source-pool-id',
  sourceKind: 'competition',
  authorityAddress: 'ArenaMoneyProgram11111111111111111111111111111',
  receiptAddress: 'LeagueReceiptPda1111111111111111111111111111',
  grossAmount: '1001',
  monthlyAmount: '600',
  quarterlyAmount: '401',
};

test('split is exact 60/40 with remainder assigned quarterly', () => {
  assert.deepEqual(splitLeagueGross('1001'), { gross: 1001n, monthly: 600n, quarterly: 401n });
});

test('validates BSC and Solana canonical chain ids', () => {
  assert.equal(validateMwlProvenance(bsc).chainId, 97);
  assert.equal(validateMwlProvenance(sol).chainId, 101);
  assert.throws(() => validateMwlProvenance({ ...bsc, chainId: 56 }), /MWL_CHAIN_UNSUPPORTED/);
});

test('rejects wrong amount and wrong split', () => {
  assert.throws(() => validateMwlProvenance({ ...bsc, monthlyAmount: '599', quarterlyAmount: '402' }), /MWL_60_40_MISMATCH/);
  assert.throws(() => validateMwlProvenance({ ...bsc, quarterlyAmount: '400' }), /MWL_GROSS_SPLIT_MISMATCH/);
});

test('rejects BSC wrong source or event identity', () => {
  assert.throws(() => validateMwlProvenance({ ...bsc, sourceId: 'bad' }), /MWL_BSC_SOURCE_INVALID/);
  assert.throws(() => validateMwlProvenance({ ...bsc, eventIndex: -1 }), /MWL_BSC_EVENT_INDEX_INVALID/);
});

test('rejects Solana missing receipt or wrong source kind', () => {
  assert.throws(() => validateMwlProvenance({ ...sol, receiptAddress: '' }), /MWL_SOLANA_RECEIPT_REQUIRED/);
  assert.throws(() => validateMwlProvenance({ ...sol, sourceKind: 'bonus' }), /MWL_SOLANA_SOURCE_KIND_INVALID/);
});

test('retry returns existing identical row and does not duplicate', async () => {
  const existing = {
    source_id: bsc.sourceId,
    gross_amount_wei: bsc.grossAmount,
    monthly_amount_wei: bsc.monthlyAmount,
    quarterly_amount_wei: bsc.quarterlyAmount,
  };
  let calls = 0;
  const db = {
    async query(sql) {
      calls += 1;
      if (sql.includes('insert into')) return { rows: [] };
      return { rows: [existing] };
    },
  };
  const out = await insertMwlProvenance(db, bsc);
  assert.equal(out.inserted, false);
  assert.equal(calls, 2);
});

test('replay with same tx but different source is rejected', async () => {
  const db = {
    async query(sql) {
      if (sql.includes('insert into')) return { rows: [] };
      return { rows: [{ source_id: `0x${'44'.repeat(32)}`, gross_amount_wei: '1001', monthly_amount_wei: '600', quarterly_amount_wei: '401' }] };
    },
  };
  await assert.rejects(() => insertMwlProvenance(db, bsc), /MWL_REPLAY_SOURCE_MISMATCH/);
});

test('replay with same tx but different amount is rejected', async () => {
  const db = {
    async query(sql) {
      if (sql.includes('insert into')) return { rows: [] };
      return { rows: [{ source_id: bsc.sourceId, gross_amount_wei: '999', monthly_amount_wei: '599', quarterly_amount_wei: '400' }] };
    },
  };
  await assert.rejects(() => insertMwlProvenance(db, bsc), /MWL_REPLAY_AMOUNT_MISMATCH/);
});
