import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://user:pass@127.0.0.1:1/none";

const { pool } = await import("../../server/db.js");
const { adminRewardOverview, internalRewardRouting } = await import("./stubs.js");

function fakeRes() {
  return {
    statusCode: 0, body: null, headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("routing totals are per chain and token; no wei + lamports sum", async (t) => {
  const original = pool.query;
  t.after(() => { pool.query = original; });
  const seen = [];
  pool.query = async (sql) => {
    seen.push(sql);
    if (/group by chain::text/.test(sql)) {
      return { rows: [
        { chain: "101", token_symbol: "SOL", wallet_count: 2, airdrop_pool_amount: "121555159", recruiter_route_amount: "0" },
        { chain: "56", token_symbol: "BNB", wallet_count: 1, airdrop_pool_amount: "1000000000000000000", recruiter_route_amount: "5" },
      ] };
    }
    return { rows: [{ active_linked_wallet_count: 3 }] };
  };
  const res = fakeRes();
  await internalRewardRouting({ method: "GET", query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.airdropPoolAmount, null);
  assert.equal(res.body.recruiterRouteAmount, null);
  assert.equal(res.body.activeLinkedWalletCount, 3);
  assert.deepEqual(res.body.byChain.map((row) => [row.chainId, row.tokenSymbol, row.airdropPoolAmount]), [
    [101, "SOL", "121555159"],
    [56, "BNB", "1000000000000000000"],
  ]);
  // The only amount sums are grouped by chain.
  for (const sql of seen) if (/sum\(amount\)/.test(sql)) assert.match(sql, /group by chain/);
});

test("overview returns no cross-chain amount totals", async (t) => {
  const original = pool.query;
  t.after(() => { pool.query = original; });
  const seen = [];
  pool.query = async (sql) => {
    seen.push(sql);
    if (/total_rewards/.test(sql)) return { rows: [{ total_rewards: 4, total_claimable: null, total_claim_pending: null, total_claimed: null, total_failed: 0 }] };
    return { rows: [] };
  };
  const res = fakeRes();
  await adminRewardOverview({ method: "GET", query: {} }, res);
  assert.equal(res.statusCode, 200);
  const totals = seen.find((sql) => /total_rewards/.test(sql));
  assert.doesNotMatch(totals, /sum\(amount\)/);
  for (const sql of seen) if (/sum\(amount\)/.test(sql)) assert.match(sql, /group by [^\n]*chain/);
});
