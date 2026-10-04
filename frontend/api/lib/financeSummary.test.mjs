import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://user:pass@127.0.0.1:1/none";

const {
  buildFinanceSummary,
  cachedFinanceSummary,
  clearFinanceSummaryCache,
  monthKey,
  monthWindow,
  rawSumToDecimal,
  splitHoldings,
  summaryMonths,
} = await import("./financeSummary.js");
const { FINANCE_MAINNETS, financeSummary, lpShareFromIndexer } = await import("../admin/finance.js");

const networks = () => FINANCE_MAINNETS.map((n) => ({ ...n }));
const NOW = "2026-10-04T14:32:00.000Z";

// Values every native unit at $100 (SOL), $500 (BNB), $2000 (ETH), event time.
const PRICE = { SOL: 100, BNB: 500, ETH: 2000 };
const fakePrices = {
  async valueEvents(asset, buckets, decimals) {
    const native = buckets.reduce((s, b) => s + Number(b.raw) / 10 ** decimals, 0);
    return { amountUsd: Math.round(native * PRICE[asset] * 1e6) / 1e6, priceUsd: PRICE[asset], priceSource: "test", priceAt: null, priceBasis: "event_time" };
  },
  async spotTable(assets) {
    return assets.map((asset) => ({ asset, priceUsd: PRICE[asset], source: "test", at: NOW }));
  },
};

const noRevenue = async () => ({ lanes: [], excludedTestCoinEvents: 0 });
const noLp = async () => ({ entries: [], unpricedTokenCount: 0 });
const noFees = async () => ({ generatedAt: NOW, destinations: [] });
const noRewards = async (network) => ({ totals: { outstanding: { byChain: [{ chainId: network.chainId, assets: [] }] } } });

function chainUsd(totals, chainId) {
  return totals.byChain.find((row) => row.chainId === chainId);
}

test("summary months: default 12, clamped to 2..24", () => {
  assert.equal(summaryMonths(undefined), 12);
  assert.equal(summaryMonths("6"), 6);
  assert.equal(summaryMonths("1"), 2);
  assert.equal(summaryMonths("99"), 24);
  assert.equal(summaryMonths("abc"), 12);
});

test("month window: UTC calendar months, oldest first, ending with the current month", () => {
  const window = monthWindow(NOW, 3);
  assert.deepEqual(window.map((m) => m.month), ["2026-08", "2026-09", "2026-10"]);
  assert.equal(window[2].start, "2026-10-01T00:00:00.000Z");
  assert.equal(window[2].end, "2026-11-01T00:00:00.000Z");
  assert.deepEqual(monthWindow("2026-01-15T00:00:00Z", 2).map((m) => m.month), ["2025-12", "2026-01"]);
  assert.equal(monthKey("2026-09-30T23:59:59Z"), "2026-09");
  assert.equal(monthKey("2026-10-01T00:00:00Z"), "2026-10");
  assert.equal(monthKey("nonsense"), null);
});

test("raw sums keep full precision", () => {
  assert.equal(rawSumToDecimal(["526501599", "17468840"], 9), "0.543970439");
  assert.equal(rawSumToDecimal([], 9), "0");
  assert.equal(rawSumToDecimal(["1000000000000000000"], 18), "1");
});

test("money earned is split by month and chain at event time; all time adds every month", async () => {
  const out = await buildFinanceSummary({
    networks: networks(),
    months: 3,
    now: NOW,
    prices: fakePrices,
    readRevenue: async (network) => network.chainId === 101
      ? { lanes: [{ asset: "SOL", decimals: 9, buckets: [
        { hour: "2026-09-10T10:00:00Z", raw: "500000000" },
        { hour: "2026-10-02T08:00:00Z", raw: "100000000" },
        { hour: "2026-01-02T08:00:00Z", raw: "1000000000" },
      ] }], excludedTestCoinEvents: 4 }
      : { lanes: [], excludedTestCoinEvents: 1 },
    readLpShare: noLp,
    readFeeRouting: noFees,
    readRewards: noRewards,
  });
  assert.equal(out.schemaVersion, "finance-summary-v1");
  assert.deepEqual(out.revenue.months.map((m) => m.month), ["2026-08", "2026-09", "2026-10"]);
  assert.equal(out.revenue.thisMonth.month, "2026-10");
  assert.equal(out.revenue.lastMonth.month, "2026-09");
  assert.equal(out.revenue.thisMonth.totals.amountUsd, 10);
  assert.equal(out.revenue.lastMonth.totals.amountUsd, 50);
  // August had nothing: a real zero, not unknown.
  assert.equal(out.revenue.months[0].totals.amountUsd, 0);
  assert.equal(out.revenue.months[0].totals.unknownAmountCount, 0);
  // All time includes January, outside the 3-month window.
  assert.equal(out.revenue.allTime.amountUsd, 160);
  assert.equal(chainUsd(out.revenue.allTime, 101).assets[0].amountNative, "1.6");
  assert.equal(chainUsd(out.revenue.allTime, 56).amountUsd, 0);
  assert.equal(out.revenue.priceBasis, "event_time");
  assert.equal(out.revenue.excludedTestCoinEvents, 6);
  assert.deepEqual(out.revenue.networks.map((n) => n.status), ["ok", "ok", "ok"]);
});

