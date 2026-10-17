import { pool } from "../server/db.js";
import { badMethod, getQuery, json, normalizeWalletFlexible, readJson } from "../server/http.js";
import { requireAdminOrOps } from "./lib/apiAuth.js";
import { requireWalletActionAuth } from "./lib/walletActionAuth.js";
import { tokenEligible } from "./lib/arenaEligibility.js";
import {
  closeChampionshipEpoch,
  finalizeMwlForChampionship,
  readChampionshipStanding,
} from "./lib/arenaQuarterlyChampionship.js";
import { currentMwlEpoch } from "./lib/arenaQuarterlyChampionshipMath.mjs";
import {
  checkinStatus,
  creditCheckin,
  creditDispatch,
  ensureActiveSeason,
} from "./lib/arenaLeagueScore.js";
import { utcDay } from "./lib/arenaLeagueScoreMath.js";
import { publicHiddenOrBlockedWhere } from "./lib/publicHiddenSql.js";
import { recordMwlFinalization } from "./lib/arenaMwlRollover.js";
import { creatorStreakStatus, hasCreatorStreaks, recordCreatorCheckin } from "./lib/creatorStreak.js";
import {
  MwlIdentityError,
  assertMwlSeasonIdentity,
  canonicalMwlMonth,
  mwlChainIdentity,
  requiredMwlChainId,
  resolveMwlTreasuryAssociation,
} from "./lib/arenaMwlChainIdentity.mjs";

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

function seasonPeriod(row) {
  return canonicalMwlMonth({ chainId: row.chain_id, year: row.year, month: row.month });
}

function validateMonthlySeason(row, chainId = row?.chain_id) {
  if (!row) return null;
  if (row.month == null) {
    throw new MwlIdentityError("MWL_MONTHLY_SEASON_REQUIRED", "Active Major War League row is not a monthly epoch", 409);
  }
  return assertMwlSeasonIdentity(row, { chainId, year: row.year, month: row.month });
}

function mapSeason(row, entries) {
  validateMonthlySeason(row, row.chain_id);
  const sorted = [...entries].sort((a, b) => b.points - a.points || b.wins - a.wins || String(a.tokenAddress).localeCompare(String(b.tokenAddress)));
  const ranked = sorted.map((entry, index) => ({ ...entry, rank: index + 1 }));
  const period = seasonPeriod(row);
  const treasury = resolveMwlTreasuryAssociation(row.chain_id);
  return {
    id: String(row.id),
    chainId: Number(row.chain_id),
    chainIdentity: mwlChainIdentity(row.chain_id),
    periodIdentity: period,
    treasuryAssociation: treasury,
    label: String(row.label || "Major War League"),
    state: STATES.includes(row.state) ? row.state : "live",
    week: Math.max(1, Number(row.week || 1)),
    month: row.month == null ? null : Math.max(1, Number(row.month)),
    quarter: Math.max(1, Number(row.quarter || 1)),
    year: Number(row.year || new Date().getUTCFullYear()),
    rewardPoolUsd: 0,
    resetAt: row.reset_at ? new Date(row.reset_at).toISOString() : futureIso(7),
    frozenAt: row.frozen_at ? new Date(row.frozen_at).toISOString() : null,
    finalizedAt: row.finalized_at ? new Date(row.finalized_at).toISOString() : null,
    regularSeasonClosed: Boolean(row.regular_season_closed),
    quarterlyChampionshipId: row.championship_epoch_id || null,
    // Historical compatibility only. New MWLs never populate this field.
    quarterFinalsTournamentId: row.quarter_finals_tournament_id || null,
    divisions: [],
    entries: ranked,
  };
}

async function activeSeason(chainId) {
  const id = requiredMwlChainId(chainId);
  const seasonResult = await pool.query(
    `select * from public.arena_league_seasons
      where active = true and chain_id = $1 and month is not null
      order by created_at desc limit 1`,
    [id],
  );
  const row = seasonResult.rows?.[0];
  if (!row) return null;
  validateMonthlySeason(row, id);
  // Hidden test coins (campaigns.meta.publicHidden) are not on the board; the MWL payout skips them
  // too (lib/arenaMwlPayouts.js), so the places shown are the places paid.
  const entries = await pool.query(
    `select e.season_id, e.token_address, e.token_name, e.symbol, e.points, e.wins, e.losses, e.finished_fights, e.checkin_streak
       from public.arena_league_entries e
      where e.season_id = $1
        and not exists (
          select 1 from public.campaigns hc
           where hc.chain_id = $2
             and (hc.token_address = e.token_address or lower(coalesce(hc.token_address::text, '')) = lower(e.token_address))
             and ${publicHiddenOrBlockedWhere("hc")}
        )`,
    [row.id, id],
  );
  return mapSeason(row, entries.rows.map(mapEntry));
}

