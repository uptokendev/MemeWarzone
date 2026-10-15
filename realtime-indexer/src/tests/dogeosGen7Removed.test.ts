import test from "node:test";
import assert from "node:assert/strict";

// Spec section 4 "Removed (B8)": DogeOS 6281971 no longer graduates into a gen-7 MuchFi V3 pool, so the
// Robinhood V3 CMS heal and V3 market routes no longer serve it (gen-8 rows are served by the gen-8
// readers). Robinhood 4663/46630 keeps both; BNB keeps falling through.
// Env is fixed before any module import because env.ts snapshots it.
process.env.RUNTIME_ENVIRONMENT = "local";
process.env.LOCAL_DISABLE_ABLY = "1";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/memewarzone_dogeos_local";
process.env.DB_WATCHDOG_EXIT = "0";
process.env.DOGEOS_RPC_HTTP_6281971 = "https://rpc.testnet.dogeos.com";
process.env.ROBINHOOD_RPC_HTTP_46630 = "https://rh-testnet-rpc.test.invalid";

const { pool } = await import("../db.js");
const { healRobinhoodGraduatedCms } = await import("../robinhoodCmsHeal.js");
const { registerRobinhoodMarketContinuityRoutes } = await import("../robinhoodMarketApi.js");

const DOGEOS = 6281971;
const CAMPAIGN = "0x00000000000000000000000000000000000000c1";

// DB stub: every query answers with no rows, so nothing touches a database.
const stubQuery = async () => ({ rows: [], rowCount: 0 });
(pool as any).query = stubQuery;
(pool as any).connect = async () => ({ query: stubQuery, release() {} });

function countingProvider() {
  const calls: string[] = [];
  const fail = (name: string) => async () => { calls.push(name); throw new Error("rpc down"); };
  return { calls, call: fail("call"), getLogs: fail("getLogs"), getBlock: fail("getBlock"), getBlockNumber: fail("getBlockNumber") };
}

test("CMS heal refuses 6281971 before any RPC read, like BNB; Robinhood still reaches the on-chain read", async () => {
  for (const chainId of [DOGEOS, 56, 97]) {
    const provider = countingProvider();
    assert.deepEqual(
      await healRobinhoodGraduatedCms(provider as any, chainId, CAMPAIGN, null),
      { healed: false, reason: "not_robinhood_chain" },
      `${chainId}`,
    );
    assert.deepEqual(provider.calls, [], `${chainId}: no RPC call`);
  }
  const robinhood = await healRobinhoodGraduatedCms(countingProvider() as any, 46630, CAMPAIGN, null);
  assert.equal(robinhood.healed, false);
  assert.match(robinhood.reason, /^rpc_read_failed:/, "46630 reaches the on-chain read");
});

function captureRoutes() {
  const routes = new Map<string, (req: any, res: any, next: () => void) => Promise<unknown>>();
  registerRobinhoodMarketContinuityRoutes({ get: (route: string, handler: any) => { routes.set(route, handler); } } as any);
  return routes;
}

function fakeResponse() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  return res;
}

test("V3 market routes let 6281971 fall through (no MuchFi V3 market); Robinhood is still served here", async () => {
  const routes = captureRoutes();
  for (const route of [
    "/api/token/:campaign/market-state",
    "/api/token/:campaign/trade-route",
    "/api/token/:campaign/market-summary",
    "/api/token/:campaign/market-trades",
  ]) {
    const handler = routes.get(route);
    assert.ok(handler, route);
    for (const chainId of [DOGEOS, 56]) {
      let nextCalled = 0;
      const res = fakeResponse();
      await handler({ query: { chainId: String(chainId) }, params: { campaign: CAMPAIGN } }, res, () => { nextCalled += 1; });
      assert.equal(nextCalled, 1, `${route}: ${chainId} falls through`);
      assert.equal(res.body, undefined, `${route}: ${chainId} got no V3 response`);
    }
    let nextCalled = 0;
    const res = fakeResponse();
    await handler({ query: { chainId: "46630" }, params: { campaign: CAMPAIGN } }, res, () => { nextCalled += 1; });
    assert.equal(nextCalled, 0, `${route}: 46630 is served here`);
    assert.notEqual(res.body, undefined, `${route}: 46630 got a response`);
  }
});
