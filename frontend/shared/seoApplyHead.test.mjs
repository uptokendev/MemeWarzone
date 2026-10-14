import test from "node:test";
import assert from "node:assert/strict";
import { applyHead, resolveHead } from "./seoApplyHead.mjs";
import { headForPath, DEFAULT_DESCRIPTION } from "./seoRoutes.mjs";

function makeDoc(initial = []) {
  const children = [];
  const mk = (tag) => {
    const el = {
      tag, attrs: {}, parent: null,
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      remove() { if (this.parent) this.parent.removeChild(this); },
    };
    return el;
  };
  const head = {
    appendChild(el) { el.parent = head; children.push(el); return el; },
    removeChild(el) { const i = children.indexOf(el); if (i >= 0) children.splice(i, 1); el.parent = null; return el; },
  };
  const doc = {
    title: "",
    head,
    children,
    createElement: mk,
    querySelector(sel) {
      const m = /^(\w+)\[(\w+)="([^"]+)"\]$/.exec(sel);
      if (!m) throw new Error("unsupported selector " + sel);
      return children.find((c) => c.tag === m[1] && c.attrs[m[2]] === m[3]) || null;
    },
  };
  for (const [tag, k, v, extra] of initial) {
    const el = mk(tag); el.setAttribute(k, v);
    for (const [ek, ev] of Object.entries(extra || {})) el.setAttribute(ek, ev);
    head.appendChild(el);
  }
  return doc;
}

const base = { title: "Coins", description: "Desc", canonical: "https://app.memewar.zone/coins", robots: "index,follow" };

test("title format with suffix", () => {
  const d = makeDoc();
  applyHead(d, base);
  assert.equal(d.title, "Coins · MemeWarzone");
});

test("title is bare brand when empty or brand", () => {
  const d = makeDoc();
  applyHead(d, { ...base, title: "" });
  assert.equal(d.title, "MemeWarzone");
  applyHead(d, { ...base, title: "MemeWarzone" });
  assert.equal(d.title, "MemeWarzone");
});

test("creates description, canonical and robots", () => {
  const d = makeDoc();
  applyHead(d, base);
  assert.equal(d.querySelector('meta[name="description"]').attrs.content, "Desc");
  assert.equal(d.querySelector('link[rel="canonical"]').attrs.href, base.canonical);
  assert.equal(d.querySelector('meta[name="robots"]').attrs.content, "index,follow");
});

test("updates existing tags without duplicating", () => {
  const d = makeDoc([
    ["link", "rel", "canonical", { href: "https://old" }],
    ["meta", "name", "robots", { content: "index,follow" }],
  ]);
  applyHead(d, { ...base, canonical: "https://app.memewar.zone/new", robots: "noindex,follow" });
  assert.equal(d.children.filter((c) => c.tag === "link").length, 1);
  assert.equal(d.querySelector('link[rel="canonical"]').attrs.href, "https://app.memewar.zone/new");
  assert.equal(d.children.filter((c) => c.attrs.name === "robots").length, 1);
  assert.equal(d.querySelector('meta[name="robots"]').attrs.content, "noindex,follow");
});

test("removes canonical when null", () => {
  const d = makeDoc([["link", "rel", "canonical", { href: "https://old" }]]);
  applyHead(d, { ...base, canonical: null });
  assert.equal(d.querySelector('link[rel="canonical"]'), null);
  applyHead(d, { ...base, canonical: null });
  assert.equal(d.querySelector('link[rel="canonical"]'), null);
});

test("empty description resets to the generic site description", () => {
  const d = makeDoc([["meta", "name", "description", { content: "Previous page" }]]);
  applyHead(d, { ...base, description: "" });
  assert.equal(d.querySelector('meta[name="description"]').attrs.content, DEFAULT_DESCRIPTION);
  const e = makeDoc();
  applyHead(e, { ...base, description: "" });
  assert.equal(e.querySelector('meta[name="description"]').attrs.content, DEFAULT_DESCRIPTION);
});

test("resolveHead: noindex override nulls canonical", () => {
  const head = headForPath("/coins");
  assert.ok(head.canonical);
  const r = resolveHead(head, { robots: "noindex,follow" });
  assert.equal(r.robots, "noindex,follow");
  assert.equal(r.canonical, null);
  assert.equal(r.title, head.title);
});

test("resolveHead: index route keeps canonical", () => {
  const head = headForPath("/coins");
  const r = resolveHead(head, {});
  assert.equal(r.robots, "index,follow");
  assert.equal(r.canonical, head.canonical);
});

test("resolveHead: override canonical wins on index route", () => {
  const overrides = { canonical: "https://app.memewar.zone/profile/abc" };
  const r = resolveHead(headForPath("/profile/abc", overrides), overrides);
  assert.equal(r.canonical, overrides.canonical);
  assert.equal(r.robots, "index,follow");
});

test("resolveHead: natively noindex head stays without canonical", () => {
  const r = resolveHead({ title: "", description: "", canonical: null, robots: "noindex,follow" }, {});
  assert.equal(r.canonical, null);
});
