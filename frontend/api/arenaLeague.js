import { pool } from "../server/db.js";
import { badMethod, json, readJson } from "../server/http.js";
import { requireAdminOrOps } from "./lib/apiAuth.js";
import { ensureActiveSeason } from "./lib/arenaLeagueScore.js";

const STATES = ["live", "quarter_finals", "completed"];

function futureIso(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function mapEntry(row) {
  const tokenId = String(row.token_address);
  return {
    tokenId,
    tokenAddress: tokenId,
    tokenName: String(row.token_name || row.symbol || "Unknown token"),
    symbol: String(row.symbol || "---"),
    points: Math.max(0, Number(row.points || 0)),
    wins: Math.max(0, Number(row.wins || 0)),
    losses: Math.max(0, Number(row.losses || 0)),
    streak: 0,
    division: "apex",
    movement: "safe",
  };
}

function mapSeason(row, entries) {
  const sorted = [...entries].sort((a, b) => b.points - a.points || b.wins - a.wins);
  return {
    id: String(row.id),
    label: String(row.label || "Major War League"),
    state: STATES.includes(row.state) ? row.state : "live",
    week: Math.max(1, Number(row.week || 1)),
    quarter: Math.max(1, Number(row.quarter || 1)),
    year: Number(row.year || new Date().getUTCFullYear()),
    rewardPoolUsd: 0,
    resetAt: row.reset_at ? new Date(row.reset_at).toISOString() : futureIso(7),
    quarterFinalsTournamentId: row.quarter_finals_tournament_id || null,
    divisions: [],
    entries: sorted,
  };
}

async function activeSeason(chainId) {
  const params = [];
  let where = "where active = true";
  if (chainId) {
    params.push(Number(chainId));
    where += ` and chain_id = $1`;
  }
  const seasonResult = await pool.query(
    `select * from public.arena_league_seasons ${where} order by created_at desc limit 1`,
    params,
  );
  const row = seasonResult.rows?.[0];
  if (!row) return null;
  const entries = await pool.query(
    `select season_id, token_address, token_name, symbol, points, wins, losses
       from public.arena_league_entries where season_id = $1`,
    [row.id],
  );
  return mapSeason(row, entries.rows.map(mapEntry));
}

async function feed(chainId) {
  return { season: await activeSeason(chainId), history: [] };
}

async function handleFeed(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    const chainId = Number(url.searchParams.get("chainId") || 0) || null;
    return json(res, 200, await feed(chainId));
  } catch (error) {
    console.error("[api/arenaLeague] feed failed", error);
    return json(res, 200, { season: null, history: [], warning: "Arena league data is unavailable." });
  }
}

async function handleAdvanceWeek(req, res) {
  const admin = await requireAdminOrOps(req, res, { routeLabel: "arena/league/advance-week", allowOps: true });
  if (!admin) return;
  const body = await readJson(req).catch(() => ({}));
  const seasonRow = await ensureActiveSeason(Number(body.chainId || 56));
  await pool.query(
    `update public.arena_league_seasons
        set week = week + 1, reset_at = $2, updated_at = now()
      where id = $1`,
    [seasonRow.id, futureIso(7)],
  );
  return json(res, 200, { ok: true, ...(await feed(seasonRow.chain_id)) });
}

async function handleOpenQuarterFinals(req, res) {
  const admin = await requireAdminOrOps(req, res, { routeLabel: "arena/league/quarter-finals", allowOps: true });
  if (!admin) return;
  const body = await readJson(req).catch(() => ({}));
  const seasonRow = await ensureActiveSeason(Number(body.chainId || 56));
  const season = await activeSeason(seasonRow.chain_id);
  if (!season) return json(res, 404, { ok: false, error: "Active arena season not found" });
  if (season.quarterFinalsTournamentId) {
    return json(res, 200, { ok: true, tournamentId: season.quarterFinalsTournamentId, ...(await feed(seasonRow.chain_id)) });
  }
  const seeds = season.entries.slice(0, 8);
  if (seeds.length < 2) return json(res, 409, { ok: false, error: "Need at least 2 scored coins to open Quarter Finals" });
  const id = `qf-${season.id}`;
  const startsAt = futureIso(1);
  await pool.query(
    `insert into public.arena_tournaments (
        id, chain_id, name, status, origin, registration_mode, buy_in_native, native_symbol, terms, starts_at, cap, created_by
      ) values ($1,$2,$3,'upcoming','quarter_finals','invite_only',0,$4,$5,$6,$7,$8)
      on conflict (id) do nothing`,
    [
      id,
      seasonRow.chain_id,
      `${season.label} Quarter Finals`,
      Number(seasonRow.chain_id) === 101 ? "SOL" : "BNB",
      "System tournament seeded from the Major War League table.",
      startsAt,
      Math.max(2, seeds.length),
      String(admin.mode || "ops"),
    ],
  );
  for (const entry of seeds) {
    await pool.query(
      `insert into public.arena_tournament_invites (tournament_id, token_address)
       values ($1,$2)
       on conflict (tournament_id, token_address) do nothing`,
      [id, entry.tokenId],
    );
  }
  await pool.query(
    `update public.arena_league_seasons
        set state = 'quarter_finals', quarter_finals_tournament_id = $2, updated_at = now()
      where id = $1`,
    [season.id, id],
  );
  return json(res, 200, { ok: true, tournamentId: id, ...(await feed(seasonRow.chain_id)) });
}

export default async function handler(req, res) {
  const method = String(req.method || "GET").toUpperCase();
  const path = String(req.path || new URL(req.url, "http://localhost").pathname);
  try {
    if (method === "GET" && path === "/arena/league") return handleFeed(req, res);
    if (method === "POST" && path === "/arena/league/advance-week") return handleAdvanceWeek(req, res);
    if (method === "POST" && path === "/arena/league/quarter-finals") return handleOpenQuarterFinals(req, res);
    if (method === "POST" && path === "/arena/league/rebalance-divisions") {
      return json(res, 410, { ok: false, error: "Major War League has no divisions." });
    }
    if (method === "POST" && path === "/arena/league/cycle-season-state") return handleOpenQuarterFinals(req, res);
    if (path.startsWith("/arena/league")) return badMethod(res);
    return json(res, 404, { error: `Unknown arena league route: ${path}` });
  } catch (error) {
    console.error("[api/arenaLeague] request failed", error);
    return json(res, 503, { ok: false, error: "Arena league storage is unavailable", detail: String(error?.message || error || "unknown error") });
  }
}
