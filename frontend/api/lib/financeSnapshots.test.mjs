import assert from "node:assert/strict";
import test from "node:test";

import { ageSnapshotMeta, createSnapshotCache, jsonCopy, snapshotKeys, snapshotMeta, trackSnapshots } from "./financeSnapshots.js";
import { buildFeeRouting, feeRoutingNetwork } from "./financeFeeRouting.js";
import { buildPayouts } from "./financePayouts.js";
import { buildFinanceSummary } from "./financeSummary.js";
import { evmFeeRoutingRegistry, evmGetterSelector } from "./financeFeeRoutingEvm.js";
import { createPriceService } from "./financePrices.js";
import { createEurUsdSource, mergeRates } from "./financeAccountingFx.js";

const NOW = "2026-10-06T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);

// An in-memory public.finance_snapshots that answers the cache's three statements.
function snapshotTable({ missing = false } = {}) {
  const rows = new Map();
  const log = [];
  return {
    rows,
    log,
    async query(sql, params) {
      log.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
      if (missing) throw Object.assign(new Error("relation does not exist"), { code: "42P01" });
      if (/^select payload, built_at/.test(sql.trim())) {
        const row = rows.get(params[0]);
        return { rows: row ? [{ ...row, payload: row.payload == null ? null : JSON.parse(row.payload) }] : [] };
      }
      if (/insert into public\.finance_snapshots \(key, kind, payload/.test(sql)) {
        rows.set(params[0], { kind: params[1], payload: params[2], built_at: new Date(params[3]), error: null, error_at: null });
        return { rows: [] };
      }
      if (/insert into public\.finance_snapshots \(key, kind, error/.test(sql)) {
        const row = rows.get(params[0]) || { kind: params[1], payload: null, built_at: null };
        rows.set(params[0], { ...row, error: params[2], error_at: new Date(NOW_MS + 1) });
        return { rows: [] };
      }
      if (/from public\.finance_snapshots order by key/.test(sql)) {
        return { rows: [...rows.entries()].map(([key, r]) => ({ key, kind: r.kind, built_at: r.built_at, build_ms: 1, error: r.error, error_at: r.error_at })) };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a stored snapshot is served from the database without calling the builder", async () => {
  const db = snapshotTable();
  let builds = 0;
  const build = async () => { builds += 1; return { total: "1.5", unknown: null, list: [1, 2] }; };
  const first = createSnapshotCache({ db, nowMs: () => NOW_MS });
  assert.deepEqual(await first.get("k", "test", build), { total: "1.5", unknown: null, list: [1, 2] });
  assert.equal(builds, 1);
  // A new process (after a redeploy): the row is read, the builder is not called.
  const second = createSnapshotCache({ db, nowMs: () => NOW_MS + 1000 });
  assert.deepEqual(await second.get("k", "test", build), { total: "1.5", unknown: null, list: [1, 2] });
  assert.equal(builds, 1);
});

test("concurrent callers share one live build", async () => {
  const db = snapshotTable();
  let builds = 0;
  const cache = createSnapshotCache({ db, nowMs: () => NOW_MS });
  const build = async () => { builds += 1; await tick(); return { n: builds }; };
  const results = await Promise.all([cache.get("k", "t", build), cache.get("k", "t", build), cache.get("k", "t", build)]);
  assert.equal(builds, 1);
  assert.deepEqual(results, [{ n: 1 }, { n: 1 }, { n: 1 }]);
});

test("an old snapshot is served at once and rebuilt in the background", async () => {
  const db = snapshotTable();
  let now = NOW_MS;
  const writer = createSnapshotCache({ db, nowMs: () => now });
  await writer.get("k", "t", async () => ({ v: "old" }));
  now += 6 * 60_000; // older than the 5 minute refresh
  const reader = createSnapshotCache({ db, nowMs: () => now });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let builds = 0;
  const build = async () => { builds += 1; await gate; return { v: "new" }; };
  assert.deepEqual(await reader.get("k", "t", build), { v: "old" }, "never waits on the rebuild");
  assert.equal(builds, 1, "one background rebuild");
  assert.deepEqual(await reader.get("k", "t", build), { v: "old" });
  assert.equal(builds, 1, "not started twice");
  release();
  await tick(); await tick();
  assert.equal(JSON.parse(db.rows.get("k").payload).v, "new");
});

test("stale data is flagged, not blocked on", async () => {
  const db = snapshotTable();
  let now = NOW_MS;
  const cache = createSnapshotCache({ db, nowMs: () => now, background: false });
  await cache.get("a", "t", async () => ({ v: 1 }));
  now += 20 * 60_000;
  const reader = createSnapshotCache({ db, nowMs: () => now, background: false });
  const { value, used } = await trackSnapshots(() => reader.get("a", "t", async () => { throw new Error("must not be called"); }));
  assert.deepEqual(value, { v: 1 });
  const meta = snapshotMeta(used, { nowMs: now });
  assert.equal(meta.asOf, NOW);
  assert.equal(meta.stale, true);
  assert.equal(meta.ageSeconds, 1200);
});

test("a failed rebuild keeps the last good payload and records the error", async () => {
  const db = snapshotTable();
  const cache = createSnapshotCache({ db, nowMs: () => NOW_MS });
  await cache.get("k", "t", async () => ({ v: "good" }));
  await assert.rejects(cache.refresh("k", "t", async () => { throw new Error("rpc down"); }), /rpc down/);
  assert.equal(JSON.parse(db.rows.get("k").payload).v, "good");
  assert.equal(db.rows.get("k").error, "rpc down");
  const fresh = createSnapshotCache({ db, nowMs: () => NOW_MS });
  assert.deepEqual(await fresh.get("k", "t", async () => { throw new Error("not called"); }), { v: "good" });
});

test("no snapshot and a failing source: the error is returned, and not retried on every request", async () => {
  const db = snapshotTable();
  let now = NOW_MS;
  const cache = createSnapshotCache({ db, nowMs: () => now });
  let calls = 0;
  const build = async () => { calls += 1; throw new Error("indexer 401"); };
  await assert.rejects(cache.get("k", "t", build), /indexer 401/);
  await assert.rejects(cache.get("k", "t", build), /indexer 401/);
  assert.equal(calls, 1);
  now += 61_000;
  await assert.rejects(cache.get("k", "t", build), /indexer 401/);
  assert.equal(calls, 2);
});

test("without the table (migration not applied) the cache works in the process only", async () => {
  const db = snapshotTable({ missing: true });
  let now = NOW_MS;
  const cache = createSnapshotCache({ db, nowMs: () => now });
  let builds = 0;
  const build = async () => { builds += 1; return { n: builds }; };
  assert.deepEqual(await cache.get("k", "t", build), { n: 1 });
  assert.deepEqual(await cache.get("k", "t", build), { n: 1 });
  assert.equal(builds, 1);
  now += 61_000;
  assert.deepEqual(await cache.get("k", "t", build), { n: 1 }, "old copy served while it rebuilds");
  await tick();
  assert.equal(builds, 2);
  const listed = await cache.list();
  assert.equal(listed.installed, false);
});

test("snapshot block: oldest source, recomputed age", () => {
  const used = [
    { key: "fee-routing:56::30", builtAt: "2026-10-06T11:58:00.000Z", source: "db" },
    { key: "payouts:56::30", builtAt: "2026-10-06T11:55:00.000Z", source: "db" },
  ];
  const meta = snapshotMeta(used, { nowMs: NOW_MS });
  assert.equal(meta.asOf, "2026-10-06T11:55:00.000Z");
  assert.equal(meta.ageSeconds, 300);
  assert.equal(meta.stale, false);
  assert.equal(snapshotMeta([]), null);
  assert.equal(ageSnapshotMeta(meta, { nowMs: NOW_MS + 20 * 60_000 }).stale, true);
  assert.equal(snapshotKeys.feeRouting({ chainId: 101, cluster: "mainnet-beta" }, 30), "fee-routing:101:mainnet-beta:30");
});

// ---------------------------------------------------------------------------
// Same numbers: a fresh snapshot gives what the live read gives.

const prices = createPriceService({
  spotReaders: {
    SOL: async () => ({ price: 100, source: "spot", at: NOW_MS }),
    BNB: async () => ({ price: 500, source: "spot", at: NOW_MS }),
    ETH: async () => ({ price: 0, source: "none", at: 0 }),
  },
  fetchImpl: async () => { throw new Error("offline"); },
  nowMs: () => NOW_MS,
  env: {},
  historyCache: new Map(),
});

function fixtureDb() {
  const snapshots = snapshotTable();
  return {
    snapshots,
    async query(sql, params) {
      if (/finance_snapshots/.test(sql)) return snapshots.query(sql, params);
      if (/from public\.reward_events/.test(sql)) return { rows: [{ hour: new Date("2026-10-05T10:00:00Z"), n: 3, weekly: "30", monthly: "70", recruiter: "5", airdrop: "0", squad: "1", protocol: "42" }] };
      if (/from public\.league_epoch_winners w/.test(sql)) return { rows: [{ period: "monthly", category: "top_earner", amount_raw: "4711134454742", claimed_at: null, root_at: null, test_coin: false }] };
      return { rows: [] };
    },
  };
}

// Half the BNB balances read, half fail: the failed ones must stay unknown.
function fixtureReaders() {
  let n = 0;
  const registry = evmFeeRoutingRegistry(56);
  return {
    readEvmNative: async () => { n += 1; if (n % 2) throw new Error("rpc down"); return { raw: String(n * 1_000_000_000_000_000), rpc: "fake" }; },
    readEvmToken: async () => ({ raw: "0", rpc: "fake" }),
    readEvmCall: async ({ to, data }) => {
      const spec = registry.wiring.find((w) => w.contract === to && evmGetterSelector(w.getter) === data);
      if (spec) return { hex: `0x${"0".repeat(24)}${String(spec.expected).slice(2).toLowerCase()}`, rpc: "fake" };
      return { hex: `0x${(10_000n * 10n ** 18n).toString(16)}`, rpc: "fake" };
    },
    readEvmCreatorV2Logs: async () => ({ rows: [], complete: true, head: 1, scannedTo: 1 }),
    readEvmCreatorCoins: async () => [],
  };
}

test("fresh snapshot = live read: fee routing, payouts built on it, and the summary", async () => {
  const network = feeRoutingNetwork({ chainId: 56 });
  const db = fixtureDb();
  const live = await buildFeeRouting({ network, days: 30, db, readers: fixtureReaders(), prices, env: {}, now: () => NOW });

  const writer = createSnapshotCache({ db, nowMs: () => NOW_MS });
  await writer.refresh(snapshotKeys.feeRouting(network, 30), "fee-routing", async () => live);
  const reader = createSnapshotCache({ db, nowMs: () => NOW_MS + 60_000 });
  const stored = await reader.get(snapshotKeys.feeRouting(network, 30), "fee-routing", async () => { throw new Error("must come from the table"); });

  assert.deepEqual(stored, jsonCopy(live), "the browser sees the same payload");
  assert.deepEqual(stored.totals, jsonCopy(live.totals));
  const unknown = stored.destinations.flatMap((d) => d.balances).filter((b) => b.status !== "ok" && b.status !== "not_configured");
  assert.ok(unknown.length > 0, "fixture has failed reads");
  for (const b of unknown) {
    assert.equal(b.amount, null, "unknown stays unknown, never 0");
    assert.equal(b.raw, null);
  }

  const payoutArgs = { network, days: 30, db, env: {}, readers: fixtureReaders(), prices, now: () => NOW };
  const payoutsLive = await buildPayouts({ ...payoutArgs, feeRouting: live });
  const payoutsFromSnapshot = await buildPayouts({ ...payoutArgs, readers: fixtureReaders(), feeRouting: stored });
  assert.deepEqual(jsonCopy(payoutsFromSnapshot), jsonCopy(payoutsLive));

  const summaryWith = (feeRouting, payouts) => buildFinanceSummary({
    networks: [{ chainId: 56, chain: "bnb", decimals: 18, asset: "BNB", environment: "mainnet", label: "BNB" }],
    months: 3,
    prices,
    now: NOW_MS,
    readRevenue: async () => ({ lanes: [] }),
    readLpShare: async () => ({ entries: [], unpricedTokenCount: 0 }),
    readFeeRouting: async () => feeRouting,
    readRewards: async () => ({ totals: { outstanding: payouts.totals.owed } }),
  });
  const a = jsonCopy(await summaryWith(live, payoutsLive));
  const b = jsonCopy(await summaryWith(stored, jsonCopy(payoutsLive)));
  delete a.generatedAt; delete b.generatedAt;
  assert.deepEqual(b, a);
});

// ---------------------------------------------------------------------------
// Prices and FX from the database.

test("hourly closes in the store are not fetched again; new ones are stored", async () => {
  const hour = Date.parse("2026-10-01T10:00:00Z");
  const saved = [];
  let fetches = 0;
  const store = {
    load: async () => new Map([[hour, 150]]),
    loadHours: async () => new Map(),
    save: async (asset, rows) => { saved.push(...rows.map((r) => ({ asset, ...r }))); },
  };
  const service = createPriceService({
    spotReaders: { SOL: async () => ({ price: 200, source: "spot", at: NOW_MS }) },
    fetchImpl: async () => { fetches += 1; return { ok: true, json: async () => [[hour + 3_600_000, "0", "0", "0", "160"]] }; },
    nowMs: () => NOW_MS,
    env: {},
    historyCache: new Map(),
    historyStore: store,
  });
  const stored = await service.valueEvents("SOL", [{ hour, raw: "1000000000" }], 9);
  assert.equal(stored.amountUsd, 150);
  assert.equal(fetches, 0, "stored hour: no Binance call");
  const fetched = await service.valueEvents("SOL", [{ hour: hour + 3_600_000, raw: "1000000000" }], 9);
  assert.equal(fetched.amountUsd, 160);
  assert.equal(fetches, 1);
  assert.deepEqual(saved, [{ asset: "SOL", hour: hour + 3_600_000, close: 160 }]);
});

test("spot: concurrent callers share one read", async () => {
  let reads = 0;
  const service = createPriceService({
    spotReaders: { SOL: async () => { reads += 1; await tick(); return { price: 200, source: "spot", at: NOW_MS }; } },
    nowMs: () => NOW_MS,
    env: {},
    historyCache: new Map(),
  });
  const all = await Promise.all(Array.from({ length: 20 }, () => service.valueAtSpot("SOL", "1")));
  assert.equal(reads, 1);
  for (const r of all) assert.equal(r.amountUsd, 200);
});

test("spot: a stored price under 15 minutes old is served while a fresh read runs", async () => {
  let reads = 0;
  const service = createPriceService({
    spotReaders: { SOL: async () => { reads += 1; return { price: 210, source: "spot", at: NOW_MS }; } },
    nowMs: () => NOW_MS,
    env: {},
    historyCache: new Map(),
    spotStore: { load: async () => ({ value: { asset: "SOL", priceUsd: 200, source: "Binance SOLUSDT spot", at: new Date(NOW_MS - 120_000).toISOString() }, readAt: NOW_MS - 120_000 }), save: async () => undefined },
    spotReuseMs: 60_000,
    spotServeStaleMs: 15 * 60_000,
  });
  const first = await service.valueAtSpot("SOL", "1");
  assert.equal(first.amountUsd, 200);
  assert.equal(first.priceAt, new Date(NOW_MS - 120_000).toISOString(), "the figure names the time of its price");
  await tick();
  assert.equal(reads, 1, "refreshed in the background");
  assert.equal((await service.valueAtSpot("SOL", "1")).amountUsd, 210);
});

test("ECB: stored rates fetched within 6 hours are used without a request; a fetch is merged and kept", async () => {
  let fetches = 0;
  const savedRows = [];
  const storedRows = [{ date: "2026-10-05", usdPerEur: 1.1 }, { date: "2026-06-01", usdPerEur: 1.05 }];
  const fresh = createEurUsdSource({
    fetchImpl: async () => { fetches += 1; throw new Error("offline"); },
    nowMs: () => NOW_MS,
    env: {},
    store: { load: async () => ({ rows: storedRows, fetchedAt: NOW_MS - 3_600_000 }), save: async () => undefined },
  });
  assert.equal((await fresh.rate("2026-10-06")).usdPerEur, 1.1);
  assert.equal(fetches, 0);

  const xml = "<Cube time='2026-10-06'><Cube currency='USD' rate='1.2'/></Cube>";
  const old = createEurUsdSource({
    fetchImpl: async () => { fetches += 1; return { ok: true, text: async () => xml }; },
    nowMs: () => NOW_MS,
    env: {},
    store: { load: async () => ({ rows: storedRows, fetchedAt: NOW_MS - 7 * 3_600_000 }), save: async (rows) => { savedRows.push(...rows); } },
  });
  assert.equal((await old.rate("2026-10-06")).usdPerEur, 1.2);
  assert.equal((await old.rate("2026-06-02")).usdPerEur, 1.05, "history older than the ECB file stays available");
  assert.equal(fetches, 1);
  assert.deepEqual(savedRows, [{ date: "2026-10-06", usdPerEur: 1.2 }]);
  assert.deepEqual(mergeRates([{ date: "2026-01-01", usdPerEur: 1 }], [{ date: "2026-01-01", usdPerEur: 2 }]), [{ date: "2026-01-01", usdPerEur: 2 }]);
});
