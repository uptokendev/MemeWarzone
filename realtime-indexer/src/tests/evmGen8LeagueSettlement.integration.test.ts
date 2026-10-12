// EVM generation 8 rows in league settlement (step 4, 2026-10-11): curve_trades rows with venue 'gen8' store the
// curve amount (fee excluded), so top_earner and biggest_hit compare trader-side amounts (buy curve + fee, sell
// curve - fee), and gen-8 rows marked league_excluded (creator, escrow, launcher first buy, creator-choice vault
// buyback) count for no trader league. Same fixtures and figures as the API's live board test
// (frontend/api/evmGen8.db.test.mjs): shown = paid. Gen-7 rows are unchanged; without the gen-5 columns the SQL is
// the pre-gen-8 text. Hybrid ingestion (2026-10-12): settlement counts a gen-8 row only below the chain's money cursor
// (indexer_state 'gen8-money:<hook>'), so the fixtures carry one; the board shows the chain head.
import assert from "node:assert/strict";
import test from "node:test";
import { startThrowawayPostgres } from "../../../scripts/dbc/throwaway-postgres.mjs";
import { gen8MoneySafeSql, gen8NettedCurveTradesSql, leagueLeaderboard } from "../rewards/leagueLeaderboard.js";
import { recruiterLeagueStandings } from "../rewards/recruiterLeague.js";
import { resetCurveTradeGen5ColumnsCache } from "../evm/curveTradeGen5Columns.js";

process.env.DBC_THROWAY_PG_PORT ||= "55444";
const pg = await startThrowawayPostgres({ extraFiles: ["db/migrations/20260930_000001_evm_gen5_indexing.sql"] });
test.after(async () => {
  await pg.stop();
});
const db = pg.pool as any;
resetCurveTradeGen5ColumnsCache();
await db.query(`alter table public.campaigns add column if not exists fee_recipient_address text`);
// Money cursor per chain (one hook per chain): rows below block 6000 are final. The recruiter league tables as in
// hiddenTestCoinLeagues.integration.test.ts.
const HOOK = "0x0000000000000000000000000000000000002aec";
const MONEY_CURSOR = 6000;
await db.query(`insert into public.indexer_state (chain_id, cursor, last_indexed_block) values (97, $1, $2), (56, $1, $2)`, [`gen8-money:${HOOK}`, MONEY_CURSOR]);
await db.query(`
  alter table public.recruiters add column if not exists metadata jsonb not null default '{}'::jsonb;
  create table if not exists public.wallet_squad_memberships (
    recruiter_id bigint not null, wallet_address text not null, member_role text,
    is_active boolean not null default true, joined_at timestamptz not null default now()
  );
`);

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

