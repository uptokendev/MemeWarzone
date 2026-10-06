import { pool } from "../../server/db.js";

/**
 * Usernames (founder, 2026-10-02): one unique @username per wallet across all chains, for @tags in
 * posts. Table public.user_handles (db/migrations/20261002_000007_user_handles.sql). Every read here
 * tolerates the table not existing yet (production before the migration): no usernames, no errors.
 */
export const HANDLE_RE = /^[A-Za-z0-9_]{3,20}$/;
export const HANDLE_CHANGE_COOLDOWN_DAYS = 30;

const RESERVED = new Set([
  "admin", "administrator", "mod", "moderator", "support", "help", "team", "staff", "official",
  "memewarzone", "memewar", "mwz", "warzone", "system", "root", "null", "undefined", "anonymous",
  "everyone", "here", "all", "you", "me", "profile", "settings", "command", "api", "status",
]);

export function missingHandlesTable(e) {
  return e?.code === "42P01";
}

/** The wallet as the feed stores it: EVM lowercased, Solana base58 as-is. */
export function walletKey(raw) {
  const s = String(raw || "").trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return s.toLowerCase();
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return s;
  return "";
}

/** @returns {"" | "format" | "reserved"} */
export function handleProblem(handle) {
  const h = String(handle || "");
  if (!HANDLE_RE.test(h)) return "format";
  if (RESERVED.has(h.toLowerCase())) return "reserved";
  return "";
}

/** wallet_key -> handle for the given wallets. Empty map when the table is missing. */
export async function loadHandlesFor(wallets) {
  const keys = [...new Set((wallets || []).map(walletKey).filter(Boolean))];
  const out = new Map();
  if (!keys.length || !pool) return out;
  try {
    const { rows } = await pool.query(
      `select wallet_key, handle from public.user_handles where wallet_key = any($1::text[])`,
      [keys],
    );
    for (const r of rows) out.set(r.wallet_key, r.handle);
  } catch (e) {
    if (!missingHandlesTable(e)) throw e;
  }
  return out;
}

/** Adds authorHandle / repostedByHandle / quoted.authorHandle to feed items (mapped post rows). */
export async function attachHandles(items) {
  const list = Array.isArray(items) ? items : [];
  const wallets = [];
  for (const it of list) {
    if (!it || typeof it !== "object") continue;
    wallets.push(it.wallet, it.repostedByWallet, it.quoted?.wallet);
  }
  const map = await loadHandlesFor(wallets.filter(Boolean));
  if (!map.size) return list;
  const pick = (w) => (w ? map.get(walletKey(w)) || null : null);
  return list.map((it) => {
    if (!it || typeof it !== "object") return it;
    const next = { ...it };
    const a = pick(it.wallet);
    if (a) next.authorHandle = a;
    const r = pick(it.repostedByWallet);
    if (r) next.repostedByHandle = r;
    if (it.quoted && typeof it.quoted === "object") {
      const q = pick(it.quoted.wallet);
      if (q) next.quoted = { ...it.quoted, authorHandle: q };
    }
    return next;
  });
}

export function shortWallet(wallet) {
  const w = String(wallet || "");
  return w.length > 10 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w;
}

/**
 * wallet_key -> how to name that wallet in a notification: @username, else the profile display name
 * (profiles are chain-scoped, so the row that has a name wins), else the short wallet.
 */
export async function loadActorLabels(wallets, { db = pool } = {}) {
  const keys = [...new Set((wallets || []).map(walletKey).filter(Boolean))];
  const out = new Map();
  if (!keys.length) return out;
  const handles = await loadHandlesFor(keys).catch(() => new Map());
  const names = new Map();
  const needNames = keys.filter((k) => !handles.get(k));
  if (needNames.length && db) {
    try {
      const { rows } = await db.query(
        `select distinct on (lower(address)) lower(address) as address_key, btrim(display_name) as display_name
           from public.user_profiles
          where lower(address) = any($1::text[])
            and display_name is not null and length(btrim(display_name)) > 0
          order by lower(address), updated_at desc nulls last`,
        [needNames.map((k) => k.toLowerCase())],
      );
      for (const r of rows) names.set(r.address_key, String(r.display_name).slice(0, 40));
    } catch {
      // No profile names: fall back to the short wallet.
    }
  }
  for (const k of keys) {
    const handle = handles.get(k);
    out.set(k, handle ? `@${handle}` : names.get(k.toLowerCase()) || shortWallet(k));
  }
  return out;
}
