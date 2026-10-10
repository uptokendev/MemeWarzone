// Hidden test coins stay out of every league field (founder, 2026-10-05: "keep test data out of the
// leagues"). Runs the real settlement SQL (rewards/leagueLeaderboard.ts, rewards/recruiterLeague.ts)
// against a throwaway Postgres: per-coin categories skip a hidden coin, wallet categories do not count
// its trades, the recruiter league counts neither its volume nor its recruiter credit, and the next
// row moves up a place.
import assert from "node:assert/strict";
import test from "node:test";
import { startThrowawayPostgres } from "../../../scripts/dbc/throwaway-postgres.mjs";
import { leagueLeaderboard } from "../rewards/leagueLeaderboard.js";
import { recruiterLeagueStandings } from "../rewards/recruiterLeague.js";
import {
  notPublicHiddenCampaignSql,
  notPublicHiddenOrBlockedCampaignSql,
  probeBlockedCoinsTable,
  publicHiddenOrBlockedWhere,
  publicHiddenWhere,
  setBlockedCoinsTablePresent,
} from "../rewards/publicHiddenSql.js";
import { resetCurveTradeGen5ColumnsCache } from "../evm/curveTradeGen5Columns.js";
// @ts-ignore -- the API's canonical rule, plain JS without imports
import * as api from "../../../frontend/api/lib/publicHiddenSql.js";

const pg = await startThrowawayPostgres();
test.after(async () => {
  await pg.stop();
});
const db = pg.pool as any;
resetCurveTradeGen5ColumnsCache();

await db.query(`
  alter table public.recruiters add column if not exists metadata jsonb not null default '{}'::jsonb;
  create table if not exists public.votes (
    chain_id integer not null, campaign_address text not null, voter_address text not null,
    amount_raw numeric not null default 0, block_number bigint not null default 0,
    block_timestamp timestamptz not null, status text not null default 'confirmed'
  );
  create table if not exists public.wallet_squad_memberships (
    recruiter_id bigint not null, wallet_address text not null, member_role text,
    is_active boolean not null default true, joined_at timestamptz not null default now()
  );
`);

const CHAIN = 97; // fastest_finish needs no unique-buyer floor on 97
const START = "2026-09-21T00:00:00.000Z";
const END = "2026-09-28T00:00:00.000Z";
const at = (h: number) => new Date(Date.parse(START) + h * 3_600_000).toISOString();
const BNB = 10n ** 18n;

const REAL = "0x00000000000000000000000000000000000000a1";
const REAL2 = "0x00000000000000000000000000000000000000a2";
const TEST = "0x00000000000000000000000000000000000000b1"; // hidden
const GRAD_REAL = "0x00000000000000000000000000000000000000c1";
const GRAD_TEST = "0x00000000000000000000000000000000000000c2"; // hidden
const W1 = "0x0000000000000000000000000000000000000001"; // test-coin trader
const W2 = "0x0000000000000000000000000000000000000002";
const W3 = "0x0000000000000000000000000000000000000003";
const CREATOR_REAL = "0x00000000000000000000000000000000000000d1";
const CREATOR_TEST = "0x00000000000000000000000000000000000000d2";

async function campaign(chainId: number, address: string, creator: string, hidden: boolean | string, extra: Record<string, unknown> = {}) {
  const meta = hidden === false ? {} : { publicHidden: hidden };
  await db.query(
    `insert into public.campaigns (chain_id, campaign_address, creator_address, name, symbol, meta, created_block, created_at_chain, graduated_at_chain, graduated_block)
     values ($1, $2, $3, $4, $4, $5::jsonb, 1, $6, $7, $8)`,
    [chainId, address, creator, address.slice(-2), JSON.stringify(meta), extra.created ?? null, extra.graduated ?? null, extra.graduatedBlock ?? null],
  );
}

