// E18: holder payouts (EVM 'airdrop_holders', Solana DBC 'dbc_holders' / code 2) travel through the
// airdrop claim tables but are a share of a coin's fees, not a draw win. Label them as such.
const HOLDER_PROGRAMS = new Set(["airdrop_holders", "dbc_holders"]);

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
