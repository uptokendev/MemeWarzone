import { pool } from "../server/db.js";
import { badMethod, getQuery, json, normalizeAddress, readJson } from "../server/http.js";
import { requireWalletActionAuth } from "./lib/walletActionAuth.js";
import {
  findTournamentVoteMatch,
  resolveTournamentVoteMatch,
  tournamentVoteTokensEqual,
} from "./lib/arenaTournamentVoteRuntime.mjs";
import {
  finalSalvoEnvironmentIdentity,
  finalSalvoIdentityMatches,
  requiredFinalSalvoChainId,
} from "./lib/arenaFinalSalvoRuntime.mjs";
import {
  ensureFinalSalvo,
  finalizeExpiredFinalSalvoShot,
} from "./lib/arenaFinalSalvoFinalizer.js";

function parseRoute(req) {
  const path = String(req.path || new URL(req.url, "http://localhost").pathname);
  const match = path.match(/^\/arena\/tournaments\/([^/]+)\/matches\/([^/]+)\/final-salvo$/);
  if (!match) return null;
  return { tournamentId: decodeURIComponent(match[1]), matchRef: decodeURIComponent(match[2]) };
}

function requestedChainId(req, body = null) {
  const query = getQuery(req);
  const value = body?.chainId ?? body?.chain_id ?? body?.auth?.chainId ?? body?.auth?.chain_id ?? query.chainId ?? query.chain_id;
  return requiredFinalSalvoChainId(value);
}

function requestedEnvironment(req, body = null) {
  const query = getQuery(req);
  const source = body == null ? query : { ...(body || {}), ...(body?.auth || {}) };
  return {
    environment: source?.environment ?? source?.runtimeEnvironment ?? source?.runtime_environment ?? null,
    solanaCluster: source?.solanaCluster ?? source?.solana_cluster ?? source?.cluster ?? null,
  };
}

function assertTournamentEnvironment(tournament, chainId, requested) {
  const rowIdentity = finalSalvoEnvironmentIdentity(chainId, {
    environment: tournament?.environment,
    solanaCluster: tournament?.solana_cluster,
  });
  if (chainId === 101 && !requested?.environment && !requested?.solanaCluster) {
    throw Object.assign(new Error("Solana Final Salvo requires devnet or mainnet-beta identity"), { code: "FINAL_SALVO_ENVIRONMENT_REQUIRED" });
  }
  const requestIdentity = finalSalvoEnvironmentIdentity(chainId, requested || {});
  if (
    rowIdentity.environment !== requestIdentity.environment ||
    rowIdentity.solanaCluster !== requestIdentity.solanaCluster
  ) {
    throw Object.assign(new Error("Final Salvo tournament environment mismatch"), { code: "FINAL_SALVO_ENVIRONMENT_MISMATCH" });
  }
  return rowIdentity;
}

async function loadTournament(id, chainId) {
  const result = await pool.query(
    `select id, chain_id, status, bracket, battle_mode, round_duration_hours, environment, solana_cluster
       from public.arena_tournaments where id = $1 and chain_id = $2 limit 1`,
    [id, chainId],
  );
  return result.rows[0] || null;
}

async function loadTiebreak(identity) {
  const result = await pool.query(
    `select * from public.arena_vote_tiebreaks
      where battle_id=$1 and chain_id=$2 and tournament_id=$3 and round_number=$4 and match_id=$5
      limit 1`,
    [identity.battleId, identity.chainId, identity.tournamentId, identity.roundNumber, identity.matchId],
  );
  return result.rows[0] || null;
}

function currentPhaseIndex(tiebreak) {
  if (!tiebreak) return { phase: null, salvoIndex: null };
  if (tiebreak.state === "salvo") return { phase: "salvo", salvoIndex: Number(tiebreak.current_salvo_index) };
  if (tiebreak.state === "sudden_death") return { phase: "sudden_death", salvoIndex: Number(tiebreak.sudden_death_round) };
  return { phase: tiebreak.state, salvoIndex: null };
}

