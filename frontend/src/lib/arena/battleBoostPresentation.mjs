function isEvmCombatant(tokenId) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(tokenId || ""));
}

function isSolanaCombatant(tokenId) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(tokenId || ""));
}

export function battleBoostAvailability(battle = {}) {
  const state = String(battle?.state || "").trim().toLowerCase();
  const source = String(battle?.source || "").trim().toLowerCase();
  const mode = String(battle?.battleMode || battle?.battle_mode || "normal").trim().toLowerCase();
  const competitionGeneration = String(
    battle?.competitionGeneration || battle?.competition_generation || battle?.poolGeneration || battle?.pool_generation || "",
  ).trim();
  const chainId = Number(battle?.chainId ?? battle?.chain_id ?? 0);
  const participants = Array.isArray(battle?.participants) ? battle.participants : [];
  const tokenIds = participants.slice(0, 2).map((participant) =>
    String(participant?.tokenAddress || participant?.tokenId || participant?.campaignAddress || "").trim(),
  );

  if (state !== "live") return { available: false, reason: "not_live", competitionGeneration, tokenIds };
  if (source === "tournament" || mode !== "normal") {
    return { available: false, reason: "not_normal_battle", competitionGeneration, tokenIds };
  }
  if (competitionGeneration !== "arena_competition_v2") {
    return { available: false, reason: "wrong_generation", competitionGeneration, tokenIds };
  }
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return { available: false, reason: "unsupported_chain", competitionGeneration, tokenIds };
  }
  const solana = chainId === 101 || chainId === 102;
  const validCombatant = solana ? isSolanaCombatant : isEvmCombatant;
  if (tokenIds.length < 2 || tokenIds.some((tokenId) => !validCombatant(tokenId))) {
    return { available: false, reason: "missing_combatants", competitionGeneration, tokenIds };
  }
  return { available: true, reason: null, competitionGeneration, tokenIds };
}
