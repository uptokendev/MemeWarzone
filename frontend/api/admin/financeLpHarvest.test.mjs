import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://user:pass@127.0.0.1:1/none";
process.env.INDEXER_API_BASE_URL = "https://indexer.test";
process.env.DASHBOARD_OPS_KEY = "test-ops-key";

const { default: financeAdmin, LP_HARVEST_EVM_PAUSED_ERROR, lpHarvestEvmPaused } = await import("./finance.js");

function fakeRes() {
  return {
    statusCode: 0, body: null, headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

// A dashboard principal that already passed lp_harvest.manage in railwayProxy.
const principal = { authUserId: "test-user", email: "ops@test", role: "finance_manager", memberId: "m1", permissions: ["lp_harvest.manage"] };

async function harvest(query, body = { pair: "DjoARyfuTTeSEJo9KbqgMS1xnG56c5Dc5xntDRNcBaBR" }) {
  const res = fakeRes();
  await financeAdmin({ method: "POST", path: "/api/admin/finance/lp-harvest", url: "/api/admin/finance/lp-harvest", query, body, headers: {}, dashboardPrincipal: principal }, res);
  return res;
}

function withFetch(fn) {
  const saved = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, txHash: "sig123", note: "Claimed." }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return fn(calls).finally(() => { globalThis.fetch = saved; });
}

test("the paused message is the plain founder copy", () => {
  assert.equal(LP_HARVEST_EVM_PAUSED_ERROR, "Harvest on BNB and Robinhood is paused until the protocol share has a vault that can pay it out.");
  assert.equal(lpHarvestEvmPaused({ query: { chainId: "56" } }), true);
  assert.equal(lpHarvestEvmPaused({ query: { chainId: "4663" } }), true);
  assert.equal(lpHarvestEvmPaused({ query: { chainId: "101" } }), false);
});

test("BNB 56 and Robinhood 4663 harvest answer 400 with the paused message and never call the indexer", async () => {
  await withFetch(async (calls) => {
    for (const chainId of ["56", "4663"]) {
      const res = await harvest({ chainId });
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.code, "LP_HARVEST_PAUSED");
      assert.equal(res.body.error, LP_HARVEST_EVM_PAUSED_ERROR);
    }
    assert.equal(calls.length, 0);
  });
});

test("bare chainId=101 is refused before the indexer: Solana needs its identity params", async () => {
  await withFetch(async (calls) => {
    const res = await harvest({ chainId: "101" });
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /Solana mainnet only/);
    assert.equal(calls.length, 0);
  });
});

test("Solana mainnet harvest forwards chainId, environment, cluster and the pair to the indexer with the ops key", async () => {
  await withFetch(async (calls) => {
    const res = await harvest({ chainId: "101", environment: "production", solanaCluster: "mainnet-beta" }, { pair: "PoolAddr", campaign: "CampaignAddr" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.txHash, "sig123");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://indexer.test/api/dashboard/lp-fees/collect");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers["x-ops-key"], "test-ops-key");
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.chainId, 101);
    assert.equal(sent.environment, "production");
    assert.equal(sent.solanaCluster, "mainnet-beta");
    assert.equal(sent.pair, "PoolAddr");
    assert.equal(sent.campaign, "CampaignAddr");
  });
});

test("an indexer refusal (treasury unset) reaches the dashboard as the same status and message", async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: "Harvest refused: SOLANA_PROTOCOL_TREASURY_ADDRESS is not set on the indexer." }), { status: 503 });
  try {
    const res = await harvest({ chainId: "101", environment: "production", solanaCluster: "mainnet-beta" });
    assert.equal(res.statusCode, 503);
    assert.match(res.body.error, /Harvest refused/);
  } finally {
    globalThis.fetch = saved;
  }
});
