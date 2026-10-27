// Swap widget tracking against a throwaway local Postgres (scripts/dbc/throwaway-postgres.mjs) with the real
// migrations: the batched rollup, the 500-site cap, partner only when active, the ledger, the fee scanner's
// wallet-bound widget marks and their 7-day retry (amounts and partner logic unchanged), the 30-day retention of
// unmatched builds, the admin read models' maths (hook filter, own wallets and test coins left out in both views), and
// everything still working on a database without the widget SQL. Never connects to staging or production; no RPC
// (the scanner gets a fake one).
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
const gen8Sql = migration("20261011_000010_evm_gen8_indexer.sql");
const accrualsStart = gen8Sql.indexOf("create table if not exists public.evm_gen8_fee_accruals");
await db.query(gen8Sql.slice(accrualsStart, gen8Sql.indexOf("\n);", accrualsStart) + 3));
await db.query(migration("20261022_000010_gen8_partner_fees.sql"));

/** The widget migration as the Supabase SQL editor runs it: part 1 (one transaction), then part 2 (one transaction). */
async function applyWidgetMigration(pool) {
  const sql = migration("20261023_000020_widget_analytics.sql");
  assert.ok(!/CREATE INDEX CONCURRENTLY/.test(sql.replace(/^\s*--.*$/gm, "")), "no CONCURRENTLY: the SQL editor wraps every run in a transaction");
  const end = sql.indexOf("\nCOMMIT;\n") + "\nCOMMIT;\n".length;
  await pool.query(sql.slice(0, end));
  const part2 = sql.slice(end);
  assert.match(part2, /BEGIN;[\s\S]*VALIDATE CONSTRAINT[\s\S]*CREATE INDEX IF NOT EXISTS[\s\S]*COMMIT;/, "part 2 is its own transaction");
  await pool.query(part2);
}

// A second database with the same schema but WITHOUT the widget SQL: tracking and the scanner must keep working.
await db.query("create database nowidget");
const bare = new Pool({ connectionString: pg.url.replace(/\/mwz$/, "/nowidget"), ssl: false });
await bare.query(`create table public.campaigns (chain_id integer, campaign_address text, token_address text, creator_address text, meta jsonb not null default '{}'::jsonb)`);
for (const name of BASE) await bare.query(migration(name));

await applyWidgetMigration(db);
await applyWidgetMigration(db); // idempotent

test.after(async () => {
  await bare.end().catch(() => {});
  await pg.stop();
});

const { flushWidgetTracking, observeWidgetRequest, queueWidgetBuild, queueWidgetUsage, resetWidgetTrackingState } = await import("./widgetTracking.js");
const { deleteUnmatchedWidgetBuilds, recordWidgetBuilds } = await import("./widgetSwapLedger.js");
const { ingestImportSwapFees, VAULT_DEPOSIT_TOPIC } = await import("./financeImportSwapFees.js");
const { evmFingerprint } = await import("./importSwapFingerprint.js");
const { buildWidgetFinance, buildWidgetUsage, funnelOf, widgetWindow } = await import("./widgetAnalytics.js");
const { GEN8_REFERRER_WIDGET } = await import("../../shared/evmGen8Swap.mjs");

const KYBER = "0x6131b5fae19ea4f9d964eac0408e4408b66337b5";
const VAULT = "0x00000000000000000000000000000000000000aa";
const HOOK = "0x" + "99".repeat(20);
const OTHER_HOOK = "0x" + "98".repeat(20);
const HOOKS = [{ chainId: 56, hook: HOOK }];
const A = "0x" + "a1".repeat(20);
const B = "0x" + "b2".repeat(20);
const TOKEN = "0x" + "cc".repeat(20);
const HIDDEN = "0x" + "dd".repeat(20);
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
const flush = (opts = {}) => flushWidgetTracking({ db, force: true, ...opts });