let logIndex = 0;
async function trade(chainId: number, campaignAddress: string, wallet: string, side: "buy" | "sell", amount: bigint, hour: number) {
  logIndex += 1;
  await db.query(
    `insert into public.curve_trades (chain_id, campaign_address, tx_hash, log_index, block_number, block_time, side, wallet, token_amount_raw, bnb_amount_raw)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9)`,
    [chainId, campaignAddress, `0x${logIndex.toString(16).padStart(64, "0")}`, logIndex, 100 + logIndex, at(hour), side, wallet, amount.toString()],
  );
}

await campaign(CHAIN, REAL, CREATOR_REAL, false);
await campaign(CHAIN, REAL2, CREATOR_REAL, false);
await campaign(CHAIN, TEST, CREATOR_TEST, true);
await campaign(CHAIN, GRAD_REAL, CREATOR_REAL, false, { created: at(0), graduated: at(10), graduatedBlock: 50 });
await campaign(CHAIN, GRAD_TEST, CREATOR_TEST, "yes", { created: at(0), graduated: at(1), graduatedBlock: 50 });

// biggest_hit: the 5 BNB buy on the test coin would be first.
await trade(CHAIN, TEST, W1, "buy", 5n * BNB, 1);
await trade(CHAIN, REAL, W2, "buy", 3n * BNB, 2);
await trade(CHAIN, REAL2, W3, "buy", 2n * BNB, 3);
// top_earner: W1 makes +5 on the test coin (buy 5, sell 10) and -1 on a real coin.
await trade(CHAIN, TEST, W1, "sell", 10n * BNB, 4);
await trade(CHAIN, REAL2, W1, "buy", 1n * BNB, 5);
await trade(CHAIN, REAL, W2, "sell", 4n * BNB, 6); // W2: +1
// crowd_favorite: ten votes on the test coin, two on a real one.
for (let i = 0; i < 10; i++) {
  await db.query(`insert into public.votes (chain_id, campaign_address, voter_address, block_timestamp) values ($1, $2, $3, $4)`, [CHAIN, TEST, `0x${String(i).padStart(40, "e")}`, at(7)]);
}
for (let i = 0; i < 2; i++) {
  await db.query(`insert into public.votes (chain_id, campaign_address, voter_address, block_timestamp) values ($1, $2, $3, $4)`, [CHAIN, REAL, `0x${String(i).padStart(40, "f")}`, at(8)]);
}

const board = (category: string) => leagueLeaderboard(db, CHAIN, START, END, category, 5_000);

test("the indexer rule is the API rule", () => {
  assert.equal(publicHiddenWhere("c"), api.publicHiddenWhere("c"));
  assert.equal(publicHiddenWhere(), api.publicHiddenWhere());
  assert.equal(notPublicHiddenCampaignSql("t"), api.notPublicHiddenCampaignSql("t"));
  assert.equal(notPublicHiddenCampaignSql("re", "campaign"), api.notPublicHiddenCampaignSql("re", "campaign"));
  // Blocked coins (Command Center -> Abuse): the same with the blocked_coins table missing and present.
  for (const present of [false, true]) {
    setBlockedCoinsTablePresent(present);
    api.setBlockedCoinsTablePresent(present);
    assert.equal(publicHiddenOrBlockedWhere("c"), api.publicHiddenOrBlockedWhere("c"));
    assert.equal(notPublicHiddenOrBlockedCampaignSql("t"), api.notPublicHiddenOrBlockedCampaignSql("t"));
    assert.equal(notPublicHiddenOrBlockedCampaignSql("re", "campaign"), api.notPublicHiddenOrBlockedCampaignSql("re", "campaign"));
  }
  assert.equal(publicHiddenOrBlockedWhere("c").includes("blocked_coins"), true);
  setBlockedCoinsTablePresent(null);
  api.setBlockedCoinsTablePresent(null);
  assert.equal(publicHiddenOrBlockedWhere("c"), publicHiddenWhere("c"), "no table: exactly the publicHidden rule");
});

test("biggest_hit: the hidden coin is skipped and the real coins move up", async () => {
  const rows = await board("biggest_hit");
  assert.deepEqual(rows.map((r) => [r.recipient, r.meta.campaign_address, r.score]), [
    [W2, REAL, 3n * BNB],
    [W3, REAL2, 2n * BNB],
  ]);
});

