import test from "node:test";
import assert from "node:assert/strict";
import { createSeoEntities } from "./seoEntities.js";

const O = "https://app.memewar.zone";
const API = "https://api.memewar.zone";
const EVM = "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD";
const evm = EVM.toLowerCase();
const SOL = "So1anaMint1111111111111111111111111111111111";

function fakeDb(rowsFor = () => []) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: (await rowsFor(sql, params)) || [] };
    },
  };
}
const make = (db, extra = {}) => createSeoEntities({ db, appOrigin: O, apiOrigin: API, ...extra });
const allStrings = (v, out = []) => {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => allStrings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => allStrings(x, out));
  return out;
};
const noEmDash = (r) => assert.ok(allStrings(r).every((s) => !/[—–]/.test(s)), "no em or en dashes");
const throwingDb = { async query() { throw new Error("boom"); } };

// ---------- coins ----------
const coinRow = (over = {}) => ({
  chain_id: 56, campaign_address: "0xcamp", token_address: evm, name: "Doge — Killer", symbol: "DOGEK",
  logo_uri: "https://cdn.example/logo.png", creator_address: "0xcreator", description: "The coin that fights dogs in the warzone.", created_at: "2026-09-01T00:00:00Z", ...over,
});

test("coin: found, canonical via canonicalForToken, sql filters, jsonld", async () => {
  const db = fakeDb((sql) => (sql.includes("public.campaigns") ? [coinRow()] : []));
  const r = await make(db).coin(EVM);
  assert.equal(r.found, true);
  assert.equal(r.canonical, `${O}/token/${evm}`);
  assert.equal(r.robots, "index,follow");
  assert.equal(r.image, `${API}/api/story/card/56/${evm}.png`);
  assert.match(r.title, /DOGEK/);
  assert.match(r.description, /BNB Chain/);
  assert.ok(r.description.length >= 100 && r.description.length <= 160, String(r.description.length));
  const types = r.jsonLd.map((j) => j["@type"]);
  assert.deepEqual(types, ["WebPage", "BreadcrumbList"]);
  for (const j of r.jsonLd) { assert.equal(j["@context"], "https://schema.org"); }
  assert.equal(r.jsonLd[0].url, r.canonical);
  assert.equal(r.summary.heading.length > 0, true);
  const sql = db.calls[0].sql;
  assert.match(sql, /publicHidden/);
  assert.match(sql, /in \(56, 101, 4663\)/);
  assert.match(sql, /scheduled_launch_at > now\(\)/);
  assert.deepEqual(db.calls[0].params.slice(0, 2), [evm, 56]);
  noEmDash(r);
});

test("coin: Robinhood canonical keeps chainId", async () => {
  const db = fakeDb((sql) => (sql.includes("public.campaigns") ? [coinRow({ chain_id: 4663 })] : []));
  const r = await make(db).coin(EVM, 4663);
  assert.equal(r.canonical, `${O}/token/${evm}?chainId=4663`);
  assert.match(r.description, /Robinhood Chain/);
  assert.equal(r.image, `${API}/api/story/card/4663/${evm}.png`);
});

test("coin: solana mint keeps case, chain defaults to 101", async () => {
  const db = fakeDb((sql) => (sql.includes("public.campaigns") ? [coinRow({ chain_id: 101, token_address: SOL })] : []));
  const r = await make(db).coin(SOL);
  assert.equal(db.calls[0].params[0], SOL);
  assert.equal(db.calls[0].params[1], 101);
  assert.equal(r.canonical, `${O}/token/${SOL}`);
  assert.match(r.description, /Solana/);
});

test("coin: campaign-address lookup canonicalises to the token address", async () => {
  const db = fakeDb((sql) => (sql.includes("public.campaigns") ? [coinRow()] : []));
  const r = await make(db).coin("0xCAMP");
  assert.equal(r.canonical, `${O}/token/${evm}`);
});

test("coin: import (passed) is found", async () => {
  const db = fakeDb((sql) => (sql.includes("arena_token_imports")
    ? [{ chain_id: 101, token_address: SOL, name: "Imported", symbol: "IMP", image_url: "https://x/y.png" }] : []));
  const r = await make(db).coin(SOL);
  assert.equal(r.found, true);
  assert.match(r.title, /IMP/);
  assert.match(db.calls.map((c) => c.sql).join("\n"), /i\.status = 'passed'/);
});