// Audit D-L2 (wash netting). Same fixtures and figures as the API's board test (frontend/api/evmGen8.db.test.mjs
// "wash netting"): W4 buys (trader-side 1.000) and sells (0.980) in ONE transaction on the graduated gen-8 coin GW =
// one net buy of 0.020; W5 buys 0.050; on G8, W6 buys 0.040 and an excluded row in the same transaction sells 0.029.
test("wash netting in settlement: one transaction's gen-8 legs by one wallet are one net row", async () => {
  const GW = "0x00000000000000000000000000000000000000a9";
  const CREATORW = "0x00000000000000000000000000000000000000d9";
  const W4 = "0x0000000000000000000000000000000000000004";
  const W5 = "0x0000000000000000000000000000000000000005";
  const W6 = "0x0000000000000000000000000000000000000006";
  await db.query(
    `insert into public.campaigns (chain_id, campaign_address, token_address, creator_address, name, symbol, created_block, created_at_chain, graduated_block, graduated_at_chain)
     values ($1, $2, $2, $3, 'Wash', 'WSH', 2, $4, 10000, $5)`,
    [CHAIN, GW, CREATORW, at(0), at(18)],
  );
  const t17 = at(17); // legs of one transaction share their block time
  const leg = (campaign: string, tx: string, logIndex: number, block: number, side: string, wallet: string, curve: bigint, fee: bigint, excluded = false) => db.query(
    `insert into public.curve_trades (chain_id, campaign_address, tx_hash, log_index, block_number, block_time, side, wallet, token_amount_raw, bnb_amount_raw, venue, fee_raw, league_excluded)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, 'gen8', $10, $11)`,
    [CHAIN, campaign, tx, logIndex, block, t17, side, wallet, curve.toString(), fee.toString(), excluded],
  );
  await leg(GW, `0x${"ab".repeat(32)}`, 7, 5000, "buy", W4, milli(980), milli(20));
  await leg(GW, `0x${"ab".repeat(32)}`, 9, 5000, "sell", W4, milli(1000), milli(20));
  await leg(GW, `0x${"cd".repeat(32)}`, 1, 5001, "buy", W5, milli(49), milli(1));
  await leg(G8, `0x${"ef".repeat(32)}`, 1, 5002, "buy", W6, milli(39), milli(1));
  await leg(G8, `0x${"ef".repeat(32)}`, 2, 5002, "sell", W6, milli(30), milli(1), true);

  const hits = await leagueLeaderboard(db, CHAIN, start, end, "biggest_hit", 10);
  const byCoin = Object.fromEntries(hits.map((r) => [r.meta.campaign_address, r]));
  assert.equal(byCoin[GW].recipient, W5, "the 1.000 wash leg is not a hit; the net buy is 0.020");
  assert.equal(byCoin[GW].score, milli(50));
  assert.equal(byCoin[G8].recipient, W1);
  assert.equal(byCoin[G7].score, milli(1020));

  const top = await leagueLeaderboard(db, CHAIN, start, end, "top_earner", 20);
  const by = Object.fromEntries(top.map((r) => [r.recipient, r.score]));
  assert.equal(by[W4], -milli(20), "net buy 0.020");
  assert.equal(by[W6], -milli(40), "the excluded sell is not netted into the buy");
  assert.equal(by[W3], milli(196) - milli(102));

  const runs = await leagueLeaderboard(db, CHAIN, start, end, "perfect_run", 10);
  assert.ok(runs.some((r) => r.recipient === CREATORW), "GW has no sell once netted");

  const fastest = await leagueLeaderboard(db, CHAIN, start, end, "fastest_finish", 10);
  assert.ok(fastest.some((r) => r.recipient === CREATORW));
});

// Hybrid ingestion (founder, 2026-10-12): settlement pays money, so a gen-8 row counts only once its block is final
// (below the chain's money cursor). The API board (frontend/api/evmGen8.db.test.mjs "money bound") shows the same rows
// at the chain head: there W7's 2.040 buy is G8's biggest hit and GW loses its perfect run; here neither moves.
test("money bound: a gen-8 row above the money cursor is not settled; without a cursor no gen-8 row is", async () => {
  const W7 = "0x0000000000000000000000000000000000000007";
  const GW = "0x00000000000000000000000000000000000000a9";
  const CREATORW = "0x00000000000000000000000000000000000000d9";
  const unsafe = (campaign: string, tx: string, block: number, side: string, curve: bigint, fee: bigint) => db.query(
    `insert into public.curve_trades (chain_id, campaign_address, tx_hash, log_index, block_number, block_time, side, wallet, token_amount_raw, bnb_amount_raw, venue, fee_raw, league_excluded)
     values ($1, $2, $3, 1, $4, $5, $6, $7, 1, $8, 'gen8', $9, false)`,
    [CHAIN, campaign, tx, block, at(19), side, W7, curve.toString(), fee.toString()],
  );
  await unsafe(G8, `0x${"11".repeat(32)}`, MONEY_CURSOR + 3000, "buy", milli(2000), milli(40)); // pays 2.040, the biggest buy on G8
  await unsafe(GW, `0x${"22".repeat(32)}`, MONEY_CURSOR + 3001, "sell", milli(100), milli(2)); // a sell on the perfect run

  const hits = await leagueLeaderboard(db, CHAIN, start, end, "biggest_hit", 10);
  const byCoin = Object.fromEntries(hits.map((r) => [r.meta.campaign_address, r]));
  assert.equal(byCoin[G8].recipient, W1, "the 2.040 buy at the chain head is not final");
  assert.equal(byCoin[G8].score, milli(1224));
  const top = await leagueLeaderboard(db, CHAIN, start, end, "top_earner", 20);
  assert.ok(!top.some((r) => r.recipient === W7), "no PnL from a row at the chain head");
  const runs = await leagueLeaderboard(db, CHAIN, start, end, "perfect_run", 10);
  assert.ok(runs.some((r) => r.recipient === CREATORW), "the sell at the chain head does not end the perfect run");
  // The bound alone drops exactly the two rows at the head; the netted trades carry them (the board shows them).
  const head = await db.query(`select count(*)::int as n from ${gen8NettedCurveTradesSql("t")} where t.wallet = $1 and ${gen8MoneySafeSql("t")}`, [W7]);
  assert.equal(head.rows[0].n, 0);
  const all = await db.query(`select count(*)::int as n from ${gen8NettedCurveTradesSql("t")} where t.wallet = $1`, [W7]);
  assert.equal(all.rows[0].n, 2);

  // No money cursor at all: nothing gen-8 is final; gen-7 settles as before.
  await db.query(`delete from public.indexer_state where chain_id = $1 and cursor like 'gen8-money:%'`, [CHAIN]);
  try {
    const none = await leagueLeaderboard(db, CHAIN, start, end, "biggest_hit", 10);
    const by = Object.fromEntries(none.map((r) => [r.meta.campaign_address, r]));
    assert.equal(by[G8], undefined, "every G8 row is gen-8");
    assert.equal(by[GW], undefined);
    assert.equal(by[G7].score, milli(1020), "gen-7 unchanged");
    const earners = await leagueLeaderboard(db, CHAIN, start, end, "top_earner", 20);
    const e = Object.fromEntries(earners.map((r) => [r.recipient, r.score]));
    assert.equal(e[W1], milli(490) - milli(1020), "only the gen-7 legs");
    assert.equal(e[W3], undefined);
  } finally {
    await db.query(`insert into public.indexer_state (chain_id, cursor, last_indexed_block) values ($1, $2, $3)`, [CHAIN, `gen8-money:${HOOK}`, MONEY_CURSOR]);
  }
});