test("top_earner: trades on the hidden coin count for nothing", async () => {
  const rows = await board("top_earner");
  const byWallet = new Map(rows.map((r) => [r.recipient, r.score]));
  assert.equal(rows[0].recipient, W2, "W1 would lead with +4 BNB counting the test coin");
  assert.equal(byWallet.get(W2), 1n * BNB);
  assert.equal(byWallet.get(W1), -1n * BNB, "only W1's real-coin buy counts");
  assert.equal(byWallet.get(W3), -2n * BNB);
});

test("crowd_favorite: votes on the hidden coin are not in the field", async () => {
  const rows = await board("crowd_favorite");
  assert.deepEqual(rows.map((r) => [r.recipient, r.meta.campaign_address, r.score]), [[CREATOR_REAL, REAL, 2n]]);
});

test("fastest_finish and perfect_run: a hidden graduation is skipped (any truthy publicHidden spelling)", async () => {
  for (const category of ["fastest_finish", "perfect_run"]) {
    const rows = await board(category);
    assert.deepEqual(rows.map((r) => [r.recipient, r.score]), [[CREATOR_REAL, 36_000n]], category);
  }
});

test("recruiter league: a network that only traded hidden coins is not active; credit from them is not earnings", async () => {
  // The recruiter league ranks the mainnets (56, 4663, 101) together.
  await campaign(56, REAL, CREATOR_REAL, false);
  await campaign(56, TEST, CREATOR_TEST, true);
  const { rows: [epoch] } = await db.query(`insert into public.epochs (chain_id, epoch_type, start_at, end_at) values (56, 'weekly', $1, $2) returning id`, [START, END]);
  const { rows: [r1] } = await db.query(`insert into public.recruiters (wallet_address, code) values ('0x00000000000000000000000000000000000000f1', 'testonly') returning id`);
  const { rows: [r2] } = await db.query(`insert into public.recruiters (wallet_address, code) values ('0x00000000000000000000000000000000000000f2', 'real') returning id`);
  const L1 = "0x00000000000000000000000000000000000000e1";
  const L2 = "0x00000000000000000000000000000000000000e2";
  await db.query(`insert into public.wallet_recruiter_links (wallet_address, recruiter_id, linked_at) values ($1, $2, $4), ($3, $5, $4)`, [L1, r1.id, L2, at(-48), r2.id]);
  await trade(56, TEST, L1, "buy", 50n * BNB, 1);
  await trade(56, REAL, L2, "buy", 1n * BNB, 2);
  await trade(56, TEST, L2, "buy", 9n * BNB, 3);
  const reward = (wallet: string, campaignAddress: string, amount: bigint, n: number) =>
    db.query(
      `insert into public.reward_events (chain_id, tx_hash, log_index, block_number, occurred_at, epoch_id, wallet_address, campaign_address, route_kind, route_profile, recruiter_amount, raw_amount, source_contract)
       values (56, $1, 0, 1, $2, $3, $4, $5, 'trade', 'standard', $6, 0, '0x')`,
      [`0xre${n}`, at(n), epoch.id, wallet, campaignAddress, amount.toString()],
    );
  await reward(L1, TEST, BNB, 1);
  await reward(L2, REAL, BNB / 100n, 2);
  await reward(L2, TEST, BNB, 3);

  const prices = { bnbUsd: 600, ethUsd: 3000, solUsd: 150 };
  const standings = await recruiterLeagueStandings(db, START, END, prices);
  assert.deepEqual(standings.map((s) => s.code), ["real"], "the test-coin-only network is not in the field");
  assert.equal(standings[0].referredVolumeUsd, 600, "1 BNB of real volume; the 9 BNB on the test coin is left out");
  assert.equal(standings[0].epochEarnedUsd, 6, "0.01 BNB of real credit; the 1 BNB from the test coin is left out");
});