async function seasonRowForChain(seasonId, chainId) {
  const id = requiredMwlChainId(chainId);
  const result = await pool.query(
    `select * from public.arena_league_seasons where id = $1 and chain_id = $2 and month is not null limit 1`,
    [String(seasonId || "").trim(), id],
  );
  const row = result.rows[0] || null;
  if (!row) return null;
  return validateMonthlySeason(row, id);
}

function ownedFromSeason(season, ownedRows) {
  if (!season || !Array.isArray(ownedRows) || !ownedRows.length) return [];
  const byId = new Map((season.entries || []).map((entry) => [ident(entry.tokenId || entry.tokenAddress), entry]));
  return ownedRows
    .map((row) => byId.get(ident(row.tokenId || row.tokenAddress)))
    .filter((entry) => entry && Number.isFinite(Number(entry.rank)) && Number(entry.rank) > 0);
}

async function currentChampionshipFor(chainId, season = null) {
  if (season?.quarterlyChampionshipId) {
    return readChampionshipStanding(pool, { epochId: season.quarterlyChampionshipId });
  }
  const chain = Number(chainId || season?.chainId || 0) || null;
  if (!chain) return null;
  const now = currentMwlEpoch(new Date());
  return readChampionshipStanding(pool, { chainId: chain, year: now.year, quarter: now.quarter });
}

// Finished months, newest first, from the frozen result snapshot finalization writes
// (arena_championship_mwl_results), so the page can still show a month after it rolls over.
async function finishedMonths(chainId, limit = 6) {
  const seasons = await pool.query(
    `select id, label, week, finalized_at
       from public.arena_league_seasons
      where chain_id = $1 and month is not null and finalized_at is not null
      order by year desc, month desc
      limit $2`,
    [chainId, limit],
  );
  const ids = seasons.rows.map((row) => row.id);
  if (!ids.length) return [];
  const results = await pool.query(
    `select season_id, token_address, token_name, symbol, final_rank, mwl_points, wins, losses, finished_fights
       from public.arena_championship_mwl_results
      where season_id = any($1::text[])
      order by season_id, final_rank asc`,
    [ids],
  );
  const bySeason = new Map();
  for (const row of results.rows) {
    if (!bySeason.has(row.season_id)) bySeason.set(row.season_id, []);
    bySeason.get(row.season_id).push({
      rank: Number(row.final_rank),
      tokenId: String(row.token_address),
      tokenName: String(row.token_name || row.symbol || "Unknown token"),
      symbol: String(row.symbol || "---"),
      points: Math.max(0, Number(row.mwl_points || 0)),
      wins: Math.max(0, Number(row.wins || 0)),
      losses: Math.max(0, Number(row.losses || 0)),
      finishedFights: Math.max(0, Number(row.finished_fights || 0)),
    });
  }
  return seasons.rows.map((row) => {
    const standings = bySeason.get(row.id) || [];
    return {
      seasonId: String(row.id),
      label: String(row.label || "Major War League"),
      completedAt: new Date(row.finalized_at).toISOString(),
      week: Number(row.week || 1),
      rewardPoolUsd: 0,
      topTokenName: standings[0]?.tokenName || "",
      topTokenSymbol: standings[0]?.symbol || "",
      standings,
    };
  });
}

async function feed(chainId, wallet) {
  const id = requiredMwlChainId(chainId);
  const season = await activeSeason(id);
  const owned = season && wallet ? ownedFromSeason(season, await ownedLeagueCoins(id, wallet, season.id)) : [];
  const championship = await currentChampionshipFor(id, season);
  return {
    chainIdentity: mwlChainIdentity(id),
    season,
    championship,
    history: await finishedMonths(id),
    owned,
  };
}