test("coin: hidden or unknown coin is not found", async () => {
  const r = await make(fakeDb(() => [])).coin(EVM);
  assert.deepEqual(r, { found: false });
});

test("coin: throwing db returns error", async () => {
  assert.deepEqual(await make(throwingDb).coin(EVM), { found: false, error: true });
});

// ---------- battles ----------
const battlePayload = (over = {}) => ({
  battle: {
    id: "arena-abc", chainId: 56, state: "finished", battleMode: "vote", winnerToken: evm,
    startedAt: "2026-10-01T10:00:00Z", endsAt: "2026-10-02T10:00:00Z",
    participants: [
      { tokenAddress: evm, symbol: "AAA", tokenName: "Alpha" },
      { tokenAddress: "0x2", symbol: "BBB", tokenName: "Beta" },
    ],
    ...over,
  },
  metrics: null, votes: null,
});

test("battle: found with Event jsonld, image and canonical", async () => {
  const r = await make(fakeDb(), { loadBattle: async (id) => { assert.equal(id, "arena-abc"); return battlePayload(); } }).battle("arena-abc");
  assert.equal(r.found, true);
  assert.equal(r.canonical, `${O}/warzone/battles/arena-abc`);
  assert.equal(r.image, `${O}/api/battle-share-card?battleId=arena-abc&v=1`);
  assert.match(r.title, /AAA vs BBB/);
  assert.match(r.description, /BNB Chain/);
  const ev = r.jsonLd.find((j) => j["@type"] === "Event");
  assert.equal(ev["@context"], "https://schema.org");
  assert.equal(ev.url, r.canonical);
  assert.equal(ev.startDate, "2026-10-01T10:00:00.000Z");
  assert.equal(ev.endDate, "2026-10-02T10:00:00.000Z");
  assert.equal(r.robots, "index,follow");
  noEmDash(r);
});

test("battle: unknown, transient state, error", async () => {
  assert.deepEqual(await make(fakeDb(), { loadBattle: async () => null }).battle("x"), { found: false });
  const w = await make(fakeDb(), { loadBattle: async () => battlePayload({ state: "waiting", startedAt: null, endsAt: null }) }).battle("x");
  assert.equal(w.found, true);
  assert.equal(w.robots, "noindex,follow");
  assert.equal(w.jsonLd.find((j) => j["@type"] === "Event").startDate, undefined);
  assert.deepEqual(await make(fakeDb(), { loadBattle: async () => { throw new Error("x"); } }).battle("x"), { found: false, error: true });
});

// ---------- tournaments ----------
test("tournament: found, Event dates, status filter in sql", async () => {
  const db = fakeDb(() => [{ id: "t1", name: "Summer Cup", status: "upcoming", chain_id: 101, starts_at: "2026-11-01T00:00:00Z", ends_at: "2026-11-03T00:00:00Z", terms: "Sixteen coins, single elimination.", cap: 16, buy_in_native: 0.5, native_symbol: "SOL" }]);
  const r = await make(db).tournament("t1");
  assert.equal(r.found, true);
  assert.equal(r.canonical, `${O}/warzone/tournaments/t1`);
  assert.match(db.calls[0].sql, /status <> 'cancelled'/);
  assert.deepEqual(db.calls[0].params, ["t1"]);
  const ev = r.jsonLd[0];
  assert.equal(ev["@type"], "Event");
  assert.equal(ev.startDate, "2026-11-01T00:00:00.000Z");
  assert.equal(ev.url, r.canonical);
  assert.match(r.description, /Solana/);
  noEmDash(r);
});
test("tournament: not found and error", async () => {
  assert.deepEqual(await make(fakeDb()).tournament("t1"), { found: false });
  assert.deepEqual(await make(throwingDb).tournament("t1"), { found: false, error: true });
});

// ---------- prepare ----------
const draft = (over = {}) => ({ id: 7, chain_id: 56, slug: "my-coin", name: "My Coin", ticker: "mine", description: "A coin being prepared for launch.", logo_url: "https://x/l.png", status: "draft", visibility: "public", campaign_address: null, token_address: null, scheduled_launch_at: null, ...over });

