import {
  arenaMatchProfileFromParticipant,
  calculateMatchQuality,
} from "./arenaMatchQuality.js";

/**
 * League eligibility is separate from settlement eligibility.
 * Tournaments and the ranked queue are competitive by construction. Manual
 * challenges may settle normally as Open War while remaining unranked.
 */
export function battleLeagueEligibility(row, options = {}) {
  if (row?.tournament_id || row?.tournamentId) return { eligible: true, reason: "tournament" };
  if (String(row?.source || "") === "queue") return { eligible: true, reason: "ranked_queue" };
  if (String(row?.source || "") !== "challenge") return { eligible: true, reason: "legacy_source" };

  const participants = Array.isArray(row?.participants) ? row.participants : [];
  if (participants.length < 2) return { eligible: false, reason: "match_profile_missing" };
  const nowMs = options.nowMs || Date.now();
  const left = arenaMatchProfileFromParticipant(participants[0], nowMs);
  const right = arenaMatchProfileFromParticipant(participants[1], nowMs);
  const match = calculateMatchQuality(left, right, { nowMs, config: options.config });
  return {
    eligible: match.rankedEligible === true,
    reason: match.rankedEligible ? "competitive_challenge" : "open_war",
    matchQuality: match.matchScore,
    classification: match.classification,
  };
}