async function currentVoteRows(identity, phase, salvoIndex) {
  if (!phase || !salvoIndex || !["salvo", "sudden_death"].includes(phase)) return [];
  const result = await pool.query(
    `select side, wallet, created_at
       from public.arena_contest_actions
      where chain_id=$1 and tournament_id=$2 and battle_id=$3 and round_number=$4
        and coalesce(match_id,battle_id)=$5 and phase=$6 and salvo_index=$7
        and action_type='free_vote' and confirmed_at is not null
      order by created_at asc`,
    [identity.chainId, identity.tournamentId, identity.battleId, identity.roundNumber, identity.matchId, phase, salvoIndex],
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
    if (wallet && rowWallet === wallet) walletVote = row.side === "left" ? matchup.tokenA : row.side === "right" ? matchup.tokenB : null;
  }
  return {
    state: tiebreak?.state || "pending",
    active: ["salvo", "sudden_death"].includes(tiebreak?.state),
    phase: phase.phase,
    shotIndex: phase.salvoIndex,
    shotStartedAt: tiebreak?.shot_started_at || null,
    shotEndsAt: tiebreak?.shot_ends_at || null,
    shotSeconds: 60,
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
    winnerToken: tiebreak?.winner_token_address || null,
    shotHistory: Array.isArray(tiebreak?.shot_history) ? tiebreak.shot_history : [],
    resolvedAt: tiebreak?.resolved_at || null,
    boostAllowed: false,
    marketMetricsAllowed: false,
  };
}

function identityFor(route, tournament, matchup, chainId) {
  return {
    chainId,
    tournamentId: route.tournamentId,
    matchId: matchup.matchId,
    battleId: matchup.battleId,
    roundNumber: matchup.roundNumber,
  };
}

async function settleLifecycle(identity) {
  const started = await ensureFinalSalvo(pool, identity);
  if (!started.ok) return started;
  const finalized = await finalizeExpiredFinalSalvoShot(pool, identity);
  return finalized.ok ? finalized : finalized;
}

async function handleGet(req, res, route, tournament, matchup, chainId) {
  const identity = identityFor(route, tournament, matchup, chainId);
  const lifecycle = await settleLifecycle(identity);
  if (!lifecycle.ok && !["FINAL_SALVO_REGULATION_ACTIVE", "FINAL_SALVO_REGULATION_NOT_TIED"].includes(lifecycle.code)) {
    return json(res, 409, { ok: false, error: "Final Salvo identity rejected", code: lifecycle.code });
  }
  const tiebreak = lifecycle.ok ? await loadTiebreak(identity) : null;
  if (!tiebreak) {
    return json(res, 200, {
      ok: true,
      chainId,
      tournamentId: route.tournamentId,
      roundNumber: matchup.roundNumber,
      matchId: matchup.matchId,
      battleId: matchup.battleId,
      finalSalvo: {
        state: "pending",
        active: false,
        entryCode: lifecycle.code,
        boostAllowed: false,
        marketMetricsAllowed: false,
      },
      updatedAt: new Date().toISOString(),
    });
  }
  const phase = currentPhaseIndex(tiebreak);
  const rows = await currentVoteRows(identity, phase.phase, phase.salvoIndex);
  const query = getQuery(req);
  const wallet = normalizeAddress(query.walletAddress || query.wallet || "", chainId);
  res.setHeader("cache-control", "no-store");
  return json(res, 200, {
    ok: true,
    chainId,
    tournamentId: route.tournamentId,
    roundNumber: matchup.roundNumber,
    matchId: matchup.matchId,
    battleId: matchup.battleId,
    finalSalvo: statePayload(tiebreak, matchup, rows, wallet),
    updatedAt: new Date().toISOString(),
  });
}

