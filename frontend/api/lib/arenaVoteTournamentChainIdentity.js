import { getQuery } from "../../server/http.js";
import { ARENA_CHAIN_IDS, arenaEnvironmentIdentity, requiredArenaChainId } from "./arenaChainEnvironment.js";

export const VOTE_TOURNAMENT_CHAIN_IDS = ARENA_CHAIN_IDS;

export function optionalVoteTournamentChainId(value) {
  if (value == null || String(value).trim() === "") return null;
  return requiredArenaChainId(value, "Vote Tournament");
}

export function requiredVoteTournamentChainId(value) {
  const chainId = optionalVoteTournamentChainId(value);
  if (chainId == null) {
    throw Object.assign(new Error("Vote Tournament chain id is required"), { code: "CHAIN_REQUIRED" });
  }
  return chainId;
}

export function voteTournamentEnvironmentIdentity(chainId, identity = {}) {
  return arenaEnvironmentIdentity(requiredVoteTournamentChainId(chainId), identity);
}

function environmentValues(value = {}) {
  return {
    environment: value?.environment ?? value?.runtimeEnvironment ?? value?.runtime_environment ?? null,
    solanaCluster: value?.solanaCluster ?? value?.solana_cluster ?? value?.cluster ?? null,
  };
}

export function voteTournamentEnvironmentFromQuery(req) {
  return environmentValues(getQuery(req));
}

export function voteTournamentEnvironmentFromBody(body) {
  return environmentValues({ ...(body || {}), ...(body?.auth || {}) });
}

export function voteTournamentChainIdFromQuery(req, { required = false } = {}) {
  const query = getQuery(req);
  const value = query.chainId ?? query.chain_id;
  return required ? requiredVoteTournamentChainId(value) : optionalVoteTournamentChainId(value);
}

export function voteTournamentChainIdFromBody(body, { required = false } = {}) {
  const value = body?.chainId ?? body?.chain_id ?? body?.auth?.chainId ?? body?.auth?.chain_id;
  return required ? requiredVoteTournamentChainId(value) : optionalVoteTournamentChainId(value);
}

export function voteTournamentIdentityError(tournament, requestedChainId, requestedEnvironment = {}) {
  if (!tournament) return { status: 404, code: "TOURNAMENT_NOT_FOUND", error: "Tournament not found" };
  if (String(tournament.battle_mode || "") !== "vote") {
    return { status: 404, code: "VOTE_TOURNAMENT_NOT_FOUND", error: "Vote Tournament not found" };
  }
  if (requestedChainId != null && Number(tournament.chain_id) !== Number(requestedChainId)) {
    return { status: 404, code: "TOURNAMENT_CHAIN_MISMATCH", error: "Vote Tournament not found on requested chain" };
  }

  try {
    const rowIdentity = voteTournamentEnvironmentIdentity(tournament.chain_id, {
      environment: tournament.environment,
      solanaCluster: tournament.solana_cluster,
    });
    const requestedValues = environmentValues(requestedEnvironment);
    if (Number(tournament.chain_id) === 101 && !requestedValues.environment && !requestedValues.solanaCluster) {
      return { status: 400, code: "TOURNAMENT_ENVIRONMENT_REQUIRED", error: "Solana Vote Tournament requires devnet or mainnet-beta identity" };
    }
    const requestIdentity = voteTournamentEnvironmentIdentity(tournament.chain_id, requestedValues);
    if (
      rowIdentity.environment !== requestIdentity.environment ||
      rowIdentity.solanaCluster !== requestIdentity.solanaCluster
    ) {
      return { status: 404, code: "TOURNAMENT_ENVIRONMENT_MISMATCH", error: "Vote Tournament not found in requested environment" };
    }
  } catch (error) {
    return { status: 400, code: error?.code || "INVALID_ENVIRONMENT", error: error?.message || "Invalid Vote Tournament environment" };
  }
  return null;
}

export function assertVoteTournamentBattleIdentity(battle, tournament) {
  if (!battle) return false;
  return (
    Number(battle.chain_id) === Number(tournament?.chain_id) &&
    String(battle.tournament_id || "") === String(tournament?.id || "") &&
    String(battle.source || "") === "tournament" &&
    String(battle.battle_mode || "") === "vote"
  );
}
