import { pool } from "../../server/db.js";

/**
 * Creator check-in streaks and free upvotes (founder, 2026-10-08). Any coin creator or verified import
 * owner checks in once per UTC day; the streak is a badge on the coin and profile, and every 7th day in
 * a row earns one free upvote credit. League points are separate (arenaLeagueScore.creditCheckin).
 * Every reader checks once whether the tables exist, so the app keeps working before the migration.
 */

export const STREAK_CREDIT_EVERY_DAYS = 7;
/** votes.asset_address of a vote paid with a credit: upvote revenue reads only the native asset. */
export const STREAK_CREDIT_ASSET = "streak_credit";

let ready = null;
export function hasCreatorStreaks(db = pool) {
  if (!ready) {
    ready = db
      .query(`select to_regclass('public.creator_checkins') is not null and to_regclass('public.upvote_credits') is not null as ok`)
      .then((r) => Boolean(r.rows[0]?.ok))
      .catch(() => false);
    ready.then((ok) => {
      if (!ok) setTimeout(() => { ready = null; }, 60_000).unref?.();
    });
  }
  return ready;
}

/** Solana keeps its case, EVM is lowercase; "" when not a wallet. */
export function streakWalletKey(value) {
  const raw = String(value || "").trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(raw)) return raw.toLowerCase();
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw)) return raw;
  return "";
}

export function utcDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function previousDay(day) {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/** The streak a wallet would have after checking in on `day`, from its last check-in. */
export function nextStreak(lastDay, lastStreak, day) {
  if (!lastDay) return 1;
  if (lastDay === day) return Math.max(1, Number(lastStreak || 1));
  return lastDay === previousDay(day) ? Number(lastStreak || 0) + 1 : 1;
}

/** A streak counts as alive until a full UTC day is missed. */
export function liveStreak(lastDay, lastStreak, day = utcDay()) {
  if (!lastDay) return 0;
  return lastDay === day || lastDay === previousDay(day) ? Number(lastStreak || 0) : 0;
}

async function lastCheckin(db, wallet) {
  const { rows } = await db.query(
    `select utc_day::text as utc_day, streak_days from public.creator_checkins
      where lower(wallet) = lower($1) order by utc_day desc limit 1`,
    [wallet],
  );
  return rows[0] || null;
}

/** Today's state for one wallet: streak, whether it checked in, open credits. */
export async function creatorStreakStatus(walletInput, { db = pool, now = new Date() } = {}) {
  const wallet = streakWalletKey(walletInput);
  const day = utcDay(now);
  const empty = { supported: false, utcDay: day, streak: 0, checkedInToday: false, nextStreak: 1, freeUpvotes: 0, daysToFreeUpvote: STREAK_CREDIT_EVERY_DAYS };
  if (!wallet || !(await hasCreatorStreaks(db))) return empty;
  const last = await lastCheckin(db, wallet);
  const credits = await db.query(`select count(*)::int as n from public.upvote_credits where lower(wallet) = lower($1) and used_at is null`, [wallet]);
  const checkedInToday = last?.utc_day === day;
  const streak = liveStreak(last?.utc_day, last?.streak_days, day);
  const next = checkedInToday ? streak : nextStreak(last?.utc_day, last?.streak_days, day);
  const sinceCredit = (checkedInToday ? streak : next - 1) % STREAK_CREDIT_EVERY_DAYS;
  return {
    supported: true,
    utcDay: day,
    streak,
    checkedInToday,
    nextStreak: next,
    freeUpvotes: Number(credits.rows[0]?.n || 0),
    daysToFreeUpvote: STREAK_CREDIT_EVERY_DAYS - sinceCredit,
  };
}

/**
 * Records today's check-in for a wallet (one per UTC day) and, on every 7th day in a row, one free
 * upvote credit. Returns { ok, already, streak, credit }. The caller has verified the wallet owns the coin.
 */
export async function recordCreatorCheckin({ wallet: walletInput, chainId, token, db = pool, now = new Date() }) {
  const wallet = streakWalletKey(walletInput);
  if (!wallet) return { ok: false, error: "Wallet is required." };
  if (!(await hasCreatorStreaks(db))) return { ok: false, error: "Check-in streaks are not available yet.", code: "STREAKS_UNAVAILABLE" };
  const day = utcDay(now);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // One check-in at a time per wallet, so two taps cannot both count.
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`creator_checkin:${wallet.toLowerCase()}`]);
    const last = await lastCheckin(client, wallet);
    if (last?.utc_day === day) {
      await client.query("ROLLBACK");
      return { ok: true, already: true, streak: Number(last.streak_days || 1), credit: false };
    }
    const streak = nextStreak(last?.utc_day, last?.streak_days, day);
    await client.query(
      `insert into public.creator_checkins (wallet, utc_day, streak_days, chain_id, token_address) values ($1, $2, $3, $4, $5)`,
      [wallet, day, streak, Number(chainId) || null, token || null],
    );
    let credit = false;
    if (streak % STREAK_CREDIT_EVERY_DAYS === 0) {
      const inserted = await client.query(
        `insert into public.upvote_credits (wallet, earned_day, streak_days) values ($1, $2, $3)
         on conflict (wallet, earned_day) do nothing returning id`,
        [wallet, day, streak],
      );
      credit = Boolean(inserted.rows[0]);
    }
    await client.query("COMMIT");
    return { ok: true, already: false, streak, credit };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Live streaks for several wallets (badge): Map(walletKey -> days), only wallets with a live streak. */
