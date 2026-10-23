// Swap widget tracking against a throwaway local Postgres (scripts/dbc/throwaway-postgres.mjs) with the real
// migrations: the daily rollup, the 500-site cap, partner only when active, the ledger, the fee scanner's wallet-bound
// widget marks (amounts and partner logic unchanged), the admin read models' maths, and everything still working on a
// database without the widget SQL. Never connects to staging or production; no RPC (the scanner gets a fake one).
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

process.env.DBC_THROWAY_PG_PORT ||= "55511";
const { startThrowawayPostgres } = await import("../../../scripts/dbc/throwaway-postgres.mjs");
const { Pool } = createRequire(new URL("../../../realtime-indexer/package.json", import.meta.url))("pg");
const pg = await startThrowawayPostgres();
const db = pg.pool;
const migration = (name) => fs.readFileSync(fileURLToPath(new URL(`../../../db/migrations/${name}`, import.meta.url)), "utf8");
const BASE = [
  "20261006_000002_finance_import_swap_fees.sql",
  "20261008_000020_import_creator_fees.sql",
  "20261009_000010_import_fee_partners.sql",
  "20261009_000020_graduated_creator_fees.sql",
];
for (const name of BASE) await db.query(migration(name));
// The gen-8 accruals table exactly as the indexer migration creates it (the rest of that migration needs the full
// indexer schema), then the gen-8 partner ledger migration on top.
const gen8 = migration("20261011_000010_evm_gen8_indexer.sql");
const accrualsStart = gen8.indexOf("create table if not exists public.evm_gen8_fee_accruals");
await db.query(gen8.slice(accrualsStart, gen8.indexOf("\n);", accrualsStart) + 3));
await db.query(migration("20261022_000010_gen8_partner_fees.sql"));

// A second database with the same schema but WITHOUT the widget SQL: tracking and the scanner must keep working.
await db.query("create database nowidget");
const bare = new Pool({ connectionString: pg.url.replace(/\/mwz$/, "/nowidget"), ssl: false });
await bare.query(`create table public.campaigns (chain_id integer, campaign_address text, token_address text, creator_address text, meta jsonb not null default '{}'::jsonb)`);
for (const name of BASE) await bare.query(migration(name));

await db.query(migration("20261023_000020_widget_analytics.sql"));
await db.query(migration("20261023_000020_widget_analytics.sql")); // idempotent

test.after(async () => {
  await bare.end().catch(() => {});
  await pg.stop();
});

const { recordWidgetUsage, activeWidgetPartner, observeWidgetRequest, resetWidgetTrackingState } = await import("./widgetTracking.js");
const { recordWidgetBuild, resetWidgetLedgerState } = await import("./widgetSwapLedger.js");
const { ingestImportSwapFees, VAULT_DEPOSIT_TOPIC } = await import("./financeImportSwapFees.js");
const { evmFingerprint } = await import("./importSwapFingerprint.js");
const { buildWidgetFinance, buildWidgetUsage, funnelOf, widgetWindow } = await import("./widgetAnalytics.js");
const { GEN8_REFERRER_WIDGET } = await import("../../shared/evmGen8Swap.mjs");

const KYBER = "0x6131b5fae19ea4f9d964eac0408e4408b66337b5";
const VAULT = "0x00000000000000000000000000000000000000aa";
const A = "0x" + "a1".repeat(20);
const B = "0x" + "b2".repeat(20);
const TOKEN = "0x" + "cc".repeat(20);
const today = new Date().toISOString().slice(0, 10);
const quietly = async (fn) => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
  }
};
const usageRows = async () => (await db.query(`select chain_id, partner_id, host, event, count::int as n from public.widget_usage_daily order by chain_id, partner_id, host, event`)).rows;

test("rollup: one upsert per request adds 1 to (today, chain, partner, website, event)", async () => {
  resetWidgetTrackingState();
  await db.query("delete from public.widget_usage_daily");
  for (let i = 0; i < 3; i += 1) assert.equal(await recordWidgetUsage(db, { chainId: 56, partnerId: "", host: "site.xyz", event: "load" }), true);
  await recordWidgetUsage(db, { chainId: 56, partnerId: "", host: "site.xyz", event: "quote" });
  await recordWidgetUsage(db, { chainId: 101, partnerId: "", host: "", event: "load" });
  assert.deepEqual(await usageRows(), [
    { chain_id: 56, partner_id: "", host: "site.xyz", event: "load", n: 3 },
    { chain_id: 56, partner_id: "", host: "site.xyz", event: "quote", n: 1 },
    { chain_id: 101, partner_id: "", host: "", event: "load", n: 1 },
  ]);
  const { rows } = await db.query(`select distinct day::text as day, (now() at time zone 'utc')::date::text as utc_today from public.widget_usage_daily`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].day, rows[0].utc_today, "the database's UTC day");
  assert.equal(await recordWidgetUsage(db, { chainId: 1, event: "load" }), false, "not a widget chain");
  assert.equal(await recordWidgetUsage(db, { chainId: 56, event: "click" }), false, "not an event");
});

