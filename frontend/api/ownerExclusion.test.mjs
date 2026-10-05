// Owner / internal wallets (shared/ownerWallets.mjs, founder 2026-10-05: "Exclude all owner wallets
// from leagues and recruiters"): the API paths that select winners, show standings or link wallets.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:1/test";
process.env.PG_DISABLE_SSL = "1";

const { pool } = await import("../server/db.js");
const { attributionWalletConnect } = await import("./dev-fix/attribution.js");
const { ownerRelinkRefusal } = await import("./dashboard/recruiters.js");
const { planMwlPayout } = await import("./lib/arenaMwlPayouts.js");
const { leagueRowWinner } = await import("./league.js");
const { withoutInternalRecruiters } = await import("./leagueRecruiter.js");
const { ownerWalletIndex, withoutOwnerWallets } = await import("../shared/ownerWallets.mjs");

const here = path.dirname(fileURLToPath(import.meta.url));
const DEPLOYER = "9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H";
const OPERATOR = "2AMfRaxS9182AESwWRz2TrvUxPqXaUot4wV1oAvjsTrB";
const BNB_DEPLOYER = "0x1a367016f10b230e28cf1abda2594c47bf60fe34";
const USER_SOL = "CVqCRi5cRVKBriiEuwcWtbx8EJ7inFHhxagagJZjS5Cf";
const USER_SOL_2 = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"; // an ordinary wallet, not ours
const owners = ownerWalletIndex({});

function fakeRes() {
  const res = { statusCode: 0, headers: {}, body: null };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.end = (text) => { res.body = JSON.parse(text); };
  return res;
}

function withQueries(answer) {
  const seen = [];
  const original = pool.query;
  pool.query = async (sql, params) => {
    seen.push(String(sql));
    return answer(String(sql), params);
  };
  return { seen, restore: () => { pool.query = original; } };
}

// ---------------------------------------------------------------- recruiter links

test("wallet-connect refuses an owner wallet before touching the database", async () => {
  const db = withQueries(() => { throw new Error("no query expected"); });
  try {
    for (const wallet of [DEPLOYER, "0x1A367016f10b230E28Cf1ABda2594C47bf60fe34"]) {
      const res = fakeRes();
      await attributionWalletConnect({ method: "POST", body: { walletAddress: wallet, sessionToken: "s", memberRole: "trader" } }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.linked, false);
      assert.equal(res.body.blocked, true);
      assert.equal(res.body.code, "INTERNAL_WALLET_NOT_LINKABLE");
    }
    assert.equal(db.seen.length, 0);
  } finally {
    db.restore();
  }
});

test("wallet-connect refuses to add a member to an internal recruiter (signup wallet is ours) and writes no link", async () => {
  const db = withQueries((sql) => {
    if (sql.includes("from public.wallet_referral_attribution_windows")) return { rows: [{ id: 7, recruiter_id: 108, code: "crazysquad", status: "active" }] };
    if (sql.includes("lower(code) = lower($1)")) return { rows: [{ id: 108, code: "crazysquad", status: "active", wallet_address: BNB_DEPLOYER, metadata: { signup: {} } }] };
    return { rows: [] };
  });
  try {
    const res = fakeRes();
    await attributionWalletConnect({ method: "POST", body: { walletAddress: USER_SOL, sessionToken: "s", memberRole: "trader" } }, res);
    assert.equal(res.body.code, "INTERNAL_RECRUITER_NOT_LINKABLE");
    assert.equal(res.body.linked, false);
    assert.ok(!db.seen.some((sql) => /insert into public\.wallet_recruiter_links|insert into public\.wallet_squad_memberships/.test(sql)));
  } finally {
    db.restore();
  }
});

test("dashboard: an owner wallet cannot be (re)linked; detaching it and normal wallets are unaffected", () => {
  assert.match(String(ownerRelinkRefusal(DEPLOYER.toLowerCase(), "active", owners)), /cannot be linked/);
  assert.equal(ownerRelinkRefusal(DEPLOYER.toLowerCase(), "inactive", owners), null);
  assert.equal(ownerRelinkRefusal(DEPLOYER.toLowerCase(), undefined, owners), null);
  assert.equal(ownerRelinkRefusal(USER_SOL.toLowerCase(), "active", owners), null);
  const src = fs.readFileSync(path.join(here, "dashboard/recruiters.js"), "utf8");
  const handler = src.slice(src.indexOf("export async function dashboardRecruiterMember"));
  assert.ok(handler.indexOf("ownerRelinkRefusal(wallet, linkStatus)") > 0);
  assert.ok(handler.indexOf("ownerRelinkRefusal(wallet, linkStatus)") < handler.indexOf("pool.connect()"), "refused before the transaction");
});

