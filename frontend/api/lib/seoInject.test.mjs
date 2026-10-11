import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { injectSeo, h1, p, ul, link } from "./seoInject.mjs";

const shell = fs.readFileSync(fileURLToPath(new URL("../../index.html", import.meta.url)), "utf8");
const count = (s, needle) => s.split(needle).length - 1;
const EVIL = '</script><script>alert(1)</script>"><img src=x>';

const base = {
  title: "Coin X",
  description: "A coin",
  canonical: "https://app.memewar.zone/coin/x",
  robots: "index,follow",
};

test("fixture sanity: shell has root anchor", () => {
  assert.ok(shell.includes('<div id="root"></div>'));
});

test("hostile values never appear raw", () => {
  const out = injectSeo(shell, {
    ...base,
    title: EVIL,
    description: EVIL,
    canonical: `https://x.test/?a="${EVIL}`,
    og: { title: EVIL, description: EVIL, url: EVIL, image: EVIL, imageAlt: EVIL },
    jsonLd: [{ name: EVIL }],
    summaryHtml: h1(EVIL) + p(EVIL),
  });
  assert.ok(!out.includes("<script>alert(1)"));
  assert.ok(!out.includes('"><img src=x>'));
  assert.ok(!out.includes("<img src=x>"));
  assert.equal(count(out, "<script>"), 0);
});

test("exactly one title, description, canonical, robots", () => {
  const out = injectSeo(shell, base);
  assert.equal(count(out, "<title>"), 1);
  assert.match(out, /<title>Coin X<\/title>/);
  assert.equal((out.match(/<meta[^>]*name="description"/g) || []).length, 1);
  assert.equal((out.match(/<link[^>]*rel="canonical"/g) || []).length, 1);
  assert.equal((out.match(/<meta[^>]*name="robots"/g) || []).length, 1);
  assert.match(out, /<link rel="canonical" href="https:\/\/app\.memewar\.zone\/coin\/x"/);
  // idempotent on already-injected output
  const again = injectSeo(out, { ...base, title: "Other" });
  assert.equal((again.match(/rel="canonical"/g) || []).length, 1);
  assert.equal((again.match(/name="robots"/g) || []).length, 1);
  assert.equal(count(again, "<title>"), 1);
});

test("canonical absent when null, removed when shell had one", () => {
  const out = injectSeo(shell, { ...base, canonical: null });
  assert.equal(count(out, 'rel="canonical"'), 0);
  const withCanon = injectSeo(shell, base);
  const removed = injectSeo(withCanon, { ...base, canonical: null });
  assert.equal(count(removed, 'rel="canonical"'), 0);
});

test("og and twitter tags replaced without duplicates", () => {
  const out = injectSeo(shell, {
    ...base,
    og: { title: "T", description: "D", url: "https://u/", image: "https://i/a.png", imageAlt: "Alt", type: "article" },
  });
  for (const k of ["og:title", "og:description", "og:url", "og:image", "og:image:secure_url", "og:image:alt", "og:type"]) {
    assert.equal(count(out, `property="${k}"`), 1, k);
  }
  for (const k of ["twitter:title", "twitter:description", "twitter:image", "twitter:image:alt"]) {
    assert.equal(count(out, `name="${k}"`), 1, k);
  }
  assert.match(out, /property="og:title" content="T"/);
  assert.match(out, /property="og:image:secure_url" content="https:\/\/i\/a\.png"/);
  assert.match(out, /name="twitter:image" content="https:\/\/i\/a\.png"/);
  assert.match(out, /property="og:type" content="article"/);
});