test("cap: once a (day, chain) has the cap of named websites, new ones count as 'other'; known ones and '' stay themselves", async () => {
  resetWidgetTrackingState();
  await db.query("delete from public.widget_usage_daily");
  for (const host of ["one.com", "two.com", "three.com", "four.com"]) await recordWidgetUsage(db, { chainId: 4663, host, event: "load" }, { cap: 2 });
  await recordWidgetUsage(db, { chainId: 4663, host: "one.com", event: "quote" }, { cap: 2 });
  await recordWidgetUsage(db, { chainId: 4663, host: "", event: "load" }, { cap: 2 });
  await recordWidgetUsage(db, { chainId: 56, host: "five.com", event: "load" }, { cap: 2 });
  assert.deepEqual((await usageRows()).map((r) => `${r.chain_id}:${r.host}:${r.event}:${r.n}`), [
    "56:five.com:load:1",
    "4663::load:1",
    "4663:one.com:load:1",
    "4663:one.com:quote:1",
    "4663:other:load:2",
    "4663:two.com:load:1",
  ]);
});

test("partner: counted only when the partner row exists and is active on that chain", async () => {
  resetWidgetTrackingState();
  await db.query(`insert into public.import_fee_partners (id, chain_id, name, payout_wallet, active) values
    ('live-p', 56, 'Live', $1, true), ('off-p', 56, 'Off', $1, false), ('live-p', 4663, 'Live RH', $1, false)`, [A]);
  assert.equal(await activeWidgetPartner(db, "live-p", 56), "live-p");
  assert.equal(await activeWidgetPartner(db, "LIVE-P", 56), "live-p");
  assert.equal(await activeWidgetPartner(db, "live-p", 4663), "", "switched off on this chain");
  assert.equal(await activeWidgetPartner(db, "off-p", 56), "");
  assert.equal(await activeWidgetPartner(db, "ghost", 56), "");
  await db.query("delete from public.widget_usage_daily");
  const req = (partner) => ({ method: "POST", headers: { origin: "https://p.site" }, body: { chainId: 56, partner } });
  await observeWidgetRequest({ spec: { event: "quote" }, req: req("live-p"), status: 200 }, { db });
  await observeWidgetRequest({ spec: { event: "quote" }, req: req("off-p"), status: 200 }, { db });
  await observeWidgetRequest({ spec: { event: "quote" }, req: req("ghost"), status: 200 }, { db });
  assert.deepEqual((await usageRows()).map((r) => `${r.partner_id}:${r.n}`), [":2", "live-p:1"]);
});

const word = (n) => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
const pad = (address) => `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;

/** A fake BSC RPC: three Kyber deposits into the ImportFeeVault. tx a1: A landed A's widget build; b2: B landed the
 *  same bytes (A's build); c3: A, no widget build. */
function fakeRpc(txs) {
  return async (method, params) => {
    if (method === "eth_blockNumber") return "0xc8";
    if (method === "eth_getLogs") {
      if (String(params[0].address).toLowerCase() !== VAULT) return [];
      return txs.map((t, i) => ({ removed: false, data: word(t.fee), blockNumber: "0x70", logIndex: `0x${i.toString(16)}`, transactionHash: t.hash, topics: [VAULT_DEPOSIT_TOPIC, pad(KYBER)] }));
    }
    if (method === "eth_getTransactionByHash") {
      const t = txs.find((x) => x.hash === params[0]);
      return { from: t.from, to: KYBER, input: t.data, value: t.value };
    }
    if (method === "eth_getTransactionReceipt") return { logs: [] };
    if (method === "eth_getBlockByNumber") return { timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}` };
    throw new Error(`unexpected ${method}`);
  };
}
const ENV = { IMPORT_FEE_VAULT_56: VAULT, IMPORT_FEE_VAULT_START_BLOCK_56: "100", IMPORT_AUTO_IMPORT: "off" };
const TXS = [
  { hash: "0x" + "a1".repeat(32), from: A, data: "0x1111", value: "0x0de0b6b3a7640000", fee: 10_000_000_000_000_000n },
  { hash: "0x" + "b2".repeat(32), from: B, data: "0x1111", value: "0x0de0b6b3a7640000", fee: 10_000_000_000_000_001n },
  { hash: "0x" + "c3".repeat(32), from: A, data: "0x2222", value: "0x0", fee: 3_000n },
];

