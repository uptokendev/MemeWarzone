import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://user:pass@127.0.0.1:1/none";

const {
  LANE_QUERIES,
  extraRevenueLanes,
  laneDefinitions,
  laneFromHourlyRows,
  summaryRevenueLanes,
  valueRevenueLanes,
} = await import("./financeRevenueLanes.js");
const { buildFinanceSummary } = await import("./financeSummary.js");
const { buildTotals, priceAssetFor } = await import("./financePrices.js");
const { FINANCE_MAINNETS } = await import("../admin/finance.js");

const SOL = () => ({ ...FINANCE_MAINNETS.find((n) => n.chainId === 101) });
const BNB = () => ({ ...FINANCE_MAINNETS.find((n) => n.chainId === 56) });
const NOW = "2026-10-04T14:32:00.000Z";

const PRICE = { SOL: 120, BNB: 600, ETH: 2500, USD: 1 };
const fakePrices = {
  async valueEvents(asset, buckets, decimals) {
    const key = priceAssetFor(asset);
    const native = buckets.reduce((s, b) => s + Number(b.raw) / 10 ** decimals, 0);
    return { amountUsd: Math.round(native * PRICE[key] * 1e6) / 1e6, priceUsd: PRICE[key], priceSource: "test", priceAt: null, priceBasis: "event_time" };
  },
  async spotTable(assets) {
    return assets.map((asset) => ({ asset, priceUsd: PRICE[asset] ?? null, source: "test", at: NOW }));
  },
};

const hour = (iso, raw, n = 1) => ({ hour: iso, period_start: iso, period_end: iso, evidence_count: n, amount_raw: String(raw) });

// Production shape (2026-10-04): 157 boosts in two vote battles, 2 MWL ledger rows.
function fakeDb(rowsByKey, { fail = {} } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      const key = Object.keys(LANE_QUERIES).find((k) => LANE_QUERIES[k] === text);
      calls.push({ key, params });
      if (fail[key]) throw fail[key];
      if (key === "arena_boosts_excluded") return { rows: [{ n: rowsByKey.excluded ?? 0 }] };
      return { rows: rowsByKey[key] || [] };
    },
  };
}

test("lane definitions: arena, sponsorship and placements on every chain; DBC referral and migration fee on Solana, finalize on EVM", () => {
  const sol = laneDefinitions(SOL()).map((d) => d.key);
  const bnb = laneDefinitions(BNB()).map((d) => d.key);
  assert.deepEqual(sol, ["arena_boosts", "arena_entries", "sponsorships", "home_placements", "import_swaps", "dbc_referral", "dbc_migration_fee"]);
  assert.deepEqual(bnb, ["arena_boosts", "arena_entries", "sponsorships", "home_placements", "import_swaps", "graduation_fee"]);
  const labels = Object.fromEntries(laneDefinitions(SOL()).map((d) => [d.key, d]));
  assert.equal(labels.arena_boosts.source, "Arena boosts 10%");
  assert.match(labels.arena_entries.source, /^Battle entries 5%/);
  assert.equal(labels.sponsorships.source, "Sponsorships 10% + marketing 20%");
  assert.equal(labels.home_placements.assetSymbol, "USD");
  assert.equal(labels.home_placements.decimals, 2);
  assert.equal(labels.import_swaps.source, "Import swaps 0.5%");
  assert.equal(labels.import_swaps.id, "import-swaps:101");
  assert.equal(labels.import_swaps.assetSymbol, "SOL");
  assert.equal(labels.import_swaps.sourceInventoryId, "sol101-mainnet-import-swap-fee");
  assert.equal(laneDefinitions(BNB()).find((d) => d.key === "import_swaps").sourceInventoryId, "bnb56-protocol-vault");
  // Lane values stay inside the dashboard's finance-revenue-v1 enum.
  const allowed = new Set(["bonding_curve_fee", "lp_protocol_share", "upvotes", "sponsorship", "other_approved"]);
  for (const d of [...laneDefinitions(SOL()), ...laneDefinitions(BNB())]) assert.ok(allowed.has(d.lane), d.key);
});

