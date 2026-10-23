import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createSeoRenderer } from "./seoRender.js";

const SHELL = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const EVM = "0x" + "AbCdEf0123".repeat(4);
const SOL = "So11111111111111111111111111111111111111112";

function fakeRes() {
  return {
    statusCode: 0, headers: {}, body: "",
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    send(b) { this.body = String(b ?? ""); return this; },
    end(b) { this.body = String(b ?? ""); return this; },
  };
}
function setup({ shell = SHELL, data = {}, cap } = {}) {
  const calls = [];
  const cur = { html: shell };
  const entity = (name) => async (...a) => { calls.push([name, ...a]); const d = data[name]; return typeof d === "function" ? d(...a) : d; };
  const entities = {};
  for (const n of ["coin", "battle", "tournament", "prepare", "post", "recruiter", "profile"]) entities[n] = entity(n);
  const r = createSeoRenderer({ shell: { get: async () => cur.html }, entities, now: () => 1000, cacheCap: cap });
  const run = async (url) => {
    const res = fakeRes();
    
    const [path, qs] = url.split("?");
    await r({ path, url, originalUrl: url, query: Object.fromEntries(new URLSearchParams(qs || "")), headers: {} }, res);
    if (res.statusCode === 404) assert.match(url, /^\/__render\/(token|warzone\/battles|post)\//, "only entity misses may be 404");
    return res;
  };
  return { run, calls, cur };
}
const found = (o = {}) => ({
  found: true, title: "Doge", description: "A coin", canonical: "https://app.memewar.zone/token/x",
  jsonLd: [{ "@type": "Thing", name: "Doge" }], summary: { heading: "Doge", lines: ["line one"], links: [{ href: "/coins", text: "All" }] }, ...o,
});

test("fixed route 200 with title and canonical", async () => {
  const { run } = setup();
  const res = await run("/__render/coins");
  assert.equal(res.statusCode, 200);
  // 64 characters with the brand, so the brand drops (shared/seoTitle.mjs).
  assert.match(res.body, /<title>Memecoins on BNB Chain, Solana and Robinhood Chain<\/title>/);
  assert.match(res.body, /rel="canonical" href="https:\/\/app\.memewar\.zone\/coins"/);
  assert.equal(res.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(res.headers["cache-control"], "no-cache");
  assert.equal(res.headers["x-robots-tag"], undefined);
});

test("root path", async () => {
  const { run } = setup();
  const res = await run("/__render");
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /rel="canonical" href="https:\/\/app\.memewar\.zone\/"/);
});

test("entity 200 injects title, canonical, json-ld, summary", async () => {
  const { run } = setup({ data: { coin: found() } });
  const res = await run(`/__render/token/${EVM}`);
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<title>Doge · MemeWarzone<\/title>/);
  assert.match(res.body, /rel="canonical" href="https:\/\/app\.memewar\.zone\/token\/x"/);
  assert.match(res.body, /application\/ld\+json/);
  assert.match(res.body, /<div id="root"><div data-ssr-summary="" style="[^"]+"><h1>Doge<\/h1><p>line one<\/p>/);
  assert.match(res.body, /<a href="\/coins">All<\/a>/);
});

test("robinhood token keeps chainId canonical and passes chainId", async () => {
  const c = "https://app.memewar.zone/token/" + EVM.toLowerCase() + "?chainId=4663";
  const { run, calls } = setup({ data: { coin: found({ canonical: c }) } });
  const res = await run(`/__render/token/${EVM}?chainId=4663`);
  assert.match(res.body, /chainId=4663/);
  assert.deepEqual(calls[0], ["coin", EVM, 4663]);
});

test("bad chainId ignored", async () => {
  const { run, calls } = setup({ data: { coin: found() } });
  await run(`/__render/token/${EVM}?chainId=1`);
  assert.equal(calls[0][2], undefined);
});

test("private prepare is noindex without canonical", async () => {
  const { run } = setup({ data: { prepare: found({ private: true, canonical: "https://app.memewar.zone/prepare/abc" }) } });
  const res = await run("/__render/prepare/abc");
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /name="robots" content="noindex,follow"/);
  assert.doesNotMatch(res.body, /rel="canonical"/);
  assert.equal(res.headers["x-robots-tag"], "noindex,follow");
});