// Founder, 2026-10-12: the recruiter league nets gen-8 legs the same way (one row per coin, wallet and transaction,
// trader-side amount) and, as a money path, counts only final rows. The board (frontend/api/evmGen8.db.test.mjs
// "recruiter board") shows the same net 0.020 and, as display, also the trade at the chain head.
test("recruiter league: a gen-8 wash pair by a linked wallet is net 0.020 of referred volume; gen-7 unchanged; chain head not yet", async () => {
  const C56 = "0x00000000000000000000000000000000000000b8"; // gen-8 coin on BNB
  const C56_7 = "0x00000000000000000000000000000000000000b7"; // gen-7 coin on BNB
  const CREATOR56 = "0x00000000000000000000000000000000000000d6";
  await db.query(
    `insert into public.campaigns (chain_id, campaign_address, token_address, creator_address, name, symbol, created_block, created_at_chain)
     values (56, $1, $1, $3, 'Bsc8', 'B8', 1, $4), (56, $2, $2, $3, 'Bsc7', 'B7', 1, $4)`,
    [C56, C56_7, CREATOR56, at(0)],
  );
  const { rows: [washed] } = await db.query(`insert into public.recruiters (wallet_address, code) values ('0x00000000000000000000000000000000000000f5', 'washed') returning id`);
  const { rows: [head] } = await db.query(`insert into public.recruiters (wallet_address, code) values ('0x00000000000000000000000000000000000000f6', 'head') returning id`);
  const LW = "0x00000000000000000000000000000000000000e5"; // washed's wallet: the wash pair and a gen-7 trade
  const LH = "0x00000000000000000000000000000000000000e6"; // head's wallet: one gen-8 trade at the chain head only
  await db.query(`insert into public.wallet_recruiter_links (wallet_address, recruiter_id, linked_at) values ($1, $2, $4), ($3, $5, $4)`, [LW, washed.id, LH, at(-48), head.id]);
  const t20 = at(20); // legs of one transaction share their block time
  const leg = (campaign: string, tx: string, logIndex: number, block: number, side: string, wallet: string, curve: bigint, fee: bigint, venue: string | null) => db.query(
    `insert into public.curve_trades (chain_id, campaign_address, tx_hash, log_index, block_number, block_time, side, wallet, token_amount_raw, bnb_amount_raw, venue, fee_raw, league_excluded)
     values (56, $1, $2, $3, $4, $5, $6, $7, 1, $8, $9, $10, false)`,
    [campaign, tx, logIndex, block, t20, side, wallet, curve.toString(), venue, fee.toString()],
  );
  const WASH = `0x${"33".repeat(32)}`;
  await leg(C56, WASH, 1, 4000, "buy", LW, milli(980), milli(20), "gen8"); // pays 1.000
  await leg(C56, WASH, 2, 4000, "sell", LW, milli(1000), milli(20), "gen8"); // receives 0.980
  await leg(C56_7, `0x${"44".repeat(32)}`, 1, 4001, "buy", LW, milli(1000), milli(20), null); // gen-7: 1.000 as stored
  await leg(C56, `0x${"55".repeat(32)}`, 1, MONEY_CURSOR + 10, "buy", LH, milli(500), milli(10), "gen8"); // at the chain head

  const standings = await recruiterLeagueStandings(db, start, end, { bnbUsd: 600, ethUsd: 3000, solUsd: 150 });
  const w = standings.find((s) => s.code === "washed");
  assert.ok(w, "the wash pair nets to 0.020, which is referred volume");
  assert.equal(w.referredVolumeUsd, (Number(String(milli(1020))) / 10 ** 18) * 600, "gen-7 1.000 + gen-8 net 0.020, at $600");
  assert.equal(w.linkedWalletCount, 1);
  assert.equal(standings.find((s) => s.code === "head"), undefined, "a gen-8 trade above the money cursor is not referred volume yet");
});

