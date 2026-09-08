const claims = new Map();

export function claimAuthoritativeSettlement(battleId) {
  const id = String(battleId || "");
  if (!id) return;
  claims.set(id, Number(claims.get(id) || 0) + 1);
}

export function releaseAuthoritativeSettlement(battleId) {
  const id = String(battleId || "");
  if (!id) return;
  const next = Number(claims.get(id) || 0) - 1;
  if (next > 0) claims.set(id, next);
  else claims.delete(id);
}

export function isAuthoritativeSettlementClaimed(battleId) {
  return Number(claims.get(String(battleId || "")) || 0) > 0;
}