test("entity miss is 404 noindex with shell", async () => {
  const { run } = setup({ data: { battle: { found: false } } });
  const res = await run("/__render/warzone/battles/abc");
  assert.equal(res.statusCode, 404);
  assert.match(res.body, /<title>Page not found · MemeWarzone<\/title>/);
  assert.match(res.body, /noindex/);
  assert.doesNotMatch(res.body, /rel="canonical"/);
  assert.match(res.body, /id="root"/);
});

test("loader error is 500 and not cached", async () => {
  let n = 0;
  const { run, calls } = setup({ data: { post: async () => (++n === 1 ? { found: false, error: true } : found()) } });
  assert.equal((await run("/__render/post/12")).statusCode, 500);
  assert.equal((await run("/__render/post/12")).statusCode, 200);
  assert.equal(calls.length, 2);
});

test("shell null is 503", async () => {
  const { run } = setup({ shell: null, data: { post: found() } });
  assert.equal((await run("/__render/post/12")).statusCode, 503);
  assert.equal((await run("/__render/coins")).statusCode, 503);
});

test("invalid ids are 410 with no loader call", async () => {
  const { run, calls } = setup({ data: { coin: found(), battle: found(), post: found(), prepare: found(), recruiter: found(), tournament: found(), profile: found() } });
  for (const u of ["/token/0x12", "/token/not$valid", "/warzone/battles/a%20b", "/post/0", "/post/abc", "/prepare/-x", "/recruiters/UP!", "/warzone/tournaments/a.b"]) {
    const res = await run("/__render" + u);
    assert.equal(res.statusCode, 410, u);
    assert.match(res.body, /Page not found/);
  }
  assert.equal(calls.length, 0);
});

test("cache holds data not HTML; uses current shell", async () => {
  const { run, calls, cur } = setup({ data: { coin: found() } });
  await run(`/__render/token/${SOL}`);
  cur.html = SHELL.replace("</head>", "<!-- NEWSHELL --></head>");
  const res = await run(`/__render/token/${SOL}`);
  assert.equal(calls.length, 1);
  assert.match(res.body, /NEWSHELL/);
});

test("EVM ids share a cache entry regardless of case", async () => {
  const { run, calls } = setup({ data: { coin: found() } });
  await run(`/__render/token/${EVM}`);
  await run(`/__render/token/${EVM.toLowerCase()}`);
  assert.equal(calls.length, 1);
});

test("LRU respects cap", async () => {
  const { run, calls } = setup({ data: { post: found() }, cap: 3 });
  for (let i = 1; i <= 10; i++) await run(`/__render/post/${i}`);
  await run("/__render/post/1");
  assert.equal(calls.length, 11);
  await run("/__render/post/10");
  assert.equal(calls.length, 11);
});

test("unknown path 410", async () => {
  const { run } = setup();
  const res = await run("/__render/nope/nothing");
  assert.equal(res.statusCode, 410);
  assert.match(res.body, /noindex/);
});

test("noindex fixed route", async () => {
  const { run } = setup();
  const res = await run("/__render/command");
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /name="robots" content="noindex,follow"/);
  assert.doesNotMatch(res.body, /rel="canonical"/);
});

test("XSS in loader title escaped", async () => {
  const { run } = setup({ data: { coin: found({ title: "</script><script>alert(1)</script>", jsonLd: [{ name: "</script><script>alert(2)</script>" }] }) } });
  const res = await run(`/__render/token/${SOL}`);
  assert.doesNotMatch(res.body, /<script>alert/);
  assert.match(res.body, /&lt;\/script&gt;/);
});

test("unexpected error is 500", async () => {
  const { run } = setup({ data: { coin: () => { throw new Error("boom"); } } });
  assert.equal((await run(`/__render/token/${SOL}`)).statusCode, 500);
});

test("miss cached 5s only; alias path is 410", async () => {
  let t = 1000;
  const calls = [];
  const r = createSeoRenderer({ shell: { get: async () => SHELL }, entities: { post: async (id) => { calls.push(id); return { found: false }; } }, now: () => t });
  const go = async (u) => { const res = fakeRes(); await r({ originalUrl: u, url: u, headers: {} }, res); return res; };
  await go("/__render/post/5"); await go("/__render/post/5");
  assert.equal(calls.length, 1);
  t += 5001;
  await go("/__render/post/5");
  assert.equal(calls.length, 2);
  assert.equal((await go("/__render/leagues")).statusCode, 410);
});

