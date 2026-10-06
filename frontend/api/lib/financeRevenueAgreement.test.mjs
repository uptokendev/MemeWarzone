// Summary monthly earnings == accounting Close revenue per month == revenue CSV
// totals, on one fixture: all three read financeRevenueLanes.js.
import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://user:pass@127.0.0.1:1/none";

const { EVENT_QUERIES, LANE_QUERIES, sharedRevenueLanes, summaryRevenueLanes } = await import("./financeRevenueLanes.js");
const { buildFinanceSummary } = await import("./financeSummary.js");
const { dailyRevenue, monthlyRevenue, revenueEventRows } = await import("./financeAccountingSources.js");
const { revenueByLane } = await import("./financeYearEnd.js");
const { FINANCE_MAINNETS } = await import("../admin/finance.js");

const HOUR = 3_600_000;
const NOW = "2026-10-20T12:00:00.000Z";

// Events per lane key and chain: [chainId, iso time, raw amount].
const EVENTS = {
  bonding: [[101, "2026-09-26T14:10:00Z", "543970439"], [101, "2026-10-02T08:15:00Z", "17468840"], [101, "2026-10-02T08:40:00Z", "1000"]],
  upvotes_solana: [[101, "2026-09-26T20:07:47Z", "24770869"]],
  upvotes_evm: [[56, "2026-08-19T08:49:12Z", "4976519534714725"]],
  arena_boosts: [[101, "2026-09-26T14:01:00Z", "4113835"], [101, "2026-10-02T11:30:00Z", "126367079"]],
  arena_entries: [[101, "2026-09-26T14:03:29Z", "5000000"], [101, "2026-10-02T11:35:25Z", "20000000"]],
  home_placements: [[56, "2026-10-03T14:39:15Z", "34900"], [56, "2026-10-03T14:40:35Z", "34900"]],
  graduation_fee: [[4663, "2026-09-30T23:59:00Z", "10000000000000000"]],
  sponsorships: [],
  dbc_referral: [],
  dbc_migration_fee: [[101, "2026-10-06T10:15:00Z", "2252000000"]],
};

function fixtureDb() {
  const keyOf = (text, table) => Object.keys(table).find((k) => table[k] === text);
  return {
    async query(text, params) {
      const hourlyKey = keyOf(text, LANE_QUERIES);
      const eventKey = keyOf(text, EVENT_QUERIES);
      if (hourlyKey?.endsWith("_excluded") || /count\(\*\)::int as n/.test(text)) return { rows: [{ n: 0 }] };
      if (hourlyKey) {
        const byHour = new Map();
        for (const [chainId, at, raw] of EVENTS[hourlyKey] || []) {
          if (chainId !== params[0]) continue;
          const hour = Math.floor(Date.parse(at) / HOUR) * HOUR;
          const row = byHour.get(hour) || { hour: new Date(hour), period_start: at, period_end: at, evidence_count: 0, amount_raw: "0" };
          row.evidence_count += 1;
          row.amount_raw = (BigInt(row.amount_raw) + BigInt(raw)).toString();
          if (at < row.period_start) row.period_start = at;
          if (at > row.period_end) row.period_end = at;
          byHour.set(hour, row);
        }
        return { rows: [...byHour.values()] };
      }
      if (eventKey) {
        const [chainId, start, end, limit] = params;
        const rows = (EVENTS[eventKey] || [])
          .filter(([c, at]) => c === chainId && at >= start.replace(".000", "") && Date.parse(at) < Date.parse(end))
          .map(([, at, raw], i) => ({ occurred_at: new Date(at), amount_raw: raw, tx_hash: `tx-${eventKey}-${i}`, log_index: i, campaign_address: null, reference: null, event_id: String(i) }));
        return { rows: rows.slice(0, limit) };
      }
      throw new Error(`unexpected query: ${text.slice(0, 80)}`);
    },
  };
}

