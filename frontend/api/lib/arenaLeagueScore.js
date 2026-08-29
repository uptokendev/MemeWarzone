import { pool } from "../../server/db.js";
import { normalizeWalletFlexible } from "../../server/http.js";
import {
  CHECKIN_POINTS,
  DISPATCH_POINTS,
  PAIR_WINDOW_DAYS,
  STREAK_BONUS_POINTS,
  identToken,
  mwlLedgerPlan,
  nextCheckinStreak,
  pairKey,
  seasonAcceptsRegularPoints,
  streakBonusDue,
  utcDay,
} from "./arenaLeagueScoreMath.js";

function ident(value) {
  return normalizeWalletFlexible(value) || identToken(value);
}

function currentQuarter(date = new Date()) {
  return Math.floor(date.getUTCMonth() / 3) + 1;
}

export async function ensureActiveSeason(chainId, db = pool) {
  const idNum = Number(chainId) || 56;
  const existing = await db.query(
    `select * from public.arena_league_seasons where chain_id = $1 and active = true limit 1`,
    [idNum],
  );
  if (existing.rows[0]) return existing.rows[0];

  const now = new Date();
  const year = now.getUTCFullYear();
  const quarter = currentQuarter(now);
  const id = `mwl-${year}-q${quarter}-c${idNum}`;
  const resetAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const inserted = await db.query(
    `insert into public.arena_league_seasons (
        id, chain_id, label, state, week, quarter, year, reset_at, active
      ) values ($1,$2,$3,'live',1,$4,$5,$6,true)
      on conflict (id) do update set active = true, updated_at = now()
      returning *`,
    [id, idNum, `Major War League ${year} Q${quarter}`, quarter, year, resetAt],
  );
  return inserted.rows[0];
}

export async function freezeSeason(seasonId) {
  const result = await pool.query(
    `update public.arena_league_seasons
        set frozen_at = coalesce(frozen_at, now()),
            regular_season_closed = true,
            state = 'quarter_finals',
            updated_at = now()
      where id = $1
      returning *`,
    [seasonId],
  );
  return result.rows[0] || null;
}

async function tournamentOrigin(tournamentId, db = pool) {
  if (!tournamentId) return null;
  const result = await db.query(
    `select origin from public.arena_tournaments where id = $1 limit 1`,
    [String(tournamentId)],
  );
  return result.rows[0]?.origin || null;
}

async function pairScoredRecently(seasonId, key, db = pool) {
  if (!key) return false;
  const result = await db.query(
    `select 1
       from public.arena_league_point_events
      where season_id = $1
        and pair_key = $2
        and kind in ('battle_win', 'battle_loss', 'battle_draw')
        and created_at >= now() - ($3::text || ' days')::interval
      limit 1`,
    [seasonId, key, String(PAIR_WINDOW_DAYS)],
  );
  return Boolean(result.rows[0]);
}

async function hasEntry(seasonId, token) {
  const address = ident(token);
  if (!address) return false;
  const result = await pool.query(
    `select 1 from public.arena_league_entries where season_id = $1 and token_address = $2 limit 1`,
    [seasonId, address],
  );
  return Boolean(result.rows[0]);
}

async function bumpEntry(seasonId, token, name, symbol, { points = 0, wins = 0, losses = 0, fights = 0, checkinStreak = null } = {}, db = pool) {
  const address = ident(token);
  if (!address) return;
  await db.query(
    `insert into public.arena_league_entries (
        season_id, token_address, token_name, symbol, points, wins, losses, finished_fights, checkin_streak
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      on conflict (season_id, token_address) do update set
        token_name = excluded.token_name,
        symbol = excluded.symbol,
        points = public.arena_league_entries.points + excluded.points,
        wins = public.arena_league_entries.wins + excluded.wins,
        losses = public.arena_league_entries.losses + excluded.losses,
        finished_fights = public.arena_league_entries.finished_fights + excluded.finished_fights,
        checkin_streak = coalesce($10, public.arena_league_entries.checkin_streak),
        updated_at = now()`,
    [
      seasonId,
      address,
      String(name || symbol || "Unknown"),
      String(symbol || "---"),
      points,
      wins,
      losses,
      fights,
      checkinStreak || 0,
      checkinStreak,
    ],
  );
}