// Fix round 2026-10-12 (F1, D14 per trade): a forced latch whose price fell back into range A keeps trading at the
// bonding rate and those swaps land in curve_trades ABOVE graduated_block. Same rows and figures as the API's board test
// (frontend/api/evmGen8.db.test.mjs "fix round leagues"): GL latched at block 4000, W8 buys 0.102 before the latch, W9
// buys 0.306 and sells after it. Settlement counts the post-latch bonding buy (biggest_hit has no graduation cutoff),
// and the run to graduation (perfect_run, fastest_finish) stays at the latch.
test("fix round: gen-8 bonding rows above graduated_block count in settlement; the latch still ends the run", async () => {
  const GL = "0x00000000000000000000000000000000000000aa";
  const CREATORL = "0x00000000000000000000000000000000000000da";
  const W8 = "0x0000000000000000000000000000000000000008";
  const W9 = "0x0000000000000000000000000000000000000009";
  await db.query(
    `insert into public.campaigns (chain_id, campaign_address, token_address, creator_address, name, symbol, created_block, created_at_chain, graduated_block, graduated_at_chain)
     values ($1, $2, $2, $3, 'Latched', 'LTC', 2, $4, 4000, $5)`,
    [CHAIN, GL, CREATORL, at(0), at(20)],
  );
  const row = (tx: string, block: number, hour: number, side: string, wallet: string, curve: bigint, fee: bigint) => db.query(
    `insert into public.curve_trades (chain_id, campaign_address, tx_hash, log_index, block_number, block_time, side, wallet, token_amount_raw, bnb_amount_raw, venue, fee_raw, league_excluded)
     values ($1, $2, $3, 1, $4, $5, $6, $7, 1, $8, 'gen8', $9, false)`,
    [CHAIN, GL, tx, block, at(hour), side, wallet, curve.toString(), fee.toString()],
  );
  await row(`0x${"31".repeat(32)}`, 3990, 19, "buy", W8, milli(100), milli(2));
  await row(`0x${"32".repeat(32)}`, 4500, 21, "buy", W9, milli(300), milli(6));
  await row(`0x${"33".repeat(32)}`, 4600, 22, "sell", W9, milli(50), milli(1));

  const hits = Object.fromEntries((await leagueLeaderboard(db, CHAIN, start, end, "biggest_hit", 20)).map((r) => [r.meta.campaign_address, r]));
  assert.equal(hits[GL].recipient, W9, "the post-latch bonding buy is GL's biggest hit (the board shows the same)");
  assert.equal(hits[GL].score, milli(306));
  const runs = await leagueLeaderboard(db, CHAIN, start, end, "perfect_run", 20);
  assert.ok(runs.some((r) => r.recipient === CREATORL), "a sell after the latch does not end the run to graduation");
  const fastest = await leagueLeaderboard(db, CHAIN, start, end, "fastest_finish", 20);
  assert.ok(fastest.some((r) => r.recipient === CREATORL), "graduation as an event: the latch");
});