// ---------------------------------------------------------------- Major War League payouts

const coin = (rank, wallet, points = 10) => ({ tokenAddress: `t${rank}`, finalRank: rank, points, wallet });

test("MWL: a coin owned by one of our wallets is skipped, the next coin takes its place and the field shrinks", () => {
  const standings = [coin(1, "0x1A367016f10b230E28Cf1ABda2594C47bf60fe34"), coin(2, "0x00000000000000000000000000000000000000b2"), coin(3, "0x00000000000000000000000000000000000000c3")];
  const plan = planMwlPayout({ chainId: 56, period: "mwl_monthly", pot: 1000n, standings, owners });
  assert.equal(plan.status, "paid");
  assert.deepEqual(plan.winners.map((w) => [w.rank, w.finalRank]), [[1, 2], [2, 3]]);
  assert.equal(plan.winners.reduce((sum, w) => sum + w.amount, 0n), 1000n, "the whole pot is still paid");
  const same = planMwlPayout({ chainId: 56, period: "mwl_monthly", pot: 1000n, standings: standings.slice(1), owners });
  assert.deepEqual(plan.winners.map((w) => w.amount), same.winners.map((w) => w.amount), "identical to a field without the owner coin");
});

test("MWL: only owner coins -> nobody eligible, the pot rolls over", () => {
  const plan = planMwlPayout({ chainId: 101, period: "quarterly", pot: 50_000_000n, standings: [coin(1, DEPLOYER), coin(2, OPERATOR)], solanaMin: 5_000_000n, owners });
  assert.deepEqual(plan, { status: "rolled_over", reason: "no-eligible-owner", winners: [] });
});

// ---------------------------------------------------------------- pre-grad live standings

test("live league standings pick the paid wallet per category and drop owner rows in order", () => {
  assert.equal(leagueRowWinner("biggest_hit", { buyer_address: "B", creator_address: "C" }), "B");
  assert.equal(leagueRowWinner("top_earner", { wallet: "W" }), "W");
  for (const category of ["fastest_finish", "perfect_run", "crowd_favorite"]) assert.equal(leagueRowWinner(category, { creator_address: "C" }), "C");
  const rows = [{ wallet: DEPLOYER }, { wallet: USER_SOL }, { wallet: BNB_DEPLOYER }, { wallet: USER_SOL_2 }];
  assert.deepEqual(withoutOwnerWallets(rows, (r) => leagueRowWinner("top_earner", r), owners).map((r) => r.wallet), [USER_SOL, USER_SOL_2]);
  const src = fs.readFileSync(path.join(here, "league.js"), "utf8");
  const finish = src.slice(src.indexOf("const finishStandings = async"));
  assert.ok(finish.indexOf("withoutOwnerWallets(items") < finish.indexOf("const fieldSize"), "owners leave before the field is counted");
  assert.ok(finish.indexOf("withoutOwnerWallets(items") < finish.indexOf("persistFinalizedCategory"), "and before any page write");
});

// ---------------------------------------------------------------- recruiter board

test("recruiter board: internal recruiters (signup or payout wallet is ours) leave, ranks close up", async () => {
  const rows = [
    { recruiterId: 114, code: "solkillers2", walletAddress: "hukfofuuwxc5qfzxzr5dbax4s7w4vjuw8ahv9ld4c2j9", signupMetadata: { solanaWalletAddress: "HuKfoFUuWxC5qFZXzr5dbaX4S7w4vJUW8AHV9LD4C2J9" }, rank: 1 },
    { recruiterId: 126, code: "adstoshi", walletAddress: USER_SOL, signupMetadata: {}, rank: 2 },
    { recruiterId: 900, code: "paidtoours", walletAddress: "0x00000000000000000000000000000000000000aa", signupMetadata: {}, rank: 3 },
    { recruiterId: 124, code: "sol-soldiers", walletAddress: "2amfraxs9182aeswwrz2trvuxpqxauot4wv1oavjstrb", signupMetadata: { solanaWalletAddress: OPERATOR }, rank: 4 },
    { recruiterId: 127, code: "realone", walletAddress: "0x00000000000000000000000000000000000000bb", signupMetadata: {}, rank: 5 },
  ];
  const db = { query: async () => ({ rows: [{ code: "paidtoours", wallet_address: BNB_DEPLOYER }] }) };
  const out = await withoutInternalRecruiters(rows, db);
  assert.deepEqual(out.map((r) => [r.recruiterId, r.rank]), [[126, 1], [127, 2]]);
});
