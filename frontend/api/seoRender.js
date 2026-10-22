// GET /__render/<original path>: the live app shell with one page's head tags and a short text summary.
// nginx proxies app page requests here. Same HTML for people and crawlers; React replaces #root on load.
// Loader DATA is cached (never HTML, never errors); the CURRENT shell is fetched on every request.
import { createAppShell } from "./lib/appShell.mjs";
import { injectSeo, esc, h1, h2, p, ul, link } from "./lib/seoInject.mjs";
import { createSeoEntities } from "./lib/seoEntities.js";
import { DEFAULT_DESCRIPTION, headForPath, matchRoute } from "../shared/seoRoutes.mjs";
import {
  ABOUT_CHAINS, ABOUT_DISAMBIGUATION, ABOUT_HERO_LINKS, ABOUT_HIGHLIGHTS, ABOUT_INTRO, ABOUT_NEXT_CHAIN, ABOUT_PATH, ABOUT_SECTIONS,
  ABOUT_TITLE, aboutJsonLd,
} from "../shared/aboutContent.mjs";
import { COMPARE_PAGES, compareJsonLd } from "../shared/comparePages.mjs";
import {
  HELP_PATH, HELP_TITLE, HELP_DESCRIPTION, HELP_TOPICS, helpArticlesForTopic, helpHead, helpJsonLd, helpPopular, helpRelated,
} from "../shared/helpContent.mjs";

const BRAND = "MemeWarzone";
const NOINDEX = "noindex,follow";
const TTL_FOUND_MS = 60_000;
const TTL_MISS_MS = 5_000;
const DEFAULT_CAP = 2000;
const CHAIN_IDS = new Set([56, 101, 4663]);

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9_.-]{0,99}$/i;
const ID80_RE = /^[A-Za-z0-9_-]{1,80}$/;
const POST_RE = /^[1-9][0-9]{0,15}$/;

const ENTITY = {
  "/token/:id": { kind: "coin", param: "id", ok: (v) => EVM_RE.test(v) || SOL_RE.test(v) },
  "/warzone/battles/:id": { kind: "battle", param: "id", ok: (v) => ID80_RE.test(v) },
  "/warzone/tournaments/:id": { kind: "tournament", param: "id", ok: (v) => ID80_RE.test(v) },
  "/prepare/:slug": { kind: "prepare", param: "slug", ok: (v) => SLUG_RE.test(v) },
  "/post/:id": { kind: "post", param: "id", ok: (v) => POST_RE.test(v) },
  "/recruiters/:code": { kind: "recruiter", param: "code", ok: (v) => SLUG_RE.test(v) },
  "/profile/:wallet": { kind: "profile", param: "wallet", ok: (v) => EVM_RE.test(v) || SOL_RE.test(v) },
};

const titleOf = (t) => (t && t !== BRAND ? `${t} · ${BRAND}` : BRAND);

function createLru(cap) {
  const map = new Map();
  return {
    get(key, t) {
      const e = map.get(key);
      if (!e) return undefined;
      if (e.exp <= t) { map.delete(key); return undefined; }
      map.delete(key);
      map.set(key, e);
      return e.value;
    },
    set(key, value, exp) {
      map.delete(key);
      map.set(key, { value, exp });
      while (map.size > cap) map.delete(map.keys().next().value);
    },
    get size() { return map.size; },
  };
}

function summaryOf(s) {
  if (!s || typeof s !== "object") return "";
  const lines = Array.isArray(s.lines) ? s.lines.filter(Boolean) : [];
  const links = Array.isArray(s.links) ? s.links : [];
  let html = s.heading ? h1(s.heading) : "";
  html += lines.map((l) => p(l)).join("");
  if (links.length) html += `<p>${links.map((l) => link(l?.href, l?.text)).join(" ")}</p>`;
  return html;
}

