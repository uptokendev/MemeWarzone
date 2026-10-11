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
  assert.match(res.body, /<title>Memecoins on BNB Chain, Solana and Robinhood Chain · MemeWarzone<\/title>/);
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
  assert.match(res.body, /<div id="root"><h1>Doge<\/h1><p>line one<\/p>/);
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
