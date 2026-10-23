import test from "node:test";
import assert from "node:assert/strict";
import { firstLink, internalPath, linkLabel, splitLinks } from "./postLinks.mjs";

test("finds http(s) and www links and keeps trailing punctuation as text", () => {
  const text = "Read https://x.com/memewarzone/status/1. Also www.example.com, ok";
  const parts = splitLinks(text);
  assert.deepEqual(parts.filter((p) => p.kind === "link").map((p) => p.href), ["https://x.com/memewarzone/status/1", "https://www.example.com"]);
  assert.equal(parts.map((p) => p.text).join(""), text, "no text is lost");
});

test("keeps a closing bracket that belongs to the link, drops one that does not", () => {
  assert.equal(firstLink("see https://en.wikipedia.org/wiki/Doge_(meme)"), "https://en.wikipedia.org/wiki/Doge_(meme)");
  assert.equal(firstLink("(see https://a.com/x)"), "https://a.com/x");
});

test("ignores text without links and non-http schemes", () => {
  assert.equal(firstLink("no links here, just text"), null);
  assert.equal(firstLink("javascript:alert(1)"), null);
  assert.equal(firstLink("www."), null);
  assert.equal(firstLink(""), null);
});

test("MemeWarzone links open in the app; labels are short", () => {
  assert.equal(internalPath("https://app.memewar.zone/faq/battle-boosts?x=1"), "/faq/battle-boosts?x=1");
  assert.equal(internalPath("https://x.com/memewarzone"), null);
  assert.equal(linkLabel("https://www.example.com/a"), "example.com/a");
  assert.ok(linkLabel(`https://example.com/${"a".repeat(60)}`).endsWith("…"));
});

test("plain domains without https:// become links (founder 2026-10-23)", () => {
  const hrefs = (t) => splitLinks(t).filter((p) => p.kind === "link").map((p) => p.href);
  assert.deepEqual(hrefs("check memewar.zone/faq and x.com/memewarzone."), ["https://memewar.zone/faq", "https://x.com/memewarzone"]);
  assert.deepEqual(hrefs("app.memewar.zone/about"), ["https://app.memewar.zone/about"]);
  assert.deepEqual(hrefs("sub.domain.co.uk/path?q=1#h"), ["https://sub.domain.co.uk/path?q=1#h"]);
  assert.equal(internalPath(firstLink("go to app.memewar.zone/faq")), "/faq");
  assert.equal(firstLink("join t.me/memewarzonehq"), "https://t.me/memewarzonehq");
});

test("emails, handles, tickers, numbers and abbreviations stay text", () => {
  for (const t of ["mail me at bob@example.com", "e.g. this, 1.5k, node.js", "@memewarzone.com", "$DOGE.com", "price is 0.002 sol", "v1.2.3 is out", "ok.so what"]) {
    assert.equal(firstLink(t), null, t);
  }
});

test("text around plain domains is kept exactly", () => {
  const t = "Read memewar.zone/faq, then x.com/memewarzone!";
  assert.equal(splitLinks(t).map((p) => p.text).join(""), t);
});
