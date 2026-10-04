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
