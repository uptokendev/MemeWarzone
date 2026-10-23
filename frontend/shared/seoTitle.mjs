// Page titles that fit: X, LinkedIn and Google cut titles at about 60 characters (founder 2026-10-23, an
// OpenGraph inspector flagged "Derpy Dave ($DERPYDAVE) price, chart and battles · MemeWarzone", 62 characters).
// Used for <title> and og:title by the API renderer and in the browser (shared/seoApplyHead.mjs). Pure module.

export const TITLE_BRAND = "MemeWarzone";
export const TITLE_MAX = 60;
const SEP = " · ";

function cut(text, max) {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  const space = head.lastIndexOf(" ");
  return `${(space > max * 0.6 ? head.slice(0, space) : head).replace(/[\s,.;:·-]+$/, "")}…`;
}

/**
 * The best title that fits in TITLE_MAX characters. `candidates` is one title or a list from longest to shortest
 * wording. Order of preference: a candidate with " · MemeWarzone", then a candidate alone, then the first one cut
 * at a word boundary. An empty title gives the brand.
 * @param {string | string[]} candidates
 */
export function fitTitle(candidates, max = TITLE_MAX) {
  const list = (Array.isArray(candidates) ? candidates : [candidates]).map((t) => String(t || "").replace(/\s+/g, " ").trim()).filter(Boolean);
  if (!list.length || list[0] === TITLE_BRAND) return TITLE_BRAND;
  for (const t of list) if (t.length + SEP.length + TITLE_BRAND.length <= max) return `${t}${SEP}${TITLE_BRAND}`;
  for (const t of list) if (t.length <= max) return t;
  return cut(list[0], max);
}