test("a failed or untracked chain is unknown, never zero, and the others still count", async () => {
  const out = await buildFinanceSummary({
    networks: networks(),
    months: 2,
    now: NOW,
    prices: fakePrices,
    readRevenue: async (network) => {
      if (network.chainId === 56) throw new Error("db down");
      if (network.chainId === 101) return { unavailable: "Test database.", lanes: [] };
      return { lanes: [{ asset: "ETH", decimals: 18, buckets: [{ hour: "2026-10-01T01:00:00Z", raw: "1000000000000000" }] }] };
    },
    readLpShare: async () => { throw new Error("indexer down"); },
    readFeeRouting: (network) => { if (network.chainId === 4663) throw new Error("rpc down"); return noFees(); },
    readRewards: async (network) => (network.chainId === 101 ? { notice: "devnet only", totals: { outstanding: { byChain: [] } } } : noRewards(network)),
  });
  assert.deepEqual(out.revenue.networks.map((n) => n.status), ["unavailable", "unavailable", "ok"]);
  assert.equal(out.revenue.networks[0].reason, "Test database.");
  assert.equal(chainUsd(out.revenue.thisMonth.totals, 101).unknownAmountCount, 1);
  assert.equal(chainUsd(out.revenue.thisMonth.totals, 56).unknownAmountCount, 1);
  assert.equal(chainUsd(out.revenue.thisMonth.totals, 4663).amountUsd, 2);
  assert.equal(out.revenue.thisMonth.totals.unknownAmountCount, 2);
  assert.deepEqual(out.revenue.lpShare.networks.map((n) => n.status), ["unavailable", "unavailable", "unavailable"]);
  assert.equal(out.holdings.networks.find((n) => n.chainId === 4663).status, "unavailable");
  assert.equal(chainUsd(out.holdings.ours, 4663).unknownAmountCount, 1);
  assert.equal(out.owed.networks[0].status, "unavailable");
  assert.equal(chainUsd(out.owed.outstanding, 101).unknownAmountCount, 1);
});

const destination = (id, ownership, balances, extra = {}) => ({ id, label: id, address: `addr-${id}`, flags: [], ownership, balances, ...extra });
const ok = (asset, amount, amountUsd) => ({ asset, status: "ok", amount, amountUsd });

test("holdings: ours by plain group, mixed and owed balances held for others, watch keys left out", () => {
  const network = FINANCE_MAINNETS[1];
  const split = splitHoldings(network, {
    destinations: [
      destination("protocol_vault", "ours", [ok("BNB", "0.1", 50)]),
      destination("protocol_operator", "ours", [ok("BNB", "0.2", 100)]),
      destination("safe", "ours", [ok("BNB", "1", 500), { asset: "WBNB", status: "error", amount: null, amountUsd: null }]),
      destination("war_pool", "owed", [ok("BNB", "0.4", 200)], { ownershipMixed: true }),
      destination("weekly_league", "owed", [ok("BNB", "0.3", 150)]),
      destination("deployer", "watch", [ok("BNB", "9", 4500)], { flags: ["watch"] }),
      // The same address twice counts once.
      destination("safe", "ours", [ok("BNB", "1", 500)]),
    ],
  });
  assert.equal(split.ours.length, 4);
  assert.equal(split.ours.filter((e) => e.amount == null).length, 1);
  assert.deepEqual(split.others.map((e) => e.amountUsd), [200, 150]);
  assert.deepEqual([...split.groups.keys()], ["protocol_vault", "operator", "multisig"]);
});

