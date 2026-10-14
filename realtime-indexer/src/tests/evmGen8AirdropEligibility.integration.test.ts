// Airdrop eligibility over gen-8 rows (founder, 2026-10-12): the trade metrics, the creator metrics and the
// wallet-splitting detector read the netted trades (rewards/leagueLeaderboard.ts gen8NettedCurveTradesSql: one row
// per coin, wallet and transaction with the trader-side amount) and only rows below the chain's money cursor (hybrid
// ingestion); the other detectors keep every raw leg. Gen-7 rows are unchanged. Throwaway Postgres with the gen-5
// columns; same fixtures as the weekly draw's test (frontend/scripts/weekly-airdrop/gen8Netting.db.test.mjs).
import assert from "node:assert/strict";
import test from "node:test";
import { startThrowawayPostgres } from "../../../scripts/dbc/throwaway-postgres.mjs";
import { resetCurveTradeGen5ColumnsCache } from "../evm/curveTradeGen5Columns.js";
import { airdropThresholdsForChain } from "../rewards/airdropThresholds.js";
import type { RewardEpochRecord } from "../rewards/epochs.js";

process.env.DBC_THROWAY_PG_PORT ||= "55445";
process.env.ABLY_API_KEY ||= "test:test";
process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID ||= "Stake11111111111111111111111111111111111111";
// The port is passed explicitly: the static import above has already read DBC_THROWAY_PG_PORT.
const pg = await startThrowawayPostgres({ port: Number(process.env.DBC_THROWAY_PG_PORT), extraFiles: ["db/migrations/20260930_000001_evm_gen5_indexing.sql"] });
// rewards/eligibility.ts opens the indexer pool at import (db.ts reads env.ts), so the env points at the throwaway
// database before the import; the functions under test take the pool they are given.
process.env.DATABASE_URL = pg.url;
process.env.PG_DISABLE_SSL = "1";
const { getCreatorMetricsMap, getTradeMetricsMap, syncAutomaticExclusionFlagsForEpoch } = await import("../rewards/eligibility.js").catch(async (error) => {
  await pg.stop();
  throw error;
});
test.after(async () => {
  const { pool } = await import("../db.js");
  await pool.end().catch(() => {});
  await pg.stop();
});
const db = pg.pool as any;
resetCurveTradeGen5ColumnsCache();

const START = "2026-09-21T00:00:00.000Z";
const END = "2026-09-28T00:00:00.000Z";
const at = (h: number) => new Date(Date.parse(START) + h * 3_600_000).toISOString();
const epoch: RewardEpochRecord = { id: 1, chainId: 56, epochType: "weekly", startAt: START, endAt: END, status: "open", createdAt: START, finalizedAt: null };
const E18 = 10n ** 18n;
const milli = (n: number) => (BigInt(n) * E18) / 1000n;
const HOOK = "0x0000000000000000000000000000000000002aec";
const MONEY_CURSOR = 6000;
const C8 = "0x00000000000000000000000000000000000000b8"; // gen-8 coin
const C7 = "0x00000000000000000000000000000000000000b7"; // gen-7 coin
const CR8 = "0x00000000000000000000000000000000000000d8";
const CR7 = "0x00000000000000000000000000000000000000d7";
const W1 = "0x0000000000000000000000000000000000000001";
const W2 = "0x0000000000000000000000000000000000000002";
const W3 = "0x0000000000000000000000000000000000000003";

