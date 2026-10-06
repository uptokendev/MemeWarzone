import { DBC_FIRST_BUY_MAX_BPS, DBC_FIRST_BUY_PARTNER_MAX_BPS } from "../../../shared/dbcEconomics.mjs";

function bpsSetting(raw, fallback) {
  const n = Number(String(raw ?? "").trim());
  return Number.isInteger(n) && n > 0 && n <= 10_000 ? n : fallback;
}

/**
 * The two numbers founders may still change without a release (2026-10-06: "the numbers are up for
 * debate"): the default every creator gets and the ceiling a listed wallet can reach. API env
 * DBC_FIRST_BUY_DEFAULT_BPS / DBC_FIRST_BUY_PARTNER_MAX_BPS, else the shared constants (20% / 50%).
 * The ceiling is never below the default.
 */
export function firstBuyCapSettings(env = process.env) {
  const defaultBps = bpsSetting(env.DBC_FIRST_BUY_DEFAULT_BPS, DBC_FIRST_BUY_MAX_BPS);
  const ceilingBps = Math.max(defaultBps, bpsSetting(env.DBC_FIRST_BUY_PARTNER_MAX_BPS, DBC_FIRST_BUY_PARTNER_MAX_BPS));
  return { defaultBps, ceilingBps };
}

/**
 * The first-buy cap (bps of supply) for this creator: the default, or the cap a row in
 * public.creator_first_buy_caps grants this wallet (its own max_bps, so each partner can get a
 * different share), never above the ceiling and never below the default. A missing table
 * (migration not applied yet) or a failed read falls back to the default, never to a higher cap.
 */
export async function loadCreatorFirstBuyCapBps(db, creatorWallet, { chainId = 101, env = process.env } = {}) {
  const { defaultBps, ceilingBps } = firstBuyCapSettings(env);
  const wallet = String(creatorWallet || "").trim();
  if (!wallet || !db) return defaultBps;
  try {
    const found = await db.query(
      `select max_bps from public.creator_first_buy_caps where chain_id = $1 and wallet = $2 limit 1`,
      [Number(chainId), wallet],
    );
    const granted = Number(found.rows?.[0]?.max_bps);
    if (!Number.isFinite(granted) || granted <= defaultBps) return defaultBps;
    return Math.min(granted, ceilingBps);
  } catch (error) {
    if (String(error?.code || "") !== "42P01") {
      console.warn("[dbc] creator first-buy cap lookup failed; using the default", error?.message || error);
    }
    return defaultBps;
  }
}

export function firstBuyCapCopy(capBps) {
  return `The first buy cannot be more than ${Number(capBps) / 100}% of supply.`;
}