test("scanner: only a fee row whose fingerprint AND landed wallet match a widget build is marked; amounts and partner logic unchanged", async () => {
  resetWidgetLedgerState();
  // A's widget build (the partner fingerprint is not recorded: no partner), as observeWidgetRequest stores it.
  await observeWidgetRequest({
    spec: { event: "build" },
    req: { method: "POST", headers: { origin: "https://www.widget.site" }, body: { chainId: 56, wallet: A.toUpperCase().replace("0X", "0x"), side: "buy", token: TOKEN, quote: { amountIn: "1000000000000000000", extraFee: { feeAmount: "100", isInBps: true } } } },
    status: 200,
    payload: JSON.stringify({ ok: true, chainId: 56, to: KYBER, data: "0x1111", value: "1000000000000000000" }),
  }, { db });
  const stored = (await db.query(`select fingerprint, wallet, host, fee_bps, kind from public.widget_swap_builds`)).rows;
  assert.deepEqual(stored, [{ fingerprint: evmFingerprint(KYBER, "0x1111", "0x0de0b6b3a7640000"), wallet: A, host: "widget.site", fee_bps: 100, kind: "import" }]);

  const out = await ingestImportSwapFees({ db, chainId: 56, env: ENV, rpc: fakeRpc(TXS) });
  assert.equal(out.split[0].inserted, 3);
  assert.equal(out.split[0].widgetMarked, 1);
  const rows = (await db.query(`select tx_hash, fee_raw::text, creator_raw::text, partner_raw::text, partner_id, swap_source, widget_host, widget_build_id is not null as linked from public.finance_import_swap_fees order by tx_hash`)).rows;
  assert.deepEqual(rows, [
    { tx_hash: TXS[0].hash, fee_raw: "10000000000000000", creator_raw: "5000000000000000", partner_raw: "0", partner_id: null, swap_source: "widget", widget_host: "widget.site", linked: true },
    { tx_hash: TXS[1].hash, fee_raw: "10000000000000001", creator_raw: "5000000000000000", partner_raw: "0", partner_id: null, swap_source: null, widget_host: null, linked: false },
    { tx_hash: TXS[2].hash, fee_raw: "3000", creator_raw: "1500", partner_raw: "0", partner_id: null, swap_source: null, widget_host: null, linked: false },
  ]);
  // A rescan from scratch marks nothing twice and changes no amount.
  const again = await ingestImportSwapFees({ db, chainId: 56, env: ENV, rpc: fakeRpc(TXS), fromScratch: true });
  assert.equal(again.split[0].inserted, 0);
  assert.equal(again.split[0].widgetMarked, undefined);
});

test("scanner and tracking on a database without the widget SQL: same rows as before, nothing marked, nothing thrown", async () => {
  resetWidgetTrackingState();
  resetWidgetLedgerState();
  await quietly(async () => {
    assert.equal(await recordWidgetUsage(bare, { chainId: 56, event: "load" }), false);
    assert.equal(await recordWidgetBuild(bare, { fingerprint: "evm:" + "1".repeat(64), chainId: 56, wallet: A }), false);
    const out = await ingestImportSwapFees({ db: bare, chainId: 56, env: ENV, rpc: fakeRpc(TXS) });
    assert.equal(out.split[0].inserted, 3);
    assert.equal(out.split[0].widgetMarked, undefined);
  });
  const rows = (await bare.query(`select tx_hash, fee_raw::text, creator_raw::text from public.finance_import_swap_fees order by tx_hash`)).rows;
  assert.deepEqual(rows.map((r) => [r.fee_raw, r.creator_raw]), [["10000000000000000", "5000000000000000"], ["10000000000000001", "5000000000000000"], ["3000", "1500"]]);
  const usage = await buildWidgetUsage({ db: bare, from: today, to: today });
  assert.equal(usage.schemaMissing, true);
  assert.equal(usage.series.length, 1);
  const finance = await buildWidgetFinance({ db: bare, from: today, to: today });
  assert.equal(finance.schemaMissing, true);
  resetWidgetTrackingState();
  resetWidgetLedgerState();
});

// Stub price service: 1 BNB = $600, 1 ETH = $3000 at every hour (financePrices.js valueEvents shape).
const prices = {
  async valueEvents(asset, buckets, decimals) {
    const usd = { BNB: 600, ETH: 3000, SOL: 150 }[asset];
    const raw = buckets.reduce((s, b) => s + BigInt(b.raw), 0n);
    return { amountUsd: Number(raw) / 10 ** decimals * usd, priceBasis: "event_time" };
  },
};