// ---------- DB protection ----------
function gated(opts = {}) {
  const gates = [];
  let inflightNow = 0;
  let maxInflight = 0;
  let loaderCalls = 0;
  let shellCalls = 0;
  const clock = { t: 1000 };
  const mk = (n) => async (id) => {
    loaderCalls += 1; inflightNow += 1; maxInflight = Math.max(maxInflight, inflightNow);
    try {
      const v = await new Promise((resolve) => gates.push({ resolve }));
      if (v === "throw") throw new Error("db down");
      return v;
    } finally { inflightNow -= 1; }
  };
  const entities = {};
  for (const n of ["coin", "battle", "tournament", "prepare", "post", "recruiter", "profile"]) entities[n] = mk(n);
  const r = createSeoRenderer({ shell: { get: async () => { shellCalls += 1; return SHELL; } }, entities, now: () => clock.t, ...opts });
  const start = (url) => { const res = fakeRes(); const p = r({ path: url, url, originalUrl: url, query: {}, headers: {} }, res).then(() => res); return p; };
  const flush = () => new Promise((r2) => setImmediate(r2));
  return { start, flush, gates, clock, stats: () => ({ maxInflight, loaderCalls, shellCalls, inflightNow }) };
}
const battleUrl = (i) => `/__render/warzone/battles/b${i}`;

test("cap: N+1 concurrent distinct ids -> at most N loader calls in flight, the rest 503 without a shell fetch", async () => {
  const g = gated({ maxConcurrent: 3 });
  const ps = [0, 1, 2, 3, 4].map((i) => g.start(battleUrl(i)));
  await g.flush();
  assert.equal(g.stats().maxInflight, 3);
  const rejected = await Promise.all(ps.slice(3));
  assert.deepEqual(rejected.map((r) => r.statusCode), [503, 503]);
  assert.equal(g.stats().shellCalls, 0);
  g.gates.forEach((x) => x.resolve(found()));
  const ok = await Promise.all(ps.slice(0, 3));
  assert.deepEqual(ok.map((r) => r.statusCode), [200, 200, 200]);
  assert.equal(g.stats().loaderCalls, 3);
});

test("cap: default is 3", async () => {
  const g = gated();
  const ps = [0, 1, 2, 3].map((i) => g.start(battleUrl(i)));
  await g.flush();
  assert.equal(g.stats().loaderCalls, 3);
  assert.equal((await ps[3]).statusCode, 503);
  g.gates.forEach((x) => x.resolve(found()));
  await Promise.all(ps.slice(0, 3));
});

test("coalescing: same key concurrently -> one loader call, one slot", async () => {
  const g = gated({ maxConcurrent: 1 });
  const ps = [0, 1, 2].map(() => g.start(battleUrl(1)));
  await g.flush();
  assert.equal(g.stats().loaderCalls, 1);
  g.gates[0].resolve(found());
  const rs = await Promise.all(ps);
  assert.deepEqual(rs.map((r) => r.statusCode), [200, 200, 200]);
  assert.equal(g.stats().loaderCalls, 1);
});

test("slot is released after a thrown loader", async () => {
  const g = gated({ maxConcurrent: 1 });
  const p1 = g.start(battleUrl(1));
  await g.flush();
  g.gates[0].resolve("throw");
  assert.equal((await p1).statusCode, 500);
  const p2 = g.start(battleUrl(2));
  await g.flush();
  assert.equal(g.stats().loaderCalls, 2);
  g.gates[1].resolve(found());
  assert.equal((await p2).statusCode, 200);
});

test("breaker: 5 errors in 10 s open it (503, no loader calls); it closes after 10 s", async () => {
  const g = gated({ maxConcurrent: 3 });
  for (let i = 0; i < 5; i++) {
    const p = g.start(battleUrl(i));
    await g.flush();
    g.gates[i].resolve(i % 2 ? "throw" : { error: true });
    assert.equal((await p).statusCode, 500);
  }
  assert.equal(g.stats().loaderCalls, 5);
  const blocked = await g.start(battleUrl(99));
  assert.equal(blocked.statusCode, 503);
  assert.equal(g.stats().loaderCalls, 5);
  assert.equal(g.stats().shellCalls, 0);
  g.clock.t += 10_001;
  const p = g.start(battleUrl(100));
  await g.flush();
  assert.equal(g.stats().loaderCalls, 6);
  g.gates[5].resolve(found());
  assert.equal((await p).statusCode, 200);
});