test("summary holdings and owed totals from fee routing and rewards", async () => {
  const out = await buildFinanceSummary({
    networks: networks(),
    months: 2,
    now: NOW,
    prices: fakePrices,
    readRevenue: noRevenue,
    readLpShare: async (network) => ({ entries: network.chainId === 101 ? [{ asset: "SOL", amount: "0.5", amountUsd: 50 }] : [], unpricedTokenCount: network.chainId === 56 ? 2 : 0 }),
    readFeeRouting: async (network) => network.chainId === 101
      ? { generatedAt: "2026-10-04T14:30:00.000Z", destinations: [
        destination("route_operator", "ours", [ok("SOL", "1", 100)]),
        destination("squads_vault", "ours", [ok("SOL", "0.5", 50)]),
        destination("mystery", "ours", [ok("SOL", "0.1", 10)]),
        destination("league_weekly", "owed", [ok("SOL", "2", 200)]),
      ] }
      : { generatedAt: "2026-10-04T14:31:00.000Z", destinations: [] },
    readRewards: async (network) => network.chainId === 101
      ? { totals: { outstanding: { byChain: [{ chainId: 101, assets: [{ asset: "SOL", amountNative: "0.12", amountUsd: 12 }] }] } } }
      : noRewards(network),
  });
  assert.equal(out.holdings.ours.amountUsd, 160);
  assert.equal(out.holdings.heldForOthers.amountUsd, 200);
  assert.equal(out.holdings.asOf, "2026-10-04T14:30:00.000Z");
  const groups = Object.fromEntries(out.holdings.groups.map((g) => [g.key, g.totals.amountUsd]));
  assert.equal(groups.operator, 100);
  assert.equal(groups.multisig, 50);
  assert.equal(groups.other, 10);
  assert.equal(groups.protocol_vault, null);
  assert.equal(out.holdings.groups.find((g) => g.key === "protocol_vault").totals.unknownAmountCount, 0);
  assert.equal(out.owed.outstanding.amountUsd, 12);
  assert.equal(out.revenue.lpShare.totals.amountUsd, 50);
  assert.equal(out.revenue.lpShare.unpricedTokenCount, 2);
  assert.deepEqual(out.prices.map((p) => p.asset), ["SOL", "BNB", "ETH"]);
});

test("LP share from the indexer: native side only, hidden coins out, coin tokens counted", () => {
  const sol = FINANCE_MAINNETS[0];
  const solOut = lpShareFromIndexer({ items: [
    { campaignAddress: "Keep", fees: { harvestedLifetime: { protocolToken0Display: "0.25", protocolToken1Display: "1000" }, unharvested: { token0Symbol: "SOL", token1Symbol: "K88" } } },
    { campaignAddress: "Hidden", fees: { harvestedLifetime: { protocolToken0Display: "5" }, unharvested: { token0Symbol: "WSOL" } } },
    { campaignAddress: "NoHarvest", fees: { unharvested: {} } },
  ] }, sol, ["Hidden"]);
  assert.deepEqual(solOut, { amounts: ["0.25"], unpricedTokenCount: 1 });

  const bnb = FINANCE_MAINNETS[1];
  const token = "0x" + "a".repeat(40);
  const wbnb = "0x" + "b".repeat(40);
  const bnbOut = lpShareFromIndexer({ items: [
    { campaignAddress: "0xKEEP", tokenAddress: token, fees: { registered: true, token0: wbnb, token1: token, harvestedLifetime: { protocolToken0Raw: "500000000000000000", protocolToken1Raw: "7" } } },
    { campaignAddress: "0xHIDDEN", tokenAddress: token, fees: { registered: true, token0: wbnb, token1: token, harvestedLifetime: { protocolToken0Raw: "1" } } },
    { campaignAddress: "0xUNREG", tokenAddress: token, fees: { registered: false, token0: wbnb, harvestedLifetime: { protocolToken0Raw: "1" } } },
  ] }, bnb, ["0xhidden"]);
  assert.deepEqual(bnbOut, { amounts: ["0.5"], unpricedTokenCount: 1 });
});

test("summary cache: one build per minute, shared while in flight, dropped on error", async () => {
  clearFinanceSummaryCache();
  let builds = 0;
  const build = async () => { builds += 1; return { n: builds }; };
  const [a, b] = await Promise.all([cachedFinanceSummary("k", build), cachedFinanceSummary("k", build)]);
  assert.equal(builds, 1);
  assert.equal(a, b);
  await cachedFinanceSummary("k", build);
  assert.equal(builds, 1);
  await assert.rejects(cachedFinanceSummary("bad", async () => { throw new Error("x"); }));
  assert.deepEqual(await cachedFinanceSummary("bad", build), { n: 2 });
  clearFinanceSummaryCache();
});