// Fixed pages whose full text is server-rendered (the same copy the app page shows), keyed by route pattern.
function sectionsHtml(sections) {
  let html = "";
  for (const s of sections) {
    html += h2(s.heading);
    if (s.lead) html += p(s.lead);
    if (s.steps?.length) html += ul(s.steps.map((x) => `${x.title}: ${x.text}`));
    if (s.chips?.length) html += p(`${s.chipsLabel || ""} ${s.chips.join(", ")}`.trim());
    for (const m of s.modes || []) html += p(`${m.name} (${m.durations.join(", ")}): ${m.text}`);
    for (const x of s.splits || []) html += p(`${x.title}: ${x.segments.map((g) => `${g.pct}% ${g.label}`).join(", ")}.`);
    if (s.items?.length) html += ul(s.items);
    if (s.categories?.length) html += ul(s.categories.map((c) => `${c.name}: ${c.text}`));
    if (s.members?.length) html += ul(s.members.map((m) => `${m.name}, ${m.role}`));
    for (const c of s.contracts || []) {
      html += p(`${c.chain}. ${c.audit}.`);
      html += `<ul>${c.entries.map((e) => `<li>${esc(e.label)}: ${link(e.href, e.address)}</li>`).join("")}</ul>`;
    }
    for (const x of s.qa || []) html += `<h3>${esc(x.q)}</h3>${p(x.a)}`;
    if (s.rows?.length) {
      html += `<table><thead><tr><th>Feature</th><th>MemeWarzone</th><th>Pump.fun</th></tr></thead><tbody>`;
      for (const r of s.rows) html += `<tr><td>${esc(r.feature)}</td><td>${esc(r.mwz)}</td><td>${esc(r.other)}</td></tr>`;
      html += "</tbody></table>";
    }
    if (s.note) html += p(s.note);
    if (s.links?.length) html += `<p>${s.links.map((l) => link(l.href, l.text)).join(" ")}</p>`;
  }
  return html;
}

function aboutBody() {
  let html = h1(ABOUT_TITLE) + ABOUT_INTRO.map((t) => p(t)).join("") + p(ABOUT_DISAMBIGUATION);
  html += p(`Live on ${ABOUT_CHAINS.join(", ")}. ${ABOUT_NEXT_CHAIN.name}: ${ABOUT_NEXT_CHAIN.label.toLowerCase()}. ${ABOUT_NEXT_CHAIN.text}`);
  html += ul(ABOUT_HIGHLIGHTS.map((x) => `${x.value}: ${x.label}`));
  html += `<p>${ABOUT_HERO_LINKS.map((l) => link(l.href, l.text)).join(" ")}</p>`;
  html += sectionsHtml(ABOUT_SECTIONS);
  return { html, jsonLd: aboutJsonLd() };
}

function compareBody(page) {
  let html = h1(page.title) + page.intro.map((t) => p(t)).join("") + p(page.disclaimer);
  for (const v of page.verdicts) html += h2(v.title) + ul(v.items);
  html += sectionsHtml(page.sections);
  html += h2("Sources") + `<ul>${page.sources.map((x) => `<li>${link(x.href, x.text)} (${esc(x.date)})</li>`).join("")}</ul>`;
  return { html, jsonLd: compareJsonLd(page) };
}
function helpArticleHtml(a) {
  let html = (a.a || []).map((t) => p(t)).join("");
  if (a.steps?.length) html += `<ol>${a.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>`;
  if (a.bullets?.length) html += ul(a.bullets);
  if (a.links?.length) html += `<p>${a.links.map((l) => link(l.href, l.text)).join(" ")}</p>`;
  return html;
}

const helpLink = (slug, text) => link(`${HELP_PATH}/${slug}`, text);

function helpIndexBody() {
  let html = h1(HELP_TITLE) + p(HELP_DESCRIPTION);
  const popular = helpPopular();
  if (popular.length) html += h2("Popular questions") + `<ul>${popular.map((a) => `<li>${helpLink(a.slug, a.q)}</li>`).join("")}</ul>`;
  for (const t of HELP_TOPICS) {
    const list = helpArticlesForTopic(t.id);
    html += h2(t.label) + p(t.description) + `<p>${helpLink(t.id, `All ${list.length} answers about ${t.label.toLowerCase()}`)}</p>`;
    html += `<ul>${list.map((a) => `<li>${helpLink(a.slug, a.q)}</li>`).join("")}</ul>`;
  }
  return { html, jsonLd: helpJsonLd(null) };
}