test("breaker: errors spread over more than the window do not open it", async () => {
  const g = gated();
  for (let i = 0; i < 6; i++) {
    const p = g.start(battleUrl(i));
    await g.flush();
    g.gates[i].resolve({ error: true });
    assert.equal((await p).statusCode, 500);
    g.clock.t += 3000;
  }
  assert.equal(g.stats().loaderCalls, 6);
});

test("malformed id: 410 without any loader call", async () => {
  const g = gated();
  const r = await g.start("/__render/token/not-an-id");
  assert.equal(r.statusCode, 410);
  assert.equal(g.stats().loaderCalls, 0);
  assert.equal(g.stats().shellCalls, 1);
});

test("a synchronously throwing loader is not stuck in the coalescing map", async () => {
  let calls = 0;
  let mode = "throw";
  const entities = {};
  for (const n of ["coin", "battle", "tournament", "prepare", "post", "recruiter", "profile"]) {
    entities[n] = (id) => { calls += 1; if (mode === "throw") throw new Error("sync boom"); return Promise.resolve(found()); };
  }
  const r = createSeoRenderer({ shell: { get: async () => SHELL }, entities, now: () => 1000 });
  const run = async () => { const res = fakeRes(); const u = battleUrl(1); await r({ path: u, url: u, originalUrl: u, query: {}, headers: {} }, res); return res; };
  assert.equal((await run()).statusCode, 500);
  mode = "ok";
  assert.equal((await run()).statusCode, 200);
  assert.equal(calls, 2);
});

test("/about serves the full About copy and its JSON-LD to crawlers", async () => {
  const { ABOUT_SECTIONS, ABOUT_INTRO } = await import("../shared/aboutContent.mjs");
  const { run, calls } = setup();
  const res = await run("/__render/about");
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["x-robots-tag"], undefined);
  assert.match(res.body, /<title>About MemeWarzone · MemeWarzone<\/title>/);
  assert.match(res.body, /rel="canonical" href="https:\/\/app\.memewar\.zone\/about"/);
  assert.match(res.body, /"@type":"AboutPage"/);
  assert.match(res.body, /<h1>About MemeWarzone<\/h1>/);
  for (const s of ABOUT_SECTIONS) assert.ok(res.body.includes(`<h2>${s.heading.replace(/'/g, "&#39;")}</h2>`), s.heading);
  assert.ok(res.body.includes("Call of Duty: Warzone"));
  assert.ok(res.body.includes('<a href="https://t.me/memewarzonehq">Telegram</a>'));
  assert.equal(ABOUT_INTRO.length, 2);
  assert.ok(res.body.includes("Vote battle (1 hour, 6 hours, 12 hours, 24 hours, 48 hours)"));
  assert.ok(res.body.includes("Perfect Run: Coins that graduated"));
  assert.equal(calls.length, 0);
});

test("About copy follows the copy rules", async () => {
  const { ABOUT_SECTIONS, aboutAllText } = await import("../shared/aboutContent.mjs");
  for (const t of aboutAllText()) assert.doesNotMatch(t, /[–—]/, t);
  for (const s of ABOUT_SECTIONS) for (const l of s.links || []) assert.match(l.href, /^(\/[a-z]|https:\/\/)/, l.href);
  const fs = await import("node:fs");
  for (const s of ABOUT_SECTIONS) for (const img of [s.image, ...(s.categories || []).map((c) => c.image)].filter(Boolean)) {
    assert.ok(fs.existsSync(new URL(`../public${img}`, import.meta.url)), img);
  }
});

