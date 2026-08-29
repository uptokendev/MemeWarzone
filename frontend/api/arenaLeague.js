import { pool } from "../server/db.js";
import { badMethod, getQuery, json, normalizeWalletFlexible, readJson } from "../server/http.js";
import { requireAdminOrOps } from "./lib/apiAuth.js";
import { requireWalletActionAuth } from "./lib/walletActionAuth.js";
import { tokenEligible } from "./lib/arenaEligibility.js";
import {
  checkinStatus,
  creditCheckin,
  creditDispatch,
  ensureActiveSeason,
  freezeSeason,
} from "./lib/arenaLeagueScore.js";
import { QF_MIN_FIGHTS, quarterFinalSeeds, utcDay } from "./lib/arenaLeagueScoreMath.js";
import { nativeSymbolFor } from "./lib/chainNative.js";

const STATES = ["live", "quarter_finals", "completed"];

function ident(value) {
  return normalizeWalletFlexible(value) || String(value || "").trim();
}

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
    finishedFights: Math.max(0, Number(row.finished_fights || 0)),
    streak: Math.max(0, Number(row.checkin_streak || 0)),
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
    frozenAt: row.frozen_at ? new Date(row.frozen_at).toISOString() : null,
    regularSeasonClosed: Boolean(row.regular_season_closed),
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
    `select season_id, token_address, token_name, symbol, points, wins, losses, finished_fights, checkin_streak
       from public.arena_league_entries where season_id = $1`,
    [row.id],
  );
  return mapSeason(row, entries.rows.map(mapEntry));
}

async function feed(chainId) {
  return { season: await activeSeason(chainId), history: [] };
}

async function ownedCoin(chainId, wallet, token) {
  const owner = ident(wallet);
  const address = ident(token);
  if (!owner || !address) return null;
  const native = await pool.query(
    `select chain_id, token_address, campaign_address, creator_address, name, symbol
       from public.campaigns
      where chain_id = $1
        and (lower(coalesce(token_address::text, '')) = lower($2) or lower(campaign_address::text) = lower($2))
        and lower(creator_address::text) = lower($3)
        and graduated_at_chain is not null
      order by created_block desc nulls last
      limit 1`,
    [chainId, address, owner],
  );
  if (native.rows[0]) {
    const row = native.rows[0];
    return {
      tokenAddress: ident(row.token_address || row.campaign_address),
      name: row.name || row.symbol || "Unknown",
      symbol: row.symbol || "---",
      origin: "native",
    };
  }
  const imported = await pool.query(
    `select token_address, name, symbol
       from public.arena_token_imports
      where chain_id = $1 and lower(token_address) = lower($2) and lower(owner_wallet) = lower($3) and status = 'passed'
      limit 1`,
    [chainId, address, owner],
  );
  if (!imported.rows[0]) return null;
  const row = imported.rows[0];
  return {
    tokenAddress: ident(row.token_address),
    name: row.name || row.symbol || "Unknown",
    symbol: row.symbol || "---",
    origin: "import",
  };
}

async function ownedLeagueCoins(chainId, wallet, seasonId) {
  const owner = ident(wallet);
  if (!owner) return [];
  const result = await pool.query(
    `select e.token_address, e.token_name, e.symbol, e.points, e.wins, e.losses, e.finished_fights
       from public.arena_league_entries e
      where e.season_id = $1
        and (
          exists (
            select 1 from public.campaigns c
             where c.chain_id = $2
               and lower(c.creator_address::text) = lower($3)
               and c.graduated_at_chain is not null
               and (
                 lower(coalesce(c.token_address::text, '')) = lower(e.token_address)
                 or lower(c.campaign_address::text) = lower(e.token_address)
               )
          )
          or exists (
            select 1 from public.arena_token_imports i
             where i.chain_id = $2
               and lower(i.owner_wallet) = lower($3)
               and i.status = 'passed'
               and lower(i.token_address) = lower(e.token_address)
          )
        )
      order by e.points desc, e.wins desc`,
    [seasonId, chainId, owner],
  );
  return result.rows.map(mapEntry);
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
  await freezeSeason(season.id);
  const frozen = await activeSeason(seasonRow.chain_id);
  const seeds = quarterFinalSeeds(frozen?.entries || season.entries);
  if (seeds.length < 2) {
    return json(res, 409, {
      ok: false,
      error: `Need at least 2 coins with ${QF_MIN_FIGHTS}+ finished fights to open Quarter Finals`,
    });
  }
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
      nativeSymbolFor(seasonRow.chain_id),
      "System tournament seeded from the frozen Major War League table.",
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
  return json(res, 200, { ok: true, tournamentId: id, seeds: seeds.map((row) => row.tokenId), ...(await feed(seasonRow.chain_id)) });
}