function helpItemBody({ slug }) {
  const head = helpHead(String(slug || ""));
  if (!head) return { notFound: true };
  const back = `<p>${link(HELP_PATH, HELP_TITLE)}</p>`;
  let html;
  if (head.kind === "topic") {
    html = back + h1(head.topic.label) + p(head.topic.description);
    for (const a of helpArticlesForTopic(head.topic.id)) html += h2(a.q) + helpArticleHtml(a) + `<p>${helpLink(a.slug, "Open this answer")}</p>`;
  } else {
    html = back + `<p>${helpLink(head.topic.id, head.topic.label)}</p>` + h1(head.article.q) + helpArticleHtml(head.article);
    const related = helpRelated(head.article);
    if (related.length) html += h2("Related questions") + `<ul>${related.map((a) => `<li>${helpLink(a.slug, a.q)}</li>`).join("")}</ul>`;
  }
  return { html, jsonLd: helpJsonLd(head), head: { title: head.title, description: head.description } };
}

const PAGE_BODIES = {
  [HELP_PATH]: helpIndexBody,
  [`${HELP_PATH}/:slug`]: helpItemBody,
  [ABOUT_PATH]: aboutBody,
  ...Object.fromEntries(COMPARE_PAGES.map((page) => [page.path, () => compareBody(page)])),
};

function splitUrl(req) {
  const raw = String(req.originalUrl || req.url || req.path || "");
  const qi = raw.indexOf("?");
  const pathPart = qi < 0 ? raw : raw.slice(0, qi);
  const query = qi < 0 ? "" : raw.slice(qi + 1);
  let path = pathPart.replace(/^\/__render(?=\/|$)/, "");
  if (!path) path = "/";
  return { path, query };
}