export async function liveStreaks(wallets, { db = pool, now = new Date() } = {}) {
  const out = new Map();
  const keys = Array.from(new Set((wallets || []).map(streakWalletKey).filter(Boolean))).slice(0, 200);
  if (!keys.length || !(await hasCreatorStreaks(db))) return out;
  const day = utcDay(now);
  const { rows } = await db.query(
    `select distinct on (lower(wallet)) wallet, utc_day::text as utc_day, streak_days
       from public.creator_checkins
      where lower(wallet) = any($1::text[]) and utc_day >= ($2::date - 1)
      order by lower(wallet), utc_day desc`,
    [keys.map((k) => k.toLowerCase()), day],
  );
  const byLower = new Map(keys.map((k) => [k.toLowerCase(), k]));
  for (const row of rows) {
    const days = liveStreak(row.utc_day, row.streak_days, day);
    const key = byLower.get(String(row.wallet).toLowerCase());
    if (key && days > 0) out.set(key, days);
  }
  return out;
}

/**
 * Spends one free upvote credit on a coin: the oldest open credit becomes a confirmed vote (amount 0,
 * asset 'streak_credit'). Locked per wallet so one credit is never spent twice. Returns
 * { ok, voteId, left } or { ok: false, code }.
 */
export async function spendUpvoteCredit({ wallet: walletInput, chainId, campaign, db = pool, now = new Date() }) {
  const wallet = streakWalletKey(walletInput);
  if (!wallet || !campaign || !Number(chainId)) return { ok: false, code: "BAD_REQUEST", error: "wallet, chainId and campaign are required" };
  if (!(await hasCreatorStreaks(db))) return { ok: false, code: "STREAKS_UNAVAILABLE", error: "Free upvotes are not available yet." };
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const credit = await client.query(
      `select id from public.upvote_credits
        where lower(wallet) = lower($1) and used_at is null
        order by earned_day asc, id asc
        limit 1
        for update skip locked`,
      [wallet],
    );
    const id = credit.rows[0]?.id;
    if (!id) {
      await client.query("ROLLBACK");
      return { ok: false, code: "NO_CREDIT", error: "No free upvotes left. A 7-day check-in streak earns one." };
    }
    const vote = await client.query(
      `insert into public.votes (chain_id, campaign_address, voter_address, asset_address, amount_raw, tx_hash, log_index, block_number, block_timestamp, meta, status)
       values ($1, $2, $3, $4, 0, $5, 0, 0, $6, 'streak_credit', 'confirmed')
       returning id`,
      [Number(chainId), campaign, wallet, STREAK_CREDIT_ASSET, `streak-credit:${id}`, now.toISOString()],
    );
    await client.query(
      `update public.upvote_credits set used_at = $2, used_chain_id = $3, used_campaign = $4, vote_id = $5 where id = $1`,
      [id, now.toISOString(), Number(chainId), campaign, vote.rows[0].id],
    );
    const left = await client.query(`select count(*)::int as n from public.upvote_credits where lower(wallet) = lower($1) and used_at is null`, [wallet]);
    await client.query("COMMIT");
    return { ok: true, voteId: Number(vote.rows[0].id), left: Number(left.rows[0]?.n || 0) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