test("finance: per chain / partner / website, volume from the fee rate, net = fee - creator - partner; gen-8 by the widget tag; partner ledger", async () => {
  // A partner-credited widget swap on 56 (the partner logic already set partner_id / partner_raw on the fee row).
  const build = (await db.query(`select id from public.widget_swap_builds limit 1`)).rows[0].id;
  await db.query(
    `insert into public.finance_import_swap_fees (chain_id, tx_hash, log_index, occurred_at, wallet, token_address, side, fee_raw, fee_asset, fee_receiver, router, source, creator_raw, partner_id, partner_raw, swap_source, widget_host, widget_build_id)
     values (56, '0xpartner', 0, now(), $1, $2, 'buy', 2000, 'BNB', $3, $4, 'evm_vault_deposit', 1000, 'live-p', 500, 'widget', 'widget.site', $5),
            (56, '0xinternal', 0, now(), $1, $2, 'buy', 9999, 'BNB', $3, $4, 'evm_vault_deposit', 0, null, 0, 'widget', 'widget.site', $5)`,
    [A, TOKEN, VAULT, KYBER, build],
  );
  await db.query(`update public.finance_import_swap_fees set internal_wallet = true where tx_hash = '0xinternal'`);
  // Gen-8: two widget-tagged trades on 56 (one graduated with a partner fee), one untagged trade.
  const hook = "0x" + "99".repeat(20);
  const acc = async (tx, phase, referrer, volume, fee, creator, protocol) => (await db.query(
    `insert into public.evm_gen8_fee_accruals (chain_id, hook_address, pool_id, token_address, tx_hash, log_index, block_number, block_time, kind, phase, trader, referrer, side, curve_amount, fee, creator_share, router_amount, protocol)
     values (56, $1, 'pool', $2, $3, 0, 1, now(), 'trade', $4, $5, $6, 'buy', $7::numeric, $8::numeric, $9::numeric, $8::numeric - $9::numeric, $10::numeric) returning id`,
    [hook, TOKEN, tx, phase, A, referrer, volume, fee, creator, protocol],
  )).rows[0].id;
  await acc("0xg1", "bonding", GEN8_REFERRER_WIDGET.toLowerCase(), "1000000", "20000", "11200", "1000");
  const post = await acc("0xg2", "post", GEN8_REFERRER_WIDGET, "2000000", "20000", "10000", "10000");
  await acc("0xg3", "post", null, "5000000", "50000", "25000", "25000");
  const gfp = evmFingerprint(KYBER, "0x3333", "0");
  await db.query(`insert into public.widget_swap_builds (fingerprint, chain_id, kind, wallet, host, partner_id) values ($1, 56, 'gen8', $2, 'gen8.site', 'live-p')`, [gfp, A]);
  await db.query(`insert into public.gen8_partner_fees (chain_id, hook_address, accrual_id, tx_hash, log_index, token_address, partner_id, fingerprint, curve_amount, partner_raw, block_time)
    values (56, $1, $2, '0xg2', 0, $3, 'live-p', $4, 2000000, 5000, now())`, [hook, post, TOKEN, gfp]);
  await db.query(`insert into public.import_fee_transfers (chain_id, kind, from_address, to_address, amount_raw, status, partner_id, gen8_raw)
    select 56, 'partner', $1, $2, 700, 'landed', 'live-p', 200`, [VAULT, A]);

  const out = await buildWidgetFinance({ db, from: today, to: today, prices });
  assert.equal(out.schemaMissing, false);
  const bnb = out.imports.byChain.find((r) => r.chainId === 56);
  // Rows: a1 (fee 1e16, creator 5e15, no partner) + partner row (2000 / 1000 / 500). Internal wallet left out.
  assert.equal(bnb.swaps, 2);
  assert.equal(bnb.feeRaw, (10_000_000_000_000_000n + 2000n).toString());
  assert.equal(bnb.creatorRaw, (5_000_000_000_000_000n + 1000n).toString());
  assert.equal(bnb.partnerRaw, "500");
  assert.equal(bnb.netRaw, (10_000_000_000_000_000n + 2000n - 5_000_000_000_000_000n - 1000n - 500n).toString());
  // Volume: fee x 10000 / 100 bps (the build's rate), floor.
  assert.equal(bnb.volumeRaw, ((10_000_000_000_000_000n * 10_000n) / 100n + (2000n * 10_000n) / 100n).toString());
  assert.equal(bnb.asset, "BNB");
  assert.ok(Math.abs(bnb.usd.fee - 6.0000000000012) < 1e-6);
  const partnerRow = out.imports.byPartner.find((r) => r.chainId === 56 && r.partnerId === "live-p");
  assert.equal(partnerRow.name, "Live");
  assert.equal(partnerRow.swaps, 1);
  assert.equal(partnerRow.partnerRaw, "500");
  assert.equal(partnerRow.earnedRaw, "500");
  assert.equal(partnerRow.paidRaw, "500", "landed payout minus its gen-8 part");
  assert.equal(partnerRow.owedRaw, "0");
  const none = out.imports.byPartner.find((r) => r.chainId === 56 && r.partnerId === "");
  assert.equal(none.swaps, 1);
  assert.deepEqual(out.imports.byHost.filter((r) => r.chainId === 56).map((r) => [r.host, r.swaps]), [["widget.site", 2]]);

  const g = out.gen8.byChain.find((r) => r.chainId === 56);
  assert.equal(out.gen8.available, true);
  assert.equal(g.swaps, 2, "the untagged trade is not a widget swap");
  assert.equal(g.bondingSwaps, 1);
  assert.equal(g.postSwaps, 1);
  assert.equal(g.volumeRaw, "3000000");
  assert.equal(g.feeRaw, "40000");
  assert.equal(g.protocolRaw, "11000");
  assert.equal(g.partnerRaw, "5000");
  assert.equal(g.netRaw, "6000");
  const gp = out.gen8.byPartner.find((r) => r.partnerId === "live-p");
  assert.equal(gp.earnedRaw, "5000");
  assert.equal(gp.paidRaw, "200");
  assert.equal(gp.owedRaw, "4800");
  assert.deepEqual(out.gen8.byHost.map((r) => [r.host, r.swaps]).sort(), [["", 1], ["gen8.site", 1]]);
  assert.equal(out.totals.swaps, 4);
  assert.equal(typeof out.totals.usd.net, "number");
});

