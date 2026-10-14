import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/memewarzone_test";
process.env.PG_DISABLE_SSL = "1";
process.env.NODE_ENV = "test";

const { pool } = await import("../../server/db.js");
const { default: follow } = await import("./campaign.js");
const { default: list } = await import("./campaign-list.js");

const SOL_WALLET = "8rEcGbN6TPdTqKkWXqcdKgcYaixbqpwBRpEzwNqxwGzt";
const EVM_WALLET = "0x00000000000000000000000000000000000000Aa";
const RH_COIN = "0x1111111111111111111111111111111111111111";
const SOL_COIN = "So1anaCoin111111111111111111111111111111pump";

function installFakeDb() {
  const rows = [];
  pool.query = async (sql, params = []) => {
    const s = String(sql);
    if (s.includes("INSERT INTO public.campaign_follows")) {
      const [chain_id, user_address, campaign_address] = params;
      if (!rows.some((r) => r.chain_id === chain_id && r.user_address === user_address && r.campaign_address === campaign_address)) {
        rows.push({ chain_id, user_address, campaign_address, created_at: rows.length });
      }
      return { rows: [] };
    }
    if (s.includes("SELECT 1 FROM public.campaign_follows")) {
      return { rows: rows.filter((r) => r.user_address === params[0] && r.campaign_address === params[1]).slice(0, 1) };
    }
    if (s.includes("DELETE FROM public.campaign_follows")) {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].user_address === params[0] && rows[i].campaign_address === params[1]) rows.splice(i, 1);
      return { rows: [] };
    }
    if (s.includes("GROUP BY campaign_address")) {
      const mine = rows.filter((r) => r.user_address === params[0]).sort((a, b) => b.created_at - a.created_at);
      return { rows: [...new Map(mine.map((r) => [r.campaign_address, r])).values()] };
    }
    throw new Error(`unexpected SQL in test: ${s.slice(0, 80)}`);
  };
  return rows;
}

async function call(handler, method, { query = {}, body } = {}) {
  const url = `/x?${new URLSearchParams(query).toString()}`;
  const res = { statusCode: 200, body: null, setHeader() {}, end(raw) { this.body = raw ? JSON.parse(String(raw)) : null; } };
  await handler({ method, url, body, headers: {} }, res);
  return res;
}

test("a Solana wallet follows a Robinhood coin, sees it, lists it and unfollows it", async () => {
  const rows = installFakeDb();
  // The browser sends the coin's chain (46630); the server keys the pair, not the chain.
  const ok = await call(follow, "POST", { body: { chainId: 46630, userAddress: SOL_WALLET, campaignAddress: RH_COIN, action: "follow" } });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.deepEqual(rows.map((r) => [r.chain_id, r.user_address, r.campaign_address]), [[101, SOL_WALLET, RH_COIN]]);

  assert.equal((await call(follow, "GET", { query: { chainId: "46630", user: SOL_WALLET, campaign: RH_COIN } })).body.isFollowing, true);
  assert.equal((await call(follow, "GET", { query: { chainId: "101", user: SOL_WALLET, campaign: RH_COIN } })).body.isFollowing, true);
  assert.deepEqual((await call(list, "GET", { query: { chainId: "101", user: SOL_WALLET } })).body.items, [RH_COIN]);

  await call(follow, "POST", { body: { chainId: 46630, userAddress: SOL_WALLET, campaignAddress: RH_COIN, action: "unfollow" } });
  assert.equal(rows.length, 0);
});

test("an EVM wallet follows a Solana coin; EVM pairs keep chain 0 and lowercase", async () => {
  const rows = installFakeDb();
  await call(follow, "POST", { body: { chainId: 0, userAddress: EVM_WALLET, campaignAddress: SOL_COIN, action: "follow" } });
  await call(follow, "POST", { body: { chainId: 0, userAddress: EVM_WALLET, campaignAddress: RH_COIN.toUpperCase().replace("0X", "0x"), action: "follow" } });
  assert.deepEqual(rows.map((r) => [r.chain_id, r.user_address, r.campaign_address]), [
    [101, EVM_WALLET.toLowerCase(), SOL_COIN],
    [0, EVM_WALLET.toLowerCase(), RH_COIN],
  ]);
  assert.equal((await call(follow, "GET", { query: { chainId: "56", user: EVM_WALLET, campaign: SOL_COIN } })).body.isFollowing, true);
  assert.deepEqual((await call(list, "GET", { query: { chainId: "0", user: EVM_WALLET } })).body.items, [RH_COIN, SOL_COIN]);
});

test("garbage addresses and actions are still refused", async () => {
  installFakeDb();
  assert.equal((await call(follow, "POST", { body: { userAddress: "nope", campaignAddress: RH_COIN, action: "follow" } })).statusCode, 400);
  assert.equal((await call(follow, "POST", { body: { userAddress: SOL_WALLET, campaignAddress: RH_COIN, action: "delete" } })).statusCode, 400);
  assert.equal((await call(list, "GET", { query: { user: "nope" } })).statusCode, 400);
});
