import test from "node:test";
import assert from "node:assert/strict";
import { APP_ORIGIN } from "../../shared/seoRoutes.mjs";
import {
  urlsetXml,
  sitemapIndexXml,
  chunkEntries,
  chunkName,
  sitemapOrigin,
  absoluteLoc,
} from "./sitemapXml.mjs";

function withEnv(value, fn) {
  const prev = process.env.APP_PUBLIC_ORIGIN;
  if (value === undefined) delete process.env.APP_PUBLIC_ORIGIN;
  else process.env.APP_PUBLIC_ORIGIN = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.APP_PUBLIC_ORIGIN;
    else process.env.APP_PUBLIC_ORIGIN = prev;
  }
}

test("urlsetXml has declaration and namespace", () => {
  const xml = urlsetXml([{ loc: "https://a.test/x" }]);
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(xml.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'));
  assert.ok(xml.includes("<url><loc>https://a.test/x</loc></url>"));
  assert.ok(xml.trimEnd().endsWith("</urlset>"));
});

test("urlsetXml escapes & < > \" ' in loc", () => {
  const xml = urlsetXml([{ loc: `https://a.test/?a=1&b=<2>"x"'y'` }]);
  assert.ok(xml.includes("<loc>https://a.test/?a=1&amp;b=&lt;2&gt;&quot;x&quot;&apos;y&apos;</loc>"));
});

test("lastmod normalised to YYYY-MM-DD (UTC) from Date, ISO and date strings", () => {
  const xml = urlsetXml([
    { loc: "https://a.test/1", lastmod: new Date("2026-03-04T23:59:59Z") },
    { loc: "https://a.test/2", lastmod: "2026-03-05T01:02:03+02:00" },
    { loc: "https://a.test/3", lastmod: "2026-03-06" },
  ]);
  assert.ok(xml.includes("<loc>https://a.test/1</loc><lastmod>2026-03-04</lastmod>"));
  assert.ok(xml.includes("<loc>https://a.test/2</loc><lastmod>2026-03-04</lastmod>"));
  assert.ok(xml.includes("<loc>https://a.test/3</loc><lastmod>2026-03-06</lastmod>"));
});

test("lastmod omitted when missing or invalid", () => {
  const xml = urlsetXml([
    { loc: "https://a.test/1" },
    { loc: "https://a.test/2", lastmod: "garbage" },
    { loc: "https://a.test/3", lastmod: new Date("nope") },
    { loc: "https://a.test/4", lastmod: null },
  ]);
  assert.ok(!xml.includes("lastmod"));
  assert.equal(xml.match(/<url>/g).length, 4);
});

test("entries with empty or invalid loc are skipped", () => {
  const xml = urlsetXml([{ loc: "" }, { loc: "   " }, { loc: null }, {}, null, { loc: 5 }, { loc: "https://a.test/ok" }]);
  assert.equal(xml.match(/<url>/g).length, 1);
  assert.ok(xml.includes("https://a.test/ok"));
});

test("sitemapIndexXml lists every child with escaped URL", () => {
  const xml = sitemapIndexXml(["coins", "coins-2", "a&b"], "https://app.test");
  assert.ok(xml.includes('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'));
  assert.ok(xml.includes("<sitemap><loc>https://app.test/sitemaps/coins.xml</loc></sitemap>"));
  assert.ok(xml.includes("<sitemap><loc>https://app.test/sitemaps/coins-2.xml</loc></sitemap>"));
  assert.ok(xml.includes("<loc>https://app.test/sitemaps/a&amp;b.xml</loc>"));
  assert.equal(xml.match(/<sitemap>/g).length, 3);
});

test("chunkEntries splits at 50,000", () => {
  const entries = Array.from({ length: 120001 }, (_, i) => ({ loc: `https://a.test/${i}` }));
  const chunks = chunkEntries(entries);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((c) => c.length), [50000, 50000, 20001]);
  assert.equal(chunks[1][0].loc, "https://a.test/50000");
  assert.deepEqual(chunkEntries([]), []);
  assert.deepEqual(chunkEntries([{ loc: "x" }, { loc: "y" }, { loc: "z" }], 2).map((c) => c.length), [2, 1]);
});

test("chunkName", () => {
  assert.equal(chunkName("coins", 0), "coins");
  assert.equal(chunkName("coins", 1), "coins-2");
  assert.equal(chunkName("coins", 2), "coins-3");
});

test("sitemapOrigin / absoluteLoc honour APP_PUBLIC_ORIGIN", () => {
  withEnv(undefined, () => {
    assert.equal(sitemapOrigin(), APP_ORIGIN);
    assert.equal(absoluteLoc("/coin/1"), `${APP_ORIGIN}/coin/1`);
  });
  withEnv("  https://staging.test/  ", () => {
    assert.equal(sitemapOrigin(), "https://staging.test");
    assert.equal(absoluteLoc("/coin/1"), "https://staging.test/coin/1");
    assert.equal(absoluteLoc("coin/1"), "https://staging.test/coin/1");
  });
  withEnv("   ", () => assert.equal(sitemapOrigin(), APP_ORIGIN));
});