await db.query(`
  create table if not exists public.exclusion_flags (
    id bigserial primary key, wallet_address text not null, epoch_id bigint, program text, flag_type text not null,
    severity text not null, details_json jsonb not null default '{}'::jsonb, metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    resolved_at timestamptz, resolved_by text, resolution_note text
  );
`);
await db.query(`insert into public.indexer_state (chain_id, cursor, last_indexed_block) values (56, $1, $2)`, [`gen8-money:${HOOK}`, MONEY_CURSOR]);
await db.query(
  `insert into public.campaigns (chain_id, campaign_address, token_address, creator_address, name, symbol, created_block, created_at_chain)
   values (56, $1, $1, $2, 'Eight', 'EGT', 1, $5), (56, $3, $3, $4, 'Seven', 'SVN', 1, $5)`,
  [C8, CR8, C7, CR7, at(0)],
);
let n = 0;
async function leg(campaign: string, tx: string, block: number, side: "buy" | "sell", wallet: string, amount: bigint, fee: bigint, venue: string | null, hour = 10) {
  n += 1;
  await db.query(
    `insert into public.curve_trades (chain_id, campaign_address, tx_hash, log_index, block_number, block_time, side, wallet, token_amount_raw, bnb_amount_raw, venue, fee_raw, league_excluded)
     values (56, $1, $2, $3, $4, $5, $6, $7, 1, $8, $9, $10, false)`,
    [campaign, tx, n, block, at(hour), side, wallet, amount.toString(), venue, fee.toString()],
  );
}
const tx = (i: number) => `0x${i.toString(16).padStart(64, "0")}`;
// W1: a wash pair in one gen-8 transaction (pays 1.000, receives 0.980) and a gen-7 buy, stored trader-side.
await leg(C8, tx(1), 4000, "buy", W1, milli(980), milli(20), "gen8");
await leg(C8, tx(1), 4000, "sell", W1, milli(1000), milli(20), "gen8");
await leg(C7, tx(2), 4001, "buy", W1, milli(1000), milli(20), null);
// W2: one gen-8 buy (0.510 trader-side) and, in another transaction, one gen-8 sell (0.196).
await leg(C8, tx(3), 4002, "buy", W2, milli(500), milli(10), "gen8");
await leg(C8, tx(4), 4003, "sell", W2, milli(200), milli(4), "gen8");
// W3: a gen-8 buy above the money cursor (not final yet).
await leg(C8, tx(5), MONEY_CURSOR + 3000, "buy", W3, milli(2000), milli(40), "gen8");
// The creator's own legs net to exactly zero in one transaction (pays 1.000, receives 1.000).
await leg(C8, tx(6), 4004, "buy", CR8, milli(980), milli(20), "gen8");
await leg(C8, tx(6), 4004, "sell", CR8, milli(1020), milli(20), "gen8");

test("trade metrics: a wash pair is one net 0.020 trade, a single gen-8 trade is trader-side, the chain head does not count, gen-7 unchanged", async () => {
  const m = await getTradeMetricsMap(db, epoch);
  assert.deepEqual(m.get(W1), { tradeVolumeRaw: milli(1020), tradeCount: 2, activeDays: 1, ownCampaignTradeCount: 0 });
  assert.deepEqual(m.get(W2), { tradeVolumeRaw: milli(706), tradeCount: 2, activeDays: 1, ownCampaignTradeCount: 0 });
  assert.equal(m.get(W3), undefined, "above the money cursor");
  assert.equal(m.get(CR8), undefined, "a zero net leaves no row");
});

test("creator metrics: buy volume and unique buyers over the netted, final rows", async () => {
  const m = await getCreatorMetricsMap(db, epoch, airdropThresholdsForChain(56, 600));
  const c8 = m.get(CR8)!;
  assert.equal(c8.totalBuyVolumeRaw, milli(20) + milli(510), "W1 net 0.020 + W2 0.510; W3's 2.040 is not final");
  assert.equal(c8.maxUniqueBuyers, 2);
  assert.equal(c8.activeCampaignCount, 1);
  const c7 = m.get(CR7)!;
  assert.equal(c7.totalBuyVolumeRaw, milli(1000));
  assert.equal(c7.maxUniqueBuyers, 1);
});

test("wallet splitting reads net volume; self trading and circular trading read every raw leg", async () => {
  const thresholds = airdropThresholdsForChain(56, 600); // trader minimum $150 = 0.25 BNB
  assert.equal(thresholds.traderMinVolume, milli(250));
  const { rows: [r] } = await db.query(`insert into public.recruiters (wallet_address, code) values ('0x00000000000000000000000000000000000000f7', 'split') returning id`);
  const S = (i: number) => `0x${"a".repeat(39)}${i}`;
  for (const i of [1, 2, 3, 4]) {
    await db.query(`insert into public.wallet_recruiter_links (wallet_address, recruiter_id, linked_at) values ($1, $2, $3)`, [S(i), r.id, at(-48)]);
    // Each wallet: one wash pair, 1.980 raw, 0.020 net.
    await leg(C8, tx(10 + i), 4100 + i, "buy", S(i), milli(980), milli(20), "gen8", 11);
    await leg(C8, tx(10 + i), 4100 + i, "sell", S(i), milli(1000), milli(20), "gen8", 11);
  }
  await syncAutomaticExclusionFlagsForEpoch(db, epoch, thresholds);
  const { rows } = await db.query(`select wallet_address, flag_type from public.exclusion_flags where epoch_id = $1 order by flag_type, wallet_address`, [epoch.id]);
  const of = (flag: string) => rows.filter((x: any) => x.flag_type === flag).map((x: any) => x.wallet_address);
  assert.deepEqual(of("WALLET_SPLITTING"), [S(1), S(2), S(3), S(4)], "four linked wallets at 0.020 net each; 1.980 raw would clear the 0.25 floor");
  assert.deepEqual(of("SELF_TRADING"), [CR8], "the creator's zero-net pair is still self trading");
  assert.ok(of("CIRCULAR_TRADING").includes(W1), "both legs of the wash pair are a buy and a sell");
});
