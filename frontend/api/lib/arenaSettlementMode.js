import {
  battlePointsV2PersistenceEnabled,
  BATTLE_POINTS_V2,
  BATTLE_POINTS_V3,
} from "./arenaBattlePointsConfig.js";

export const ARENA_SETTLEMENT_MODE_V1 = "v1_mcap_pct_change";
export const ARENA_SETTLEMENT_MODE_V2 = BATTLE_POINTS_V2;
export const ARENA_SETTLEMENT_MODE_V3 = BATTLE_POINTS_V3;

/**
 * Finished rows are interpreted only from persisted settlement evidence so
 * rollout flags never relabel historical battles. Live V3 selection is stored
 * separately in the immutable arena_battle_scoring_locks table and is handled
 * by the settlement coordinator rather than inferred here.
 */
export function arenaSettlementMode(battleRow = null) {
  const persisted = String(
    battleRow?.settlement_scoring_version ?? battleRow?.settlementScoringVersion ?? "",
  ).trim();
  if (persisted === BATTLE_POINTS_V3) return ARENA_SETTLEMENT_MODE_V3;
  if (persisted === BATTLE_POINTS_V2) return ARENA_SETTLEMENT_MODE_V2;
  if (persisted === "mcap_pct_change") return ARENA_SETTLEMENT_MODE_V1;

  const state = String(battleRow?.state || "");
  if (state === "finished") {
    const version = Number(battleRow?.settlement_version ?? battleRow?.settlementVersion ?? 0);
    if (version >= 3) return ARENA_SETTLEMENT_MODE_V3;
    return version >= 2 ? ARENA_SETTLEMENT_MODE_V2 : ARENA_SETTLEMENT_MODE_V1;
  }

  return battlePointsV2PersistenceEnabled()
    ? ARENA_SETTLEMENT_MODE_V2
    : ARENA_SETTLEMENT_MODE_V1;
}
