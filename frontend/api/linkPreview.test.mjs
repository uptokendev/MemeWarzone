import test from "node:test";
import assert from "node:assert/strict";
import { assertPublicImageUrl } from "./lib/hudShareCardSvg.mjs";
import { createLinkPreview, decodeEntities, fetchPreviewHtml, normalizePreviewUrl, parsePreview } from "./linkPreview.js";

const quiet = { info() {} };
const html = (head) => `<!doctype html><html><head>${head}</head><body>x</body></html>`;
function resp(status, body = "", headers = {}) {
  return { status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, body: null, text: async () => body };
}
function fakeRes() {
  return { statusCode: 0, headers: {}, body: null, status(c) { this.statusCode = c; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, json(b) { this.body = b; return this; } };
}
const publicCheck = async (u) => new URL(u);

test("normalizes urls and refuses non-http, credentials and junk", () => {
  assert.equal(normalizePreviewUrl("example.com/a#x"), "https://example.com/a");
  assert.equal(normalizePreviewUrl("http://Example.com"), "http://example.com/");
  assert.equal(normalizePreviewUrl("javascript:alert(1)"), null);
  assert.equal(normalizePreviewUrl("ftp://x.com"), null);
  assert.equal(normalizePreviewUrl("https://u:p@x.com"), null);
  assert.equal(normalizePreviewUrl(""), null);
  assert.equal(normalizePreviewUrl("https://x.com/" + "a".repeat(3000)), null);
});

test("parses Open Graph, then Twitter, then plain tags; https images only, resolved against the page", () => {
  const p = parsePreview(html(`<title>Plain &amp; title</title><meta property="og:title" content="OG &quot;title&quot;"><meta name="description" content="desc"><meta property="og:image" content="/img.png"><meta property="og:site_name" content="Site">`), "https://www.example.com/post/1");
  assert.equal(p.title, 'OG "title"');
  assert.equal(p.description, "desc");
  assert.equal(p.image, "https://www.example.com/img.png");
  assert.equal(p.siteName, "Site");
  assert.equal(p.domain, "example.com");
  assert.equal(parsePreview(html(`<title>T</title><meta name="twitter:image" content="http://insecure.com/a.png">`), "https://a.com").image, null);
  assert.equal(parsePreview(html(`<title>Only title</title>`), "https://a.com").title, "Only title");
  assert.equal(decodeEntities("&#x41;&#66;&lt;"), "AB<");
});

test("private and local addresses are refused before any fetch, also after a redirect", async () => {
  let fetched = 0;
  const fetchImpl = async () => { fetched += 1; return resp(200, html("<title>x</title>"), { "content-type": "text/html" }); };
  for (const u of ["http://127.0.0.1/", "http://10.0.0.5/admin", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "http://localhost/"]) {
    await assert.rejects(fetchPreviewHtml(u, { fetchImpl, check: assertPublicImageUrl }), /private|not public/, u);
  }
  assert.equal(fetched, 0);
  const redirecting = async () => resp(302, "", { location: "http://192.168.1.1/" });
  const check = async (u) => (/192\.168/.test(u) ? assertPublicImageUrl(u) : new URL(u));
  await assert.rejects(fetchPreviewHtml("https://good.example/", { fetchImpl: redirecting, check }), /private/);
});

test("non-HTML and error pages give no preview", async () => {
  const pdf = async () => resp(200, "%PDF", { "content-type": "application/pdf" });
  await assert.rejects(fetchPreviewHtml("https://a.example/x.pdf", { fetchImpl: pdf, check: publicCheck }), /not html/);
  const notFound = async () => resp(404, "", { "content-type": "text/html" });
  await assert.rejects(fetchPreviewHtml("https://a.example/", { fetchImpl: notFound, check: publicCheck }), /404/);
});

test("handler returns the preview, caches it and refuses bad urls", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return resp(200, html(`<meta property="og:title" content="Hello"><meta property="og:image" content="https://cdn.example/a.jpg">`), { "content-type": "text/html; charset=utf-8" }); };
  const handler = createLinkPreview({ fetchImpl, check: publicCheck, log: quiet });
  const req = (url) => ({ query: { url }, headers: { "x-forwarded-for": "1.1.1.1" } });
  const r1 = fakeRes();
  await handler(req("https://news.example/story"), r1);
  assert.equal(r1.statusCode, 200);
  assert.equal(r1.body.title, "Hello");
  assert.equal(r1.body.image, "https://cdn.example/a.jpg");
  assert.equal(r1.body.domain, "news.example");
  const r2 = fakeRes();
  await handler(req("https://news.example/story"), r2);
  assert.equal(calls, 1, "second request is served from the cache");
  const bad = fakeRes();
  await handler(req("javascript:alert(1)"), bad);
  assert.equal(bad.statusCode, 400);
});

test("YouTube links use oEmbed", async () => {
  const { youTubePreview } = await import("./linkPreview.js");
  let asked = "";
  const fetchImpl = async (u) => { asked = u; return resp(200, JSON.stringify({ title: "Video &amp; more", author_name: "Channel", thumbnail_url: "https://i.ytimg.com/vi/x/hqdefault.jpg" }), { "content-type": "application/json" }); };
  const p = await youTubePreview("https://www.youtube.com/watch?v=abc", { fetchImpl, check: publicCheck });
  assert.match(asked, /^https:\/\/www\.youtube\.com\/oembed\?format=json&url=https%3A%2F%2Fwww\.youtube\.com%2Fwatch%3Fv%3Dabc$/);
  assert.equal(p.title, "Video & more");
  assert.equal(p.image, "https://i.ytimg.com/vi/x/hqdefault.jpg");
  assert.equal(await youTubePreview("https://example.com/watch?v=abc", { fetchImpl, check: publicCheck }), null);
});
