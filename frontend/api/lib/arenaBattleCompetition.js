import {
  arenaMatchProfileFromParticipant,
  calculateMatchQuality,
} from "./arenaMatchQuality.js";

/**
 * League eligibility is separate from settlement eligibility.
 * Tournaments and the ranked queue are competitive by construction. Manual
 * challenges may settle normally as Open War while remaining unranked.
 */
/**
 * League points for an unranked (Open War) challenge, as a fraction of a ranked result.
 * Founder policy 2026-09-25: 0.5, so every battle counts and fair matchups count more.
 */
export function openWarPointsMultiplier(env = process.env) {
  const raw = env?.ARENA_OPEN_WAR_POINTS_MULTIPLIER;
  const value = raw === undefined || raw === "" ? 0.5 : Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.5;
}

export function battleLeagueEligibility(row, options = {}) {
  if (row?.tournament_id || row?.tournamentId) return { eligible: true, reason: "tournament", pointsMultiplier: 1 };
  if (String(row?.source || "") === "queue") return { eligible: true, reason: "ranked_queue", pointsMultiplier: 1 };
  if (String(row?.source || "") !== "challenge") return { eligible: true, reason: "legacy_source", pointsMultiplier: 1 };
  // A Vote Battle is decided by the community, not by market data: any coin may challenge any
  // coin and it always counts in full (founder policy 2026-09-25).
  if (String(row?.battle_mode ?? row?.battleMode ?? "").toLowerCase() === "vote") return { eligible: true, reason: "vote_battle", pointsMultiplier: 1 };

  const participants = Array.isArray(row?.participants) ? row.participants : [];
  if (participants.length < 2) return { eligible: false, reason: "match_profile_missing", pointsMultiplier: 0 };
  const nowMs = options.nowMs || Date.now();
  const left = arenaMatchProfileFromParticipant(participants[0], nowMs);
  const right = arenaMatchProfileFromParticipant(participants[1], nowMs);
  const match = calculateMatchQuality(left, right, { nowMs, config: options.config });
  return {
    eligible: match.rankedEligible === true,
    reason: match.rankedEligible ? "competitive_challenge" : "open_war",
    pointsMultiplier: match.rankedEligible ? 1 : openWarPointsMultiplier(options.env),
    matchQuality: match.matchScore,
    classification: match.classification,
  };
}