function fakeRes() {
  return { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}

test("summary route: GET only, finance.view bearer required, currency checked", async () => {
  clearFinanceSummaryCache();
  const principal = { owner: false, permissions: ["finance.view"] };
  const build = async (months) => ({ schemaVersion: "finance-summary-v1", months });

  let res = fakeRes();
  await financeSummary({ method: "POST", query: {}, dashboardPrincipal: principal }, res, { build });
  assert.equal(res.code, 405);

  res = fakeRes();
  await financeSummary({ method: "GET", query: {} }, res, { build });
  assert.equal(res.code, 401);

  res = fakeRes();
  await financeSummary({ method: "GET", query: {}, dashboardPrincipal: { owner: false, permissions: ["operations.view"] } }, res, { build });
  assert.equal(res.code, 401);

  res = fakeRes();
  await financeSummary({ method: "GET", query: { currency: "eur" }, dashboardPrincipal: principal }, res, { build });
  assert.equal(res.code, 400);

  res = fakeRes();
  await financeSummary({ method: "GET", query: { months: "6", currency: "usd" }, dashboardPrincipal: principal }, res, { build });
  assert.equal(res.code, 200);
  assert.equal(res.body.months, 6);
  assert.equal(res.headers["Cache-Control"], "private, max-age=60");
  clearFinanceSummaryCache();
});

test("Solana paid UP votes are a revenue lane in /revenue and /summary alike, test coins excluded", async () => {
  const { pool } = await import("../../server/db.js");
  const { revenueLanes, buildRevenue } = await import("../admin/finance.js");
  const original = pool.query;
  const seen = [];
  pool.query = async (text, params) => {
    seen.push({ text, params });
    if (/from public\.votes/.test(text)) {
      assert.equal(params[0], 101);
      // The native vote asset is part of the shared lane spec (financeRevenueLanes.js), not a parameter.
      assert.match(text, /lower\('11111111111111111111111111111111'\)/);
      assert.match(text, /not exists \(\s*select 1 from public\.campaigns hc/);
      return { rows: [{ hour: new Date("2026-09-26T20:00:00Z"), period_start: new Date("2026-09-26T20:07:47Z"), period_end: new Date("2026-09-26T20:07:47Z"), evidence_count: 1, amount_raw: "24770869" }] };
    }
    if (/from public\.reward_events/.test(text) && /group by 1/.test(text)) {
      return { rows: [{ hour: new Date("2026-10-02T08:00:00Z"), period_start: new Date("2026-10-02T08:10:00Z"), period_end: new Date("2026-10-02T08:20:00Z"), evidence_count: 2, amount_raw: "17468840" }] };
    }
    if (/count\(\*\)::int as n/.test(text)) return { rows: [{ n: 0 }] };
    return { rows: [] };
  };
  try {
    const sol = { ...FINANCE_MAINNETS[0] };
    const lanes = await revenueLanes(sol);
    assert.deepEqual(lanes.lanes.map((l) => l.aggregate.lane), ["bonding_curve_fee", "upvotes"]);
    const vote = lanes.lanes[1].aggregate;
    assert.equal(vote.id, "upvotes:101:native");
    assert.equal(vote.assetSymbol, "SOL");
    assert.equal(vote.nativeAmount, "0.024770869");
    assert.equal(vote.sourceInventoryId, "sol101-mainnet-protocol-treasury");

    const revenue = await buildRevenue(sol, { prices: { ...fakePrices, async spotTable() { return []; } } });
    assert.equal(revenue.aggregates.find((a) => a.lane === "upvotes").amountUsd, 2.477087);
    assert.equal(revenue.totals.amountUsd, Math.round((2.477087 + 1.746884) * 1e6) / 1e6);

    const summary = await buildFinanceSummary({
      networks: [sol],
      months: 2,
      now: NOW,
      prices: fakePrices,
      readRevenue: async (network) => {
        const read = await revenueLanes(network);
        return { lanes: read.lanes.map((lane) => ({ asset: lane.aggregate.assetSymbol, decimals: network.decimals, buckets: lane.buckets })), excludedTestCoinEvents: read.excludedEvents };
      },
      readLpShare: noLp,
      readFeeRouting: noFees,
      readRewards: noRewards,
    });
    assert.equal(summary.revenue.lastMonth.totals.amountUsd, 2.477087);
    assert.equal(summary.revenue.thisMonth.totals.amountUsd, 1.746884);
    assert.equal(summary.revenue.allTime.amountUsd, revenue.totals.amountUsd);
  } finally {
    pool.query = original;
  }
});
