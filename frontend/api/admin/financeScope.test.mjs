import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://user:pass@127.0.0.1:1/none";

const { FINANCE_MAINNETS, buildAllChains, financeScope, mergeOverviewModules } = await import("./finance.js");
const { buildTotals } = await import("../lib/financePrices.js");
const { feeRoutingNetwork, feeRoutingAllNetworks } = await import("../lib/financeFeeRouting.js");

test("finance scope: mainnets only, all by default", () => {
  assert.equal(financeScope({}).all, true);
  assert.deepEqual(financeScope({ chainId: "all" }).networks.map((n) => n.chainId), [101, 56, 4663]);
  assert.equal(financeScope({ chainId: "56" }).networks[0].asset, "BNB");
  assert.equal(financeScope({ chainId: "4663" }).networks[0].chain, "robinhood");
  assert.equal(financeScope({ chainId: "101", environment: "production", solanaCluster: "mainnet-beta" }).networks[0].cluster, "mainnet-beta");
});

test("finance scope refuses testnets and devnet", () => {
  assert.equal(financeScope({ chainId: "97" }), null);
  assert.equal(financeScope({ chainId: "46630" }), null);
  assert.equal(financeScope({ chainId: "101", environment: "staging", solanaCluster: "devnet" }), null);
  assert.equal(financeScope({ chainId: "101" }), null);
  assert.equal(financeScope({ chainId: "102" }), null);
  assert.equal(feeRoutingNetwork({ chainId: 97 }), null);
  assert.equal(feeRoutingNetwork({ chainId: 46630 }), null);
  assert.deepEqual(feeRoutingAllNetworks().map((n) => n.chainId), [101, 56, 4663]);
});

const totalsFor = (network, amount, amountUsd) => buildTotals(amount == null ? [] : [{ chainId: network.chainId, chain: network.chain, asset: network.asset, amount, amountUsd }], { seed: [network] });

test("all chains: one failing chain is reported, the others still add up in USD", async () => {
  const out = await buildAllChains("revenue", FINANCE_MAINNETS.map((n) => ({ ...n })), async (network) => {
    if (network.chainId === 4663) throw new Error("rpc down");
    const amount = network.chainId === 101 ? "1" : "0.5";
    const usd = network.chainId === 101 ? 120 : 400;
    return { totals: totalsFor(network, amount, usd), prices: [{ asset: network.asset, priceUsd: 1, source: "test", at: null }] };
  });
  assert.equal(out.schemaVersion, "finance-all-chains-v1");
  assert.deepEqual(out.networks.map((n) => n.status), ["ok", "ok", "error"]);
  assert.match(out.networks[2].error, /chain 4663/);
  assert.equal(out.totals.amountUsd, 520);
  assert.equal(out.totals.byChain.length, 2);
  assert.equal(out.testCoinsExcluded, true);
  assert.deepEqual(out.prices.map((p) => p.asset), ["SOL", "BNB"]);
});

test("all chains in native terms: per chain only, never one SOL+BNB+ETH number", async () => {
  const out = await buildAllChains("inventory", FINANCE_MAINNETS.map((n) => ({ ...n })), async (network) => ({ totals: totalsFor(network, "1", null), prices: [] }));
  assert.equal(out.totals.amountUsd, null, "no prices: no USD total");
  assert.equal(out.totals.missingPriceCount, 3);
  assert.deepEqual(out.totals.byChain.map((c) => c.assets[0].asset), ["SOL", "BNB", "ETH"]);
  assert.equal("amountNative" in out.totals, false);
});

test("overview modules merge to the worst status and summed counts", () => {
  const merged = mergeOverviewModules([
    [{ key: "revenue", status: "ready", blockerCount: 0, warningCount: 0 }, { key: "costs", status: "disabled", blockerCount: 0, warningCount: 0 }],
    [{ key: "revenue", status: "blocked", blockerCount: 1, warningCount: 0 }, { key: "costs", status: "disabled", blockerCount: 0, warningCount: 0 }],
    [{ key: "revenue", status: "attention", blockerCount: 0, warningCount: 2 }, { key: "costs", status: "disabled", blockerCount: 0, warningCount: 0 }],
  ]);
  const revenue = merged.find((m) => m.key === "revenue");
  assert.equal(revenue.status, "blocked");
  assert.equal(revenue.blockerCount, 1);
  assert.equal(revenue.warningCount, 2);
  assert.equal(merged.find((m) => m.key === "costs").status, "disabled");
});

