import { settleBattleResult } from "./arenaLeagueScoreMath.js";

export function canSettleBattle(row, nowMs = Date.now()) {
  if (!row || String(row.state || "") !== "live") return false;
  const ends = row.ends_at ? Date.parse(row.ends_at) : NaN;
  if (!Number.isFinite(ends) || ends > nowMs) return false;
  return true;
}

export function decideBattleSettlement(input) {
  return settleBattleResult(input);
}

export function decorateSettledParticipants(participants, decision) {
  const parts = Array.isArray(participants) ? participants.map((part) => ({ ...part })) : [];
  return parts.map((part, index) => {
    const pct = index === 0 ? decision.leftPct : decision.rightPct;
    const end = index === 0 ? decision.leftEndMcap : decision.rightEndMcap;
    const battlePoints = index === 0 ? decision.leftBattlePoints : decision.rightBattlePoints;
    const mcapPoints = index === 0 ? decision.leftMcapPoints : decision.rightMcapPoints;
    const holderPoints = index === 0 ? decision.leftHolderPoints : decision.rightHolderPoints;
    const volumePoints = index === 0 ? decision.leftVolumePoints : decision.rightVolumePoints;
    const isLeft = index === 0;
    const isMwlWinner =
      Boolean(decision.mwlWinnerToken) &&
      ((isLeft && decision.mwlWinnerSide === "left") || (!isLeft && decision.mwlWinnerSide === "right"));
    return {
      ...part,
      priceChangePct: Number(pct) * 100,
      marketCapUsd: end,
      ...(Number.isFinite(Number(battlePoints)) ? { battlePoints: Number(battlePoints) } : {}),
      ...(Number.isFinite(Number(mcapPoints)) ? { mcapPoints: Number(mcapPoints) } : {}),
      ...(Number.isFinite(Number(holderPoints)) ? { holderPoints: Number(holderPoints) } : {}),
      ...(Number.isFinite(Number(volumePoints)) ? { volumePoints: Number(volumePoints) } : {}),
      isLeading: isMwlWinner,
    };
  });
}

export function battleSettlementPatch(decision, { nowIso, participants, metricsUpdatedAt = null } = {}) {
  if (!decision?.ok) {
    return {
      persist: false,
      reason: decision?.reason || "invalid_market_cap_snapshot",
      patch: null,
    };
  }
  return {
    persist: true,
    reason: "ok",
    patch: {
      state: "finished",
      winner_token: decision.moneyWinnerToken,
      money_winner_token: decision.moneyWinnerToken,
      money_tie_break: decision.moneyTieBreak,
      mwl_result: decision.mwlResult,
      mwl_draw: Boolean(decision.mwlDraw),
      mwl_winner_token: decision.mwlWinnerToken,
      challenger_end_mcap_usd: decision.leftEndMcap,
      defender_end_mcap_usd: decision.rightEndMcap,
      challenger_pct_change: decision.leftPct,
      defender_pct_change: decision.rightPct,
      settlement_version: decision.settlementVersion,
      settlement_scoring_version: decision.settlementScoringVersion || null,
      challenger_battle_points: decision.leftBattlePoints ?? null,
      defender_battle_points: decision.rightBattlePoints ?? null,
      challenger_mcap_points: decision.leftMcapPoints ?? null,
      defender_mcap_points: decision.rightMcapPoints ?? null,
      challenger_holder_points: decision.leftHolderPoints ?? null,
      defender_holder_points: decision.rightHolderPoints ?? null,
      challenger_volume_points: decision.leftVolumePoints ?? null,
      defender_volume_points: decision.rightVolumePoints ?? null,
      settlement_metrics_updated_at: metricsUpdatedAt,
      settlement_tie_break_used: decision.tieBreakUsed ?? null,
      settled_at: nowIso,
      finished_at: nowIso,
      participants,
    },
  };
}
