import test from "node:test";
import assert from "node:assert/strict";
import { createPageCardRenderer, pageCardSpec, pageCardSvg, pageCardUrl, wrap } from "./pageCard.mjs";
import { HELP_ARTICLES, HELP_TOPICS } from "../../shared/helpContent.mjs";

test("every content page has a card spec; unknown paths do not", () => {
  for (const p of ["/about", "/memewarzone-vs-pumpfun", "/faq", ...HELP_TOPICS.map((t) => `/faq/${t.id}`), ...HELP_ARTICLES.map((a) => `/faq/${a.slug}`)]) {
    const s = pageCardSpec(p);
    assert.ok(s && s.title && s.eyebrow && s.footer, p);
    assert.doesNotMatch(`${s.title} ${s.subtitle} ${s.eyebrow}`, /[–—]|gen-?8/i, p);
  }
  for (const p of ["/", "/coins", "/faq/nope-not-here", "/about/x", "javascript:alert(1)"]) assert.equal(pageCardSpec(p), null, p);
});

test("URL carries a content version and the API origin", () => {
  assert.match(pageCardUrl("/faq/battle-boosts"), /^https:\/\/api\.memewar\.zone\/api\/og\/page\.jpg\?path=%2Ffaq%2Fbattle-boosts&v=[0-9a-f]{10}$/);
  assert.equal(pageCardUrl("/coins"), null);
});

test("wrap keeps lines short and marks cut text", () => {
  const lines = wrap("one two three four five six seven eight nine ten", 10, 2);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.length <= 13));
  assert.match(lines[1], /\.\.\.$/);
  assert.deepEqual(wrap("short", 10, 2), ["short"]);
});

test("SVG escapes text", () => {
  const svg = pageCardSvg({ eyebrow: "X", title: "<b>&\"", subtitle: "a<b", chips: ["<c>"], footer: "f" });
  assert.doesNotMatch(svg, /<b>|a<b|<c>/);
  assert.match(svg, /&lt;b&gt;&amp;&quot;/i);
});

test("renders a JPEG card and 404s unknown paths", async () => {
  const handler = createPageCardRenderer();
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
  await handler({ query: { path: "/faq/battle-boosts" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "image/jpeg");
  assert.equal(res.body[0], 0xff);
  assert.equal(res.body[1], 0xd8);
  assert.ok(res.body.length < 300_000, `${res.body.length} bytes`);
  const miss = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
  await handler({ query: { path: "/coins" } }, miss);
  assert.equal(miss.statusCode, 404);
});
