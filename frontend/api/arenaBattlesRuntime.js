import arenaBattles from "./arenaBattles.js";
import { activateNormalBattleSettlementOnRead } from "./lib/arenaBattleSettlementRuntime.js";
import { claimAuthoritativeSettlement, releaseAuthoritativeSettlement } from "./lib/arenaBattleSettlementGuard.js";

export default async function handler(req, res) {
  const outcomes = await activateNormalBattleSettlementOnRead(req);
  const authoritativeIds = [...new Set(outcomes.filter((item) => item?.authoritative === true).map((item) => String(item.battleId)))];
  for (const battleId of authoritativeIds) claimAuthoritativeSettlement(battleId);
  const blocked = outcomes.filter((item) => item && item.settled === false && item.reason && item.reason !== "not_due_already_settled_or_not_normal" && item.reason !== "not_due_already_settled_or_not_v2_locked");
  if (blocked.length) {
    console.warn("[arena-battle-settlement-runtime] recoverable settlement blocks", blocked.map((item) => ({
      battleId: item.battleId,
      scoringGeneration: item.scoringGeneration,
      reason: item.reason,
    })));
  }
  try {
    return await arenaBattles(req, res);
  } finally {
    for (const battleId of authoritativeIds) releaseAuthoritativeSettlement(battleId);
  }
}