test("splits: only the protocol share is read, prize and MWL money never", () => {
  assert.match(LANE_QUERIES.arena_boosts, /sum\(a\.protocol_native_raw\)/);
  assert.doesNotMatch(LANE_QUERIES.arena_boosts, /pool_native_raw|gross_native_raw\)/);
  // Program: MWL 20% and protocol 5% of the same base -> protocol = floor(league / 4).
  assert.match(LANE_QUERIES.arena_entries, /floor\(l\.gross_raw \/ 4\)/);
  assert.match(LANE_QUERIES.sponsorships, /marketing_native_raw.*protocol_native_raw/s);
  assert.doesNotMatch(LANE_QUERIES.sponsorships, /prize_native_raw/);
  assert.match(LANE_QUERIES.graduation_fee, /route_kind = 'finalize'/);
  // A boost is earned only when the pool resolved: a cancelled pool refunds it.
  assert.match(LANE_QUERIES.arena_boosts, /b\.state = 'finished'/);
  assert.match(LANE_QUERIES.arena_boosts, /t\.status = 'finished'/);
  assert.match(LANE_QUERIES.sponsorships, /status = 'confirmed'/);
  assert.match(LANE_QUERIES.home_placements, /payment_status in \('paid', 'verified'\)/);
});

test("test coins: every lane with a campaign filters hidden campaigns", () => {
  for (const key of ["arena_boosts", "arena_entries", "home_placements", "dbc_referral", "dbc_migration_fee", "dbc_migration_fee_bound_quote", "graduation_fee"]) {
    assert.match(LANE_QUERIES[key], /meta->>'publicHidden'/, key);
  }
  // Both battle sides are checked, by campaign address and token address.
  assert.match(LANE_QUERIES.arena_boosts, /challenger_token/);
  assert.match(LANE_QUERIES.arena_boosts, /defender_token/);
  assert.match(LANE_QUERIES.arena_boosts, /hc\.token_address/);
});

test("amounts: production rows give 0.130480914 SOL boosts and 0.025 SOL entries", async () => {
  const db = fakeDb({
    arena_boosts: [hour("2026-09-26T14:00:00.000Z", 4113835, 5), hour("2026-10-02T11:00:00.000Z", 126367079, 152)],
    arena_entries: [hour("2026-09-26T14:00:00.000Z", 5000000), hour("2026-10-02T11:00:00.000Z", 20000000)],
    excluded: 3,
  });
  const { lanes, excludedEvents } = await extraRevenueLanes(db, SOL());
  const byId = Object.fromEntries(lanes.map((l) => [l.aggregate.id, l.aggregate]));
  assert.equal(byId["arena-boosts:101"].nativeAmount, "0.130480914");
  assert.equal(byId["arena-boosts:101"].evidenceCount, 157);
  assert.equal(byId["arena-boosts:101"].assetSymbol, "SOL");
  assert.equal(byId["arena-entries:101"].nativeAmount, "0.025");
  assert.equal(byId["arena-entries:101"].periodStart, "2026-09-26T14:00:00.000Z");
  assert.equal(byId["arena-entries:101"].periodEnd, "2026-10-02T11:00:00.000Z");
  assert.equal(lanes.length, 2, "empty lanes are left out");
  assert.equal(excludedEvents, 3);
  assert.ok(db.calls.every((c) => c.params[0] === 101), "every lane is per chain");
});

test("missing table drops only that lane; other errors are logged and drop only that lane", async () => {
  const warnings = [];
  const missing = Object.assign(new Error("relation does not exist"), { code: "42P01" });
  const broken = new Error("boom");
  const db = fakeDb({ sponsorships: [hour("2026-10-01T10:00:00.000Z", "3000000000000000")] }, { fail: { arena_boosts: missing, arena_entries: broken } });
  const { lanes } = await extraRevenueLanes(db, BNB(), { log: { warn: (...a) => warnings.push(a.join(" ")) } });
  assert.deepEqual(lanes.map((l) => l.aggregate.id), ["sponsorships:56"]);
  assert.equal(lanes[0].aggregate.nativeAmount, "0.003");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /arena_entries lane omitted/);
});

test("pricing: native lanes at chain decimals, Home placements in USD cents", async () => {
  const network = BNB();
  const db = fakeDb({
    home_placements: [hour("2026-10-03T14:00:00.000Z", 69800, 2)],
    graduation_fee: [hour("2026-10-01T17:00:00.000Z", "10000000000000000")],
  });
  const { lanes } = await extraRevenueLanes(db, network);
  const aggregates = await valueRevenueLanes(lanes, network, fakePrices);
  const byId = Object.fromEntries(aggregates.map((a) => [a.id, a]));
  assert.equal(byId["home-placements:56"].nativeAmount, "698");
  assert.equal(byId["home-placements:56"].amountUsd, 698);
  assert.equal(byId["graduation-fee:56"].nativeAmount, "0.01");
  assert.equal(byId["graduation-fee:56"].amountUsd, 6);
  assert.equal(priceAssetFor("USD"), "USD");
});