// A price that changes every hour, so event-time pricing is really exercised.
const BASE = { SOL: 120, BNB: 600, ETH: 2500 };
const priceAt = (asset, hour) => (asset === "USD" ? 1 : BASE[asset] + ((hour / HOUR) % 7));
const assetOf = (symbol) => ({ SOL: "SOL", BNB: "BNB", ETH: "ETH", USD: "USD" }[String(symbol).toUpperCase()]);
const prices = {
  async valueEvents(symbol, buckets, decimals) {
    const asset = assetOf(symbol);
    let usd = 0;
    for (const b of buckets) {
      const hour = Math.floor(new Date(b.hour).getTime() / HOUR) * HOUR;
      usd += (Number(b.raw) / 10 ** decimals) * priceAt(asset, hour);
    }
    return { amountUsd: Math.round(usd * 1e6) / 1e6, priceUsd: null, priceSource: "fixture", priceAt: null, priceBasis: "event_time" };
  },
  async hourly(asset, hours) { return new Map(hours.map((h) => [h, priceAt(asset, h)])); },
  async spot(asset) { return { priceUsd: priceAt(asset, 0), source: "fixture spot", at: NOW }; },
  async spotTable(assets) { return assets.map((asset) => ({ asset, priceUsd: BASE[asset] ?? null, source: "fixture", at: NOW })); },
};
const fx = { async rate() { return { usdPerEur: 1.1, source: "fixture" }; } };
const approveAll = async () => ({ approved: true, aggregate: null, reason: null });
const networks = () => FINANCE_MAINNETS.map((n) => ({ ...n }));

test("Summary month == Close month == revenue CSV month, every lane and chain", async () => {
  const db = fixtureDb();
  const summary = await buildFinanceSummary({
    networks: networks(),
    months: 3,
    now: NOW,
    prices,
    readRevenue: async (network) => {
      const read = await sharedRevenueLanes(db, network, { upvoteApproval: approveAll });
      return { lanes: summaryRevenueLanes(read.lanes, network), excludedTestCoinEvents: read.excludedEvents };
    },
    readLpShare: async () => ({ entries: [], unpricedTokenCount: 0 }),
    readFeeRouting: async () => ({ generatedAt: NOW, destinations: [] }),
    readRewards: async (network) => ({ totals: { outstanding: { byChain: [{ chainId: network.chainId, assets: [] }] } } }),
  });
  const close = await monthlyRevenue({ fromMonth: "2026-08", toMonth: "2026-10", db, prices, upvotes: approveAll, networks: networks(), env: {} });
  const csv = await revenueEventRows({ fromMonth: "2026-08", toMonth: "2026-10", db, prices, fx, upvotes: approveAll, networks: networks(), env: {} });

  const csvByMonth = new Map();
  for (const row of csv.rows) csvByMonth.set(row.month, (csvByMonth.get(row.month) || 0) + row.amountUsd);

  const cents = (v) => Math.round(v * 100);
  for (const { month, totals } of summary.revenue.months) {
    const s = totals.amountUsd;
    assert.equal(cents(close.months[month].totalUsd), cents(s), `Close ${month}`);
    assert.equal(cents(csvByMonth.get(month) || 0), cents(s), `CSV ${month}`);
  }
  // The new lanes are really in all three: Home placements $698 in October on BNB.
  const oct = close.months["2026-10"].lanes;
  assert.ok(oct.some((l) => l.laneId === "home-placements:56" && l.amountUsd === 698 && l.source.startsWith("Home placements")));
  assert.ok(oct.some((l) => l.laneId === "arena-boosts:101"));
  assert.ok(close.months["2026-09"].lanes.some((l) => l.laneId === "graduation-fee:4663"), "a 23:59 UTC event stays in its month");
  assert.ok(close.months["2026-09"].lanes.some((l) => l.laneId === "upvotes:101:native"), "Solana UP votes are in the books");
  const placements = csv.rows.filter((r) => r.laneId === "home-placements:56");
  assert.equal(placements.length, 2);
  assert.deepEqual(placements.map((r) => [r.asset, r.amountNative, r.priceUsd, r.amountUsd, r.amountEur]), [["USD", "349", 1, 349, 317.272727], ["USD", "349", 1, 349, 317.272727]]);
  assert.ok(csv.rows.every((r) => r.source && r.txHash && r.eventId != null));
  assert.equal(csv.rows.length, Object.values(EVENTS).flat().length);
});

