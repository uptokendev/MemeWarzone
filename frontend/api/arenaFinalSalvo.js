import { pool } from "../server/db.js";
import { badMethod, getQuery, json, normalizeAddress, readJson } from "../server/http.js";
import { requireWalletActionAuth } from "./lib/walletActionAuth.js";
import {
  findTournamentVoteMatch,
  resolveTournamentVoteMatch,
  tournamentVoteTokensEqual,
} from "./lib/arenaTournamentVoteRuntime.mjs";

function parseRoute(req) {
  const path = String(req.path || new URL(req.url, "http://localhost").pathname);
  const match = path.match(/^\/arena\/tournaments\/([^/]+)\/matches\/([^/]+)\/final-salvo$/);
  if (!match) return null;
  return { tournamentId: decodeURIComponent(match[1]), matchRef: decodeURIComponent(match[2]) };
}

async function loadTournament(id) {
  const result = await pool.query(
    `select id, chain_id, status, bracket, battle_mode, round_duration_hours
       from public.arena_tournaments where id = $1 limit 1`,
    [id],
  );
  return result.rows[0] || null;
}

async function loadTiebreak(battleId) {
  const result = await pool.query(`select * from public.arena_vote_tiebreaks where battle_id = $1 limit 1`, [battleId]);
  return result.rows[0] || null;
}

function currentPhaseIndex(tiebreak) {
  if (!tiebreak) return { phase: null, salvoIndex: null };
  if (tiebreak.state === "salvo") return { phase: "salvo", salvoIndex: Number(tiebreak.current_salvo_index) };
  if (tiebreak.state === "sudden_death") return { phase: "sudden_death", salvoIndex: Number(tiebreak.sudden_death_round) };
  return { phase: tiebreak.state, salvoIndex: null };
}

async function currentVoteRows({ battleId, roundNumber, phase, salvoIndex }) {
  if (!phase || !salvoIndex || !["salvo", "sudden_death"].includes(phase)) return [];
  const result = await pool.query(
    `select side, wallet, created_at
       from public.arena_contest_actions
      where battle_id = $1
        and round_number = $2
        and phase = $3
        and salvo_index = $4
        and action_type = 'free_vote'
        and confirmed_at is not null
      order by created_at asc`,
    [battleId, roundNumber, phase, salvoIndex],
  );
  return result.rows || [];
}

function statePayload(tiebreak, matchup, rows = [], wallet = "") {
  const phase = currentPhaseIndex(tiebreak);
  const wallets = new Set();
  let leftUniqueVotes = 0;
  let rightUniqueVotes = 0;
  let walletVote = null;
  for (const row of rows) {
    const rowWallet = String(row.wallet || "");
    if (wallets.has(rowWallet)) continue;
    wallets.add(rowWallet);
    if (row.side === "left") leftUniqueVotes += 1;
    if (row.side === "right") rightUniqueVotes += 1;
    if (wallet && rowWallet === wallet) {
      walletVote = row.side === "left" ? matchup.tokenA : row.side === "right" ? matchup.tokenB : null;
    }
  }
  return {
    state: tiebreak?.state || "pending",
    active: ["salvo", "sudden_death"].includes(tiebreak?.state),
    phase: phase.phase,
    shotIndex: phase.salvoIndex,
    shotStartedAt: tiebreak?.shot_started_at || null,
    shotEndsAt: tiebreak?.shot_ends_at || null,
    regulation: {
      leftPoints: Number(tiebreak?.regulation_left_points || 0),
      rightPoints: Number(tiebreak?.regulation_right_points || 0),
    },
    series: {
      leftWins: Number(tiebreak?.left_salvo_points || 0),
      rightWins: Number(tiebreak?.right_salvo_points || 0),
      maxShots: 5,
    },
    currentShot: {
      leftUniqueVotes,
      rightUniqueVotes,
      walletVote,
      walletEligible: Boolean(wallet && !walletVote && ["salvo", "sudden_death"].includes(tiebreak?.state)),
    },
    suddenDeathRound: Number(tiebreak?.sudden_death_round || 0),
    winnerSide: tiebreak?.winner_side || null,
    winnerToken: tiebreak?.winner_side === "left" ? matchup.tokenA : tiebreak?.winner_side === "right" ? matchup.tokenB : null,
    shotHistory: Array.isArray(tiebreak?.shot_history) ? tiebreak.shot_history : [],
    resolvedAt: tiebreak?.resolved_at || null,
    boostAllowed: false,
  };
}