export function createSeoRenderer({
  shell, entities, now = Date.now, cacheCap = DEFAULT_CAP,
  maxConcurrent = 3, breakerErrors = 5, breakerWindowMs = 10_000, breakerOpenMs = 10_000,
} = {}) {
  const cache = createLru(cacheCap);
  // The renderer shares the API's pg pool, so it protects it: a slot cap, per-key coalescing and a
  // circuit breaker. Anything refused answers 503 and nginx serves the plain shell.
  const inflight = new Map();
  let active = 0;
  let errorTimes = [];
  let openUntil = 0;
  const UNAVAILABLE = { unavailable: true };

  function noteError(t) {
    errorTimes = errorTimes.filter((x) => t - x < breakerWindowMs);
    errorTimes.push(t);
    if (errorTimes.length >= breakerErrors) {
      openUntil = t + breakerOpenMs;
      errorTimes = [];
    }
  }

  const send = (res, status, html, robots) => {
    res.statusCode = status;
    if (typeof res.status === "function") res.status(status);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    if (robots && /noindex/i.test(robots)) res.setHeader("X-Robots-Tag", robots);
    res.send(html);
  };

  // 410 = invalid id / unknown path (nginx passes it through); entity miss = 404 (nginx serves the plain shell,
  // so a just-launched coin that is not in the database yet never gets a sticky "Page not found" preview).
  const notFound = (res, html, status = 410) =>
    send(res, status, injectSeo(html, {
      title: titleOf("Page not found"),
      description: DEFAULT_DESCRIPTION,
      canonical: null,
      robots: NOINDEX,
      summaryHtml: h1("Page not found") + p("This page does not exist on MemeWarzone.") + `<p>${link("/", "Go to MemeWarzone")}</p>`,
    }), NOINDEX);

  async function load(spec, id, chainId) {
    const t = now();
    const norm = EVM_RE.test(id) ? id.toLowerCase() : id;
    const key = `${spec.kind}:${norm}:${chainId || ""}`;
    const hit = cache.get(key, t);
    if (hit) return hit;
    let pending = inflight.get(key);
    if (!pending) {
      if (t < openUntil || active >= maxConcurrent) return UNAVAILABLE;
      active += 1;
      pending = (async () => {
        await null; // yield so `inflight.set` below always runs before this body can settle
        try {
          const d = spec.kind === "coin" ? await entities.coin(id, chainId) : await entities[spec.kind](id);
          if (!d || typeof d !== "object" || d.error) { noteError(now()); return { error: true }; }
          cache.set(key, d, now() + (d.found ? TTL_FOUND_MS : TTL_MISS_MS));
          return d;
        } catch (err) {
          noteError(now());
          throw err;
        } finally {
          active -= 1;
          if (inflight.get(key) === pending) inflight.delete(key);
        }
      })();
      inflight.set(key, pending);
    }
    const data = await pending;
    return data;
  }

  const plain = (res, status, text) => {
    res.statusCode = status;
    if (typeof res.status === "function") res.status(status);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    return res.send(text);
  };

  async function handle(req, res) {
    const { path, query } = splitUrl(req);
    const rule = matchRoute(path);
    const spec = rule && rule.kind === "index" ? ENTITY[rule.pattern] : undefined;

    // Validate first so a malformed id costs no loader call; the shell is fetched only when we answer with HTML.
    let id;
    let chainId;
    let invalid = !rule || rule.kind === "alias";
    if (!invalid && spec) {
      id = rule.params[spec.param];
      try { id = decodeURIComponent(id); } catch { invalid = true; }
      if (!invalid && !spec.ok(id)) invalid = true;
      if (!invalid && spec.kind === "coin") {
        const c = Number(new URLSearchParams(query).get("chainId"));
        if (Number.isInteger(c) && CHAIN_IDS.has(c)) chainId = c;
      }
    }

    let data;
    if (!invalid && spec) {
      data = await load(spec, id, chainId);
      if (data.unavailable) return plain(res, 503, "Render busy");
      if (data.error) return plain(res, 500, "Render failed");
    }

    const html = await shell.get();
    if (!html) return plain(res, 503, "Shell unavailable");

    if (invalid) return notFound(res, html);
    if (spec) {
      if (!data.found) return notFound(res, html, 404);
      const hidden = data.private || /noindex/i.test(String(data.robots || ""));
      const robots = hidden ? NOINDEX : data.robots || "index,follow";
      const canonical = hidden ? null : data.canonical || null;
      const title = titleOf(data.title);
      return send(res, 200, injectSeo(html, {
        title,
        description: data.description,
        canonical,
        robots,
        og: { title, description: data.description, url: canonical || undefined, image: data.image, imageAlt: data.imageAlt, type: data.ogType || "website" },
        jsonLd: hidden ? [] : data.jsonLd,
        summaryHtml: summaryOf(data.summary),
      }), robots);
    }

    const page = rule && PAGE_BODIES[rule.pattern] ? PAGE_BODIES[rule.pattern](rule.params || {}) : null;
    if (page?.notFound) return notFound(res, html);
    const head = headForPath(path, page?.head || {});
    const title = titleOf(head.title);
    return send(res, 200, injectSeo(html, {
      title,
      description: head.description || DEFAULT_DESCRIPTION,
      canonical: head.canonical,
      robots: head.robots,
      og: { title, description: head.description || DEFAULT_DESCRIPTION, url: head.canonical || undefined, type: "website" },
      jsonLd: page ? page.jsonLd : undefined,
      summaryHtml: page ? page.html : h1(head.title || BRAND) + (head.description ? p(head.description) : ""),
    }), head.robots);
  }

  return async function seoRender(req, res) {
    try {
      await handle(req, res);
    } catch (err) {
      console.error("[api/seoRender] failed", err?.message || err);
      try {
        if (res.headersSent) return;
        res.statusCode = 500;
        if (typeof res.status === "function") res.status(500);
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        res.send("Render failed");
      } catch { /* nothing left to do */ }
    }
  };
}

// Default wiring. The database pool loads lazily so importing this module never needs DATABASE_URL.
let real = null;
const lazyDb = {
  async query(...args) {
    const { pool } = await import("../server/db.js");
    return pool.query(...args);
  },
};
export default function seoRender(req, res) {
  if (!real) real = createSeoRenderer({ shell: createAppShell(), entities: createSeoEntities({ db: lazyDb }) });
  return real(req, res);
}