test("recruiter league: only squad wallets that traded in the epoch count toward the score", async () => {
  // Founder, 2026-10-09: a recruiter padded its squad with 120 scripted wallets that never traded and
  // led the league on counts alone. Idle wallets now add nothing; volume still decides the rest.
  const COIN = "0x00000000000000000000000000000000000000a3";
  await campaign(56, COIN, CREATOR_REAL, false);
  const { rows: [padded] } = await db.query(`insert into public.recruiters (wallet_address, code) values ('0x00000000000000000000000000000000000000f3', 'padded') returning id`);
  const { rows: [honest] } = await db.query(`insert into public.recruiters (wallet_address, code) values ('0x00000000000000000000000000000000000000f4', 'honest') returning id`);
  const wallet = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
  const traded = wallet(0xe100);
  const idle = [1, 2, 3, 4, 5].map((n) => wallet(0xe200 + n));
  const honestWallets = [wallet(0xe301), wallet(0xe302)];
  const join = async (recruiterId: number, address: string) => {
    await db.query(`insert into public.wallet_recruiter_links (wallet_address, recruiter_id, linked_at) values ($1, $2, $3)`, [address, recruiterId, at(-48)]);
    await db.query(`insert into public.wallet_squad_memberships (recruiter_id, wallet_address, member_role, joined_at) values ($1, $2, 'trader', $3)`, [recruiterId, address, at(-48)]);
  };
  for (const address of [traded, ...idle]) await join(padded.id, address);
  for (const address of honestWallets) await join(honest.id, address);
  await trade(56, COIN, traded, "buy", BNB, 20);
  await trade(56, COIN, honestWallets[0], "buy", BNB, 21);
  await trade(56, COIN, honestWallets[1], "buy", BNB, 22);

  const standings = await recruiterLeagueStandings(db, START, END, { bnbUsd: 600, ethUsd: 3000, solUsd: 150 });
  const p = standings.find((s) => s.code === "padded");
  const h = standings.find((s) => s.code === "honest");
  assert.ok(p && h, "both recruiters have volume, so both are in the field");
  assert.equal(p.linkedWalletCount, 1, "five idle links add nothing");
  assert.equal(p.linkedTradersCount, 1, "five idle squad traders add nothing");
  assert.equal(p.referredVolumeUsd, 600, "volume itself is unchanged");
  assert.equal(h.linkedWalletCount, 2);
  assert.equal(h.linkedTradersCount, 2);
  assert.ok(standings.indexOf(h) < standings.indexOf(p), "two trading members beat one trading member plus five idle ones");
});

test("blocked coins: an active block takes a coin out of the league field like publicHidden; a release puts it back", async () => {
  // Before the migration the table is missing and the board is unchanged (the 42P01 never reaches SQL).
  assert.equal(await probeBlockedCoinsTable(db), false);
  const before = await board("biggest_hit");
  assert.deepEqual(before.map((r) => r.meta.campaign_address), [REAL, REAL2]);

  const fs = await import("node:fs");
  const migration = fs.readFileSync(new URL("../../../db/migrations/20261010_000020_blocked_coins.sql", import.meta.url), "utf8");
  await db.query(migration);
  setBlockedCoinsTablePresent(null);
  assert.equal(await probeBlockedCoinsTable(db), true);

  await db.query(`insert into public.blocked_coins (chain_id, campaign_address, kind, mode, reason) values ($1, $2, 'abuse', 'hide', 'league test')`, [CHAIN, REAL2]);
  const blocked = await board("biggest_hit");
  assert.deepEqual(blocked.map((r) => [r.recipient, r.meta.campaign_address]), [[W2, REAL]]);
  const earners = new Map((await board("top_earner")).map((r) => [r.recipient, r.score]));
  assert.equal(earners.has(W3), false, "W3 only traded the blocked coin");

  await db.query(`update public.blocked_coins set released_at = now(), release_reason = 'undo' where reason = 'league test'`);
  const released = await board("biggest_hit");
  assert.deepEqual(released.map((r) => r.meta.campaign_address), [REAL, REAL2]);
});
