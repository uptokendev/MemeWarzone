import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";

process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/memewarzone_test";
process.env.PG_DISABLE_SSL = "1";
process.env.NODE_ENV = "test";

const { buildWalletActionMessage } = await import("./lib/walletActionAuth.js");
const { pool } = await import("../server/db.js");
const { default: handler } = await import("./arenaBattleActivity.js");

const BATTLE = "arena-test-1";
const voter = ethers.Wallet.createRandom();
const stranger = ethers.Wallet.createRandom();

function installFakeDb() {
  const db = { nonces: new Set(), comments: [], nextId: 1 };
  pool.query = async (sql, params = []) => {
    const s = String(sql);
    if (s.includes("update public.auth_nonces")) {
      const nonce = params.find((p) => typeof p === "string" && p.startsWith("n-"));
      if (!nonce || db.nonces.has(nonce)) return { rows: [] };
      db.nonces.add(nonce);
      return { rows: [{ expires_at: new Date(Date.now() + 60_000).toISOString() }] };
    }
    if (s.includes("from public.arena_battles")) return { rows: params[0] === BATTLE ? [{ id: BATTLE, chain_id: 101 }] : [] };
    if (s.includes("action_type = 'boost'") && s.includes("limit 30")) {
      return { rows: [{ id: 3, side: "right", wallet: "8rEc", boost_units: 2, gross_native_raw: "250000000", at: "2026-10-02T10:05:00Z" }] };
    }
    if (s.includes("action_type = 'free_vote'") && s.includes("group by side, bucket")) {
      return { rows: [{ side: "left", bucket: Math.floor(Date.parse("2026-10-02T10:12:00Z") / 600000), n: 14 }] };
    }
    if (s.includes("group by wallet, side")) return { rows: [{ wallet: "8rEc", side: "right", boosts: 2, gross_native_raw: "420000000" }] };
    if (s.includes("group by side") && s.includes("pool_native_raw")) return { rows: [{ side: "right", boosts: 2, gross_native_raw: "420000000", pool_native_raw: "378000000" }] };
    if (s.includes("from public.arena_battle_comments c")) return { rows: db.comments.slice().reverse() };
    if (s.includes("count(*)::int as n from public.arena_battle_comments")) return { rows: [{ n: db.comments.length }] };
    if (s.includes("insert into public.arena_battle_comments")) {
      const row = { id: db.nextId++, author_wallet: params[2], body: params[3], created_at: new Date().toISOString(), side: null };
      db.comments.push(row);
      return { rows: [row] };
    }
    throw new Error(`unexpected SQL in test: ${s.slice(0, 80)}`);
  };
  return db;
}

let seq = 0;
async function sign(wallet, text, chainId = 56) {
  const nonce = `n-${++seq}`;
  const walletAddress = wallet.address.toLowerCase();
  const message = buildWalletActionMessage({ action: "arena_battle_comment", walletAddress, chainId, nonce, extraLines: [`Battle: ${BATTLE}`, `Comment: ${text}`] });
  return { action: "arena_battle_comment", walletAddress, chainId, nonce, message, signature: await wallet.signMessage(message) };
}

async function call(method, path, body) {
  const res = { statusCode: 200, body: null, setHeader() {}, end(raw) { this.body = raw ? JSON.parse(String(raw)) : null; } };
  await handler({ method, path, url: path, body, headers: {} }, res);
  return res;
}

test("activity: boosts, grouped votes, supporters and totals in native units", async () => {
  installFakeDb();
  const res = await call("GET", `/arena/battles/${BATTLE}/activity`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.activity.map((a) => a.kind), ["votes", "boost"]);
  assert.equal(res.body.activity[1].amountNative, 0.25);
  assert.equal(res.body.supporters[0].amountNative, 0.42);
  assert.equal(res.body.boosts.total.boosts, 2);
  assert.equal((await call("GET", "/arena/battles/nope/activity")).statusCode, 404);
});

test("comments: signed by the wallet, text bound into the signature, rate limited", async () => {
  const db = installFakeDb();
  const text = "Nine votes ahead. Do not get comfortable.";
  const auth = await sign(voter, text);
  const ok = await call("POST", `/arena/battles/${BATTLE}/comments`, { chainId: 56, walletAddress: voter.address, body: `  ${text}  `, auth });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.comment.body, text);

  const replay = await call("POST", `/arena/battles/${BATTLE}/comments`, { chainId: 56, walletAddress: voter.address, body: text, auth });
  assert.equal(replay.statusCode, 401, "a nonce works once");

  const swapped = await call("POST", `/arena/battles/${BATTLE}/comments`, { chainId: 56, walletAddress: voter.address, body: "something else", auth: await sign(voter, text) });
  assert.equal(swapped.statusCode, 401, "the stored text must be the signed text");

  const wrong = await call("POST", `/arena/battles/${BATTLE}/comments`, { chainId: 56, walletAddress: voter.address, body: text, auth: await sign(stranger, text) });
  assert.equal(wrong.statusCode, 401);

  for (let i = db.comments.length; i < 5; i += 1) db.comments.push({ id: 100 + i, author_wallet: voter.address.toLowerCase(), body: "x", created_at: new Date().toISOString() });
  const limited = await call("POST", `/arena/battles/${BATTLE}/comments`, { chainId: 56, walletAddress: voter.address, body: "one more", auth: await sign(voter, "one more") });
  assert.equal(limited.statusCode, 429);

  const list = await call("GET", `/arena/battles/${BATTLE}/comments`);
  assert.equal(list.statusCode, 200);
  assert.ok(list.body.comments.length >= 1);
});

test("comment validation and unknown routes", async () => {
  installFakeDb();
  assert.equal((await call("POST", `/arena/battles/${BATTLE}/comments`, { chainId: 56, body: "  " })).body.code, "BATTLE_COMMENT_EMPTY");
  assert.equal((await call("POST", `/arena/battles/${BATTLE}/comments`, { chainId: 1, body: "hi" })).body.code, "BATTLE_COMMENT_CHAIN");
  assert.equal((await call("GET", `/arena/battles/${BATTLE}/other`)).statusCode, 404);
});
