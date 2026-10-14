// Weekly airdrop candidates over gen-8 rows (founder, 2026-10-12): traderCandidates and creatorCandidates read the
// netted trades (api/lib/evmGen8LeagueSql.js: one row per coin, wallet and transaction with the trader-side amount)
// and only rows below the chain's gen-8 money cursor (the draw pays money). Gen-7 rows are unchanged, and a database
// without the gen-5 columns reads the plain table exactly as before. Throwaway Postgres with the gen-5 columns; same
// fixtures as the indexer's eligibility test (realtime-indexer/src/tests/evmGen8AirdropEligibility.integration.test.ts).
import assert from "node:assert/strict";
import test from "node:test";
import { creatorCandidates, traderCandidates } from "./candidates.mjs";

process.env.DBC_THROWAY_PG_PORT ||= "55447";
process.env.AIRDROP_TRADER_MIN_TRADES = "1";
process.env.AIRDROP_TRADER_MIN_ACTIVE_DAYS = "1";
const { startThrowawayPostgres } = await import("../../../scripts/dbc/throwaway-postgres.mjs");
const pg = await startThrowawayPostgres({ extraFiles: ["db/migrations/20260930_000001_evm_gen5_indexing.sql"] });
test.after(async () => {
  await pg.stop();
});
const db = pg.pool;
await db.query(`
  create table if not exists public.campaign_security_states (campaign_address text primary key, paused boolean not null default false, buy_paused boolean not null default false);
  create table if not exists public.wallet_risk_profiles (wallet_address text primary key, restricted boolean not null default false, cluster_id text, risk_level text);
`);

const START = new Date("2026-09-21T00:00:00Z");
const END = new Date("2026-09-28T00:00:00Z");
const at = (h) => new Date(START.getTime() + h * 3_600_000).toISOString();
const E18 = 10n ** 18n;
const milli = (n) => (BigInt(n) * E18) / 1000n;
const HOOK = "0x0000000000000000000000000000000000002aec";
const MONEY_CURSOR = 6000;
const C8 = "0x00000000000000000000000000000000000000b8"; // gen-8 coin
const C7 = "0x00000000000000000000000000000000000000b7"; // gen-7 coin
const CR8 = "0x00000000000000000000000000000000000000d8";
const CR7 = "0x00000000000000000000000000000000000000d7";
const W1 = "0x0000000000000000000000000000000000000001";
const W2 = "0x0000000000000000000000000000000000000002";
const W3 = "0x0000000000000000000000000000000000000003";
// Floors of 1 wei so every fixture wallet is a candidate; the caps are far above the fixtures.
const thresholds = { nativeUsd: 600, traderMinRaw: 1n, traderCapRaw: 10n ** 21n, traderCapScore: 15, creatorMinRaw: 1n, creatorCapRaw: 10n ** 21n, creatorCapScore: 25, creatorMinUniqueBuyers: 1 };
const args = { chainId: 56, start: START, end: END, exclusions: { all: new Set() }, thresholds };