async function handleGet(req, res, route, tournament, matchup) {
  const tiebreak = await loadTiebreak(matchup.battleId);
  if (!tiebreak) {
    return json(res, 200, {
      ok: true,
      tournamentId: route.tournamentId,
      roundNumber: matchup.roundNumber,
      matchId: matchup.matchId,
      battleId: matchup.battleId,
      finalSalvo: { state: "pending", active: false, boostAllowed: false },
      updatedAt: new Date().toISOString(),
    });
  }
  const phase = currentPhaseIndex(tiebreak);
  const rows = await currentVoteRows({
    battleId: matchup.battleId,
    roundNumber: Number(tiebreak.round_number),
    phase: phase.phase,
    salvoIndex: phase.salvoIndex,
  });
  const query = getQuery(req);
  const wallet = normalizeAddress(query.walletAddress || query.wallet || "", Number(tournament.chain_id));
  res.setHeader("cache-control", "no-store");
  return json(res, 200, {
    ok: true,
    tournamentId: route.tournamentId,
    roundNumber: matchup.roundNumber,
    matchId: matchup.matchId,
    battleId: matchup.battleId,
    finalSalvo: statePayload(tiebreak, matchup, rows, wallet),
    updatedAt: new Date().toISOString(),
  });
}

async function handlePost(req, res, route, tournament, matchup) {
  const body = await readJson(req);
  const chainId = Number(tournament.chain_id);
  const wallet = normalizeAddress(body.walletAddress || body.auth?.walletAddress || "", chainId);
  const selectedToken = String(body.tokenAddress || body.tokenId || body.selectedToken || "").trim();
  if (!wallet || !selectedToken) {
    return json(res, 400, { ok: false, error: "walletAddress and tokenAddress are required", code: "SALVO_INPUT_REQUIRED" });
  }
  if (!tournamentVoteTokensEqual(selectedToken, matchup.tokenA) && !tournamentVoteTokensEqual(selectedToken, matchup.tokenB)) {
    return json(res, 409, { ok: false, error: "Selected token is not in this matchup", code: "SALVO_TOKEN_NOT_IN_MATCH" });
  }

  const preview = await loadTiebreak(matchup.battleId);
  const previewPhase = currentPhaseIndex(preview);
  if (!preview || !["salvo", "sudden_death"].includes(preview.state) || !previewPhase.salvoIndex) {
    return json(res, 409, { ok: false, error: "Final Salvo is not accepting votes", code: "FINAL_SALVO_NOT_ACTIVE" });
  }

  const verified = await requireWalletActionAuth({
    res,
    pool,
    auth: body.auth || body,
    expectedWallet: wallet,
    chainId,
    action: "arena_final_salvo_vote",
    routeLabel: "arena/tournaments/matches/final-salvo",
    extraLines: [
      `Tournament: ${route.tournamentId}`,
      `Round: ${matchup.roundNumber}`,
      `Match: ${matchup.matchId}`,
      `Phase: ${previewPhase.phase}`,
      `Shot: ${previewPhase.salvoIndex}`,
      `Token: ${selectedToken}`,
    ],
  });
  if (!verified) return;

  const side = tournamentVoteTokensEqual(selectedToken, matchup.tokenA) ? "left" : "right";
  const client = await pool.connect();
  try {
    await client.query("begin");
    const locked = await client.query(`select * from public.arena_vote_tiebreaks where battle_id = $1 for update`, [matchup.battleId]);
    const current = locked.rows[0];
    const phase = currentPhaseIndex(current);
    if (!current || !["salvo", "sudden_death"].includes(current.state) || !phase.salvoIndex) {
      await client.query("rollback");
      return json(res, 409, { ok: false, error: "Final Salvo is not accepting votes", code: "FINAL_SALVO_NOT_ACTIVE" });
    }
    const clock = await client.query(`select now() as now`);
    const dbNow = new Date(clock.rows[0]?.now).getTime();
    if (!current.shot_started_at || !current.shot_ends_at || dbNow < new Date(current.shot_started_at).getTime() || dbNow >= new Date(current.shot_ends_at).getTime()) {
      await client.query("rollback");
      return json(res, 409, { ok: false, error: "This Final Salvo shot closed before the vote was recorded", code: "FINAL_SALVO_SHOT_CLOSED" });
    }

    const inserted = await client.query(
      `insert into public.arena_contest_actions (
         chain_id, tournament_id, match_id, battle_id, round_number, phase, salvo_index,
         side, wallet, action_type, boost_units, points,
         gross_native_raw, pool_native_raw, protocol_native_raw, confirmed_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'free_vote',0,1,0,0,0,now())
       on conflict do nothing
       returning id, side, created_at`,
      [chainId, route.tournamentId, matchup.matchId, matchup.battleId, Number(current.round_number), phase.phase, phase.salvoIndex, side, wallet],
    );
    if (!inserted.rows[0]) {
      await client.query("rollback");
      return json(res, 409, {
        ok: false,
        error: "This wallet already voted in the current Final Salvo shot.",
        code: "FINAL_SALVO_VOTE_ALREADY_USED",
      });
    }

    const rows = await client.query(
      `select side, wallet, created_at
         from public.arena_contest_actions
        where battle_id = $1 and round_number = $2 and phase = $3 and salvo_index = $4
          and action_type = 'free_vote' and confirmed_at is not null
        order by created_at asc`,
      [matchup.battleId, Number(current.round_number), phase.phase, phase.salvoIndex],
    );
    await client.query("commit");
    return json(res, 201, {
      ok: true,
      tournamentId: route.tournamentId,
      roundNumber: matchup.roundNumber,
      matchId: matchup.matchId,
      battleId: matchup.battleId,
      selectedToken,
      pointsAdded: 1,
      finalSalvo: statePayload(current, matchup, rows.rows, wallet),
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
  if (!route) return json(res, 404, { ok: false, error: "Unknown Final Salvo route" });
  const method = String(req.method || "GET").toUpperCase();
  if (!new Set(["GET", "POST"]).has(method)) return badMethod(res);

  try {
    const tournament = await loadTournament(route.tournamentId);
    if (!tournament) return json(res, 404, { ok: false, error: "Tournament not found", code: "TOURNAMENT_NOT_FOUND" });
    if (tournament.battle_mode !== "vote" || Number(tournament.round_duration_hours) !== 24) {
      return json(res, 409, { ok: false, error: "Final Salvo requires a Vote Tournament", code: "FINAL_SALVO_TOURNAMENT_INACTIVE" });
    }

    if (method === "GET") {
      const historical = findTournamentVoteMatch({ tournament, matchRef: route.matchRef });
      if (!historical.ok || !historical.battleId) {
        return json(res, 404, { ok: false, error: "Tournament matchup not found", code: "FINAL_SALVO_MATCH_NOT_FOUND", reason: historical.reason });
      }
      return handleGet(req, res, route, tournament, historical);
    }

    if (tournament.status !== "live") {
      return json(res, 409, { ok: false, error: "Final Salvo voting is closed", code: "FINAL_SALVO_TOURNAMENT_INACTIVE" });
    }
    const matchup = resolveTournamentVoteMatch({ tournament, matchRef: route.matchRef });
    if (!matchup.ok || !matchup.battleId) {
      return json(res, 409, { ok: false, error: "Tournament matchup is not active", code: "FINAL_SALVO_MATCH_INACTIVE", reason: matchup.reason });
    }
    return handlePost(req, res, route, tournament, matchup);
  } catch (error) {
    console.error("[api/arenaFinalSalvo]", error);
    return json(res, 503, { ok: false, error: "Final Salvo runtime is unavailable", detail: String(error?.message || error) });
  }
}
