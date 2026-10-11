import test from "node:test";
import assert from "node:assert/strict";
import {
  CHILD_NAMES,
  staticEntries,
  coinEntries,
  battleEntries,
  tournamentEntries,
  recruiterEntries,
  postEntries,
  profileEntries,
  prepareEntries,
  createSitemapHandlers,
} from "./sitemapSources.js";

const O = "https://app.memewar.zone";

function fakeDb(rowsFor = () => []) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      const rows = await rowsFor(sql, params, calls.length);
      return { rows };
    },
  };
}

function fakeRes() {
  const res = { statusCode: 0, headers: {}, body: "" };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.end = (b) => { res.body = String(b ?? ""); };
  return res;
}

test("child list has the eight names", () => {
  assert.deepEqual(CHILD_NAMES, ["static", "coins", "battles", "tournaments", "recruiters", "posts", "profiles", "prepare"]);
});

test("static: fixed index routes only", () => {
  const locs = staticEntries().map((e) => e.loc);
  assert.ok(locs.includes(`${O}/coins`));
  assert.ok(locs.includes(`${O}/warzone/battles`));
  assert.ok(locs.every((l) => !l.includes(":") || l.startsWith("https://")));
  assert.ok(locs.every((l) => !l.slice(8).includes(":") && !l.includes("**")));
});

test("coins: canonical urls, hidden filter and chain whitelist in SQL", async () => {
  const db = fakeDb((sql) => sql.includes("arena_token_imports") ? [{ chain_id: 101, token_address: "So1anaMint111", lastmod: null }] : [
    { chain_id: 56, campaign_address: "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD", lastmod: "2026-10-01T00:00:00Z" },
    { chain_id: 4663, campaign_address: "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD", lastmod: null },
  ]);
  const out = await coinEntries(db);
  const locs = out.map((e) => e.loc);
  assert.ok(locs.includes(`${O}/token/0xabcdefabcdefabcdefabcdefabcdefabcdefabcd`));
  assert.ok(locs.includes(`${O}/token/0xabcdefabcdefabcdefabcdefabcdefabcdefabcd?chainId=4663`));
  assert.ok(locs.includes(`${O}/token/So1anaMint111`));
  const sql = db.calls.map((c) => c.sql).join("\n");
  assert.match(sql, /publicHidden/);
  assert.match(sql, /\(56,\s*101,\s*4663\)/);
  assert.doesNotMatch(sql, /\b(insert|update|delete)\b/i);
});

test("battles / tournaments / recruiters / posts / prepare / profiles map rows", async () => {
  assert.deepEqual((await battleEntries(fakeDb(() => [{ id: "b-1", lastmod: "2026-10-02" }]))).map((e) => e.loc), [`${O}/warzone/battles/b-1`]);
  assert.deepEqual((await tournamentEntries(fakeDb(() => [{ id: 7 }]))).map((e) => e.loc), [`${O}/warzone/tournaments/7`]);
  assert.deepEqual((await recruiterEntries(fakeDb(() => [{ code: "og_one" }]))).map((e) => e.loc), [`${O}/recruiters/og_one`]);
  assert.deepEqual((await postEntries(fakeDb(() => [{ id: "12" }]))).map((e) => e.loc), [`${O}/post/12`]);
  assert.deepEqual((await prepareEntries(fakeDb(() => [{ slug: "my slug" }]))).map((e) => e.loc), [`${O}/prepare/my%20slug`]);
  const prof = await profileEntries(fakeDb(() => [{ wallet: "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD" }, { wallet: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" }, { wallet: "SoLWallet1" }]));
  assert.deepEqual(prof.map((e) => e.loc), [`${O}/profile/0xabcdefabcdefabcdefabcdefabcdefabcdefabcd`, `${O}/profile/SoLWallet1`]);
});

test("recruiter and post SQL filters", async () => {
  const r = fakeDb(); await recruiterEntries(r);
  assert.match(r.calls[0].sql, /status\s*=\s*'active'/);
  const p = fakeDb(); await postEntries(p);
  assert.match(p.calls[0].sql, /status\s*=\s*0/);
  const t = fakeDb(); await tournamentEntries(t);
  assert.match(t.calls[0].sql, /<>\s*'cancelled'/);
  const d = fakeDb(); await prepareEntries(d);
  assert.match(d.calls[0].sql, /visibility/);
});

test("handlers: throwing source gives 200 valid empty urlset", async () => {
  const db = fakeDb(() => { throw new Error("boom"); });
  const h = createSitemapHandlers({ db, log: () => {} });
  const res = fakeRes();
  await h.child({ params: { file: "coins.xml" } }, res);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /application\/xml; charset=utf-8/);
  assert.match(res.body, /<urlset[^>]*>\s*<\/urlset>/);
});

test("handlers: unknown child is 404 XML", async () => {
  const h = createSitemapHandlers({ db: fakeDb() });
  for (const file of ["nope.xml", "coins-9.xml", "../x.xml", "coins"]) {
    const res = fakeRes();
    await h.child({ params: { file } }, res);
    assert.equal(res.statusCode, 404, file);
    assert.match(res.headers["content-type"], /xml/);
    assert.match(res.body, /^<\?xml/);
  }
});

test("handlers: index lists all eight names, headers set", async () => {
  const h = createSitemapHandlers({ db: fakeDb() });
  const res = fakeRes();
  await h.index({}, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["cache-control"], "public, max-age=600");
  for (const n of CHILD_NAMES) assert.ok(res.body.includes(`${O}/sitemaps/${n}.xml`), n);
});

test("handlers: chunks beyond 50000 served as name-2", async () => {
  const rows = Array.from({ length: 50001 }, (_, i) => ({ id: i + 1 }));
  const h = createSitemapHandlers({ db: fakeDb(() => rows) });
  const res = fakeRes();
  await h.index({}, res);
  assert.ok(res.body.includes("/sitemaps/posts-2.xml"));
  const r2 = fakeRes();
  await h.child({ params: { file: "posts-2.xml" } }, r2);
  assert.equal(r2.statusCode, 200);
  assert.equal((r2.body.match(/<url>/g) || []).length, 1);
});

test("handlers: cache serves within TTL without a second query, refetches after", async () => {
  let t = 1_000_000;
  const db = fakeDb(() => [{ id: 5 }]);
  const h = createSitemapHandlers({ db, now: () => t });
  const a = fakeRes(); await h.child({ params: { file: "posts.xml" } }, a);
  const n = db.calls.length;
  t += 5 * 60_000;
  const b = fakeRes(); await h.child({ params: { file: "posts.xml" } }, b);
  assert.equal(db.calls.length, n);
  assert.equal(a.body, b.body);
  t += 6 * 60_000;
  const c = fakeRes(); await h.child({ params: { file: "posts.xml" } }, c);
  assert.ok(db.calls.length > n);
});

test("handlers: static needs no db", async () => {
  const db = fakeDb();
  const h = createSitemapHandlers({ db });
  const res = fakeRes();
  await h.child({ params: { file: "static.xml" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(db.calls.length, 0);
  assert.ok(res.body.includes(`${O}/coins`));
});