test("comparison page serves its table, FAQ and sources to crawlers", async () => {
  const { COMPARE_PAGES, compareAllText } = await import("../shared/comparePages.mjs");
  const page = COMPARE_PAGES[0];
  const { run, calls } = setup();
  const res = await run(`/__render${page.path}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["x-robots-tag"], undefined);
  assert.match(res.body, /<title>MemeWarzone vs Pump\.fun · MemeWarzone<\/title>/);
  assert.match(res.body, /rel="canonical" href="https:\/\/app\.memewar\.zone\/memewarzone-vs-pumpfun"/);
  assert.match(res.body, /"@type":"FAQPage"/);
  assert.match(res.body, /<table>/);
  assert.ok(res.body.includes("1.25% on every buy and sell."));
  assert.ok(res.body.includes('href="https://pump.fun/docs/fees"'));
  assert.equal(calls.length, 0);
  for (const t of compareAllText(page)) assert.doesNotMatch(t, /[–—]/, t);
  for (const s of page.sections) for (const l of s.links || []) assert.match(l.href, /^(\/[a-z]|https:\/\/)/, l.href);
});

test("About contract addresses are checksummed and link to the right explorer", async () => {
  const { ethers } = await import("ethers");
  const { ABOUT_SECTIONS } = await import("../shared/aboutContent.mjs");
  const c = ABOUT_SECTIONS.find((s) => s.id === "contracts").contracts;
  for (const group of c) for (const e of group.entries) {
    assert.ok(e.href.endsWith(e.address), e.label);
    if (e.address.startsWith("0x")) assert.equal(ethers.getAddress(e.address.toLowerCase()), e.address, e.address);
    else assert.match(e.address, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    const host = new URL(e.href).host;
    assert.equal(host, group.chain === "BNB Chain" ? "bscscan.com" : group.chain === "Solana" ? "solscan.io" : "robinhoodchain.blockscout.com");
  }
});

test("Help Center: index, topic and article render for crawlers; unknown slug is 410", async () => {
  const { HELP_ARTICLES, HELP_TOPICS } = await import("../shared/helpContent.mjs");
  const { run, calls } = setup();
  const idx = await run("/__render/faq");
  assert.equal(idx.statusCode, 200);
  assert.match(idx.body, /<title>Help Center · MemeWarzone<\/title>/);
  assert.match(idx.body, /rel="canonical" href="https:\/\/app\.memewar\.zone\/faq"/);
  for (const t of HELP_TOPICS) assert.ok(idx.body.includes(`href="/faq/${t.id}"`), t.id);
  const topic = await run(`/__render/faq/${HELP_TOPICS[0].id}`);
  assert.equal(topic.statusCode, 200);
  assert.ok(topic.body.includes(`<h1>${HELP_TOPICS[0].label}</h1>`));
  if (HELP_ARTICLES.length) {
    const a = HELP_ARTICLES[0];
    const art = await run(`/__render/faq/${a.slug}`);
    assert.equal(art.statusCode, 200);
    assert.match(art.body, /"@type":"FAQPage"/);
    assert.match(art.body, new RegExp(`rel="canonical" href="https://app\\.memewar\\.zone/faq/${a.slug}"`));
    assert.equal(art.headers["x-robots-tag"], undefined);
  }
  const miss = await run("/__render/faq/this-answer-does-not-exist");
  assert.equal(miss.statusCode, 410);
  assert.equal(calls.length, 0);
});

test("content pages link their own share card; other fixed pages keep the default image", async () => {
  const { run } = setup();
  for (const p of ["/about", "/memewarzone-vs-pumpfun", "/faq", "/faq/battles", "/faq/battle-boosts"]) {
    const res = await run(`/__render${p}`);
    assert.equal(res.statusCode, 200, p);
    const m = res.body.match(/<meta property="og:image" content="([^"]+)"/);
    assert.ok(m, p);
    assert.match(m[1].replace(/&amp;/g, "&"), new RegExp(`^https://api\\.memewar\\.zone/api/og/page\\.jpg\\?path=${encodeURIComponent(p).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}&v=[0-9a-f]{10}$`), p);
    assert.match(res.body, /<meta name="twitter:image" content="https:\/\/api\.memewar\.zone\/api\/og\/page\.jpg/);
  }
  const coins = await run("/__render/coins");
  assert.doesNotMatch(coins.body, /api\/og\/page\.jpg/);
});

test("titles fit in 60 characters; long coin names use a shorter wording with the brand", async () => {
  const { run } = setup({ data: { coin: found({ title: "Derpy Dave ($DERPYDAVE) price, chart and battles", titles: ["Derpy Dave ($DERPYDAVE) price, chart and battles", "Derpy Dave ($DERPYDAVE) price and chart", "Derpy Dave ($DERPYDAVE)"] }) } });
  const res = await run(`/__render/token/${EVM}`);
  assert.match(res.body, /<title>Derpy Dave \(\$DERPYDAVE\) price and chart · MemeWarzone<\/title>/);
  assert.match(res.body, /<meta property="og:title" content="Derpy Dave \(\$DERPYDAVE\) price and chart · MemeWarzone"/);
  for (const p of ["/about", "/faq", "/coins", "/memewarzone-vs-pumpfun", "/faq/battle-boosts"]) {
    const r = await run(`/__render${p}`);
    const t = r.body.match(/<title>([^<]*)<\/title>/)[1].replace(/&amp;/g, "&").replace(/&#39;/g, "'");
    assert.ok(t.length <= 60, `${p}: ${t} (${t.length})`);
  }
});
