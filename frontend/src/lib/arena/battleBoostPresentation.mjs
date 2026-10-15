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
  // Standalone Vote Battles (queue / challenge) take boosts on the same route
  // as normal battles; tournament rounds boost through the tournament page.
  if (source === "tournament" || (mode !== "normal" && mode !== "vote")) {
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

export const BOOST_MAX_PER_WALLET = 2;

function clockLabel(ms) {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * What one wallet can still Boost in a battle or tournament matchup, from the read route's
 * boostRules + walletBoostUnits (api/lib/arenaBoostRules.js enforces the same numbers).
 * remaining is null while the wallet's count is unknown (no wallet connected).
 */
export function boostAllowance({ boostRules = null, walletBoostUnits = null, nowMs = Date.now() } = {}) {
  const limit = Number(boostRules?.maxUnitsPerWallet) > 0 ? Number(boostRules.maxUnitsPerWallet) : BOOST_MAX_PER_WALLET;
  const closesMs = boostRules?.closesAt ? Date.parse(boostRules.closesAt) : Number.NaN;
  const open = Number.isFinite(closesMs) ? Number(nowMs) < closesMs : boostRules?.open !== false;
  let used = null;
  if (walletBoostUnits !== null && walletBoostUnits !== undefined && walletBoostUnits !== "") {
    const parsed = Number(walletBoostUnits);
    used = Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  const remaining = used === null ? null : Math.max(0, limit - used);
  let label;
  if (!open) label = "Boosts are closed for the last 20% of the battle.";
  else if (remaining === 0) label = `You used your ${limit} Boosts in this battle.`;
  else {
    const left = remaining === null ? `Max ${limit} Boosts per wallet` : `${remaining} of ${limit} Boosts left for your wallet`;
    label = Number.isFinite(closesMs) ? `${left}. Boosts close at ${clockLabel(closesMs)}.` : `${left}.`;
  }
  return { limit, used, remaining, open, closesAtMs: Number.isFinite(closesMs) ? closesMs : null, label };
}

/** Quantity buttons: 1 and 2, never more than the wallet has left. */
export function boostQuantityOptions(allowance) {
  const limit = Number(allowance?.limit) > 0 ? Number(allowance.limit) : BOOST_MAX_PER_WALLET;
  return Array.from({ length: limit }, (_, index) => index + 1).map((value) => ({
    value,
    disabled: allowance?.open === false || (allowance?.remaining !== null && allowance?.remaining !== undefined && value > allowance.remaining),
  }));
}