test("prepare: public draft", async () => {
  const db = fakeDb((sql) => (sql.includes("campaign_drafts") ? [draft()] : []));
  const r = await make(db).prepare("My-Coin");
  assert.equal(r.found, true);
  assert.equal(r.private, undefined);
  assert.equal(r.canonical, `${O}/prepare/my-coin`);
  assert.equal(r.image, `${O}/api/prepare-share-card?slug=my-coin&v=4`);
  assert.equal(r.robots, "index,follow");
  assert.match(db.calls[0].sql, /lower\(slug\) = lower\(\$1\)/);
  noEmDash(r);
});
test("prepare: private draft leaks nothing", async () => {
  const db = fakeDb((sql) => (sql.includes("campaign_drafts") ? [draft({ visibility: "private", name: "SecretName" })] : []));
  const r = await make(db).prepare("my-coin");
  assert.equal(r.found, true);
  assert.equal(r.private, true);
  assert.equal(r.robots, "noindex,follow");
  assert.ok(!JSON.stringify(r).includes("SecretName"));
  assert.deepEqual(r.jsonLd, []);
});
test("prepare: launched draft canonicalises to the coin, or noindex", async () => {
  const launched = draft({ status: "deployed", token_address: EVM, campaign_address: "0xc", chain_id: 4663 });
  const r = await make(fakeDb((sql) => (sql.includes("campaign_drafts") ? [launched] : []))).prepare("my-coin");
  assert.equal(r.canonical, `${O}/token/${evm}?chainId=4663`);
  const r2 = await make(fakeDb((sql) => (sql.includes("campaign_drafts") ? [draft({ status: "deployed" })] : []))).prepare("my-coin");
  assert.equal(r2.found, true);
  assert.equal(r2.robots, "noindex,follow");
});
test("prepare: testnet draft noindex; missing; error", async () => {
  const r = await make(fakeDb((sql) => (sql.includes("campaign_drafts") ? [draft({ chain_id: 97 })] : []))).prepare("my-coin");
  assert.equal(r.robots, "noindex,follow");
  assert.deepEqual(await make(fakeDb()).prepare("nope"), { found: false });
  assert.deepEqual(await make(throwingDb).prepare("nope"), { found: false, error: true });
});

// ---------- posts ----------
const postRow = (over = {}) => ({ id: 12, author_address: "0xauthor", body: "gm\n\nthis coin is going to the moon — " + "x".repeat(300), created_at: "2026-10-05T08:00:00Z", parent_id: null, author_display_name: "Alice", ...over });
test("post: found, truncation, DiscussionForumPosting", async () => {
  const db = fakeDb((sql) => (sql.includes("social_posts") ? [postRow()] : sql.includes("user_handles") ? [{ handle: "alice" }] : []));
  const r = await make(db).post("12");
  assert.equal(r.found, true);
  assert.equal(r.canonical, `${O}/post/12`);
  assert.match(db.calls[0].sql, /p\.status = 0/);
  assert.ok(r.description.length <= 160);
  assert.match(r.title, /@alice/);
  const j = r.jsonLd[0];
  assert.equal(j["@type"], "DiscussionForumPosting");
  assert.equal(j["@context"], "https://schema.org");
  assert.equal(j.url, r.canonical);
  assert.equal(j.datePublished, "2026-10-05T08:00:00.000Z");
  assert.ok(j.text.length <= 500);
  assert.equal(r.robots, "index,follow");
  noEmDash(r);
});
test("post: reply is noindex; missing; error", async () => {
  const r = await make(fakeDb((sql) => (sql.includes("social_posts") ? [postRow({ parent_id: 3 })] : []))).post("12");
  assert.equal(r.robots, "noindex,follow");
  assert.deepEqual(await make(fakeDb()).post("12"), { found: false });
  assert.deepEqual(await make(throwingDb).post("12"), { found: false, error: true });
});

