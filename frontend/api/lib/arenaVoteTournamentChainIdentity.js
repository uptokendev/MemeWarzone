import { getQuery } from "../../server/http.js";

export const VOTE_TOURNAMENT_CHAIN_IDS = Object.freeze([56, 101, 4663]);
const SUPPORTED = new Set(VOTE_TOURNAMENT_CHAIN_IDS);

export function optionalVoteTournamentChainId(value) {
  if (value == null || String(value).trim() === "") return null;
  const chainId = Number(value);
  if (!Number.isSafeInteger(chainId) || !SUPPORTED.has(chainId)) {
    throw Object.assign(new Error("Unsupported Vote Tournament chain id"), { code: "INVALID_CHAIN" });
  }
  return chainId;
}

export function requiredVoteTournamentChainId(value) {
  const chainId = optionalVoteTournamentChainId(value);
  if (chainId == null) {
    throw Object.assign(new Error("Vote Tournament chain id is required"), { code: "CHAIN_REQUIRED" });
  }
  return chainId;
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

export function voteTournamentIdentityError(tournament, requestedChainId) {
  if (!tournament) return { status: 404, code: "TOURNAMENT_NOT_FOUND", error: "Tournament not found" };
  if (String(tournament.battle_mode || "") !== "vote") {
    return { status: 404, code: "VOTE_TOURNAMENT_NOT_FOUND", error: "Vote Tournament not found" };
  }
  if (requestedChainId != null && Number(tournament.chain_id) !== Number(requestedChainId)) {
    return { status: 404, code: "TOURNAMENT_CHAIN_MISMATCH", error: "Vote Tournament not found on requested chain" };
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
