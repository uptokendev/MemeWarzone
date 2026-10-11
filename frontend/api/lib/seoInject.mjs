// Pure head/body injector for the server-rendered SEO shell. No I/O.

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
}

export function h1(text) {
  return `<h1>${esc(text)}</h1>`;
}

export function p(text) {
  return `<p>${esc(text)}</p>`;
}

export function ul(items) {
  return `<ul>${(items || []).map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
}

/** Same-origin path ("/x") or https URL only; anything else renders as plain text. */
export function link(href, text) {
  const h = String(href ?? "");
  const ok = (h.startsWith("/") && !h.startsWith("//") && !h.startsWith("/\\")) || /^https:\/\/[^\s]/i.test(h);
  return ok ? `<a href="${esc(h)}">${esc(text)}</a>` : esc(text);
}

function jsonForScript(obj) {
  return JSON.stringify(obj)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(new RegExp(String.fromCharCode(0x2028), "g"), "\\u2028")
    .replace(new RegExp(String.fromCharCode(0x2029), "g"), "\\u2029");
}

const TAG = (name) => new RegExp(`<${name}\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, "gi");

function hasAttr(tag, attr, value) {
  const re = new RegExp(`\\s${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i");
  const m = re.exec(tag);
  return !!m && (m[1] ?? m[2]) === value;
}

/** Removes every matching tag; returns [html, removedCount, indexOfFirst]. */
function removeTags(html, name, attr, value) {
  let first = -1;
  let n = 0;
  const out = html.replace(TAG(name), (tag, offset) => {
    if (!hasAttr(tag, attr, value)) return tag;
    if (first < 0) first = offset;
    n += 1;
    return "";
  });
  return { html: out, n, first };
}

/** Replaces the first matching tag with `tagHtml`, drops further duplicates. Returns null if none matched. */
function replaceTag(html, name, attr, value, tagHtml) {
  let seen = false;
  const out = html.replace(TAG(name), (tag) => {
    if (!hasAttr(tag, attr, value)) return tag;
    if (seen) return "";
    seen = true;
    return tagHtml;
  });
  return seen ? out : null;
}

function insertInHead(html, snippet) {
  return html.replace(/<\/head>/i, () => `    ${snippet}\n  </head>`);
}

function setMeta(html, attr, key, content, { addIfMissing = true } = {}) {
  const tag = `<meta ${attr}="${key}" content="${esc(content)}" />`;
  const replaced = replaceTag(html, "meta", attr, key, tag);
  if (replaced !== null) return replaced;
  return addIfMissing ? insertInHead(html, tag) : html;
}

const has = (v) => typeof v === "string" && v !== "";

export function injectSeo(shell, opts = {}) {
  const { title, description, canonical, robots, og = {}, jsonLd = [], summaryHtml } = opts || {};
  const src = String(shell ?? "");
  const rootRe = /<div id="root">\s*<\/div>/;
  if (!rootRe.test(src) || !/<title>[\s\S]*?<\/title>/i.test(src) || !/<\/head>/i.test(src)) return src;

  let html = src;

  if (title != null) {
    html = html.replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${esc(title)}</title>`);
  }
  if (description != null) html = setMeta(html, "name", "description", description);

  const o = og || {};
  if (has(o.title)) {
    html = setMeta(html, "property", "og:title", o.title);
    html = setMeta(html, "name", "twitter:title", o.title);
  }
  if (has(o.description)) {
    html = setMeta(html, "property", "og:description", o.description);
    html = setMeta(html, "name", "twitter:description", o.description);
  }
  if (has(o.url)) html = setMeta(html, "property", "og:url", o.url);
  if (has(o.type)) html = setMeta(html, "property", "og:type", o.type);
  if (has(o.image)) {
    html = setMeta(html, "property", "og:image", o.image);
    html = setMeta(html, "property", "og:image:secure_url", o.image, { addIfMissing: false });
    html = setMeta(html, "name", "twitter:image", o.image);
  }
  if (has(o.imageAlt)) {
    html = setMeta(html, "property", "og:image:alt", o.imageAlt, { addIfMissing: false });
    html = setMeta(html, "name", "twitter:image:alt", o.imageAlt, { addIfMissing: false });
  }

  if (canonical !== undefined) {
    html = removeTags(html, "link", "rel", "canonical").html;
    if (typeof canonical === "string" && canonical) {
      html = insertInHead(html, `<link rel="canonical" href="${esc(canonical)}" />`);
    }
  }
  if (has(robots)) html = setMeta(html, "name", "robots", robots);

  const blocks = (Array.isArray(jsonLd) ? jsonLd : [])
    .filter((x) => x && typeof x === "object")
    .map((x) => `<script type="application/ld+json">${jsonForScript(x)}</script>`)
    .join("\n    ");
  if (blocks) {
    const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi;
    let lastEnd = -1;
    let m;
    while ((m = re.exec(html))) lastEnd = m.index + m[0].length;
    if (lastEnd >= 0) html = `${html.slice(0, lastEnd)}\n    ${blocks}${html.slice(lastEnd)}`;
    else html = insertInHead(html, blocks);
  }

  if (typeof summaryHtml === "string" && summaryHtml) {
    html = html.replace(rootRe, () => `<div id="root">${summaryHtml}</div>`);
  }
  return html;
}
