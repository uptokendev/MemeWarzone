import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";

process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/memewarzone_test";
process.env.PG_DISABLE_SSL = "1";
process.env.NODE_ENV = "test";
process.env.SUPABASE_URL = "https://abc.supabase.co";

const { buildWalletActionMessage } = await import("./lib/walletActionAuth.js");
const { pool } = await import("../server/db.js");
const { default: handler } = await import("./coinPage.js");

const CHAIN = 97;
const TOKEN = "0xa9d9350de50b2b413663b3f0b08352a8d92871d5";
const owner = ethers.Wallet.createRandom();
const stranger = ethers.Wallet.createRandom();

/** In-memory stand-in for the few statements coinPage.js runs. */
function installFakeDb({ importRow = null } = {}) {
  const db = { nonces: new Set(), profile: { short_story: "keep me", sections: { origin: "keep" } }, posts: [], nextId: 1 };
  pool.query = async (sql, params = []) => {
    const s = String(sql);
    if (s.includes("update public.auth_nonces")) {
      const nonce = params.find((p) => typeof p === "string" && p.startsWith("n-"));
      if (!nonce || db.nonces.has(nonce)) return { rows: [] };
      db.nonces.add(nonce);
      return { rows: [{ expires_at: new Date(Date.now() + 60_000).toISOString() }] };
    }
    if (s.includes("from public.arena_token_imports")) return { rows: importRow ? [importRow] : [] };
    if (s.includes("creator_address from public.campaigns")) return { rows: [{ token_address: TOKEN, campaign_address: TOKEN, creator_address: owner.address.toLowerCase() }] };
    if (s.includes("created_at_chain, graduated_at_chain from public.campaigns")) return { rows: [{ token_address: TOKEN, campaign_address: TOKEN, created_at_chain: "2026-09-25T10:00:00Z", graduated_at_chain: null }] };
    if (s.includes("from public.arena_battles")) return { rows: [] };
    if (s.startsWith("select") && s.includes("from public.token_story_profiles")) return { rows: [db.profile] };
    if (s.includes("insert into public.token_story_profiles")) {
      const cols = s.match(/\(chain_id, token_address, updated_by, updated_at, ([^)]+)\)/)[1].split(", ");
      cols.forEach((c, i) => {
        const v = params[3 + i];
        db.profile[c] = c === "section_images" && typeof v === "string" ? JSON.parse(v) : v;
      });
      db.profile.updated_by = params[2];
      return { rows: [] };
    }
    if (s.includes("count(*)::int as n from public.coin_posts")) return { rows: [{ n: db.posts.length }] };
    if (s.includes("insert into public.coin_posts")) {
      const row = { id: db.nextId++, body: params[3], media_url: params[4], share_to_feed: params[5], status: 0, created_at: new Date().toISOString() };
      db.posts.push(row);
      return { rows: [row] };
    }
    if (s.includes("select 1 from public.coin_posts")) return { rows: db.posts.some((p) => String(p.id) === String(params[0]) && p.status === 0) ? [{}] : [] };
    if (s.includes("from public.coin_posts")) return { rows: db.posts.filter((p) => p.status === 0).slice().reverse() };
    if (s.includes("update public.coin_posts set status = 2")) {
      const p = db.posts.find((x) => String(x.id) === String(params[0]) && x.status === 0);
      if (p) p.status = 2;
      return { rows: [], rowCount: p ? 1 : 0 };
    }
    if (s.includes("set pinned_post_id = null")) {
      if (String(db.profile.pinned_post_id) === String(params[2])) db.profile.pinned_post_id = null;
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected SQL in test: ${s.slice(0, 80)}`);
  };
  return db;
}

let nonceSeq = 0;
async function signed(wallet, action, extraLines = []) {
  const nonce = `n-${++nonceSeq}`;
  const walletAddress = wallet.address.toLowerCase();
  const message = buildWalletActionMessage({ action, walletAddress, chainId: CHAIN, nonce, extraLines: [`Token: ${TOKEN}`, ...extraLines] });
  return { action, walletAddress, chainId: CHAIN, nonce, message, signature: await wallet.signMessage(message) };
}

async function call(method, path, body) {
  const res = { statusCode: 200, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(raw) { this.body = raw ? JSON.parse(String(raw)) : null; } };
  const url = new URL(`http://localhost/api${path}`);
  const req = { method, path: url.pathname.replace(/^\/api/, ""), url: url.pathname + url.search, query: Object.fromEntries(url.searchParams), body, headers: {} };
  await handler(req, res);
  return res;
}

test("read: profile defaults, launch auto update, owner shown", async () => {
  installFakeDb();
  const res = await call("GET", `/coin-page?chainId=${CHAIN}&token=${TOKEN}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.owner.origin, "launched");
  assert.equal(res.body.profile.showAutoUpdates, true);
  assert.deepEqual(res.body.autoUpdates.map((a) => a.kind), ["launch"]);
  assert.deepEqual(res.body.storyText, { shortStory: "keep me", sections: { origin: "keep" } });
});

test("profile save: owner only, signature checked, only sent columns written", async () => {
  const db = installFakeDb();
  const bad = await call("POST", "/coin-page/profile", { chainId: CHAIN, token: TOKEN, profile: { founderNote: "hi" }, auth: await signed(stranger, "coin_page_profile_update") });
  assert.equal(bad.statusCode, 401);

  const auth = await signed(owner, "coin_page_profile_update");
  const ok = await call("POST", "/coin-page/profile", { chainId: CHAIN, token: TOKEN, profile: { founderNote: "The only monster that eats red candles.", bio: "A kaiju.", tags: "kaiju, monsters" }, auth });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.profile.founderNote, "The only monster that eats red candles.");
  assert.deepEqual(ok.body.profile.tags, ["kaiju", "monsters"]);
  assert.equal(db.profile.short_story, "keep me", "the Story's own fields are never written");
  assert.deepEqual(db.profile.sections, { origin: "keep" });

  const replay = await call("POST", "/coin-page/profile", { chainId: CHAIN, token: TOKEN, profile: { founderNote: "again" }, auth });
  assert.equal(replay.statusCode, 401, "a nonce works once");
});

test("profile save: foreign images refused, own uploads accepted", async () => {
  installFakeDb();
  const foreign = await call("POST", "/coin-page/profile", { chainId: CHAIN, token: TOKEN, profile: { bannerUrl: "https://evil.example/b.png" }, auth: await signed(owner, "coin_page_profile_update") });
  assert.equal(foreign.body.code, "COIN_IMAGE_FOREIGN");
  const own = `https://abc.supabase.co/storage/v1/object/public/MEMEBATTLES/coin-pages/${CHAIN}/${TOKEN}/banner-u.png`;
  const ok = await call("POST", "/coin-page/profile", { chainId: CHAIN, token: TOKEN, profile: { bannerUrl: own }, auth: await signed(owner, "coin_page_profile_update") });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.profile.bannerUrl, own);
});

test("imported coins: bio goes through the project details (D4)", async () => {
  installFakeDb({ importRow: { token_address: TOKEN, project_owner_wallet: owner.address.toLowerCase(), ownership_status: "ownership_verified" } });
  const res = await call("POST", "/coin-page/profile", { chainId: CHAIN, token: TOKEN, profile: { bio: "hello" }, auth: await signed(owner, "coin_page_profile_update") });
  assert.equal(res.body.code, "COIN_BIO_IMPORTS_USE_PROJECT");
});

test("unverified import has no owner: writes refused", async () => {
  installFakeDb({ importRow: { token_address: TOKEN, project_owner_wallet: owner.address.toLowerCase(), ownership_status: "ownership_pending" } });
  const res = await call("POST", "/coin-page/profile", { chainId: CHAIN, token: TOKEN, profile: { founderNote: "x" }, auth: await signed(owner, "coin_page_profile_update") });
  assert.equal(res.statusCode, 403);
});

test("posts: create, list, pin, rate limit, delete unpins", async () => {
  const db = installFakeDb();
  const made = await call("POST", "/coin-page/posts", { chainId: CHAIN, token: TOKEN, post: { body: "Holders passed 1,200." }, auth: await signed(owner, "coin_post_create") });
  assert.equal(made.statusCode, 200, JSON.stringify(made.body));
  const id = made.body.post.id;

  const pin = await call("POST", "/coin-page/profile", { chainId: CHAIN, token: TOKEN, profile: { pinnedPostId: id }, auth: await signed(owner, "coin_page_profile_update") });
  assert.equal(pin.body.profile.pinnedPostId, id);
  const badPin = await call("POST", "/coin-page/profile", { chainId: CHAIN, token: TOKEN, profile: { pinnedPostId: "999" }, auth: await signed(owner, "coin_page_profile_update") });
  assert.equal(badPin.body.code, "COIN_PIN_INVALID");

  const list = await call("GET", `/coin-page?chainId=${CHAIN}&token=${TOKEN}`);
  assert.deepEqual(list.body.posts.map((p) => p.body), ["Holders passed 1,200."]);

  for (let i = 0; i < 4; i += 1) await call("POST", "/coin-page/posts", { chainId: CHAIN, token: TOKEN, post: { body: `p${i}` }, auth: await signed(owner, "coin_post_create") });
  const limited = await call("POST", "/coin-page/posts", { chainId: CHAIN, token: TOKEN, post: { body: "one too many" }, auth: await signed(owner, "coin_post_create") });
  assert.equal(limited.statusCode, 429);

  const foreign = await call("POST", "/coin-page/posts", { chainId: CHAIN, token: TOKEN, post: { body: "img", mediaUrl: "https://evil.example/x.png" }, auth: await signed(owner, "coin_post_create") });
  assert.equal(foreign.body.code, "COIN_IMAGE_FOREIGN");

  const wrongLine = await call("POST", `/coin-page/posts/${id}/delete`, { chainId: CHAIN, token: TOKEN, auth: await signed(owner, "coin_post_delete") });
  assert.equal(wrongLine.statusCode, 401, "delete signature must name the post");
  const del = await call("POST", `/coin-page/posts/${id}/delete`, { chainId: CHAIN, token: TOKEN, auth: await signed(owner, "coin_post_delete", [`PostId: ${id}`]) });
  assert.equal(del.statusCode, 200);
  assert.equal(db.profile.pinned_post_id, null);
});

test("bad identity and unknown routes", async () => {
  installFakeDb();
  assert.equal((await call("GET", "/coin-page?chainId=97&token=nope")).statusCode, 400);
  assert.equal((await call("GET", "/coin-page/whatever")).statusCode, 404);
});
