import { pool } from "../server/db.js";
import { badMethod, getQuery, json, normalizeAddress, readJson } from "../server/http.js";
import { requireWalletActionAuth } from "./lib/walletActionAuth.js";
import {
  resolveTournamentVoteMatch,
  tournamentVoteSummary,
  tournamentVoteTokensEqual,
} from "./lib/arenaTournamentVoteRuntime.mjs";

function ident(value) {
  return String(value || "").trim();
}

function parseRoute(req) {
  const path = String(req.path || new URL(req.url, "http://localhost").pathname);
  const match = path.match(/^\/arena\/tournaments\/([^/]+)\/matches\/([^/]+)\/votes$/);
  if (!match) return null;
  return {
    tournamentId: decodeURIComponent(match[1]),
    matchRef: decodeURIComponent(match[2]),
  };
}

async function loadTournament(id) {
  const result = await pool.query(
    `select id, chain_id, status, bracket, battle_mode, round_duration_hours
       from public.arena_tournaments where id = $1 limit 1`,
    [id],
  );
  return result.rows[0] || null;
}

async function listMatchVotes({ tournamentId, roundNumber, matchId, battleId }) {
  const result = await pool.query(
    `select side, wallet, created_at
       from public.arena_contest_actions
      where tournament_id = $1
        and battle_id = $2
        and round_number = $3
        and coalesce(match_id, battle_id) = $4
        and phase = 'regulation'
        and action_type = 'free_vote'
      order by created_at asc`,
    [tournamentId, battleId, roundNumber, matchId],
  );
  return result.rows;
}

async function handleGet(req, res, route, tournament) {
  const resolved = resolveTournamentVoteMatch({ tournament, matchRef: route.matchRef });
  if (!resolved.ok) {
    return json(res, 409, { ok: false, error: "Tournament matchup is not open for voting.", code: "VOTE_MATCH_NOT_ACTIVE", reason: resolved.reason });
  }

  const rows = await listMatchVotes({
    tournamentId: route.tournamentId,
    roundNumber: resolved.roundNumber,
    matchId: resolved.matchId,
    battleId: resolved.battleId,
  });
  const summary = tournamentVoteSummary(rows, resolved);
  const query = getQuery(req);
  const wallet = normalizeAddress(query.walletAddress || query.wallet || "", Number(tournament.chain_id));
  let walletVote = null;
  if (wallet) {
    const found = rows.find((row) => normalizeAddress(row.wallet || "", Number(tournament.chain_id)) === wallet);
    walletVote = found?.side === "left" ? resolved.tokenA : found?.side === "right" ? resolved.tokenB : null;
  }

  return json(res, 200, {
    ok: true,
    tournamentId: route.tournamentId,
    roundNumber: resolved.roundNumber,
    matchId: resolved.matchId,
    battleId: resolved.battleId,
    phase: "regulation",
    votingLive: true,
    freeVotePoints: 1,
    boostPointsPerUsd: 2,
    summary,
    walletVote,
    updatedAt: new Date().toISOString(),
  });
}

