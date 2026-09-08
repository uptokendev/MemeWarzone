export const LEGACY_BATTLE_ROUTE = "/battle/:id";

export const LEGACY_BATTLE_ROUTE_PARITY_GATES = Object.freeze([
  Object.freeze({ key: "deep_link", label: "Battle deep links resolve to the replacement fight surface" }),
  Object.freeze({ key: "battle_unavailable", label: "Unavailable/not-found state is preserved" }),
  Object.freeze({ key: "combatants", label: "Both combatants, token links and leader state are preserved" }),
  Object.freeze({ key: "realtime", label: "Realtime health and DATA DELAY presentation are preserved" }),
  Object.freeze({ key: "funding", label: "Matched-battle funding controls remain available" }),
  Object.freeze({ key: "tournament_redirect", label: "Tournament fights redirect Support to the tournament event" }),
  Object.freeze({ key: "result_log", label: "Settlement winner, scoring generation and timestamps remain visible" }),
  Object.freeze({ key: "claim", label: "Finished-battle claim remains available only for an explicit supported pool generation" }),
  Object.freeze({ key: "generation_economics", label: "Historical V1 and V2 economics are displayed only from explicit generation data" }),
  Object.freeze({ key: "share", label: "Replacement surface preserves canonical sharing/deep-link behavior" }),
  Object.freeze({ key: "mobile", label: "Replacement surface preserves approved mobile combatant composition" }),
]);

export const LEGACY_ROUTE_KNOWN_UNSAFE_BEHAVIORS = Object.freeze([
  "hardcoded_war_pool_v1_copy",
  "claim_without_generation_gate",
  "settlement_generation_v1_v2_only",
]);

export function canRetireLegacyBattleRoute(checks = {}) {
  return LEGACY_BATTLE_ROUTE_PARITY_GATES.every((gate) => checks?.[gate.key] === true);
}