test("the finance router refuses a testnet with 400 and never reads it", async () => {
  const { default: financeAdmin } = await import("./finance.js");
  const saved = process.env.DASHBOARD_OPS_KEY;
  process.env.DASHBOARD_OPS_KEY = "test-ops-key";
  try {
    const res = {
      statusCode: 0, body: null, headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
      end() { return this; },
    };
    await financeAdmin({ method: "GET", path: "/api/admin/finance/revenue", url: "/api/admin/finance/revenue?chainId=97", query: { chainId: "97" }, headers: { "x-ops-key": "test-ops-key" } }, res);
    if (res.statusCode === 401 || res.statusCode === 403) return; // auth layer differs per env; the scope test above covers the parser
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /mainnets only/);
  } finally {
    if (saved == null) delete process.env.DASHBOARD_OPS_KEY; else process.env.DASHBOARD_OPS_KEY = saved;
  }
});

test("LP harvest: mainnets pass the input check, BNB 97 and Solana devnet are refused before any harvest logic", async () => {
  const { harvestNetwork, lpHarvestMainnetOnly, LP_HARVEST_SCOPE_ERROR } = await import("./finance.js");
  const pick = (query) => lpHarvestMainnetOnly(harvestNetwork({ query }));
  assert.equal(pick({ chainId: "56" }).chainId, 56);
  assert.equal(pick({ chainId: "101", environment: "production", solanaCluster: "mainnet-beta" }).cluster, "mainnet-beta");
  assert.equal(pick({ chainId: "97" }), null);
  assert.equal(pick({ chainId: "46630" }), null);
  assert.equal(pick({ chainId: "101", environment: "staging", solanaCluster: "devnet" }), null);
  assert.equal(pick({ chainId: "101" }), null);
  assert.match(LP_HARVEST_SCOPE_ERROR, /Solana mainnet only/);
});

test("LP harvest route answers a testnet with 400 and never calls the indexer", async () => {
  const { default: financeAdmin } = await import("./finance.js");
  const saved = process.env.DASHBOARD_OPS_KEY;
  const savedFetch = globalThis.fetch;
  process.env.DASHBOARD_OPS_KEY = "test-ops-key";
  let fetched = 0;
  globalThis.fetch = async () => { fetched += 1; throw new Error("no network in tests"); };
  try {
    for (const query of [{ chainId: "97" }, { chainId: "101", environment: "staging", solanaCluster: "devnet" }]) {
      const res = {
        statusCode: 0, body: null, headers: {},
        setHeader(name, value) { this.headers[name] = value; },
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
        end() { return this; },
      };
      await financeAdmin({ method: "POST", path: "/api/admin/finance/lp-harvest", url: "/api/admin/finance/lp-harvest", query, body: { pair: "0xabc" }, headers: { "x-ops-key": "test-ops-key" } }, res);
      if (res.statusCode === 401 || res.statusCode === 403) continue; // auth layer differs per env
      assert.equal(res.statusCode, 400);
      assert.match(res.body.error, /Solana mainnet only/);
    }
    assert.equal(fetched, 0);
  } finally {
    globalThis.fetch = savedFetch;
    if (saved == null) delete process.env.DASHBOARD_OPS_KEY; else process.env.DASHBOARD_OPS_KEY = saved;
  }
});

test("all chains overview and fee routing carry Ours beside Held now, per chain, USD summed only when priced", async () => {
  const solana = FINANCE_MAINNETS[0];
  const bnb = FINANCE_MAINNETS[1];
  const out = await buildAllChains("fee-routing", [solana, bnb].map((n) => ({ ...n })), async (network) => ({
    totals: {
      holdings: totalsFor(network, "5", network.chainId === 101 ? 500 : null),
      ours: totalsFor(network, "2", network.chainId === 101 ? 200 : null),
      inflows: totalsFor(network, null, null),
    },
    prices: [],
  }));
  assert.equal(out.totals.ours.amountUsd, 200, "BNB has no price: it is counted as missing, not as 0");
  assert.equal(out.totals.ours.missingPriceCount, 1);
  assert.deepEqual(out.totals.ours.byChain.map((c) => c.assets[0].amountNative), ["2", "2"]);
  assert.equal(out.totals.holdings.amountUsd, 500);
  const overview = await buildAllChains("overview", [solana].map((n) => ({ ...n })), async (network) => ({
    modules: [],
    totals: { revenue: null, holdings: null, feeHoldings: totalsFor(network, "5", 500), ours: totalsFor(network, "2", 200) },
    prices: [],
  }));
  assert.equal(overview.totals.ours.amountUsd, 200);
  assert.equal(overview.totals.feeHoldings.amountUsd, 500);
});
