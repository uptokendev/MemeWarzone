/** Coin page tab memory (UI redesign phase 1). Pure. */

// The old page had Overview / Trades / Community; map a remembered choice onto the new tabs.
const LEGACY = { overview: "about", comments: "posts", trades: "trades" };

/** The tab to open: the stored one when it exists, else its legacy mapping, else the first. */
export function pickCoinTab(stored, available) {
  const list = Array.isArray(available) ? available : [];
  if (!list.length) return "";
  const raw = String(stored || "");
  if (list.includes(raw)) return raw;
  const mapped = LEGACY[raw];
  if (mapped && list.includes(mapped)) return mapped;
  return list[0];
}
