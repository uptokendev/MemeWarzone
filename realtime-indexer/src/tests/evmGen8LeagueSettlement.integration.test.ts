// EVM generation 8 rows in league settlement (step 4, 2026-10-11): curve_trades rows with venue 'gen8' store the
// curve amount (fee excluded), so top_earner and biggest_hit compare trader-side amounts (buy curve + fee, sell
// curve - fee), and gen-8 rows marked league_excluded (creator, escrow, launcher first buy, creator-choice vault
// buyback) count for no trader league. Same fixtures and figures as the API's live board test
// (frontend/api/evmGen8.db.test.mjs): shown = paid. Gen-7 rows are unchanged; without the gen-5 columns the SQL is
// the pre-gen-8 text.
import assert from "node:assert/strict";
import test from "node:test";
import { startThrowawayPostgres } from "../../../scripts/dbc/throwaway-postgres.mjs";
import { leagueLeaderboard } from "../rewards/leagueLeaderboard.js";
import { resetCurveTradeGen5ColumnsCache } from "../evm/curveTradeGen5Columns.js";

process.env.DBC_THROWAY_PG_PORT ||= "55444";
const pg = await startThrowawayPostgres({ extraFiles: ["db/migrations/20260930_000001_evm_gen5_indexing.sql"] });
test.after(async () => {
  await pg.stop();
});
const db = pg.pool as any;
resetCurveTradeGen5ColumnsCache();
await db.query(`alter table public.campaigns add column if not exists fee_recipient_address text`);

const CHAIN = 97;
const E18 = 10n ** 18n;
const milli = (n: number) => (BigInt(n) * E18) / 1000n;
const G7 = "0x00000000000000000000000000000000000000a7";
const G8 = "0x00000000000000000000000000000000000000a8";
const CREATOR7 = "0x00000000000000000000000000000000000000d7";
const CREATOR8 = "0x00000000000000000000000000000000000000d8";
const W1 = "0x0000000000000000000000000000000000000001";
const W2 = "0x0000000000000000000000000000000000000002";
const W3 = "0x0000000000000000000000000000000000000003";
const OPERATOR = "0x00000000000000000000000000000000000000f0";
const start = new Date(Date.now() - 4 * 86_400_000).toISOString();
const end = new Date(Date.now() + 86_400_000).toISOString();
const at = (h: number) => new Date(Date.now() - 3 * 86_400_000 + h * 3_600_000).toISOString();

await db.query(
  `insert into public.campaigns (chain_id, campaign_address, token_address, creator_address, name, symbol, created_block, created_at_chain)
   values ($1, $2, $2, $3, 'Seven', 'SVN', 1, $5), ($1, $4, $4, $6, 'Eight', 'EGT', 2, $5)`,
  [CHAIN, G7, CREATOR7, G8, at(0), CREATOR8],
);
let n = 0;
async function trade(campaign: string, wallet: string, side: string, amount: bigint, fee: bigint, hour: number, o: { venue?: string | null; excluded?: boolean } = {}) {
  n += 1;
  await db.query(
    `insert into public.curve_trades (chain_id, campaign_address, tx_hash, log_index, block_number, block_time, side, wallet, token_amount_raw, bnb_amount_raw, venue, fee_raw, league_excluded)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, $11, $12)`,
    [CHAIN, campaign, `0x${n.toString(16).padStart(64, "0")}`, n, 100 + n, at(hour), side, wallet, amount.toString(), o.venue ?? null, fee.toString(), o.excluded ?? false],
  );
}
await trade(G7, W1, "buy", milli(1020), milli(20), 1);
await trade(G7, W1, "sell", milli(490), milli(10), 2);
const g8 = { venue: "gen8" };
await trade(G8, CREATOR8, "buy", milli(100), milli(2), 10, { ...g8, excluded: true });
await trade(G8, W1, "buy", milli(1200), milli(24), 11, g8);
await trade(G8, W2, "buy", milli(500), milli(450), 12, g8);
await trade(G8, W1, "sell", milli(300), milli(6), 13, g8);
await trade(G8, OPERATOR, "buy", milli(200), milli(4), 14, { ...g8, excluded: true });
await trade(G8, W3, "buy", milli(100), milli(2), 15, g8);
await trade(G8, W3, "sell", milli(200), milli(4), 16, g8);

test("top_earner settlement: gen-8 trader-side PnL, the buyback wallet out; the API board's figures", async () => {
  const rows = await leagueLeaderboard(db, CHAIN, start, end, "top_earner", 10);
  const by = Object.fromEntries(rows.map((r) => [r.recipient, r.score]));
  assert.equal(by[W3], milli(196) - milli(102));
  assert.equal(by[W1], milli(490) - milli(1020) + milli(294) - milli(1224));
  assert.equal(by[W2], -milli(950), "a launch-window buy costs curve + 90% fee");
  assert.equal(by[OPERATOR], undefined);
  assert.equal(by[CREATOR8], undefined);
});

test("biggest_hit settlement: gen-8 buy = curve + fee; gen-7 unchanged", async () => {
  const rows = await leagueLeaderboard(db, CHAIN, start, end, "biggest_hit", 10);
  const by = Object.fromEntries(rows.map((r) => [r.meta.campaign_address, r]));
  assert.equal(by[G8].recipient, W1);
  assert.equal(by[G8].score, milli(1224));
  assert.equal(by[G7].score, milli(1020));
});
