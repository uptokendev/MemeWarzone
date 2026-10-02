/**
 * Battle page data (UI redesign phase 4b): live activity, top supporters and comments for one battle.
 * Pure shaping; the SQL lives in api/arenaBattleActivity.js. Spec: docs/build_plans/ui-redesign/CHANGELOG.md.
 */

export const BATTLE_COMMENT_MAX = 280;
export const BATTLE_COMMENT_RATE = Object.freeze({ count: 5, windowMinutes: 10 });
const VOTE_BUCKET_SECONDS = 600;

/** One line, collapsed whitespace, 1..280 characters. The signed message carries it verbatim. */
export function normalizeBattleComment(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return { ok: false, code: "BATTLE_COMMENT_EMPTY", error: "Write something first." };
  if (text.length > BATTLE_COMMENT_MAX) return { ok: false, code: "BATTLE_COMMENT_TOO_LONG", error: `Comments can be at most ${BATTLE_COMMENT_MAX} characters.` };
  return { ok: true, text };
}

/** Native decimals per chain (Solana lamports, EVM wei). */
export function nativeDecimals(chainId) {
  const id = Number(chainId);
  return id === 101 || id === 102 || id === 103 ? 9 : 18;
}

/** Raw integer string → decimal number for display (precision is fine for UI amounts). */
export function rawToNative(raw, decimals) {
  try {
    const value = BigInt(String(raw ?? "0").split(".")[0] || "0");
    const base = 10n ** BigInt(decimals);
    const whole = value / base;
    const frac = value % base;
    return Number(whole) + Number(frac) / Number(base);
  } catch {
    return 0;
  }
}

/**
 * Activity feed, newest first: each confirmed boost, and free votes grouped per side in 10-minute
 * windows (individual voters stay out of the feed).
 */
export function buildActivity({ boosts = [], voteBuckets = [], decimals = 18 } = {}) {
  const out = [];
  for (const b of boosts) {
    const at = new Date(b.at).toISOString();
    out.push({
      id: `boost:${b.id}`,
      kind: "boost",
      at,
      side: b.side === "right" ? "right" : "left",
      wallet: String(b.wallet || ""),
      units: Number(b.boost_units || 0),
      amountNative: rawToNative(b.gross_native_raw, decimals),
    });
  }
  for (const v of voteBuckets) {
    const at = new Date(Number(v.bucket) * VOTE_BUCKET_SECONDS * 1000 + VOTE_BUCKET_SECONDS * 1000).toISOString();
    out.push({
      id: `votes:${v.side}:${v.bucket}`,
      kind: "votes",
      at,
      side: v.side === "right" ? "right" : "left",
      count: Number(v.n || 0),
      windowMinutes: VOTE_BUCKET_SECONDS / 60,
    });
  }
  return out.filter((e) => e.kind !== "votes" || e.count > 0).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export function buildSupporters(rows = [], decimals = 18) {
  return rows.map((r, i) => ({
    rank: i + 1,
    wallet: String(r.wallet || ""),
    side: r.side === "right" ? "right" : "left",
    boosts: Number(r.boosts || 0),
    amountNative: rawToNative(r.gross_native_raw, decimals),
  }));
}

export function buildBoostSummary(rows = [], decimals = 18) {
  const sides = { left: { boosts: 0, grossNative: 0, poolNative: 0 }, right: { boosts: 0, grossNative: 0, poolNative: 0 } };
  for (const r of rows) {
    const key = r.side === "right" ? "right" : "left";
    sides[key] = {
      boosts: Number(r.boosts || 0),
      grossNative: rawToNative(r.gross_native_raw, decimals),
      poolNative: rawToNative(r.pool_native_raw, decimals),
    };
  }
  return {
    ...sides,
    total: {
      boosts: sides.left.boosts + sides.right.boosts,
      grossNative: sides.left.grossNative + sides.right.grossNative,
      poolNative: sides.left.poolNative + sides.right.poolNative,
    },
  };
}

export function commentFromRow(row) {
  return {
    id: String(row.id),
    at: new Date(row.created_at).toISOString(),
    wallet: String(row.author_wallet || ""),
    body: String(row.body || ""),
    side: row.side === "left" || row.side === "right" ? row.side : null,
  };
}