test("usage: series per day zero-filled, funnel load -> quote -> build -> landed, by chain / partner / website, filters", async () => {
  resetWidgetTrackingState();
  await db.query("delete from public.widget_usage_daily");
  await db.query(`insert into public.widget_usage_daily (day, chain_id, partner_id, host, event, count) values
    ($1, 56, '', 'widget.site', 'load', 40), ($1, 56, '', 'widget.site', 'quote', 20), ($1, 56, '', 'widget.site', 'build', 4),
    ($1, 56, 'live-p', 'p.site', 'load', 10), ($1, 101, '', '', 'bonding_trade', 2), ($1::date - 1, 56, '', 'widget.site', 'load', 5)`, [today]);
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 2 * 86_400_000).toISOString().slice(0, 10);
  const out = await buildWidgetUsage({ db, from, to: today });
  assert.equal(out.series.length, 3);
  assert.deepEqual(out.series.map((d) => d.load), [0, 5, 50]);
  assert.equal(out.totals.load, 55);
  assert.equal(out.totals.bonding_trade, 2);
  // Landed: imports a1 + partner row + internal row (usage counts every widget swap) and the two tagged gen-8 trades.
  assert.equal(out.totals.landed, 5);
  assert.deepEqual(out.funnel.map((s) => [s.step, s.count]), [["load", 55], ["quote", 20], ["build", 4], ["landed", 5]]);
  assert.equal(out.funnel[1].rateFromPrevious, 20 / 55);
  assert.deepEqual(out.byChain.map((r) => [r.chainId, r.load, r.landed]), [[56, 55, 5], [101, 0, 0]]);
  const live = out.byPartner.find((r) => r.partnerId === "live-p");
  assert.equal(live.name, "Live");
  assert.equal(live.load, 10);
  assert.equal(live.landed, 2, "the partner-credited import and the gen-8 swap built for the partner");
  assert.equal(out.topHosts[0].host, "widget.site");
  const only = await buildWidgetUsage({ db, from, to: today, chainId: 101 });
  assert.equal(only.totals.load, 0);
  assert.equal(only.totals.bonding_trade, 2);
  const none = await buildWidgetUsage({ db, from, to: today, partner: "" });
  assert.equal(none.totals.load, 45);
  assert.deepEqual(funnelOf({ load: 0, quote: 0, build: 0, landed: 0 })[1].rateFromPrevious, null);
  assert.deepEqual(widgetWindow({ from: "2026-10-01", to: "2026-10-23T23:59:59.999Z" }), { from: "2026-10-01", to: "2026-10-23" });
  assert.throws(() => widgetWindow({ from: "2026-10-23", to: "2026-10-01" }), /after/);
  assert.throws(() => widgetWindow({ from: "2024-01-01", to: "2026-10-01" }), /at most/);
});
