import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://user:pass@127.0.0.1:1/none";

const { financeFeeRouting } = await import("./finance.js");

function fakeRes() {
  return {
    statusCode: 0, body: null, headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const principal = (permissions) => ({ isOwner: false, permissions });
const build = async ({ network, days }) => ({ schemaVersion: "finance-fee-routing-v1", network, days });

test("fee routing refuses without a dashboard principal (no ops-key or legacy pass-through)", async () => {
  const res = fakeRes();
  await financeFeeRouting({ method: "GET", query: { chainId: "56" }, headers: { "x-ops-key": "anything" } }, res, { build, db: {} });
  assert.equal(res.statusCode, 401);
});

test("fee routing refuses a principal without finance.view", async () => {
  const res = fakeRes();
  await financeFeeRouting({ method: "GET", query: { chainId: "56" }, dashboardPrincipal: principal(["operations.view"]) }, res, { build, db: {} });
  assert.equal(res.statusCode, 401);
});

test("fee routing is GET only", async () => {
  const res = fakeRes();
  await financeFeeRouting({ method: "POST", query: { chainId: "56" }, dashboardPrincipal: principal(["finance.view"]) }, res, { build, db: {} });
  assert.equal(res.statusCode, 405);
});

test("fee routing rejects Solana without the explicit mainnet pair", async () => {
  const res = fakeRes();
  await financeFeeRouting({ method: "GET", query: { chainId: "101" }, dashboardPrincipal: principal(["finance.view"]) }, res, { build, db: {} });
  assert.equal(res.statusCode, 400);
});

test("fee routing returns the read model for finance.view", async () => {
  const res = fakeRes();
  await financeFeeRouting({ method: "GET", query: { chainId: "4663", days: "7" }, dashboardPrincipal: principal(["finance.view"]) }, res, { build, db: {} });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.network.chainId, 4663);
  assert.equal(res.body.days, 7);
  assert.equal(res.headers["Cache-Control"], "no-store");
});

test("fee routing refuses testnets", async () => {
  for (const chainId of ["97", "46630"]) {
    const res = fakeRes();
    await financeFeeRouting({ method: "GET", query: { chainId }, dashboardPrincipal: principal(["finance.view"]) }, res, { build, db: {} });
    assert.equal(res.statusCode, 400);
  }
});

test("fee routing chainId=all reads the three mainnets and adds totals", async () => {
  const res = fakeRes();
  const seen = [];
  const buildEach = async ({ network, days }) => {
    seen.push(network.chainId);
    return { schemaVersion: "finance-fee-routing-v1", network, days, totals: { holdings: { byChain: [{ chainId: network.chainId, chain: network.chain, assets: [], amountUsd: 10, pricedCount: 1, missingPriceCount: 0 }] }, inflows: { byChain: [] } }, prices: [] };
  };
  await financeFeeRouting({ method: "GET", query: { chainId: "all", days: "30" }, dashboardPrincipal: principal(["finance.view"]) }, res, { build: buildEach, db: {} });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(seen.sort((a, b) => a - b), [56, 101, 4663]);
  assert.equal(res.body.schemaVersion, "finance-all-chains-v1");
  assert.equal(res.body.totals.holdings.amountUsd, 30);
});
