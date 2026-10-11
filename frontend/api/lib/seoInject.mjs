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
  if (/[\u0000-\u001f\u007f\\]/.test(h)) return esc(text);
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
  const re = new RegExp(`\\s${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const m = re.exec(tag);
  return !!m && (m[1] ?? m[2] ?? m[3]) === value;

}

/** Offsets of comment and script/style regions, where tag-like text is not real markup. */
function maskedRanges(html) {
  const ranges = [];
  const re = /<!--[\s\S]*?(?:-->|$)|<(script|style)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;
  let m;
  while ((m = re.exec(html))) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

function inRanges(ranges, offset) {
  return ranges.some(([a, b]) => offset >= a && offset < b);
}

/** Removes every matching tag; returns [html, removedCount, indexOfFirst]. */
function removeTags(html, name, attr, value) {
  let first = -1;
  let n = 0;
  const masked = maskedRanges(html);
  const out = html.replace(TAG(name), (tag, offset) => {
    if (inRanges(masked, offset) || !hasAttr(tag, attr, value)) return tag;
    if (first < 0) first = offset;
    n += 1;
    return "";
  });
  return { html: out, n, first };
}

/** Replaces the first matching tag with `tagHtml`, drops further duplicates. Returns null if none matched. */
function replaceTag(html, name, attr, value, tagHtml) {
  let seen = false;
  const masked = maskedRanges(html);
  const out = html.replace(TAG(name), (tag, offset) => {
    if (inRanges(masked, offset) || !hasAttr(tag, attr, value)) return tag;
    if (seen) return "";
    seen = true;
    return tagHtml;
  });
  return seen ? out : null;
}

/** Replaces the first match of `re` that lies outside comment/script/style regions. */
function replaceFirstUnmasked(html, re, fn) {
  const masked = maskedRanges(html);
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let m;
  while ((m = g.exec(html))) {
    if (inRanges(masked, m.index)) continue;
    return html.slice(0, m.index) + fn(m[0]) + html.slice(m.index + m[0].length);
  }
  return null;
}

const TITLE_RE = /<title>[\s\S]*?<\/title>/i;
const ROOT_RE = /<div id="root">\s*<\/div>/;
const HEAD_END_RE = /<\/head>/i;

function insertInHead(html, snippet) {
  return replaceFirstUnmasked(html, HEAD_END_RE, () => `    ${snippet}\n  </head>`) ?? html;
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
  const anchored = (re) => replaceFirstUnmasked(src, re, (x) => x) !== null;
  if (!anchored(ROOT_RE) || !anchored(TITLE_RE) || !anchored(HEAD_END_RE)) return src;

  let html = src;

  if (title != null) {
    html = replaceFirstUnmasked(html, TITLE_RE, () => `<title>${esc(title)}</title>`) ?? html;
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
    // These describe the shell's static image, not the replacement.
    for (const k of ["og:image:type", "og:image:width", "og:image:height"]) html = removeTags(html, "meta", "property", k).html;
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
    const masked = maskedRanges(html).filter(([a]) => html.startsWith("<!--", a));
    while ((m = re.exec(html))) if (!inRanges(masked, m.index)) lastEnd = m.index + m[0].length;
    if (lastEnd >= 0) html = `${html.slice(0, lastEnd)}\n    ${blocks}${html.slice(lastEnd)}`;
    else html = insertInHead(html, blocks);
  }

  if (typeof summaryHtml === "string" && summaryHtml) {
    html = replaceFirstUnmasked(html, ROOT_RE, () => `<div id="root">${summaryHtml}</div>`) ?? html;
  }
  return html;
}
