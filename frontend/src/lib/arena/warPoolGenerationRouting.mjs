export const WAR_POOL_GENERATIONS = Object.freeze({
  war_pool_v1: Object.freeze({
    key: "war_pool_v1",
    winnersShare: 0.85,
    protocolShare: 0.05,
    leagueShare: 0.10,
  }),
  war_pool_v2: Object.freeze({
    key: "war_pool_v2",
    winnersShare: 0.75,
    protocolShare: 0.05,
    leagueShare: 0.20,
  }),
  competition_pool_v2: Object.freeze({
    key: "war_pool_v2",
    winnersShare: 0.75,
    protocolShare: 0.05,
    leagueShare: 0.20,
  }),
});

export function normalizeWarPoolGeneration(value) {
  const raw = String(value || "").trim().toLowerCase();
  return WAR_POOL_GENERATIONS[raw] || null;
}

export function hasExplicitWarPoolRouting(value = {}) {
  return [value?.winnersUsd, value?.protocolUsd, value?.featuredUsd]
    .map(Number)
    .every(Number.isFinite);
}

export function presentWarPoolRouting(value = {}, totalPotUsd = 0, generationValue = null) {
  if (hasExplicitWarPoolRouting(value)) {
    return {
      winnersUsd: Number(value.winnersUsd),
      protocolUsd: Number(value.protocolUsd),
      featuredUsd: Number(value.featuredUsd),
      source: "explicit",
    };
  }

  const generation = normalizeWarPoolGeneration(generationValue);
  if (!generation) return null;

  const total = Number(totalPotUsd);
  if (!Number.isFinite(total) || total < 0) return null;

  return {
    winnersUsd: Math.round(total * generation.winnersShare),
    protocolUsd: Math.round(total * generation.protocolShare),
    featuredUsd: Math.round(total * generation.leagueShare),
    source: generation.key,
  };
}
