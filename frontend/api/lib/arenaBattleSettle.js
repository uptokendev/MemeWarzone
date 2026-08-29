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
    const isLeft = index === 0;
    const isMwlWinner =
      Boolean(decision.mwlWinnerToken) &&
      ((isLeft && decision.mwlWinnerSide === "left") || (!isLeft && decision.mwlWinnerSide === "right"));
    return {
      ...part,
      priceChangePct: Number(pct) * 100,
      marketCapUsd: end,
      isLeading: isMwlWinner,
    };
  });
}

export function battleSettlementPatch(decision, { nowIso, participants } = {}) {
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
      settled_at: nowIso,
      finished_at: nowIso,
      participants,
    },
  };
}
