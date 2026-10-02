/** Edit coin page form → the fields that changed (UI redesign phase 1b). Pure. */

/**
 * @typedef {{ bannerUrl: string, bannerPositionY: number, bio: string, founderNote: string, websiteUrl: string, xUrl: string,
 *   telegramUrl: string, discordUrl: string, tags: string, pinnedPostId: string,
 *   shareUpdatesToFeed: boolean, showAutoUpdates: boolean, sectionImages: Record<string, string> }} CoinProfileForm
 */

const TEXT_FIELDS = ["bannerUrl", "founderNote", "websiteUrl", "xUrl", "telegramUrl", "discordUrl"];

function tagList(value) {
  return String(value || "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

function sameImages(a, b) {
  const ka = Object.keys(a || {}).sort();
  const kb = Object.keys(b || {}).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

/**
 * Only changed fields go to the API, so a save never rewrites what the owner did not touch.
 * Imported coins never send `bio` (their description is the project details, founder D4).
 * @param {Record<string, any>} stored  profile from GET /api/coin-page
 * @param {CoinProfileForm} form
 */
export function diffCoinProfile(stored, form, { imported = false } = {}) {
  const s = stored || {};
  const out = {};
  for (const key of TEXT_FIELDS) {
    const next = String(form[key] ?? "").trim();
    if (next !== String(s[key] ?? "")) out[key] = next;
  }
  if (!imported) {
    const bio = String(form.bio ?? "").trim();
    if (bio !== String(s.bio ?? "")) out.bio = bio;
  }
  const tags = tagList(form.tags);
  if (tags.join(",") !== (Array.isArray(s.tags) ? s.tags : []).join(",")) out.tags = tags;
  const pin = String(form.pinnedPostId || "");
  if (pin !== String(s.pinnedPostId || "")) out.pinnedPostId = pin || null;
  if (Boolean(form.shareUpdatesToFeed) !== (s.shareUpdatesToFeed !== false)) out.shareUpdatesToFeed = Boolean(form.shareUpdatesToFeed);
  if (Boolean(form.showAutoUpdates) !== (s.showAutoUpdates !== false)) out.showAutoUpdates = Boolean(form.showAutoUpdates);
  if (!sameImages(form.sectionImages, s.sectionImages)) out.sectionImages = { ...(form.sectionImages || {}) };
  const position = Math.max(0, Math.min(100, Math.round(Number(form.bannerPositionY ?? 50))));
  if (position !== Math.round(Number(s.bannerPositionY ?? 50))) out.bannerPositionY = position;
  return out;
}