test("migration: CHECK validated, the three concurrent indexes valid, RLS on", async () => {
  const check = await db.query(`select convalidated from pg_constraint where conname = 'finance_import_swap_fees_widget_check'`);
  assert.equal(check.rows[0].convalidated, true);
  const idx = await db.query(`select c.relname, i.indisvalid from pg_index i join pg_class c on c.oid = i.indexrelid
    where c.relname in ('finance_import_swap_fees_widget_idx', 'finance_import_swap_fees_widget_build_idx', 'evm_gen8_fee_accruals_widget_idx') order by 1`);
  assert.deepEqual(idx.rows.map((r) => [r.relname, r.indisvalid]), [["evm_gen8_fee_accruals_widget_idx", true], ["finance_import_swap_fees_widget_build_idx", true], ["finance_import_swap_fees_widget_idx", true]]);
  const rls = await db.query(`select relname, relrowsecurity from pg_class where relname in ('widget_usage_daily', 'widget_swap_builds') order by 1`);
  assert.deepEqual(rls.rows.map((r) => r.relrowsecurity), [true, true]);
});

test("rollup: counts add up in memory and land in one upsert per flush, on top of what is stored", async () => {
  resetWidgetTrackingState();
  await db.query("delete from public.widget_usage_daily");
  for (let i = 0; i < 3; i += 1) queueWidgetUsage({ chainId: 56, host: "site.xyz", event: "load" }, { loop: false });
  queueWidgetUsage({ chainId: 56, host: "site.xyz", event: "quote" }, { loop: false });
  queueWidgetUsage({ chainId: 101, host: "", event: "load" }, { loop: false });
  assert.equal((await flush()).usageRows, 3);
  queueWidgetUsage({ chainId: 56, host: "site.xyz", event: "load" }, { loop: false });
  await flush();
  assert.deepEqual(await usageRows(), [
    { chain_id: 56, partner_id: "", host: "site.xyz", event: "load", n: 4 },
    { chain_id: 56, partner_id: "", host: "site.xyz", event: "quote", n: 1 },
    { chain_id: 101, partner_id: "", host: "", event: "load", n: 1 },
  ]);
  assert.equal(queueWidgetUsage({ chainId: 1, event: "load" }, { loop: false }), false, "not a widget chain");
  assert.equal(queueWidgetUsage({ chainId: 56, event: "click" }, { loop: false }), false, "not an event");
});

test("cap: a (day, chain) never gets more than the cap of named websites; the rest count as 'other'; '' stays itself", async () => {
  resetWidgetTrackingState();
  await db.query("delete from public.widget_usage_daily");
  for (const host of ["one.com", "two.com", "three.com", "four.com"]) queueWidgetUsage({ chainId: 4663, host, event: "load" }, { loop: false });
  queueWidgetUsage({ chainId: 56, host: "five.com", event: "load" }, { loop: false });
  await flush({ cap: 2 });
  queueWidgetUsage({ chainId: 4663, host: "one.com", event: "quote" }, { loop: false });
  queueWidgetUsage({ chainId: 4663, host: "zeta.com", event: "load" }, { loop: false });
  queueWidgetUsage({ chainId: 4663, host: "", event: "load" }, { loop: false });
  await flush({ cap: 2 });
  // Within one batch new sites are taken in name order: four.com and one.com; then the cap is full.
  assert.deepEqual((await usageRows()).map((r) => `${r.chain_id}:${r.host}:${r.event}:${r.n}`), [
    "56:five.com:load:1",
    "4663::load:1",
    "4663:four.com:load:1",
    "4663:one.com:load:1",
    "4663:one.com:quote:1",
    "4663:other:load:3",
  ]);
});

