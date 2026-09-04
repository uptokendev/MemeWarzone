import { battlePointsV2PersistenceEnabled, BATTLE_POINTS_V2 } from "./arenaBattlePointsConfig.js";

export const ARENA_SETTLEMENT_MODE_V1 = "v1_mcap_pct_change";
export const ARENA_SETTLEMENT_MODE_V2 = BATTLE_POINTS_V2;

/**
 * Finished rows are interpreted from their persisted settlement evidence so an
 * active V2 rollout never relabels historical V1 battles. Live rows use the
 * rollout flag because their final settlement has not been persisted yet.
 */
export function arenaSettlementMode(battleRow = null) {
  const persisted = String(
    battleRow?.settlement_scoring_version ?? battleRow?.settlementScoringVersion ?? "",
  ).trim();
  if (persisted === BATTLE_POINTS_V2) return ARENA_SETTLEMENT_MODE_V2;
  if (persisted === "mcap_pct_change") return ARENA_SETTLEMENT_MODE_V1;

  const state = String(battleRow?.state || "");
  if (state === "finished") {
    return Number(battleRow?.settlement_version ?? battleRow?.settlementVersion ?? 0) >= 2
      ? ARENA_SETTLEMENT_MODE_V2
      : ARENA_SETTLEMENT_MODE_V1;
  }

  return battlePointsV2PersistenceEnabled()
    ? ARENA_SETTLEMENT_MODE_V2
    : ARENA_SETTLEMENT_MODE_V1;
}