await db.query(`insert into public.indexer_state (chain_id, cursor, last_indexed_block) values (56, $1, $2)`, [`gen8-money:${HOOK}`, MONEY_CURSOR]);
await db.query(
  `insert into public.campaigns (chain_id, campaign_address, token_address, creator_address, name, symbol, created_block, created_at_chain)
   values (56, $1, $1, $2, 'Eight', 'EGT', 1, $5), (56, $3, $3, $4, 'Seven', 'SVN', 1, $5)`,
  [C8, CR8, C7, CR7, at(0)],
);
let n = 0;
async function leg(campaign, tx, block, side, wallet, amount, fee, venue) {
  n += 1;
  await db.query(
    `insert into public.curve_trades (chain_id, campaign_address, tx_hash, log_index, block_number, block_time, side, wallet, token_amount_raw, bnb_amount_raw, venue, fee_raw, league_excluded)
     values (56, $1, $2, $3, $4, $5, $6, $7, 1, $8, $9, $10, false)`,
    [campaign, tx, n, block, at(10), side, wallet, amount.toString(), venue, fee.toString()],
  );
}
const tx = (i) => `0x${i.toString(16).padStart(64, "0")}`;
// W1: a wash pair in one gen-8 transaction (pays 1.000, receives 0.980) and a gen-7 buy, stored trader-side.
await leg(C8, tx(1), 4000, "buy", W1, milli(980), milli(20), "gen8");
await leg(C8, tx(1), 4000, "sell", W1, milli(1000), milli(20), "gen8");
await leg(C7, tx(2), 4001, "buy", W1, milli(1000), milli(20), null);
// W2: one gen-8 buy (0.510 trader-side) and, in another transaction, one gen-8 sell (0.196).
await leg(C8, tx(3), 4002, "buy", W2, milli(500), milli(10), "gen8");
await leg(C8, tx(4), 4003, "sell", W2, milli(200), milli(4), "gen8");
// W3: a gen-8 buy above the money cursor (not final yet).
await leg(C8, tx(5), MONEY_CURSOR + 3000, "buy", W3, milli(2000), milli(40), "gen8");
// The creator's own legs (never a candidate's volume) net to exactly zero in one transaction.
await leg(C8, tx(6), 4004, "buy", CR8, milli(980), milli(20), "gen8");
await leg(C8, tx(6), 4004, "sell", CR8, milli(1020), milli(20), "gen8");

test("traders: a wash pair is one net 0.020 trade, a single gen-8 trade is trader-side, the chain head does not count, gen-7 unchanged", async () => {
  const rows = await traderCandidates(db, args);
  const by = Object.fromEntries(rows.map((r) => [r.walletAddress, r]));
  assert.equal(by[W1].totalVolumeRaw, milli(1020).toString(), "gen-7 1.000 + gen-8 net 0.020");
  assert.equal(by[W1].tradeCount, 2);
  assert.equal(by[W1].campaignCount, 2);
  assert.equal(by[W2].totalVolumeRaw, milli(706).toString(), "0.510 buy + 0.196 sell, trader-side");
  assert.equal(by[W2].tradeCount, 2);
  assert.equal(by[W3], undefined, "above the money cursor");
  assert.equal(by[CR8], undefined);
});

test("creators: qualified buy volume and unique buyers over the netted, final rows", async () => {
  const rows = await creatorCandidates(db, args);
  const by = Object.fromEntries(rows.map((r) => [r.walletAddress, r]));
  assert.equal(by[CR8].totalVolumeRaw, (milli(20) + milli(510)).toString(), "W1 net 0.020 + W2 0.510; W3's 2.040 is not final");
  assert.equal(by[CR8].uniqueBuyers, 2);
  assert.equal(by[CR7].totalVolumeRaw, milli(1000).toString());
  assert.equal(by[CR7].uniqueBuyers, 1);
});

test("no money cursor: no gen-8 row is final, gen-7 as before", async () => {
  await db.query(`delete from public.indexer_state where chain_id = 56 and cursor like 'gen8-money:%'`);
  try {
    const rows = await traderCandidates(db, args);
    const by = Object.fromEntries(rows.map((r) => [r.walletAddress, r]));
    assert.equal(by[W1].totalVolumeRaw, milli(1000).toString(), "only the gen-7 buy");
    assert.equal(by[W1].tradeCount, 1);
    assert.equal(by[W2], undefined);
  } finally {
    await db.query(`insert into public.indexer_state (chain_id, cursor, last_indexed_block) values (56, $1, $2)`, [`gen8-money:${HOOK}`, MONEY_CURSOR]);
  }
});

test("without the gen-5 columns the plain table is read exactly as before: every leg, raw amounts, chain head included", async () => {
  // The probe sees no columns, every other query runs against the real database.
  const plain = { query: (sql, params) => (sql.includes("information_schema.columns") ? Promise.resolve({ rows: [] }) : db.query(sql, params)) };
  const rows = await traderCandidates(plain, args);
  const by = Object.fromEntries(rows.map((r) => [r.walletAddress, r]));
  assert.equal(by[W1].totalVolumeRaw, (milli(980) + milli(1000) + milli(1000)).toString());
  assert.equal(by[W1].tradeCount, 3);
  assert.equal(by[W3].totalVolumeRaw, milli(2000).toString());
});
