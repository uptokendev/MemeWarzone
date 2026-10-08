// E18: holder payouts (EVM 'airdrop_holders', Solana DBC 'dbc_holders' / code 2) travel through the
// airdrop claim tables but are a share of a coin's fees, not a draw win. Label them as such.
// "airdrop_holders_gen7": holder batches of gen-7's own CreatorRewardsVaultV2 (one program per vault, 2026-10-08).
const HOLDER_PROGRAMS = new Set(["airdrop_holders", "airdrop_holders_gen7", "dbc_holders"]);

export function isHolderPayoutProgram(program) {
  return HOLDER_PROGRAMS.has(String(program ?? ""));
}

/** "Trader" / "Creator" / "Holder payout" for a reward program. Anything unknown stays "Trader" as before. */
export function airdropProgramKind(program) {
  if (isHolderPayoutProgram(program)) return "Holder payout";
  return program === "airdrop_creator" ? "Creator" : "Trader";
}

/** "Trader draw" / "Creator draw" / "Holder payout". */
export function airdropProgramLabel(program) {
  return isHolderPayoutProgram(program) ? "Holder payout" : `${airdropProgramKind(program)} draw`;
}

/** "winner" for a draw, "payout" for a holder payout (a holder is paid by share, not drawn). */
export function airdropRankNoun(program) {
  return isHolderPayoutProgram(program) ? "payout" : "winner";
}

/**
 * One claimable airdrop row in Rewards and claims: "Week of 2026-10-05 · Trader draw". A week can be
 * paid from either airdrop pot of a chain (main or gen-7); each row claims from its own distributor,
 * so the pot is not part of the label (a wallet wins from at most one pot a week).
 */
export function airdropClaimLabel(metadata) {
  const program = metadata?.program;
  const epochId = String(metadata?.epochId ?? "").trim();
  const kind = airdropProgramLabel(program);
  return /^\d{4}-\d{2}-\d{2}$/.test(epochId) ? `Week of ${epochId} · ${kind}` : kind;
}