test("/revenue and /summary give the same totals from the same lanes", async () => {
  const sol = SOL();
  const bnb = BNB();
  const lanesFor = {
    101: [
      laneFromHourlyRows([hour("2026-09-26T14:00:00.000Z", 543970439, 105)], { id: "bonding-route:101", chain: "solana", lane: "bonding_curve_fee", assetSymbol: "SOL", sourceInventoryId: "x" }),
      ...(await extraRevenueLanes(fakeDb({ arena_boosts: [hour("2026-10-02T11:00:00.000Z", 130480914, 157)], arena_entries: [hour("2026-09-26T14:00:00.000Z", 25000000, 2)] }), sol)).lanes,
    ],
    56: (await extraRevenueLanes(fakeDb({ home_placements: [hour("2026-10-03T14:00:00.000Z", 69800, 2)] }), bnb)).lanes,
    4663: [],
  };
  // laneFromHourlyRows without decimals: the lane falls back to the chain's decimals.
  lanesFor[101][0].aggregate.decimals = undefined;
  lanesFor[101][0].aggregate.nativeAmount = "0.543970439";

  const revenueTotals = [];
  for (const network of FINANCE_MAINNETS.map((n) => ({ ...n }))) {
    const aggregates = await valueRevenueLanes(lanesFor[network.chainId], network, fakePrices);
    revenueTotals.push(buildTotals(aggregates.map((a) => ({ chainId: network.chainId, chain: network.chain, asset: a.assetSymbol, amount: a.nativeAmount, amountUsd: a.amountUsd })), { seed: [network] }));
  }
  const revenueUsd = revenueTotals.reduce((s, t) => s + (t.amountUsd || 0), 0);

  const summary = await buildFinanceSummary({
    networks: FINANCE_MAINNETS.map((n) => ({ ...n })),
    months: 12,
    now: NOW,
    prices: fakePrices,
    readRevenue: async (network) => ({ lanes: summaryRevenueLanes(lanesFor[network.chainId], network), excludedTestCoinEvents: 0 }),
    readLpShare: async () => ({ entries: [], unpricedTokenCount: 0 }),
    readFeeRouting: async () => ({ generatedAt: NOW, destinations: [] }),
    readRewards: async (network) => ({ totals: { outstanding: { byChain: [{ chainId: network.chainId, assets: [] }] } } }),
  });
  assert.equal(Math.round(summary.revenue.allTime.amountUsd * 1e6), Math.round(revenueUsd * 1e6));
  // 0.543970439 + 0.130480914 + 0.025 SOL at $120, plus $698.
  assert.equal(Math.round(summary.revenue.allTime.amountUsd * 100), Math.round(((0.543970439 + 0.130480914 + 0.025) * 120 + 698) * 100));
  const thisMonth = summary.revenue.thisMonth.totals.amountUsd;
  const lastMonth = summary.revenue.lastMonth.totals.amountUsd;
  assert.equal(Math.round((thisMonth + lastMonth) * 1e6), Math.round(summary.revenue.allTime.amountUsd * 1e6), "month split adds up to all time");
});

test("fee routing map: import swaps on BNB, off-chain Home placements on every mainnet", async () => {
  const { evmFeeRoutingRegistry } = await import("./financeFeeRoutingEvm.js");
  const { solanaFeeRoutingRegistry } = await import("./financeFeeRoutingSolana.js");
  const bnb = evmFeeRoutingRegistry(56).flows.map((f) => f.id);
  const rh = evmFeeRoutingRegistry(4663).flows.map((f) => f.id);
  const sol = solanaFeeRoutingRegistry({}).flows.map((f) => f.id);
  assert.ok(bnb.includes("evm_import_swaps"));
  assert.ok(rh.includes("evm_import_swaps"), "Robinhood import swaps (Universal Router, 2026-10-03)");
  for (const ids of [bnb, rh, sol]) assert.ok(ids.includes("home_placements"));
  const swap = evmFeeRoutingRegistry(56).flows.find((f) => f.id === "evm_import_swaps");
  assert.deepEqual(swap.splits.map((s) => s.destinationId), ["protocol_vault"]);
  for (const flow of [...evmFeeRoutingRegistry(56).flows, ...solanaFeeRoutingRegistry({}).flows]) {
    assert.ok(flow.status.length <= 40, `${flow.id} status fits the dashboard`);
    for (const split of flow.splits) assert.ok(split.share.length <= 80, `${flow.id} share fits the dashboard`);
  }
});