async function handlePost(req, res, route, tournament) {
  const body = await readJson(req);
  const chainId = Number(tournament.chain_id);
  const wallet = normalizeAddress(body.walletAddress || body.auth?.walletAddress || "", chainId);
  const selectedToken = ident(body.tokenAddress || body.tokenId || body.selectedToken);
  if (!wallet || !selectedToken) {
    return json(res, 400, { ok: false, error: "walletAddress and tokenAddress are required", code: "VOTE_INPUT_REQUIRED" });
  }

  const resolved = resolveTournamentVoteMatch({ tournament, matchRef: route.matchRef, selectedToken });
  if (!resolved.ok) {
    return json(res, 409, { ok: false, error: "Tournament matchup is not open for this vote.", code: "VOTE_MATCH_NOT_ACTIVE", reason: resolved.reason });
  }

  const verified = await requireWalletActionAuth({
    res,
    pool,
    auth: body.auth || body,
    expectedWallet: wallet,
    chainId,
    action: "arena_tournament_vote",
    routeLabel: "arena/tournaments/matches/votes",
    extraLines: [
      `Tournament: ${route.tournamentId}`,
      `Round: ${resolved.roundNumber}`,
      `Match: ${resolved.matchId}`,
      "Phase: regulation",
      `Token: ${selectedToken}`,
    ],
  });
  if (!verified) return;

  const client = await pool.connect();
  try {
    await client.query("begin");
    const locked = await client.query(
      `select id, chain_id, status, bracket, battle_mode, round_duration_hours
         from public.arena_tournaments where id = $1 limit 1 for update`,
      [route.tournamentId],
    );
    const current = locked.rows[0];
    if (!current) {
      await client.query("rollback");
      return json(res, 404, { ok: false, error: "Tournament not found", code: "TOURNAMENT_NOT_FOUND" });
    }

    const currentMatch = resolveTournamentVoteMatch({ tournament: current, matchRef: route.matchRef, selectedToken });
    if (!currentMatch.ok) {
      await client.query("rollback");
      return json(res, 409, { ok: false, error: "Tournament matchup closed before the vote was recorded.", code: "VOTE_MATCH_NOT_ACTIVE", reason: currentMatch.reason });
    }

    const side = tournamentVoteTokensEqual(selectedToken, currentMatch.tokenA) ? "left" : "right";
    const inserted = await client.query(
      `insert into public.arena_contest_actions (
         chain_id, tournament_id, match_id, battle_id, round_number, phase, salvo_index,
         side, wallet, action_type, boost_units, points,
         gross_native_raw, pool_native_raw, protocol_native_raw, confirmed_at
       ) values ($1,$2,$3,$4,$5,'regulation',null,$6,$7,'free_vote',0,1,0,0,0,now())
       on conflict do nothing
       returning id, side, created_at`,
      [
        Number(current.chain_id),
        route.tournamentId,
        currentMatch.matchId,
        currentMatch.battleId,
        currentMatch.roundNumber,
        side,
        wallet,
      ],
    );

    if (!inserted.rows[0]) {
      const existing = await client.query(
        `select side from public.arena_contest_actions
          where tournament_id = $1
            and battle_id = $2
            and round_number = $3
            and coalesce(match_id, battle_id) = $4
            and phase = 'regulation'
            and action_type = 'free_vote'
            and wallet = $5
          limit 1`,
        [route.tournamentId, currentMatch.battleId, currentMatch.roundNumber, currentMatch.matchId, wallet],
      );
      await client.query("rollback");
      const existingSide = existing.rows[0]?.side;
      return json(res, 409, {
        ok: false,
        error: "This wallet already used its free vote for this matchup and round.",
        code: "TOURNAMENT_VOTE_ALREADY_USED",
        existingToken: existingSide === "left" ? currentMatch.tokenA : existingSide === "right" ? currentMatch.tokenB : null,
      });
    }

    const rows = await client.query(
      `select side from public.arena_contest_actions
        where tournament_id = $1
          and battle_id = $2
          and round_number = $3
          and coalesce(match_id, battle_id) = $4
          and phase = 'regulation'
          and action_type = 'free_vote'`,
      [route.tournamentId, currentMatch.battleId, currentMatch.roundNumber, currentMatch.matchId],
    );
    await client.query("commit");

    return json(res, 201, {
      ok: true,
      tournamentId: route.tournamentId,
      roundNumber: currentMatch.roundNumber,
      matchId: currentMatch.matchId,
      battleId: currentMatch.battleId,
      phase: "regulation",
      selectedToken,
      walletVote: selectedToken,
      pointsAdded: 1,
      summary: tournamentVoteSummary(rows.rows, currentMatch),
    });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  const route = parseRoute(req);
  if (!route) return json(res, 404, { ok: false, error: "Unknown tournament vote route" });
  const method = String(req.method || "GET").toUpperCase();
  if (!new Set(["GET", "POST"]).has(method)) return badMethod(res);

  try {
    const tournament = await loadTournament(route.tournamentId);
    if (!tournament) return json(res, 404, { ok: false, error: "Tournament not found", code: "TOURNAMENT_NOT_FOUND" });
    if (method === "GET") return handleGet(req, res, route, tournament);
    return handlePost(req, res, route, tournament);
  } catch (error) {
    console.error("[api/arenaTournamentVotes]", error);
    if (error?.code === "42P01") {
      return json(res, 503, { ok: false, error: "Tournament contest-action schema is not installed.", code: "TOURNAMENT_VOTE_SCHEMA_MISSING" });
    }
    return json(res, 503, { ok: false, error: "Tournament vote runtime is unavailable", detail: String(error?.message || error) });
  }
}
