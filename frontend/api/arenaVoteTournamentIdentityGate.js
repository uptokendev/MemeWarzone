import { pool } from "../server/db.js";
import { json } from "../server/http.js";
import arenaTournamentBoosts from "./arenaTournamentBoosts.js";
import arenaSolanaBoosts from "./arenaSolanaBoosts.js";
import arenaVoteTournamentSetup from "./arenaVoteTournamentSetup.js";
import { findTournamentVoteMatch } from "./lib/arenaTournamentVoteRuntime.mjs";
import {
  assertVoteTournamentBattleIdentity,
  voteTournamentChainIdFromBody,
  voteTournamentChainIdFromQuery,
  voteTournamentEnvironmentFromBody,
  voteTournamentEnvironmentFromQuery,
  voteTournamentIdentityError,
} from "./lib/arenaVoteTournamentChainIdentity.js";

function pathOf(req) {
  return String(req.path || new URL(req.url, "http://localhost").pathname);
}

function methodOf(req) {
  return String(req.method || "GET").toUpperCase();
}

function bodyOf(req) {
  return req.body && typeof req.body === "object" ? req.body : {};
}

function identityFailure(res, error) {
  return json(res, error.status, { ok: false, error: error.error, code: error.code });
}

function invalidChain(res, error) {
  return json(res, 400, { ok: false, error: error?.message || "Invalid Vote Tournament chain id", code: error?.code || "INVALID_CHAIN" });
}

async function loadTournament(id) {
  return (await pool.query(
    `select id, chain_id, status, bracket, battle_mode, round_duration_hours, competition_generation,
            contest_scoring_version, environment, solana_cluster
       from public.arena_tournaments where id=$1 limit 1`,
    [id],
  )).rows[0] || null;
}

async function validateMatchBattleIdentity(tournament, matchRef) {
  const match = findTournamentVoteMatch({ tournament, matchRef });
  if (!match.ok || !match.battleId) return null;
  const battle = (await pool.query(
    `select id, chain_id, tournament_id, source, battle_mode
       from public.arena_battles where id=$1 limit 1`,
    [match.battleId],
  )).rows[0] || null;
  if (!battle) return null;
  if (!assertVoteTournamentBattleIdentity(battle, tournament)) {
    return {
      status: 409,
      code: "TOURNAMENT_BATTLE_CHAIN_MISMATCH",
      error: "Vote Tournament matchup is not bound to this tournament chain",
    };
  }
  return null;
}

function requestedEnvironment(req, body = null) {
  return body == null ? voteTournamentEnvironmentFromQuery(req) : voteTournamentEnvironmentFromBody(body);
}

export async function arenaVoteTournamentSetupIdentityGate(req, res) {
  const path = pathOf(req);
  const method = methodOf(req);
  try {
    if (path === "/arena/tournaments/v2/buy-in-quote") {
      const chainId = voteTournamentChainIdFromQuery(req, { required: true });
      if (chainId === 101) {
        const env = requestedEnvironment(req);
        if (!env.environment && !env.solanaCluster) return invalidChain(res, Object.assign(new Error("Solana Vote Tournament requires devnet or mainnet-beta identity"), { code: "TOURNAMENT_ENVIRONMENT_REQUIRED" }));
      }
      return arenaVoteTournamentSetup(req, res);
    }
    if (path === "/arena/tournaments/v2/create") {
      const body = bodyOf(req);
      const chainId = voteTournamentChainIdFromBody(body, { required: true });
      if (chainId === 101) {
        const env = requestedEnvironment(req, body);
        if (!env.environment && !env.solanaCluster) return invalidChain(res, Object.assign(new Error("Solana Vote Tournament requires devnet or mainnet-beta identity"), { code: "TOURNAMENT_ENVIRONMENT_REQUIRED" }));
      }
      return arenaVoteTournamentSetup(req, res);
    }

    const receipt = path.match(/^\/arena\/tournaments\/([^/]+)\/(v2-buy-in-receipt|buy-in-receipt)$/);
    if (!receipt) return arenaVoteTournamentSetup(req, res);
    const tournamentId = decodeURIComponent(receipt[1]);
    const tournament = await loadTournament(tournamentId);

    if (receipt[2] === "buy-in-receipt" && tournament && tournament.battle_mode !== "vote") {
      return arenaVoteTournamentSetup(req, res);
    }

    const body = method === "GET" ? null : bodyOf(req);
    const requestedChainId = method === "GET"
      ? voteTournamentChainIdFromQuery(req)
      : voteTournamentChainIdFromBody(body);
    const error = voteTournamentIdentityError(tournament, requestedChainId, requestedEnvironment(req, body));
    if (error) return identityFailure(res, error);
    return arenaVoteTournamentSetup(req, res);
  } catch (error) {
    if (["INVALID_CHAIN", "CHAIN_REQUIRED", "INVALID_ENVIRONMENT", "TOURNAMENT_ENVIRONMENT_REQUIRED"].includes(error?.code)) return invalidChain(res, error);
    throw error;
  }
}

async function tournamentBoostGate(req, res, delegate, { solanaOnly = false } = {}) {
  const path = pathOf(req);
  const route = path.match(/^\/arena\/tournaments\/([^/]+)\/matches\/([^/]+)\/boosts(?:\/.*)?$/);
  if (!route) return delegate(req, res);
  const tournamentId = decodeURIComponent(route[1]);
  const matchRef = decodeURIComponent(route[2]);
  try {
    const body = methodOf(req) === "GET" ? null : bodyOf(req);
    const requestedChainId = methodOf(req) === "GET"
      ? voteTournamentChainIdFromQuery(req)
      : voteTournamentChainIdFromBody(body);
    const tournament = await loadTournament(tournamentId);
    const error = voteTournamentIdentityError(tournament, requestedChainId, requestedEnvironment(req, body));
    if (error) return identityFailure(res, error);
    if (solanaOnly && Number(tournament.chain_id) !== 101) {
      return json(res, 404, { ok: false, error: "Vote Tournament not found on Solana", code: "TOURNAMENT_CHAIN_MISMATCH" });
    }
    if (!solanaOnly && Number(tournament.chain_id) === 101) {
      return json(res, 404, { ok: false, error: "Vote Tournament requires the Solana Tournament Boost route", code: "TOURNAMENT_CHAIN_MISMATCH" });
    }
    const battleError = await validateMatchBattleIdentity(tournament, matchRef);
    if (battleError) return identityFailure(res, battleError);
    return delegate(req, res);
  } catch (error) {
    if (["INVALID_CHAIN", "CHAIN_REQUIRED", "INVALID_ENVIRONMENT", "TOURNAMENT_ENVIRONMENT_REQUIRED"].includes(error?.code)) return invalidChain(res, error);
    throw error;
  }
}

export async function arenaVoteTournamentBoostsIdentityGate(req, res) {
  return tournamentBoostGate(req, res, arenaTournamentBoosts, { solanaOnly: false });
}

export async function arenaVoteTournamentSolanaBoostsIdentityGate(req, res) {
  return tournamentBoostGate(req, res, arenaSolanaBoosts, { solanaOnly: true });
}