test("partner: counted only when the partner row exists and is active on that chain (cached list, checked at flush)", async () => {
  resetWidgetTrackingState();
  await db.query(`insert into public.import_fee_partners (id, chain_id, name, payout_wallet, active) values
    ('live-p', 56, 'Live', $1, true), ('off-p', 56, 'Off', $1, false), ('live-p', 4663, 'Live RH', $1, false)`, [A]);
  await db.query("delete from public.widget_usage_daily");
  const req = (partner, chainId = 56) => ({ method: "POST", headers: { origin: "https://p.site" }, body: { chainId, partner } });
  for (const [partner, chainId] of [["live-p", 56], ["LIVE-P", 56], ["off-p", 56], ["ghost", 56], ["live-p", 4663]]) {
    observeWidgetRequest({ spec: { event: "quote" }, req: req(partner, chainId), status: 200 }, { queueUsage: (x) => queueWidgetUsage(x, { loop: false }) });
  }
  await flush();
  assert.deepEqual((await usageRows()).map((r) => `${r.chain_id}:${r.partner_id}:${r.n}`), ["56::2", "56:live-p:2", "4663::1"]);
});

const word = (n) => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
const pad = (address) => `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;

/** A fake BSC RPC: Kyber deposits into the ImportFeeVault. */
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
// a1: A lands A's widget build. b2: B lands the same bytes (A's build). c3: A, its build arrives only after the scan.
const TXS = [
  { hash: "0x" + "a1".repeat(32), from: A, data: "0x1111", value: "0x0de0b6b3a7640000", fee: 10_000_000_000_000_000n },
  { hash: "0x" + "b2".repeat(32), from: B, data: "0x1111", value: "0x0de0b6b3a7640000", fee: 10_000_000_000_000_001n },
  { hash: "0x" + "c3".repeat(32), from: A, data: "0x2222", value: "0x0", fee: 3_000n },
];
const buildAnswer = (data, value) => ({
  spec: { event: "build" },
  req: { method: "POST", headers: { origin: "https://www.widget.site" }, body: { chainId: 56, wallet: A.toUpperCase().replace("0X", "0x"), side: "buy", token: TOKEN, quote: { amountIn: "1000000000000000000", extraFee: { feeAmount: "100", isInBps: true } } } },
  status: 200,
  payload: JSON.stringify({ ok: true, chainId: 56, to: KYBER, data, value }),
});
const queueOnly = { queueUsage: (x) => queueWidgetUsage(x, { loop: false }), queueBuild: (x) => queueWidgetBuild(x, { loop: false }) };

test("scanner: only a fee row whose fingerprint AND landed wallet match a widget build is marked; amounts and partner logic unchanged", async () => {
  resetWidgetTrackingState();
  observeWidgetRequest(buildAnswer("0x1111", "1000000000000000000"), queueOnly);
  await flush();
  const stored = (await db.query(`select fingerprint, wallet, host, fee_bps, kind from public.widget_swap_builds`)).rows;
  assert.deepEqual(stored, [{ fingerprint: evmFingerprint(KYBER, "0x1111", "0x0de0b6b3a7640000"), wallet: A, host: "widget.site", fee_bps: 100, kind: "import" }]);

  const out = await ingestImportSwapFees({ db, chainId: 56, env: ENV, rpc: fakeRpc(TXS) });
  assert.equal(out.split[0].inserted, 3);
  assert.equal(out.widgetMarked, 1);
  const rows = (await db.query(`select tx_hash, fee_raw::text, creator_raw::text, partner_raw::text, partner_id, swap_source, widget_host, widget_build_id is not null as linked, landed_fingerprint is not null as fp from public.finance_import_swap_fees order by tx_hash`)).rows;
  assert.deepEqual(rows, [
    { tx_hash: TXS[0].hash, fee_raw: "10000000000000000", creator_raw: "5000000000000000", partner_raw: "0", partner_id: null, swap_source: "widget", widget_host: "widget.site", linked: true, fp: true },
    { tx_hash: TXS[1].hash, fee_raw: "10000000000000001", creator_raw: "5000000000000000", partner_raw: "0", partner_id: null, swap_source: null, widget_host: null, linked: false, fp: true },
    { tx_hash: TXS[2].hash, fee_raw: "3000", creator_raw: "1500", partner_raw: "0", partner_id: null, swap_source: null, widget_host: null, linked: false, fp: true },
  ]);
});

test("scanner retry: a build stored after its swap was scanned is marked on the next run; older than 7 days is left alone; idempotent", async () => {
  resetWidgetTrackingState();
  observeWidgetRequest(buildAnswer("0x2222", "0"), queueOnly);
  await flush();
  const again = await ingestImportSwapFees({ db, chainId: 56, env: ENV, rpc: fakeRpc(TXS), fromScratch: true });
  assert.equal(again.split[0].inserted, 0, "nothing new stored");
  assert.equal(again.widgetMarked, 1, "c3 is marked now");
  const c3 = (await db.query(`select swap_source, widget_host, fee_raw::text, creator_raw::text from public.finance_import_swap_fees where tx_hash = $1`, [TXS[2].hash])).rows[0];
  assert.deepEqual(c3, { swap_source: "widget", widget_host: "widget.site", fee_raw: "3000", creator_raw: "1500" });
  // An old row with a matching build is outside the 7-day look-back.
  const old = evmFingerprint(KYBER, "0x3333", "0");
  await recordWidgetBuilds(db, [{ fingerprint: old, chainId: 56, wallet: A, host: "old.site" }]);
  await db.query(`insert into public.finance_import_swap_fees (chain_id, tx_hash, log_index, occurred_at, wallet, fee_raw, fee_asset, fee_receiver, source, landed_fingerprint)
    values (56, '0xold', 0, now() - interval '8 days', $1, 10, 'BNB', $2, 'evm_vault_deposit', $3)`, [A, VAULT, old]);
  const third = await ingestImportSwapFees({ db, chainId: 56, env: ENV, rpc: fakeRpc(TXS), fromScratch: true });
  assert.equal(third.widgetMarked, undefined, "nothing left to mark");
  assert.equal((await db.query(`select swap_source from public.finance_import_swap_fees where tx_hash = '0xold'`)).rows[0].swap_source, null);
});

test("scanner and tracking on a database without the widget SQL: same rows as before, nothing marked, nothing thrown", async () => {
  resetWidgetTrackingState();
  await quietly(async () => {
    queueWidgetUsage({ chainId: 56, event: "load" }, { loop: false });
    const flushed = await flushWidgetTracking({ db: bare, force: true });
    assert.equal(flushed.usageRows, 0);
    assert.equal(await recordWidgetBuilds(bare, [{ fingerprint: "evm:" + "1".repeat(64), chainId: 56, wallet: A }]), null);
    const out = await ingestImportSwapFees({ db: bare, chainId: 56, env: ENV, rpc: fakeRpc(TXS) });
    assert.equal(out.split[0].inserted, 3);
    assert.equal(out.widgetMarked, undefined);
  });
  const rows = (await bare.query(`select tx_hash, fee_raw::text, creator_raw::text from public.finance_import_swap_fees order by tx_hash`)).rows;
  assert.deepEqual(rows.map((r) => [r.fee_raw, r.creator_raw]), [["10000000000000000", "5000000000000000"], ["10000000000000001", "5000000000000000"], ["3000", "1500"]]);
  const usage = await buildWidgetUsage({ db: bare, from: today, to: today, hooks: HOOKS });
  assert.equal(usage.schemaMissing, true);
  assert.equal(usage.series.length, 1);
  const finance = await buildWidgetFinance({ db: bare, from: today, to: today, hooks: HOOKS });
  assert.equal(finance.schemaMissing, true);
  resetWidgetTrackingState();
});

// Stub price service: 1 BNB = $600, 1 ETH = $3000 at every hour (financePrices.js valueEvents shape).
const prices = {
  async valueEvents(asset, buckets, decimals) {
    const usd = { BNB: 600, ETH: 3000, SOL: 150 }[asset];
    const raw = buckets.reduce((s, b) => s + BigInt(b.raw), 0n);
    return { amountUsd: (Number(raw) / 10 ** decimals) * usd, priceBasis: "event_time" };
  },
};

test("finance: per chain / partner / website, volume from the fee rate, net = fee - creator - partner; gen-8 by tag and hook; partner ledger", async () => {
  // A partner-credited widget swap on 56 (the partner logic already set partner_id / partner_raw on the fee row), and
  // one by our own wallet.
  const build = (await db.query(`select id from public.widget_swap_builds where fingerprint = $1`, [evmFingerprint(KYBER, "0x1111", "0x0de0b6b3a7640000")])).rows[0].id;
  await db.query(
    `insert into public.finance_import_swap_fees (chain_id, tx_hash, log_index, occurred_at, wallet, token_address, side, fee_raw, fee_asset, fee_receiver, router, source, creator_raw, partner_id, partner_raw, swap_source, widget_host, widget_build_id, internal_wallet)
     values (56, '0xpartner', 0, now(), $1, $2, 'buy', 2000, 'BNB', $3, $4, 'evm_vault_deposit', 1000, 'live-p', 500, 'widget', 'widget.site', $5, false),
            (56, '0xinternal', 0, now(), $1, $2, 'buy', 9999, 'BNB', $3, $4, 'evm_vault_deposit', 0, null, 0, 'widget', 'widget.site', $5, true)`,
    [A, TOKEN, VAULT, KYBER, build],
  );
  await db.query(`insert into public.campaigns (chain_id, campaign_address, token_address, meta) values (56, $1, $1, '{"publicHidden": true}'::jsonb)`, [HIDDEN]);
  const acc = async (tx, phase, referrer, volume, fee, creator, protocol, { hook = HOOK, token = TOKEN } = {}) => (await db.query(
    `insert into public.evm_gen8_fee_accruals (chain_id, hook_address, pool_id, token_address, tx_hash, log_index, block_number, block_time, kind, phase, trader, referrer, side, curve_amount, fee, creator_share, router_amount, protocol)
     values (56, $1, 'pool', $2, $3, 0, 1, now(), 'trade', $4, $5, $6, 'buy', $7::numeric, $8::numeric, $9::numeric, $8::numeric - $9::numeric, $10::numeric) returning id`,
    [hook, token, tx, phase, A, referrer, volume, fee, creator, protocol],
  )).rows[0].id;
  await acc("0xg1", "bonding", GEN8_REFERRER_WIDGET.toLowerCase(), "1000000", "20000", "11200", "1000");
  const post = await acc("0xg2", "post", GEN8_REFERRER_WIDGET, "2000000", "20000", "10000", "10000");
  await acc("0xg3", "post", null, "5000000", "50000", "25000", "25000");
  await acc("0xg4", "post", GEN8_REFERRER_WIDGET, "7000000", "70000", "35000", "35000", { hook: OTHER_HOOK });
  await acc("0xg5", "post", GEN8_REFERRER_WIDGET, "9000000", "90000", "45000", "45000", { token: HIDDEN });
  const gfp = evmFingerprint(KYBER, "0x4444", "0");
  await db.query(`insert into public.widget_swap_builds (fingerprint, chain_id, kind, wallet, host, partner_id) values ($1, 56, 'gen8', $2, 'gen8.site', 'live-p')`, [gfp, A]);
  await db.query(`insert into public.gen8_partner_fees (chain_id, hook_address, accrual_id, tx_hash, log_index, token_address, partner_id, fingerprint, curve_amount, partner_raw, block_time)
    values (56, $1, $2, '0xg2', 0, $3, 'live-p', $4, 2000000, 5000, now())`, [HOOK, post, TOKEN, gfp]);
  await db.query(`insert into public.import_fee_transfers (chain_id, kind, from_address, to_address, amount_raw, status, partner_id, gen8_raw)
    select 56, 'partner', $1, $2, 700, 'landed', 'live-p', 200`, [VAULT, A]);

  const out = await buildWidgetFinance({ db, from: today, to: today, prices, hooks: HOOKS });
  assert.equal(out.schemaMissing, false);
  const bnb = out.imports.byChain.find((r) => r.chainId === 56);
  // a1 (fee 1e16, creator 5e15) + c3 (3000 / 1500) + the partner row (2000 / 1000 / 500). Our own wallet left out.
  const fee = 10_000_000_000_000_000n + 3000n + 2000n;
  const creator = 5_000_000_000_000_000n + 1500n + 1000n;
  assert.equal(bnb.swaps, 3);
  assert.equal(bnb.feeRaw, fee.toString());
  assert.equal(bnb.creatorRaw, creator.toString());
  assert.equal(bnb.partnerRaw, "500");
  assert.equal(bnb.netRaw, (fee - creator - 500n).toString());
  // Volume: fee x 10000 / 100 bps (the build's rate), floor.
  assert.equal(bnb.volumeRaw, ((10_000_000_000_000_000n * 10_000n) / 100n + (3000n * 10_000n) / 100n + (2000n * 10_000n) / 100n).toString());
  assert.equal(bnb.asset, "BNB");
  assert.ok(Math.abs(bnb.usd.fee - (Number(fee) / 1e18) * 600) < 1e-6);
  const partnerRow = out.imports.byPartner.find((r) => r.chainId === 56 && r.partnerId === "live-p");
  assert.equal(partnerRow.name, "Live");
  assert.equal(partnerRow.swaps, 1);
  assert.equal(partnerRow.partnerRaw, "500");
  assert.equal(partnerRow.earnedRaw, "500");
  assert.equal(partnerRow.paidRaw, "500", "landed payout minus its gen-8 part");
  assert.equal(partnerRow.owedRaw, "0");
  assert.equal(out.imports.byPartner.find((r) => r.chainId === 56 && r.partnerId === "").swaps, 2);
  assert.deepEqual(out.imports.byHost.filter((r) => r.chainId === 56).map((r) => [r.host, r.swaps]), [["widget.site", 3]]);

  const g = out.gen8.byChain.find((r) => r.chainId === 56);
  assert.equal(out.gen8.available, true);
  assert.equal(g.swaps, 2, "untagged, other-hook and test-coin trades are not counted");
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
  assert.equal(out.totals.swaps, 5);
  assert.equal(typeof out.totals.usd.net, "number");
  const noHooks = await buildWidgetFinance({ db, from: today, to: today, prices, hooks: [] });
  assert.equal(noHooks.gen8.byChain.length, 0, "no configured hook, no gen-8 rows");
});

test("usage: series per day zero-filled; landed = the finance view's swaps (same partner, same exclusions); filters", async () => {
  resetWidgetTrackingState();
  await db.query("delete from public.widget_usage_daily");
  await db.query(`insert into public.widget_usage_daily (day, chain_id, partner_id, host, event, count) values
    ($1, 56, '', 'widget.site', 'load', 40), ($1, 56, '', 'widget.site', 'quote', 20), ($1, 56, '', 'widget.site', 'build', 4),
    ($1, 56, 'live-p', 'p.site', 'load', 10), ($1, 101, '', '', 'bonding_trade', 2), ($1::date - 1, 56, '', 'widget.site', 'load', 5)`, [today]);
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 2 * 86_400_000).toISOString().slice(0, 10);
  const out = await buildWidgetUsage({ db, from, to: today, hooks: HOOKS });
  assert.equal(out.series.length, 3);
  assert.deepEqual(out.series.map((d) => d.load), [0, 5, 50]);
  assert.equal(out.totals.load, 55);
  assert.equal(out.totals.bonding_trade, 2);
  const finance = await buildWidgetFinance({ db, from, to: today, hooks: HOOKS });
  assert.equal(out.totals.landed, finance.totals.swaps, "usage landed = finance swaps");
  assert.equal(out.totals.landed, 5);
  assert.deepEqual(out.funnel.map((s) => [s.step, s.count]), [["load", 55], ["quote", 20], ["build", 4], ["landed", 5]]);
  assert.equal(out.funnel[1].rateFromPrevious, 20 / 55);
  assert.deepEqual(out.byChain.map((r) => [r.chainId, r.load, r.landed]), [[56, 55, 5], [101, 0, 0]]);
  const live = out.byPartner.find((r) => r.partnerId === "live-p");
  assert.equal(live.name, "Live");
  assert.equal(live.load, 10);
  assert.equal(live.landed, 2, "the partner-paid import and the gen-8 partner swap");
  assert.equal(out.topHosts[0].host, "widget.site");
  const only = await buildWidgetUsage({ db, from, to: today, chainId: 101, hooks: HOOKS });
  assert.equal(only.totals.load, 0);
  assert.equal(only.totals.bonding_trade, 2);
  const none = await buildWidgetUsage({ db, from, to: today, partner: "", hooks: HOOKS });
  assert.equal(none.totals.load, 45);
  assert.equal(none.totals.landed, 3);
  assert.deepEqual(funnelOf({ load: 0, quote: 0, build: 0, landed: 0 })[1].rateFromPrevious, null);
  assert.deepEqual(widgetWindow({ from: "2026-10-01", to: "2026-10-23T23:59:59.999Z" }), { from: "2026-10-01", to: "2026-10-23" });
  assert.throws(() => widgetWindow({ from: "2026-10-23", to: "2026-10-01" }), /after/);
  assert.throws(() => widgetWindow({ from: "2024-01-01", to: "2026-10-01" }), /at most/);
});

test("retention: unmatched builds older than 30 days are deleted (bounded); matched and recent ones stay", async () => {
  const fp = (n) => `evm:${String(n).padStart(64, "e")}`;
  await recordWidgetBuilds(db, [
    { fingerprint: fp(1), chainId: 56, wallet: A, host: "x" },
    { fingerprint: fp(2), chainId: 56, wallet: A, host: "x" },
    { fingerprint: fp(3), chainId: 56, wallet: A, host: "x" },
    { fingerprint: fp(4), chainId: 56, wallet: A, host: "x", kind: "gen8" },
    { fingerprint: fp(5), chainId: 56, wallet: A, host: "x" },
  ]);
  await db.query(`update public.widget_swap_builds set created_at = now() - interval '31 days' where fingerprint = any($1::text[])`, [[fp(1), fp(2), fp(4), fp(5)]]);
  const matched = (await db.query(`select id from public.widget_swap_builds where fingerprint = $1`, [fp(2)])).rows[0].id;
  await db.query(`insert into public.finance_import_swap_fees (chain_id, tx_hash, log_index, occurred_at, wallet, fee_raw, fee_asset, fee_receiver, source, swap_source, widget_build_id)
    values (56, '0xkept', 0, now() - interval '31 days', $1, 10, 'BNB', $2, 'evm_vault_deposit', 'widget', $3)`, [A, VAULT, matched]);
  const accrual = (await db.query(`select id from public.evm_gen8_fee_accruals where tx_hash = '0xg3'`)).rows[0].id;
  await db.query(`insert into public.gen8_partner_fees (chain_id, hook_address, accrual_id, tx_hash, log_index, token_address, partner_id, fingerprint, curve_amount, partner_raw, block_time)
    values (56, $1, $2, '0xg3', 0, $3, 'live-p', $4, 5000000, 1, now())`, [HOOK, accrual, TOKEN, fp(4)]);
  assert.equal(await deleteUnmatchedWidgetBuilds(db, { limit: 1 }), 1, "bounded batch");
  assert.equal(await deleteUnmatchedWidgetBuilds(db), 1);
  assert.equal(await deleteUnmatchedWidgetBuilds(db), 0, "idempotent");
  const left = (await db.query(`select fingerprint from public.widget_swap_builds where fingerprint = any($1::text[]) order by fingerprint`, [[fp(1), fp(2), fp(3), fp(4), fp(5)]])).rows.map((r) => r.fingerprint);
  assert.deepEqual(left, [fp(2), fp(3), fp(4)], "matched import, recent, matched gen-8 stay; the two old unmatched are gone");
});