test("DBC migration fee lane: the protocol slice of the keeper's finalize row, SOL coins only, into protocol_vault", () => {
  const def = laneDefinitions(SOL()).find((d) => d.key === "dbc_migration_fee");
  assert.equal(def.id, "dbc-migration-fee:101");
  assert.equal(def.source, "DBC migration fee (partner share)");
  assert.equal(def.lane, "bonding_curve_fee");
  assert.equal(def.assetSymbol, "SOL");
  assert.equal(def.decimals, 9);
  assert.equal(def.sourceInventoryId, "sol101-mainnet-protocol-vault");
  assert.equal(laneDefinitions(BNB()).some((d) => d.key === "dbc_migration_fee"), false, "Solana only");
  const sql = LANE_QUERIES.dbc_migration_fee;
  // realtime-indexer/src/dbc/dbcGraduationKeeper.ts insertFinalizeRewardEvent
  assert.match(sql, /r\.route_kind = 'finalize'/);
  assert.match(sql, /r\.matched_activity_source = 'dbc_graduation'/);
  assert.match(sql, /sum\(r\.protocol_amount\)/);
  assert.doesNotMatch(sql, /recruiter_amount|airdrop_amount|squad_amount|raw_amount/, "only the protocol slice");
  assert.match(sql, /\$1::int = 101/);
  assert.match(sql, /date_trunc\('hour', r\.occurred_at\)/, "event-time buckets");
  // Bound-quote coins are counted apart, not mixed into SOL.
  assert.match(sql, /'\{dbc,quoteMint\}'/);
  assert.match(LANE_QUERIES.dbc_migration_fee_bound_quote, /count\(\*\)::int as n/);
  // The launchpad bonding lane never reads finalize rows, so nothing is counted twice.
  assert.match(LANE_QUERIES.bonding, /r\.route_kind = 'trade'/);
});

test("DBC migration fee: 2.252 SOL migration valued at its event hour; bound-quote rows give a note", async () => {
  const network = SOL();
  const db = fakeDb({ dbc_migration_fee: [hour("2026-10-06T10:00:00.000Z", "2252000000")], dbc_migration_fee_bound_quote: [{ n: 2 }] });
  const { lanes, notes } = await sharedRevenueLanesFor(db, network);
  const lane = lanes.find((l) => l.aggregate.id === "dbc-migration-fee:101");
  assert.equal(lane.aggregate.nativeAmount, "2.252");
  assert.equal(lane.buckets[0].hour, "2026-10-06T10:00:00.000Z");
  const [valued] = await valueRevenueLanes([lane], network, fakePrices);
  assert.equal(valued.amountUsd, 270.24);
  assert.equal(valued.priceBasis, "event_time");
  assert.ok(notes.some((n) => /2 DBC migration fees are on a coin with a non-SOL quote/.test(n)), notes.join("|"));
  const none = await sharedRevenueLanesFor(fakeDb({ dbc_migration_fee_bound_quote: [{ n: 0 }] }), network);
  assert.equal(none.notes.some((n) => /DBC migration/.test(n)), false);
  const bnb = await sharedRevenueLanesFor(fakeDb({}), BNB());
  assert.ok(!bnb.notes.some((n) => /DBC/.test(n)));
});

test("DBC migration fee VAT: graduation fees (paid from the coin's raised SOL), not the Meteora B2B referral rule", async () => {
  const { vatLaneOf } = await import("./financeTaxRules.js");
  assert.equal(vatLaneOf("dbc-migration-fee:101"), "graduation_fees");
  assert.equal(vatLaneOf("dbc-referral:101"), "dbc_referral");
});

test("fee routing map: DBC migration flow pays the partner share into protocol_vault after D7", async () => {
  const { solanaFeeRoutingRegistry } = await import("./financeFeeRoutingSolana.js");
  const registry = solanaFeeRoutingRegistry({});
  const flow = registry.flows.find((f) => f.id === "sol_dbc_migration");
  assert.ok(flow);
  const ids = new Set(registry.destinations.map((d) => d.id));
  for (const split of flow.splits) assert.ok(ids.has(split.destinationId), split.destinationId);
  assert.equal(flow.splits.at(-1).destinationId, "protocol_vault");
  assert.ok(flow.notes.some((n) => /dbc-migration-fee/.test(n)));
});

async function sharedRevenueLanesFor(db, network) {
  const { sharedRevenueLanes } = await import("./financeRevenueLanes.js");
  return sharedRevenueLanes(db, network, { upvoteApproval: async () => ({ approved: true }), log: { warn() {} } });
}

test("the DBC referral lane counts only fees paid to our referral account", async () => {
  const fs = await import("node:fs");
  for (const file of ["./financeRevenueLanes.js", "./financeFeeRouting.js", "./financeDbcPools.js"]) {
    const src = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    // Terminals name their own referral on our pools (2026-10-07: 5 of 22 swaps paid us).
    assert.match(src, /referral_ours is true/, file);
  }
});