async function writeEvent({ seasonId, token, kind, points, wallet = null, battleId = null, pair = null, day = null, metadata = {} }, db = pool) {
  if (!kind) return false;
  const conflict = battleId
    ? ` on conflict (season_id, battle_id, token_address, kind)
        where battle_id is not null and kind in ('battle_win', 'battle_loss', 'battle_draw')
        do nothing`
    : "";
  const result = await db.query(
    `insert into public.arena_league_point_events (
        season_id, token_address, kind, points, wallet, battle_id, pair_key, utc_day, metadata
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)${conflict}
      returning id`,
    [seasonId, ident(token), kind, points, wallet ? ident(wallet) : null, battleId || null, pair || null, day || null, metadata],
  );
  return Boolean(result.rows[0]);
}

export async function recordFinishedBattle(row, db = pool) {
  const left = ident(row?.challenger_token);
  const right = ident(row?.defender_token);
  if (!left || !right) return { scored: false, reason: "missing-tokens" };

  const season = await ensureActiveSeason(row.chain_id, db);
  const origin = await tournamentOrigin(row.tournament_id, db);
  const isQuarterFinals = origin === "quarter_finals";
  const frozen = !seasonAcceptsRegularPoints(season);
  const key = pairKey(left, right);
  const pairAlreadyScored = await pairScoredRecently(season.id, key, db);
  const mwlDraw = row.mwlDraw === true || row.mwl_draw === true;
  const plan = mwlLedgerPlan({
    mwlDraw,
    mwlWinnerToken: ident(row.mwlWinnerToken || row.mwl_winner_token),
    leftToken: left,
    rightToken: right,
    pairAlreadyScored,
    frozen,
    isQuarterFinals,
    isTournament: Boolean(row.tournament_id) && !isQuarterFinals,
  });

  if (!plan.countFight && plan.skipPoints) return { scored: false, reason: "frozen-or-qf" };

  const participants = Array.isArray(row.participants) ? row.participants : [];
  const leftPart = participants[0] || {};
  const rightPart = participants[1] || {};
  const fights = plan.countFight ? 1 : 0;

  if (plan.skipPoints) {
    await bumpEntry(season.id, left, leftPart.tokenName, leftPart.symbol, { fights }, db);
    await bumpEntry(season.id, right, rightPart.tokenName, rightPart.symbol, { fights }, db);
    return { scored: false, reason: "pair-window", countFight: true };
  }

  const leftInserted = await writeEvent({
    seasonId: season.id,
    token: left,
    kind: plan.left.kind,
    points: plan.left.points,
    battleId: row.id,
    pair: key,
    metadata: { side: "left", mwlResult: row.mwlResult || row.mwl_result || null },
  }, db);
  const rightInserted = await writeEvent({
    seasonId: season.id,
    token: right,
    kind: plan.right.kind,
    points: plan.right.points,
    battleId: row.id,
    pair: key,
    metadata: { side: "right", mwlResult: row.mwlResult || row.mwl_result || null },
  }, db);

  if (!leftInserted && !rightInserted) return { scored: false, reason: "already-scored" };

  if (leftInserted) {
    await bumpEntry(season.id, left, leftPart.tokenName, leftPart.symbol, {
      points: plan.left.points,
      wins: plan.left.wins,
      losses: plan.left.losses,
      fights,
    }, db);
  }
  if (rightInserted) {
    await bumpEntry(season.id, right, rightPart.tokenName, rightPart.symbol, {
      points: plan.right.points,
      wins: plan.right.wins,
      losses: plan.right.losses,
      fights,
    }, db);
  }
  return { scored: true, reason: "ok" };
}

