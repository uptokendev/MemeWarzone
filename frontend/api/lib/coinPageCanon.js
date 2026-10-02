/**
 * Coin page fields (N5), coin posts (N1) and auto updates (N4) — pure validation and shaping.
 * UI redesign phase 1b; spec in docs/build_plans/ui-redesign/CHANGELOG.md.
 */
import { STORY_FULL_SECTIONS } from "../../shared/storyContract.mjs";

export const COIN_BIO_MAX = 1200;
export const COIN_FOUNDER_NOTE_MAX = 140;
export const COIN_LINK_MAX = 512;
export const COIN_TAGS_MAX = 5;
export const COIN_TAG_MAX = 24;
export const COIN_POST_MAX = 280;
export const COIN_POST_RATE = Object.freeze({ count: 5, windowMinutes: 10 });

const SECTION_KEYS = new Set(STORY_FULL_SECTIONS.map((s) => s.key));

function fail(code, error, extra = {}) {
  return { ok: false, code, error, ...extra };
}

/** https URL, or "" for empty input, or null when it is not a usable https URL. */
export function httpsUrlOrEmpty(value, max = COIN_LINK_MAX) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (raw.length > max) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname.includes(".") ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Social handles are accepted as full links or the usual shorthand (@name, t.me/name, discord.gg/x). */
export function socialUrlOrEmpty(kind, value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (kind === "x" && /^@?[A-Za-z0-9_]{1,15}$/.test(raw)) return `https://x.com/${raw.replace(/^@/, "")}`;
  if (kind === "telegram" && /^(t\.me|telegram\.me)\//i.test(raw)) return httpsUrlOrEmpty(`https://${raw}`);
  if (kind === "discord" && /^(discord\.gg|discord\.com)\//i.test(raw)) return httpsUrlOrEmpty(`https://${raw}`);
  if (!/^https?:\/\//i.test(raw) && /^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(raw)) return httpsUrlOrEmpty(`https://${raw}`);
  return httpsUrlOrEmpty(raw);
}

/** Up to 5 lowercase tags, letters/digits/space/dash, deduplicated, each at most 24 characters. */
export function normalizeTags(value) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(",");
  const out = [];
  for (const item of list) {
    const tag = String(item ?? "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!tag) continue;
    if (tag.length > COIN_TAG_MAX || !/^[a-z0-9][a-z0-9 -]*$/.test(tag)) return null;
    if (!out.includes(tag)) out.push(tag);
  }
  return out.length > COIN_TAGS_MAX ? null : out;
}

/**
 * Validates a profile save. `origin` is "launched" | "imported". Fields the body leaves out are
 * returned as `undefined` so the caller keeps what is stored; an empty string clears a field.
 */
export function validateCoinProfileInput(body, origin) {
  const b = body && typeof body === "object" ? body : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const values = {};

  if (has("bio")) {
    const bio = String(b.bio ?? "").trim();
    if (bio && origin !== "launched") {
      return fail("COIN_BIO_IMPORTS_USE_PROJECT", "Imported coins edit their description in the project details.");
    }
    if (bio.length > COIN_BIO_MAX) return fail("COIN_BIO_TOO_LONG", `The bio can be at most ${COIN_BIO_MAX} characters.`);
    values.bio = bio || null;
  }
  if (has("founderNote")) {
    const note = String(b.founderNote ?? "").trim();
    if (note.length > COIN_FOUNDER_NOTE_MAX) return fail("COIN_NOTE_TOO_LONG", `The founder note can be at most ${COIN_FOUNDER_NOTE_MAX} characters.`);
    values.founder_note = note || null;
  }
  for (const [key, column, kind] of [
    ["websiteUrl", "website_url", "website"],
    ["xUrl", "x_url", "x"],
    ["telegramUrl", "telegram_url", "telegram"],
    ["discordUrl", "discord_url", "discord"],
  ]) {
    if (!has(key)) continue;
    const url = socialUrlOrEmpty(kind, b[key]);
    if (url === null) return fail("COIN_LINK_INVALID", "Links must be https addresses.", { field: key });
    values[column] = url || null;
  }
  if (has("bannerUrl")) {
    const url = httpsUrlOrEmpty(b.bannerUrl);
    if (url === null) return fail("COIN_LINK_INVALID", "The banner must be an https image address.", { field: "bannerUrl" });
    values.banner_url = url || null;
  }
  if (has("bannerPositionY")) {
    const raw = b.bannerPositionY;
    const n = raw === null || raw === "" ? null : Math.round(Number(raw));
    if (n !== null && (!Number.isFinite(n) || n < 0 || n > 100)) return fail("COIN_BANNER_POSITION", "Banner position must be between 0 and 100.", { field: "bannerPositionY" });
    values.banner_position_y = n;
  }
  if (has("tags")) {
    const tags = normalizeTags(b.tags);
    if (tags === null) return fail("COIN_TAGS_INVALID", `Up to ${COIN_TAGS_MAX} tags, letters and numbers only, ${COIN_TAG_MAX} characters each.`);
    values.tags = tags.length ? tags : null;
  }
  if (has("pinnedPostId")) {
    const raw = b.pinnedPostId;
    if (raw === null || raw === "" || raw === undefined) values.pinned_post_id = null;
    else if (/^\d{1,18}$/.test(String(raw))) values.pinned_post_id = String(raw);
    else return fail("COIN_PIN_INVALID", "Pick one of this coin's posts to pin.");
  }
  for (const [key, column] of [["shareUpdatesToFeed", "share_updates_to_feed"], ["showAutoUpdates", "show_auto_updates"]]) {
    if (!has(key)) continue;
    if (typeof b[key] !== "boolean") return fail("COIN_TOGGLE_INVALID", "Toggles must be true or false.", { field: key });
    values[column] = b[key];
  }
  if (has("sectionImages")) {
    const raw = b.sectionImages && typeof b.sectionImages === "object" ? b.sectionImages : {};
    const images = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!SECTION_KEYS.has(key)) return fail("COIN_SECTION_UNKNOWN", "Unknown story section.", { field: key });
      const url = httpsUrlOrEmpty(value);
      if (url === null) return fail("COIN_LINK_INVALID", "Story images must be https addresses.", { field: key });
      if (url) images[key] = url;
    }
    values.section_images = Object.keys(images).length ? images : null;
  }
  if (!Object.keys(values).length) return fail("COIN_PROFILE_EMPTY", "Nothing to save.");
  return { ok: true, values };
}

export function validateCoinPostInput(body) {
  const b = body && typeof body === "object" ? body : {};
  const text = String(b.body ?? "").trim();
  if (!text) return fail("COIN_POST_EMPTY", "Write something first.");
  if (text.length > COIN_POST_MAX) return fail("COIN_POST_TOO_LONG", `Posts can be at most ${COIN_POST_MAX} characters.`);
  const media = httpsUrlOrEmpty(b.mediaUrl);
  if (media === null) return fail("COIN_LINK_INVALID", "The image must be an https address.");
  const shareToFeed = b.shareToFeed === undefined ? true : b.shareToFeed === true;
  return { ok: true, values: { body: text, media_url: media || null, share_to_feed: shareToFeed } };
}

/** `banner`, `post` or `section:<story key>`; null otherwise. */
export function parseImageSlot(value) {
  const raw = String(value ?? "").trim();
  if (raw === "banner" || raw === "post") return raw;
  const m = raw.match(/^section:([a-z]+)$/);
  return m && SECTION_KEYS.has(m[1]) ? raw : null;
}

/** Storage path for an uploaded coin page image. Token is kept as given (Solana is case-sensitive). */
export function coinImagePath({ chainId, token, slot, uuid, ext }) {
  const safeSlot = String(slot).replace(":", "-");
  const safeToken = String(token).replace(/[^A-Za-z0-9]/g, "");
  return `coin-pages/${Number(chainId)}/${safeToken}/${safeSlot}-${uuid}.${ext}`;
}

/** Profile row → API shape. Unset fields come back as null / defaults. */
export function profileFromRow(row) {
  const r = row || {};
  return {
    bannerUrl: r.banner_url || null,
    bannerPositionY: r.banner_position_y == null ? null : Number(r.banner_position_y),
    bio: r.bio || null,
    founderNote: r.founder_note || null,
    websiteUrl: r.website_url || null,
    xUrl: r.x_url || null,
    telegramUrl: r.telegram_url || null,
    discordUrl: r.discord_url || null,
    tags: Array.isArray(r.tags) ? r.tags : [],
    pinnedPostId: r.pinned_post_id != null ? String(r.pinned_post_id) : null,
    shareUpdatesToFeed: r.share_updates_to_feed !== false,
    showAutoUpdates: r.show_auto_updates !== false,
    sectionImages: r.section_images && typeof r.section_images === "object" ? r.section_images : {},
    updatedAt: r.updated_at || null,
  };
}

export function postFromRow(row) {
  return {
    id: String(row.id),
    kind: "post",
    at: new Date(row.created_at).toISOString(),
    body: String(row.body || ""),
    mediaUrl: row.media_url || null,
    shareToFeed: row.share_to_feed !== false,
  };
}

/**
 * Auto updates from facts that already exist. Never stored. Newest first.
 * @param {{ launchedAt?: string|null, graduatedAt?: string|null, battles?: Array<{ id: string, at: string, won: boolean, rivalTicker?: string|null, mode?: string }> }} facts
 */
export function buildAutoUpdates(facts = {}) {
  const out = [];
  const iso = (v) => {
    const t = Date.parse(String(v ?? ""));
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  };
  const launched = iso(facts.launchedAt);
  if (launched) out.push({ id: "auto:launch", kind: "launch", at: launched, text: "Launched on MemeWarzone." });
  const graduated = iso(facts.graduatedAt);
  if (graduated) out.push({ id: "auto:graduation", kind: "graduation", at: graduated, text: "Graduated. Trading moved to the DEX pool." });
  for (const b of Array.isArray(facts.battles) ? facts.battles : []) {
    const at = iso(b.at);
    if (!at || !b.id) continue;
    const rival = b.rivalTicker ? ` $${String(b.rivalTicker).replace(/^\$/, "")}` : " its rival";
    const mode = b.mode === "vote" ? "vote battle" : "battle";
    out.push({
      id: `auto:battle:${b.id}`,
      kind: "battle",
      at,
      text: b.won ? `Won the ${mode} against${rival}.` : `Lost the ${mode} against${rival}.`,
      battleId: String(b.id),
      won: Boolean(b.won),
    });
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/**
 * True when `url` is a coin page image this API stored for this coin:
 * `<storageBase>/storage/v1/object/public/<bucket>/coin-pages/<chain>/<token>/…`.
 * Keeps banners, post images and story images from pointing at outside hosts.
 */
export function isOwnCoinImage(url, { storageBase, chainId, token }) {
  const base = String(storageBase || "").replace(/\/+$/, "");
  if (!base || !url) return false;
  const safeToken = String(token).replace(/[^A-Za-z0-9]/g, "");
  const prefix = `${base}/storage/v1/object/public/`;
  const value = String(url);
  if (!value.startsWith(prefix)) return false;
  const rest = value.slice(prefix.length);
  const slash = rest.indexOf("/");
  return slash > 0 && rest.slice(slash + 1).startsWith(`coin-pages/${Number(chainId)}/${safeToken}/`) && !rest.includes("..");
}