async function ownedCoin(chainId, wallet, token) {
  const id = requiredMwlChainId(chainId);
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
    [id, address, owner],
  );
  if (native.rows[0]) {
    const row = native.rows[0];
    return {
      chainId: id,
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
    [id, address, owner],
  );
  if (!imported.rows[0]) return null;
  const row = imported.rows[0];
  return {
    chainId: id,
    tokenAddress: ident(row.token_address),
    name: row.name || row.symbol || "Unknown",
    symbol: row.symbol || "---",
    origin: "import",
  };
}

async function ownedLeagueCoins(chainId, wallet, seasonId) {
  const id = requiredMwlChainId(chainId);
  const owner = ident(wallet);
  if (!owner || !seasonId) return [];
  const season = await seasonRowForChain(seasonId, id);
  if (!season) throw new MwlIdentityError("MWL_SEASON_CHAIN_MISMATCH", "Major War League season is not on the requested chain", 409);
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
      order by e.points desc, e.wins desc, e.token_address asc`,
    [seasonId, id, owner],
  );
  return result.rows.map(mapEntry);
}

/**
 * League check-in status that never blocks the streak: when the month's league cannot be read (for
 * example a month that ended and is not finalized yet), league points are off and the streak goes on.
 */
async function safeCheckinStatus(chainId, wallet) {
  try {
    return await checkinStatus({ chainId, wallet });
  } catch (error) {
    if (!(await hasCreatorStreaks())) throw error;
    console.warn("[arena/league/checkin] league season unavailable", error?.code || error?.message || error);
    return { utcDay: utcDay(), seasonId: null, frozen: true, due: false, alreadyCheckedIn: false, alreadyDispatched: false, streak: 0, lastDay: null };
  }
}

/**
 * Every coin this wallet can check in for (founder, 2026-10-08): coins it launched here, at any stage,
 * and imports it verified it owns. `league` marks the ones in this month's Major War League (the only
 * ones that earn league points); the rest keep the streak and its rewards.
 */
async function ownedCheckinCoins(chainId, wallet, seasonId) {
  const id = requiredMwlChainId(chainId);
  const owner = ident(wallet);
  if (!owner) return [];
  const league = seasonId ? await ownedLeagueCoins(id, owner, seasonId) : [];
  const inLeague = new Set(league.map((coin) => String(coin.tokenAddress).toLowerCase()));
  const { rows } = await pool.query(
    `select token_address, name, symbol from (
       select coalesce(c.token_address::text, c.campaign_address::text) as token_address, c.name, c.symbol,
              coalesce(c.created_at_chain, c.created_at) as at
         from public.campaigns c
        where c.chain_id = $1
          and lower(c.creator_address::text) = lower($2)
          and not (${publicHiddenOrBlockedWhere("c")})
       union all
       select i.token_address, i.name, i.symbol, i.created_at as at
         from public.arena_token_imports i
        where i.chain_id = $1 and lower(i.owner_wallet) = lower($2) and i.status = 'passed'
     ) x
     order by at desc nulls last
     limit 25`,
    [id, owner],
  );
  const others = rows
    .filter((row) => row.token_address && !inLeague.has(String(row.token_address).toLowerCase()))
    .map((row) => ({
      ...mapEntry({ token_address: row.token_address, token_name: row.name, symbol: row.symbol }),
      league: false,
    }));
  return [...league.map((coin) => ({ ...coin, league: true })), ...others];
}

/** A coin this wallet launched here (any stage) or verified as an import; null otherwise. */
async function ownedCheckinCoin(chainId, wallet, token) {
  const league = await ownedCoin(chainId, wallet, token);
  if (league) return league;
  const id = requiredMwlChainId(chainId);
  const { rows } = await pool.query(
    `select coalesce(c.token_address::text, c.campaign_address::text) as token_address, c.name, c.symbol
       from public.campaigns c
      where c.chain_id = $1
        and (lower(coalesce(c.token_address::text, '')) = lower($2) or lower(c.campaign_address::text) = lower($2))
        and lower(c.creator_address::text) = lower($3)
      limit 1`,
    [id, ident(token), ident(wallet)],
  );
  const row = rows[0];
  if (!row) return null;
  return { chainId: id, tokenAddress: ident(row.token_address), name: row.name || row.symbol || "Unknown", symbol: row.symbol || "---", origin: "native" };
}

async function handleFeed(req, res) {
  const url = new URL(req.url, "http://localhost");
  const chainId = requiredMwlChainId(url.searchParams.get("chainId"));
  const wallet = ident(url.searchParams.get("wallet") || url.searchParams.get("address"));
  return json(res, 200, await feed(chainId, wallet));
}

// Quarterly Championship routes below retain their existing implementation.
async function handleChampionshipFeed(req, res) {
  const query = getQuery(req);
  const now = currentMwlEpoch(new Date());
  const chainId = Number(query.chainId || 56);
  const year = Number(query.year || now.year);
  const quarter = Number(query.quarter || now.quarter);
  const epochId = String(query.epochId || "").trim() || null;
  const championship = await readChampionshipStanding(pool, { chainId, year, quarter, epochId });
  if (!championship) return json(res, 404, { ok: false, error: "Quarterly Championship epoch not found" });
  return json(res, 200, { ok: true, championship });
}

async function handleAdvanceWeek(req, res) {
  const admin = await requireAdminOrOps(req, res, { routeLabel: "arena/league/advance-week", allowOps: true });
  if (!admin) return;
  const body = await readJson(req).catch(() => ({}));
  const chainId = requiredMwlChainId(body.chainId);
  const seasonRow = await ensureActiveSeason(chainId);
  validateMonthlySeason(seasonRow, chainId);
  if (seasonRow.regular_season_closed || seasonRow.state === "completed") {
    return json(res, 409, { ok: false, error: "Major War League monthly epoch is already closed." });
  }
  await pool.query(
    `update public.arena_league_seasons
        set week = week + 1, reset_at = $2, updated_at = now()
      where id = $1 and chain_id = $3`,
    [seasonRow.id, futureIso(7), chainId],
  );
  return json(res, 200, { ok: true, ...(await feed(chainId)) });
}

async function handleFinalizeMwl(req, res, routeLabel = "arena/league/finalize") {
  const admin = await requireAdminOrOps(req, res, { routeLabel, allowOps: true });
  if (!admin) return;
  const body = await readJson(req).catch(() => ({}));
  const chainId = requiredMwlChainId(body.chainId);
  const explicitSeasonId = String(body.seasonId || "").trim();
  let seasonRow = null;
  if (explicitSeasonId) {
    seasonRow = await seasonRowForChain(explicitSeasonId, chainId);
    if (!seasonRow) {
      return json(res, 409, { ok: false, error: "Major War League season does not match requested chain", code: "MWL_SEASON_CHAIN_MISMATCH" });
    }
  } else {
    const active = await activeSeason(chainId);
    if (active?.id) seasonRow = await seasonRowForChain(active.id, chainId);
  }
  if (!seasonRow?.id) return json(res, 404, { ok: false, error: "Active Major War League not found" });

  const treasury = resolveMwlTreasuryAssociation(chainId);
  if (!treasury.configured) {
    return json(res, 503, { ok: false, error: "Chain-scoped Major War League Treasury is not configured", code: "MWL_TREASURY_NOT_CONFIGURED", chainId });
  }

  const result = await finalizeMwlForChampionship(pool, seasonRow.id);
  if (!result.ok) return json(res, 409, result);
  if (Number(result.chainId) !== chainId) {
    return json(res, 409, { ok: false, error: "Finalized Major War League result returned wrong chain", code: "MWL_FINALIZATION_CHAIN_MISMATCH" });
  }
  const finalizationIdentity = await recordMwlFinalization(pool, seasonRow, treasury);
  return json(res, 200, {
    ...result,
    finalizationIdentity,
    treasuryAssociation: treasury,
    legacyQuarterFinalRoute: routeLabel.includes("quarter-finals"),
    quarterFinalTournamentCreated: false,
    ...(await feed(chainId)),
  });
}

async function handleCloseChampionship(req, res) {
  const admin = await requireAdminOrOps(req, res, { routeLabel: "arena/league/championship/close", allowOps: true });
  if (!admin) return;
  const body = await readJson(req).catch(() => ({}));
  const now = currentMwlEpoch(new Date());
  const result = await closeChampionshipEpoch(pool, {
    epochId: String(body.epochId || "").trim() || null,
    chainId: Number(body.chainId || 56),
    year: Number(body.year || now.year),
    quarter: Number(body.quarter || now.quarter),
  });
  if (!result.ok) return json(res, 409, result);
  return json(res, 200, result);
}

async function handleRetryChampionshipBonus(req, res) {
  const admin = await requireAdminOrOps(req, res, { routeLabel: "arena/league/championship/apply-mwl-bonus", allowOps: true });
  if (!admin) return;
  const body = await readJson(req).catch(() => ({}));
  const seasonId = String(body.seasonId || "").trim();
  if (!seasonId) return json(res, 400, { ok: false, error: "seasonId is required" });
  // Re-running finalization is the transaction-safe retry path. It never changes
  // the frozen MWL result snapshot and cannot double-credit the Championship.
  const result = await finalizeMwlForChampionship(pool, seasonId);
  if (!result.ok) return json(res, 409, result);
  return json(res, 200, result);
}

async function handleCheckinStatus(req, res) {
  const query = getQuery(req);
  const chainId = requiredMwlChainId(query.chainId);
  const wallet = ident(query.wallet || query.address);
  const status = await safeCheckinStatus(chainId, wallet);
  if (status.seasonId && !(await seasonRowForChain(status.seasonId, chainId))) {
    throw new MwlIdentityError("MWL_SEASON_CHAIN_MISMATCH", "Check-in status resolved a different chain season", 409);
  }
  if (await hasCreatorStreaks()) {
    // Every creator checks in for the streak; league points stay with league coins (2026-10-08).
    const coins = wallet ? await ownedCheckinCoins(chainId, wallet, status.seasonId) : [];
    const streak = await creatorStreakStatus(wallet);
    return json(res, 200, {
      ok: true,
      chainIdentity: mwlChainIdentity(chainId),
      ...status,
      due: !streak.checkedInToday,
      alreadyCheckedIn: streak.checkedInToday,
      streak: streak.checkedInToday ? streak.streak : streak.nextStreak,
      // The creator streak and its rewards (lib/creatorStreak.js), kept apart from league scoring.
      creatorStreak: streak,
      coins,
    });
  }
  const coins = wallet && status.seasonId ? await ownedLeagueCoins(chainId, wallet, status.seasonId) : [];
  return json(res, 200, { ok: true, chainIdentity: mwlChainIdentity(chainId), ...status, coins });
}

async function handleCheckin(req, res) {
  const body = await readJson(req).catch(() => ({}));
  const chainId = requiredMwlChainId(body.chainId);
  const token = ident(body.tokenAddress || body.tokenId);
  const wallet = ident(body.auth?.walletAddress || body.walletAddress || body.wallet);
  if (!token || !wallet) return json(res, 400, { ok: false, error: "wallet and tokenAddress are required" });

  const streaks = await hasCreatorStreaks();
  const coin = streaks ? await ownedCheckinCoin(chainId, wallet, token) : await ownedCoin(chainId, wallet, token);
  if (!coin) return json(res, 403, { ok: false, error: "Only the coin owner can check in." });
  if (coin.chainId !== chainId) return json(res, 409, { ok: false, error: "Coin chain identity mismatch", code: "MWL_TOKEN_CHAIN_MISMATCH" });
  // League points need a league coin; the streak does not (2026-10-08).
  let leagueCoin = Boolean(await ownedCoin(chainId, wallet, token));
  if (!(await tokenEligible(pool, chainId, coin.tokenAddress))) {
    if (!streaks) return json(res, 409, { ok: false, error: "Coin is not Arena eligible." });
    leagueCoin = false;
  }

  const verified = await requireWalletActionAuth({
    res,
    pool,
    auth: body.auth || body,
    expectedWallet: wallet,
    chainId,
    action: "arena_league_checkin",
    routeLabel: "arena/league/checkin",
    extraLines: [`Chain: ${chainId}`, `Token: ${coin.tokenAddress}`, `Day: ${utcDay()}`],
  });
  if (!verified) return;

  if (streaks) {
    const streak = await recordCreatorCheckin({ wallet: verified.walletAddress || wallet, chainId, token: coin.tokenAddress });
    if (!streak.ok) return json(res, 409, streak);
    // League points as before, for a league coin only. "Fight at least once" and a closed month are
    // not errors here: the check-in still counts for the streak.
    const league = leagueCoin
      ? await creditCheckin({ chainId, wallet: verified.walletAddress || wallet, token: coin.tokenAddress, name: coin.name, symbol: coin.symbol })
          .catch((error) => {
            console.warn("[arena/league/checkin] league points skipped", error?.code || error?.message || error);
            return { ok: false };
          })
      : { ok: false };
    return json(res, 200, {
      ok: true,
      already: streak.already,
      streakDays: streak.streak,
      streakRewardEarned: streak.credit,
      points: league.ok ? league.points : 0,
      bonus: league.ok ? league.bonus : 0,
      ...(await feed(chainId).catch(() => ({}))),
      ...(await handleCheckinPayload(chainId, wallet)),
    });
  }

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
  const status = await safeCheckinStatus(chainId, wallet);
  if (status.seasonId && !(await seasonRowForChain(status.seasonId, chainId))) {
    throw new MwlIdentityError("MWL_SEASON_CHAIN_MISMATCH", "Check-in payload resolved a different chain season", 409);
  }
  if (await hasCreatorStreaks()) {
    const coins = await ownedCheckinCoins(chainId, wallet, status.seasonId);
    const streak = await creatorStreakStatus(wallet);
    return {
      ...status,
      due: !streak.checkedInToday,
      alreadyCheckedIn: streak.checkedInToday,
      streak: streak.checkedInToday ? streak.streak : streak.nextStreak,
      // The creator streak and its rewards (lib/creatorStreak.js), kept apart from league scoring.
      creatorStreak: streak,
      coins,
    };
  }
  const coins = status.seasonId ? await ownedLeagueCoins(chainId, wallet, status.seasonId) : [];
  return { ...status, coins };
}

async function handleDispatch(req, res) {
  const body = await readJson(req).catch(() => ({}));
  const chainId = requiredMwlChainId(body.chainId);
  const token = ident(body.tokenAddress || body.tokenId);
  const wallet = ident(body.auth?.walletAddress || body.walletAddress || body.wallet);
  const cardId = String(body.cardId || "").trim();
  if (!token || !wallet || !cardId) return json(res, 400, { ok: false, error: "wallet, tokenAddress, and cardId are required" });

  const coin = await ownedCoin(chainId, wallet, token);
  if (!coin) return json(res, 403, { ok: false, error: "Only the coin owner can send a War Dispatch." });
  if (coin.chainId !== chainId) return json(res, 409, { ok: false, error: "Coin chain identity mismatch", code: "MWL_TOKEN_CHAIN_MISMATCH" });

  const verified = await requireWalletActionAuth({
    res,
    pool,
    auth: body.auth || body,
    expectedWallet: wallet,
    chainId,
    action: "arena_war_dispatch",
    routeLabel: "arena/league/dispatch",
    extraLines: [`Chain: ${chainId}`, `Token: ${coin.tokenAddress}`, `Card: ${cardId}`, `Day: ${utcDay()}`],
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
    if (method === "GET" && path === "/arena/league/championship") return handleChampionshipFeed(req, res);
    if (method === "GET" && path === "/arena/league/checkin") return handleCheckinStatus(req, res);
    if (method === "POST" && path === "/arena/league/checkin") return handleCheckin(req, res);
    if (method === "POST" && path === "/arena/league/dispatch") return handleDispatch(req, res);
    if (method === "POST" && path === "/arena/league/advance-week") return handleAdvanceWeek(req, res);
    if (method === "POST" && path === "/arena/league/finalize") return handleFinalizeMwl(req, res);
    // Legacy route retained as a compatibility alias only. It no longer creates
    // a quarter-final tournament or tournament invitation roster.
    if (method === "POST" && path === "/arena/league/quarter-finals") return handleFinalizeMwl(req, res, "arena/league/quarter-finals");
    if (method === "POST" && path === "/arena/league/championship/apply-mwl-bonus") return handleRetryChampionshipBonus(req, res);
    if (method === "POST" && path === "/arena/league/championship/close") return handleCloseChampionship(req, res);
    if (method === "POST" && path === "/arena/league/rebalance-divisions") {
      return json(res, 410, { ok: false, error: "Major War League has no divisions." });
    }
    if (method === "POST" && path === "/arena/league/cycle-season-state") return handleFinalizeMwl(req, res, "arena/league/cycle-season-state");
    if (path.startsWith("/arena/league")) return badMethod(res);
    return json(res, 404, { error: `Unknown arena league route: ${path}` });
  } catch (error) {
    if (error instanceof MwlIdentityError) {
      return json(res, Number(error.status || 400), { ok: false, error: error.message, code: error.code });
    }
    console.error("[api/arenaLeague] request failed", error);
    return json(res, 503, { ok: false, error: "Arena league storage is unavailable", detail: String(error?.message || error || "unknown error") });
  }
}