export async function creditCheckin({ chainId, wallet, token, name, symbol }) {
  const season = await ensureActiveSeason(chainId);
  if (!seasonAcceptsRegularPoints(season)) {
    return { ok: false, error: "Regular season is frozen." };
  }
  const address = ident(token);
  const owner = ident(wallet);
  if (!address || !owner) return { ok: false, error: "Wallet and token are required." };
  if (!(await hasEntry(season.id, address))) {
    return { ok: false, error: "Fight at least once this quarter before check-in points land." };
  }

  const day = utcDay();
  const previous = await pool.query(
    `select utc_day::text as utc_day, streak_days
       from public.arena_creator_checkins
      where lower(wallet) = lower($1)
      order by utc_day desc
      limit 1`,
    [owner],
  );
  const last = previous.rows[0];
  if (last?.utc_day === day) {
    return { ok: false, error: "Already checked in today.", already: true, streak: Number(last.streak_days || 0) };
  }
  const streak = nextCheckinStreak(last?.utc_day, day, last?.streak_days);
  const inserted = await pool.query(
    `insert into public.arena_creator_checkins (season_id, wallet, token_address, utc_day, streak_days)
     values ($1,$2,$3,$4,$5)
     on conflict (wallet, utc_day) do nothing
     returning *`,
    [season.id, owner, address, day, streak],
  );
  if (!inserted.rows[0]) {
    return { ok: false, error: "Already checked in today.", already: true, streak };
  }

  await bumpEntry(season.id, address, name, symbol, { points: CHECKIN_POINTS, checkinStreak: streak });
  await writeEvent({
    seasonId: season.id,
    token: address,
    kind: "checkin",
    points: CHECKIN_POINTS,
    wallet: owner,
    day,
    metadata: { streak },
  });

  let bonus = 0;
  if (streakBonusDue(streak)) {
    bonus = STREAK_BONUS_POINTS;
    await bumpEntry(season.id, address, name, symbol, { points: bonus, checkinStreak: streak });
    await writeEvent({
      seasonId: season.id,
      token: address,
      kind: "streak_bonus",
      points: bonus,
      wallet: owner,
      day,
      metadata: { streak },
    });
  }

  return { ok: true, points: CHECKIN_POINTS + bonus, streak, bonus, utcDay: day };
}

export async function creditDispatch({ chainId, wallet, token, name, symbol, cardId }) {
  const season = await ensureActiveSeason(chainId);
  if (!seasonAcceptsRegularPoints(season)) {
    return { ok: false, error: "Regular season is frozen." };
  }
  const address = ident(token);
  const owner = ident(wallet);
  const card = String(cardId || "").trim();
  if (!address || !owner || !card) return { ok: false, error: "Wallet, token, and card id are required." };
  if (!(await hasEntry(season.id, address))) {
    return { ok: false, error: "Fight at least once this quarter before War Dispatch points land." };
  }

  const day = utcDay();
  const inserted = await pool.query(
    `insert into public.arena_war_dispatches (season_id, wallet, token_address, utc_day, card_id)
     values ($1,$2,$3,$4,$5)
     on conflict (wallet, utc_day) do nothing
     returning *`,
    [season.id, owner, address, day, card],
  );
  if (!inserted.rows[0]) {
    return { ok: false, error: "Already dispatched today.", already: true };
  }

  await bumpEntry(season.id, address, name, symbol, { points: DISPATCH_POINTS });
  await writeEvent({
    seasonId: season.id,
    token: address,
    kind: "dispatch",
    points: DISPATCH_POINTS,
    wallet: owner,
    day,
    metadata: { cardId: card },
  });
  return { ok: true, points: DISPATCH_POINTS, utcDay: day, cardId: card };
}

export async function checkinStatus({ chainId, wallet }) {
  const season = await ensureActiveSeason(chainId);
  const owner = ident(wallet);
  const day = utcDay();
  if (!owner) return { utcDay: day, due: false, coins: [], frozen: !seasonAcceptsRegularPoints(season) };

  const last = await pool.query(
    `select utc_day::text as utc_day, streak_days, token_address
       from public.arena_creator_checkins
      where lower(wallet) = lower($1)
      order by utc_day desc
      limit 1`,
    [owner],
  );
  const lastRow = last.rows[0];
  const already = lastRow?.utc_day === day;
  const dispatch = await pool.query(
    `select 1 from public.arena_war_dispatches where lower(wallet) = lower($1) and utc_day = $2 limit 1`,
    [owner, day],
  );

  return {
    utcDay: day,
    seasonId: season.id,
    frozen: !seasonAcceptsRegularPoints(season),
    due: !already && seasonAcceptsRegularPoints(season),
    alreadyCheckedIn: already,
    alreadyDispatched: Boolean(dispatch.rows[0]),
    streak: already ? Number(lastRow?.streak_days || 0) : nextCheckinStreak(lastRow?.utc_day, day, lastRow?.streak_days),
    lastDay: lastRow?.utc_day || null,
  };
}