test("an unapproved EVM vote treasury drops BNB votes from Summary, Close and CSV alike", async () => {
  const db = fixtureDb();
  const deny = async (network) => (network.chain === "solana" ? { approved: true } : { approved: false, reason: "FEE_RECEIVER_NOT_PROTOCOL_REVENUE_VAULT" });
  const bnb = networks().filter((n) => n.chainId === 56);
  const close = await monthlyRevenue({ fromMonth: "2026-08", toMonth: "2026-08", db, prices, upvotes: deny, networks: bnb, env: {} });
  const csv = await revenueEventRows({ fromMonth: "2026-08", toMonth: "2026-08", db, prices, fx, upvotes: deny, networks: bnb, env: {} });
  const shared = await sharedRevenueLanes(db, bnb[0], { upvoteApproval: deny });
  assert.equal(close.months["2026-08"].lanes.length, 0);
  assert.equal(csv.rows.length, 0);
  assert.ok(!shared.lanes.some((l) => l.aggregate.lane === "upvotes"));
  assert.ok(close.notes.some((n) => /FEE_RECEIVER_NOT_PROTOCOL_REVENUE_VAULT/.test(n)));
});

test("year end: the daily revenue it reads adds up to Summary and Close per month, and its lanes to the year total", async () => {
  const db = fixtureDb();
  const summary = await buildFinanceSummary({
    networks: networks(),
    months: 3,
    now: NOW,
    prices,
    readRevenue: async (network) => {
      const read = await sharedRevenueLanes(db, network, { upvoteApproval: approveAll });
      return { lanes: summaryRevenueLanes(read.lanes, network), excludedTestCoinEvents: read.excludedEvents };
    },
    readLpShare: async () => ({ entries: [], unpricedTokenCount: 0 }),
    readFeeRouting: async () => ({ generatedAt: NOW, destinations: [] }),
    readRewards: async (network) => ({ totals: { outstanding: { byChain: [{ chainId: network.chainId, assets: [] }] } } }),
  });
  const close = await monthlyRevenue({ fromMonth: "2026-08", toMonth: "2026-10", db, prices, upvotes: approveAll, networks: networks(), env: {} });
  const daily = await dailyRevenue({ fromDate: "2026-01-01", toDate: "2026-10-20", db, prices, upvotes: approveAll, networks: networks(), env: {} });
  const byMonth = new Map();
  for (const [date, day] of Object.entries(daily.days)) byMonth.set(date.slice(0, 7), (byMonth.get(date.slice(0, 7)) || 0) + day.lanes.reduce((s, l) => s + l.amountUsd, 0));
  const cents = (v) => Math.round(v * 100);
  for (const { month, totals } of summary.revenue.months) {
    assert.equal(cents(byMonth.get(month) || 0), cents(totals.amountUsd), `year-end days vs Summary ${month}`);
    assert.equal(cents(byMonth.get(month) || 0), cents(close.months[month].totalUsd), `year-end days vs Close ${month}`);
  }
  // Every lane id of the Close is a lane of the year end (new lanes appear by themselves).
  const lanes = revenueByLane({ revDays: daily.days, year: 2026, today: "2026-10-20", usdPerEur: () => 1.1, segments: [] });
  const closeLaneIds = new Set(Object.values(close.months).flatMap((m) => m.lanes.map((l) => l.laneId)));
  assert.deepEqual(new Set(lanes.rows.map((r) => r.laneId)), closeLaneIds);
  const closeYearUsd = Object.values(close.months).reduce((s, m) => s + m.totalUsd, 0);
  assert.equal(cents(lanes.rows.reduce((s, r) => s + r.grossUsd, 0)), cents(closeYearUsd));
});