// ---------- recruiters ----------
const recRow = { id: 5, wallet_address: "0xr", code: "ALPHA", display_name: "Alpha Recruiter", is_og: true, status: "active", created_at: "2026-08-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" };
test("recruiter: visible on leaderboard is indexed", async () => {
  const db = fakeDb((sql) => (sql.includes("cluster_id") ? [{ id: 5 }] : sql.includes("public.recruiters") ? [recRow] : []));
  const r = await make(db).recruiter("alpha");
  assert.equal(r.found, true);
  assert.equal(r.canonical, `${O}/recruiters/ALPHA`);
  assert.equal(r.robots, "index,follow");
  noEmDash(r);
});
test("recruiter: hidden by cluster rule is noindex", async () => {
  const db = fakeDb((sql) => (sql.includes("cluster_id") ? [] : sql.includes("public.recruiters") ? [recRow] : []));
  const r = await make(db).recruiter("alpha");
  assert.equal(r.found, true);
  assert.equal(r.robots, "noindex,follow");
});
test("recruiter: inactive or missing is not found; error", async () => {
  const db = fakeDb((sql) => (sql.includes("public.recruiters") && !sql.includes("cluster_id") ? [{ ...recRow, status: "closed" }] : []));
  assert.deepEqual(await make(db).recruiter("alpha"), { found: false });
  assert.deepEqual(await make(fakeDb()).recruiter("alpha"), { found: false });
  assert.deepEqual(await make(throwingDb).recruiter("alpha"), { found: false, error: true });
});

// ---------- profiles ----------
const profDb = ({ handle = null, coins = [], name = null } = {}) => fakeDb((sql) => {
  if (sql.includes("user_handles")) return handle ? [{ handle }] : [];
  if (sql.includes("user_profiles")) return name ? [{ display_name: name }] : [];
  if (sql.includes("public.campaigns")) return coins;
  return [];
});
test("profile: handle makes it indexable; wallet lowercased", async () => {
  const db = profDb({ handle: "alice" });
  const r = await make(db).profile(EVM);
  assert.equal(r.found, true);
  assert.equal(r.robots, "index,follow");
  assert.equal(r.canonical, `${O}/profile/${evm}`);
  assert.match(r.title, /@alice/);
  assert.deepEqual(r.jsonLd.map((j) => j["@type"]), ["WebPage", "BreadcrumbList"]);
  assert.equal(r.jsonLd[0].url, r.canonical);
  assert.ok(db.calls.every((c) => c.params[0] === evm));
  noEmDash(r);
});
test("profile: launched public coin makes it indexable", async () => {
  const db = profDb({ coins: [{ chain_id: 56, token_address: evm, name: "Doge", symbol: "DG" }] });
  const r = await make(db).profile(EVM);
  assert.equal(r.robots, "index,follow");
  const sql = db.calls.find((c) => c.sql.includes("public.campaigns")).sql;
  assert.match(sql, /publicHidden/);
  assert.match(sql, /in \(56, 101, 4663\)/);
  assert.ok(r.summary.links.some((l) => l.href === `${O}/token/${evm}`));
});
test("profile: ineligible wallet is found but noindex", async () => {
  const r = await make(profDb()).profile(SOL);
  assert.equal(r.found, true);
  assert.equal(r.robots, "noindex,follow");
  assert.equal(r.canonical, `${O}/profile/${SOL}`);
});
test("profile: missing handles table tolerated; db error", async () => {
  const db = fakeDb((sql) => { if (sql.includes("user_handles")) { const e = new Error("no table"); e.code = "42P01"; throw e; } return []; });
  assert.equal((await make(db).profile(EVM)).robots, "noindex,follow");
  assert.deepEqual(await make(throwingDb).profile(EVM), { found: false, error: true });
});

test("all loaders are read-only sql", async () => {
  const db = fakeDb((sql) => (sql.includes("campaign_drafts") ? [draft()] : sql.includes("social_posts") ? [postRow()] : sql.includes("recruiters") ? [recRow] : sql.includes("campaigns") ? [coinRow()] : []));
  const e = make(db, { loadBattle: async () => battlePayload() });
  await Promise.all([e.coin(EVM), e.tournament("1"), e.prepare("a"), e.post("1"), e.recruiter("a"), e.profile(EVM)]);
  assert.ok(db.calls.length > 6);
  for (const c of db.calls) assert.doesNotMatch(c.sql, /\b(insert|update|delete|alter|drop|truncate)\s/i);
});
