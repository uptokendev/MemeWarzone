import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.ABLY_API_KEY ||= "test:key";
process.env.SOLANA_RPC_HTTP ||= "http://127.0.0.1:8899";

const { referralPaidToUs } = await import("../dbcIndexer.js");
const { accrueDbcFees } = await import("../dbc/dbcFeeAccruals.js");

// Our referral token account on mainnet (WSOL, read 2026-10-07) and a terminal's (6TP3B2e1..., 3 swaps).
const OURS = "AYQNtghqVvzCUHr8Nkuap2Gpe6FZTuB42P7HvTy8K1tS";
const THEIRS = "6TP3B2e1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const tx = (...keys: string[]) => ({ transaction: { message: { accountKeys: keys } }, meta: {} });

test("a swap paid our referral only when our referral token account is in the transaction", () => {
  assert.equal(referralPaidToUs(tx("payer", OURS, "pool"), [OURS]), true);
  assert.equal(referralPaidToUs(tx("payer", THEIRS, "pool"), [OURS]), false);
  // No accounts configured on this indexer: unknown, never assumed ours.
  assert.equal(referralPaidToUs(tx("payer", OURS), []), null);
});

function fakeDb(meta: Record<string, unknown>) {
  const inserts: unknown[][] = [];
  let ddl = 0;
  return {
    inserts,
    get ddl() { return ddl; },
    async query(sql: string, params: unknown[] = []) {
      if (/alter table public\.dbc_fee_accruals add column if not exists referral_ours/.test(sql)) { ddl += 1; return { rows: [] }; }
      if (/count\(\*\)::int as n/.test(sql)) return { rows: [{ n: 0 }] };
      if (/from public\.curve_trades t\s+join public\.activity_events/.test(sql)) {
        return { rows: [{ campaign_address: "Pool1", tx_hash: "sig1", log_index: 0, wallet: "W1", block_number: 1, block_time: new Date("2026-10-07T12:00:00Z"), activity_meta: meta, campaign_meta: {} }] };
      }
      if (/insert into public\.dbc_fee_accruals/.test(sql)) { inserts.push(params); return { rows: [], rowCount: 1 }; }
      if (/public\.epochs/.test(sql)) return { rows: [{ id: 1, chain_id: 101, epoch_type: "weekly", start_at: "2026-10-05T00:00:00Z", end_at: "2026-10-12T00:00:00Z", status: "open", created_at: "2026-10-05T00:00:00Z" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

for (const [label, metaOurs, expected] of [
  ["paid to us", true, true],
  ["paid to a terminal", false, false],
  ["recorded before this change", undefined, null],
] as const) {
  test(`accrual stores referral_ours (${label})`, async () => {
    const meta: Record<string, unknown> = { trading_fee: "8000", protocol_fee: "1600", referral_fee: "400" };
    if (metaOurs !== undefined) meta.referral_ours = metaOurs;
    const db = fakeDb(meta);
    await accrueDbcFees(db as any);
    assert.ok(db.inserts.length >= 1, "accrual row written");
    assert.equal(db.inserts[0][17], expected);
  });
}

test("no referral fee means not ours, whatever the meta says", async () => {
  const db = fakeDb({ trading_fee: "8000", protocol_fee: "1600", referral_fee: "0", referral_ours: true });
  await accrueDbcFees(db as any);
  assert.equal(db.inserts[0][17], false);
});