async function handlePost(req, res, route, tournament, matchup, chainId, body) {
  const identity = identityFor(route, tournament, matchup, chainId);
  const lifecycle = await settleLifecycle(identity);
  if (!lifecycle.ok) {
    return json(res, 409, { ok: false, error: "Final Salvo is not available for this matchup", code: lifecycle.code });
  }

  const wallet = normalizeAddress(body.walletAddress || body.auth?.walletAddress || "", chainId);
  const selectedToken = String(body.tokenAddress || body.tokenId || body.selectedToken || "").trim();
  if (!wallet || !selectedToken) return json(res, 400, { ok: false, error: "walletAddress and tokenAddress are required", code: "SALVO_INPUT_REQUIRED" });
  if (!tournamentVoteTokensEqual(selectedToken, matchup.tokenA) && !tournamentVoteTokensEqual(selectedToken, matchup.tokenB)) {
    return json(res, 409, { ok: false, error: "Selected token is not in this matchup", code: "SALVO_TOKEN_NOT_IN_MATCH" });
  }

  const preview = await loadTiebreak(identity);
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
    const current = (await client.query(`select * from public.arena_vote_tiebreaks where battle_id=$1 for update`, [matchup.battleId])).rows[0];
    const phase = currentPhaseIndex(current);
    if (!current || !finalSalvoIdentityMatches(current, identity)) {
      await client.query("rollback");
      return json(res, 409, { ok: false, error: "Final Salvo identity changed", code: "FINAL_SALVO_IDENTITY_MISMATCH" });
    }
    if (!["salvo", "sudden_death"].includes(current.state) || !phase.salvoIndex) {
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
         chain_id,tournament_id,match_id,battle_id,round_number,phase,salvo_index,
         side,wallet,action_type,boost_units,points,gross_native_raw,pool_native_raw,protocol_native_raw,confirmed_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'free_vote',0,1,0,0,0,now())
       on conflict do nothing returning id,side,created_at`,
      [chainId, route.tournamentId, matchup.matchId, matchup.battleId, Number(current.round_number), phase.phase, phase.salvoIndex, side, wallet],
    );
    if (!inserted.rows[0]) {
      await client.query("rollback");
      return json(res, 409, { ok: false, error: "This wallet already voted in the current Final Salvo shot.", code: "FINAL_SALVO_VOTE_ALREADY_USED" });
    }

    const rows = await client.query(
      `select side,wallet,created_at from public.arena_contest_actions
        where chain_id=$1 and tournament_id=$2 and battle_id=$3 and round_number=$4
          and coalesce(match_id,battle_id)=$5 and phase=$6 and salvo_index=$7
          and action_type='free_vote' and confirmed_at is not null order by created_at asc`,
      [chainId, route.tournamentId, matchup.battleId, Number(current.round_number), matchup.matchId, phase.phase, phase.salvoIndex],
    );
    await client.query("commit");
    return json(res, 201, {
      ok: true,
      chainId,
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
    const body = method === "POST" ? await readJson(req) : null;
    const chainId = requestedChainId(req, body);
    const tournament = await loadTournament(route.tournamentId, chainId);
    if (!tournament) return json(res, 404, { ok: false, error: "Tournament not found on requested chain", code: "TOURNAMENT_CHAIN_MISMATCH" });
    assertTournamentEnvironment(tournament, chainId, requestedEnvironment(req, body));
    const roundHours = Number(tournament.round_duration_hours);
    if (tournament.battle_mode !== "vote" || !Number.isInteger(roundHours) || roundHours < 1) {
      return json(res, 409, { ok: false, error: "Final Salvo requires a Vote Tournament", code: "FINAL_SALVO_TOURNAMENT_INACTIVE" });
    }

    if (method === "GET") {
      const historical = findTournamentVoteMatch({ tournament, matchRef: route.matchRef });
      if (!historical.ok || !historical.battleId) {
        return json(res, 404, { ok: false, error: "Tournament matchup not found", code: "FINAL_SALVO_MATCH_NOT_FOUND", reason: historical.reason });
      }
      return handleGet(req, res, route, tournament, historical, chainId);
    }

    if (tournament.status !== "live") return json(res, 409, { ok: false, error: "Final Salvo voting is closed", code: "FINAL_SALVO_TOURNAMENT_INACTIVE" });
    const matchup = resolveTournamentVoteMatch({ tournament, matchRef: route.matchRef });
    if (!matchup.ok || !matchup.battleId) {
      return json(res, 409, { ok: false, error: "Tournament matchup is not active", code: "FINAL_SALVO_MATCH_INACTIVE", reason: matchup.reason });
    }
    return handlePost(req, res, route, tournament, matchup, chainId, body);
  } catch (error) {
    if (["INVALID_CHAIN", "INVALID_ENVIRONMENT", "FINAL_SALVO_ENVIRONMENT_REQUIRED", "FINAL_SALVO_ENVIRONMENT_MISMATCH"].includes(error?.code)) {
      return json(res, error.code === "FINAL_SALVO_ENVIRONMENT_MISMATCH" ? 404 : 400, { ok: false, error: error.message, code: error.code });
    }
    console.error("[api/arenaFinalSalvo]", error);
    return json(res, 503, { ok: false, error: "Final Salvo runtime is unavailable", detail: String(error?.message || error) });
  }
}
