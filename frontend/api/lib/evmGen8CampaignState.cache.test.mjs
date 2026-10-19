// Generation 8 campaign-state cache: 60 s, and a newer evm_gen8_swaps row reads the lens again.
// Generation 5 keeps the 10 s cache (evmGen5CampaignState.test.mjs).
import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:1/test";
const { evmCampaignStateHandler, clearEvmCampaignStateCache } = await import("../evmCampaignState.js");

const campaign = "0x00000000000000000000000000000000000000c8";

function fakeRes() {
  return {
    statusCode: 0,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    end(payload) { this.body = payload ? JSON.parse(payload) : null; },
    json(payload) { this.body = payload; },
  };
}

function depsFor(reads, swaps) {
  return {
    getProvider: async () => ({}),
    gen8Config: () => ({ hook: { address: "0x00000000000000000000000000000000000000aa" } }),
    readGen8Pool: async () => ({ poolId: "0xpool" }),
    readGen8State: async () => {
      reads.n += 1;
      return {
        campaignAddress: campaign,
        supported: true,
        generation: { factoryGeneration: 8, kind: "gen8" },
        gen8: { poolId: "0xpool" },
        market: { sqrtPriceX96: String(reads.n) },
      };
    },
    loadGen8Indexed: async () => null,
    db: {
      query: async (sql, params) => {
        assert.match(String(sql), /evm_gen8_swaps/);
        assert.equal(params[0], 46630);
        assert.equal(String(params[1]).toLowerCase(), campaign);
        assert.ok(params[2] instanceof Date);
        if (swaps.mode === "throw") throw new Error("db down");
        return { rows: swaps.mode === "newer" ? [{ hit: 1 }] : [] };
      },
    },
  };
}

async function call(deps) {
  const res = fakeRes();
  const url = `/api/evm/campaign-state?chainId=46630&campaign=${campaign}`;
  await evmCampaignStateHandler({ method: "GET", url, query: { chainId: "46630", campaign } }, res, deps);
  return res;
}

test("a gen-8 coin stays cached until a newer indexed swap, and a DB error keeps the cache", async () => {
  clearEvmCampaignStateCache();
  const reads = { n: 0 };
  const swaps = { mode: "same" };
  const deps = depsFor(reads, swaps);

  const first = await call(deps);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.cached, false);
  assert.equal(first.body.market.sqrtPriceX96, "1");
  assert.equal(reads.n, 1);

  const second = await call(deps);
  assert.equal(second.body.cached, true);
  assert.equal(second.body.market.sqrtPriceX96, "1");
  assert.equal(reads.n, 1);

  swaps.mode = "newer";
  const third = await call(deps);
  assert.equal(third.body.cached, false);
  assert.equal(third.body.market.sqrtPriceX96, "2");
  assert.equal(reads.n, 2);

  swaps.mode = "same";
  const fourth = await call(deps);
  assert.equal(fourth.body.cached, true);
  assert.equal(reads.n, 2);

  swaps.mode = "throw";
  const fifth = await call(deps);
  assert.equal(fifth.body.cached, true);
  assert.equal(reads.n, 2, "a DB error keeps the cached lens");
});