async function handleCheckinStatus(req, res) {
  const query = getQuery(req);
  const chainId = Number(query.chainId || 56);
  const wallet = ident(query.wallet || query.address);
  const status = await checkinStatus({ chainId, wallet });
  const coins = wallet ? await ownedLeagueCoins(chainId, wallet, status.seasonId) : [];
  return json(res, 200, { ok: true, ...status, coins });
}

async function handleCheckin(req, res) {
  const body = await readJson(req).catch(() => ({}));
  const chainId = Number(body.chainId || 56);
  const token = ident(body.tokenAddress || body.tokenId);
  const wallet = ident(body.auth?.walletAddress || body.walletAddress || body.wallet);
  if (!token || !wallet) return json(res, 400, { ok: false, error: "wallet and tokenAddress are required" });

  const coin = await ownedCoin(chainId, wallet, token);
  if (!coin) return json(res, 403, { ok: false, error: "Only the coin owner can check in." });
  if (!(await tokenEligible(pool, chainId, coin.tokenAddress))) {
    return json(res, 409, { ok: false, error: "Coin is not Arena eligible." });
  }

  const verified = await requireWalletActionAuth({
    res,
    pool,
    auth: body.auth || body,
    expectedWallet: wallet,
    chainId,
    action: "arena_league_checkin",
    routeLabel: "arena/league/checkin",
    extraLines: [`Token: ${coin.tokenAddress}`, `Day: ${utcDay()}`],
  });
  if (!verified) return;

  const result = await creditCheckin({
    chainId,
    wallet: verified.walletAddress || wallet,
    token: coin.tokenAddress,
    name: coin.name,
    symbol: coin.symbol,
  });
  if (!result.ok && !result.already) return json(res, 409, result);
  return json(res, 200, { ok: true, ...result, ...(await feed(chainId)), ...(await handleCheckinPayload(chainId, wallet)) });
}

async function handleCheckinPayload(chainId, wallet) {
  const status = await checkinStatus({ chainId, wallet });
  const coins = await ownedLeagueCoins(chainId, wallet, status.seasonId);
  return { ...status, coins };
}

async function handleDispatch(req, res) {
  const body = await readJson(req).catch(() => ({}));
  const chainId = Number(body.chainId || 56);
  const token = ident(body.tokenAddress || body.tokenId);
  const wallet = ident(body.auth?.walletAddress || body.walletAddress || body.wallet);
  const cardId = String(body.cardId || "").trim();
  if (!token || !wallet || !cardId) return json(res, 400, { ok: false, error: "wallet, tokenAddress, and cardId are required" });

  const coin = await ownedCoin(chainId, wallet, token);
  if (!coin) return json(res, 403, { ok: false, error: "Only the coin owner can send a War Dispatch." });

  const verified = await requireWalletActionAuth({
    res,
    pool,
    auth: body.auth || body,
    expectedWallet: wallet,
    chainId,
    action: "arena_war_dispatch",
    routeLabel: "arena/league/dispatch",
    extraLines: [`Token: ${coin.tokenAddress}`, `Card: ${cardId}`, `Day: ${utcDay()}`],
  });
  if (!verified) return;

  const result = await creditDispatch({
    chainId,
    wallet: verified.walletAddress || wallet,
    token: coin.tokenAddress,
    name: coin.name,
    symbol: coin.symbol,
    cardId,
  });
  if (!result.ok && !result.already) return json(res, 409, result);
  return json(res, 200, { ok: true, ...result, ...(await feed(chainId)), ...(await handleCheckinPayload(chainId, wallet)) });
}

export default async function handler(req, res) {
  const method = String(req.method || "GET").toUpperCase();
  const path = String(req.path || new URL(req.url, "http://localhost").pathname);
  try {
    if (method === "GET" && path === "/arena/league") return handleFeed(req, res);
    if (method === "GET" && path === "/arena/league/checkin") return handleCheckinStatus(req, res);
    if (method === "POST" && path === "/arena/league/checkin") return handleCheckin(req, res);
    if (method === "POST" && path === "/arena/league/dispatch") return handleDispatch(req, res);
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
