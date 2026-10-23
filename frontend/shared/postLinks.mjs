// Links in feed post text: finding them, trimming trailing punctuation, and telling MemeWarzone's own links
// (opened inside the app) from outside links (opened in a new tab). Pure apart from window in the last helpers.

/** http(s) URLs and bare www. links. Stops at whitespace and at characters that never end a URL in text. */
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
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
    // Trim trailing punctuation, but keep a closing bracket the link opened itself (Wikipedia-style URLs).
    while (TRAILING.test(raw)) {
      const end = raw.at(-1);
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
