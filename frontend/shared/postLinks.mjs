// Links in feed post text: finding them, trimming trailing punctuation, and telling MemeWarzone's own links
// (opened inside the app) from outside links (opened in a new tab). Pure apart from window in the last helpers.

/**
 * http(s) URLs, www. links and plain domains with a known ending ("memewar.zone/faq", "x.com/memewarzone"), since
 * most people type links without https:// (founder, 2026-10-23). Plain domains need a listed top-level domain so
 * "e.g." or "1.5" never turn into links. No lookbehind: older iPhones (Safari before 16.4) cannot parse it, so the
 * character before a plain domain is checked in code instead.
 */
// Endings that are also short English words (so, to, it, in, be, us, es) are left out: "ok.so" stays text.
const TLDS = "com|net|org|io|co|app|dev|zone|xyz|fun|gg|ai|me|tv|sh|info|news|wtf|lol|club|live|pro|finance|money|exchange|trade|meme|world|site|online|tech|art|link|page|social|games|bet|cash|army|vip|biz|ly|fm|uk|de|nl|eu|ca|fr|ch|au|jp|kr|br";
const URL_RE = new RegExp(
  `(?:https?:\\/\\/|www\\.)[^\\s<>"'\`]+|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${TLDS})(?::\\d{2,5})?(?:[/?#][^\\s<>"'\`]*)?(?![a-z0-9-])`,
  "gi",
);
/** A plain domain right after one of these is part of something else: an email, a @handle, a path, a $ticker. */
const NOT_BEFORE_PLAIN = /[@\w.\-/$#]/;
const TRAILING = /[.,;:!?)\]}'"»]+$/;

const APP_HOSTS = new Set(["app.memewar.zone"]);

/**
 * Splits post text into plain text and link parts. Trailing punctuation stays text ("see x.com." keeps the dot).
 * @returns {({ kind: "text", text: string } | { kind: "link", text: string, href: string })[]}
 */
export function splitLinks(text) {
  const s = String(text || "");
  const parts = [];
  let last = 0;
  for (const m of s.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    let raw = m[0];
    const plain = !/^(?:https?:\/\/|www\.)/i.test(raw);
    if (plain && start > 0 && NOT_BEFORE_PLAIN.test(s[start - 1])) continue;
    // Trim trailing punctuation, but keep a closing bracket the link opened itself (Wikipedia-style URLs).
    while (TRAILING.test(raw)) {
      const end = raw[raw.length - 1];
      if (end === ")" && (raw.match(/\(/g) || []).length >= (raw.match(/\)/g) || []).length) break;
      raw = raw.slice(0, -1);
    }
    if (!raw || /^www\.?$/i.test(raw)) continue;
    const href = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
      const u = new URL(href);
      if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname.includes(".")) continue;
    } catch {
      continue;
    }
    if (start > last) parts.push({ kind: "text", text: s.slice(last, start) });
    parts.push({ kind: "link", text: raw, href });
    last = start + raw.length;
  }
  if (last < s.length) parts.push({ kind: "text", text: s.slice(last) });
  return parts;
}

/** The first link in the text, as a full URL, or null. */
export function firstLink(text) {
  const part = splitLinks(text).find((p) => p.kind === "link");
  return part ? part.href : null;
}

/** The in-app path for a MemeWarzone link, or null for an outside link. */
export function internalPath(href) {
  try {
    const u = new URL(href);
    const here = typeof window !== "undefined" ? window.location.host : "";
    if (APP_HOSTS.has(u.host) || (here && u.host === here)) return `${u.pathname}${u.search}${u.hash}` || "/";
  } catch {
    // not a URL
  }
  return null;
}

/** Short label for a link in text: host plus a trimmed path, like X does. */
export function linkLabel(raw) {
  const s = String(raw || "").replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  return s.length > 42 ? `${s.slice(0, 40)}…` : s;
}

/** Opens a link from inside a clickable post: in-app for MemeWarzone links, a new tab for outside links. */
export function openPostLink(href, navigate) {
  const path = internalPath(href);
  if (path) {
    navigate(path);
    return;
  }
  window.open(href, "_blank", "noopener,noreferrer");
}