test("unprovided og values keep the shell's", () => {
  const out = injectSeo(shell, base);
  assert.match(out, /property="og:title" content="MemeWarzone: memecoin launchpad/);
  assert.match(out, /property="og:image" content="https:\/\/app\.memewar\.zone\/assets\/og-20260825\.png"/);
});

test("shell JSON-LD preserved, new blocks appended after it", () => {
  const out = injectSeo(shell, { ...base, jsonLd: [{ "@type": "A", n: "<b>& " }, { "@type": "B" }] });
  assert.equal(count(out, "application/ld+json"), 3);
  assert.ok(out.includes('"@type": "Organization"'));
  assert.ok(out.indexOf('"@type": "Organization"') < out.indexOf('"@type":"A"'));
  assert.ok(out.indexOf('"@type":"A"') < out.indexOf('"@type":"B"'));
  assert.ok(out.includes("\\u003cb\\u003e\\u0026\\u2028"));
  assert.ok(!out.includes(" "));
  for (const m of out.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) JSON.parse(m[1]);
});

test("summary placed inside root", () => {
  const out = injectSeo(shell, { ...base, summaryHtml: h1("Hello") });
  assert.match(out, /<div id="root"><h1>Hello<\/h1><\/div>/);
});

test("shell unchanged when root anchor missing", () => {
  const broken = shell.replace('<div id="root"></div>', "");
  assert.equal(injectSeo(broken, base), broken);
  assert.equal(injectSeo("", base), "");
});

test("$ patterns in values are literal", () => {
  const out = injectSeo(shell, { ...base, title: "Cost $& $1 $`", summaryHtml: p("$& $'") });
  assert.ok(out.includes("<title>Cost $&amp; $1 $`</title>"));
  assert.ok(out.includes("<p>$&amp; $&#39;</p>"));
});

test("helpers escape and link drops unsafe hrefs", () => {
  assert.equal(h1("<a>&\"'"), "<h1>&lt;a&gt;&amp;&quot;&#39;</h1>");
  assert.equal(p("<x>"), "<p>&lt;x&gt;</p>");
  assert.equal(ul(["<a>", "b"]), "<ul><li>&lt;a&gt;</li><li>b</li></ul>");
  assert.equal(link("/coin/x", "X"), '<a href="/coin/x">X</a>');
  assert.equal(link("https://a.test/p?q=1&r=2", "A"), '<a href="https://a.test/p?q=1&amp;r=2">A</a>');
  assert.equal(link("javascript:alert(1)", "bad"), "bad");
  assert.equal(link("//evil.test/x", "bad"), "bad");
  assert.equal(link("http://a.test", "bad"), "bad");
  assert.equal(link('/x"><img src=x>', "t"), '<a href="/x&quot;&gt;&lt;img src=x&gt;">t</a>');
});

test("link rejects control characters and backslashes anywhere", () => {
  for (const bad of ["/\t/evil.com", "/\n/evil.com", "/\r/evil.com", "/\\evil.com", "/a\\b", "/a\u0000b", "/a\u007fb", "https://a.test/\tx"]) {
    assert.equal(link(bad, "t"), "t", JSON.stringify(bad));
  }
});

test("tags inside HTML comments are not touched", () => {
  const sample = '<!-- example: <meta property="og:title" content="EXAMPLE" /> <link rel="canonical" href="https://example.invalid/" /> -->';
  const withComment = shell.replace("<title>", `${sample}\n    <title>`);
  assert.notEqual(withComment, shell);
  const out = injectSeo(withComment, { ...base, canonical: null, og: { title: "Real" } });
  assert.ok(out.includes(sample));
  assert.match(out, /<meta property="og:title" content="Real" \/>/);
  assert.equal(count(out, 'content="Real"'), 2); // og:title + twitter:title
});

test("unquoted attribute values are recognised", () => {
  const html = "<!doctype html><html><head><title>a</title><meta name=description content=old><link rel=canonical href=/old><meta property=og:title content=old></head><body><div id=\"root\"></div></body></html>";
  const out = injectSeo(html, { title: "t", description: "new", canonical: "https://x.test/", og: { title: "N" } });
  assert.equal((out.match(/name=description|name="description"/g) || []).length, 1);
  assert.equal((out.match(/rel=canonical|rel="canonical"/g) || []).length, 1);
  assert.equal((out.match(/og:title/g) || []).length, 1);
  assert.ok(!out.includes("content=old"));
});

test("$& in descriptions and og values stays literal", () => {
  const out = injectSeo(shell, { ...base, description: "a $& b $1", og: { title: "$&", description: "$`" } });
  assert.ok(out.includes('name="description" content="a $&amp; b $1"'));
  assert.ok(out.includes('property="og:title" content="$&amp;"'));
});

const mini = (head, body = '<div id="root"></div>') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

test("title inside a comment is skipped; the real title is replaced", () => {
  const c = "<!-- <title>X</title> -->";
  const out = injectSeo(mini(`${c}<title>T</title>`), { title: "New" });
  assert.ok(out.includes(c));
  assert.ok(out.includes("<title>New</title>"));
  assert.ok(!out.includes("<title>T</title>"));
});

test("a title only inside a comment counts as a missing anchor", () => {
  const html = mini("<!-- <title>X</title> -->");
  assert.equal(injectSeo(html, { title: "New" }), html);
});

test("</head> inside a comment is not the insertion point", () => {
  const c = "<!-- </head> -->";
  const out = injectSeo(mini(`<title>T</title>${c}`), { canonical: "https://x.test/" });
  assert.ok(out.includes(c));
  const canon = out.indexOf('rel="canonical"');
  assert.ok(canon > out.indexOf(c) + c.length);
  assert.ok(canon < out.indexOf("</head>", out.indexOf(c) + c.length));
});

test("root div inside a comment is skipped; the real root gets the summary", () => {
  const c = '<!-- <div id="root"></div> -->';
  const out = injectSeo(mini("<title>T</title>", `${c}<div id="root"></div>`), { summaryHtml: "<p>S</p>" });
  assert.ok(out.includes(c));
  assert.ok(out.includes('<div id="root"><p>S</p></div>'));
  const only = mini("<title>T</title>", c);
  assert.equal(injectSeo(only, { summaryHtml: "<p>S</p>" }), only);
});

test("unterminated comment masks the rest of the document", () => {
  const html = mini('<title>T</title><!-- open <meta name="description" content="x" />');
  const out = injectSeo(html, { title: "New", description: "D" });
  assert.ok(out.includes('<!-- open <meta name="description" content="x" />'));
});

test("<!-- inside a script body does not start a comment", () => {
  const html = mini('<script>var a = "<!--";</script><title>T</title><meta name="description" content="old" />');
  const out = injectSeo(html, { title: "New", description: "D" });
  assert.ok(out.includes("<title>New</title>"));
  assert.ok(out.includes('name="description" content="D"'));
});
