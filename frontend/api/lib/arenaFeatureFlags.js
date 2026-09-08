function readFlag(name) {
  const raw = String(process.env[name] || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function arenaBattlePointsV3Enabled() {
  return readFlag("ARENA_BATTLE_POINTS_V3");
}

export function arenaBattleBoostsEnabled() {
  return readFlag("ARENA_BATTLE_BOOSTS");
}

export function arenaVoteTournamentsEnabled() {
  return readFlag("ARENA_VOTE_TOURNAMENTS");
}

export function arenaFinalSalvoEnabled() {
  return readFlag("ARENA_FINAL_SALVO");
}

export function arenaPoolV2Enabled() {
  return readFlag("ARENA_POOL_V2");
}

export function arenaSponsorshipV1Enabled() {
  return readFlag("ARENA_SPONSORSHIP_V1");
}

export function arenaSponsorshipPricingEnabled() {
  return readFlag("ARENA_SPONSORSHIP_PRICING");
}

export function arenaPostgradLeagueV2Enabled() {
  return readFlag("ARENA_POSTGRAD_LEAGUE_V2");
}

export const ARENA_PHASE1_FEATURE_FLAGS = Object.freeze({
  battlePointsV3: "ARENA_BATTLE_POINTS_V3",
  battleBoosts: "ARENA_BATTLE_BOOSTS",
  voteTournaments: "ARENA_VOTE_TOURNAMENTS",
  finalSalvo: "ARENA_FINAL_SALVO",
  poolV2: "ARENA_POOL_V2",
  sponsorshipV1: "ARENA_SPONSORSHIP_V1",
  sponsorshipPricing: "ARENA_SPONSORSHIP_PRICING",
  postgradLeagueV2: "ARENA_POSTGRAD_LEAGUE_V2",
});
