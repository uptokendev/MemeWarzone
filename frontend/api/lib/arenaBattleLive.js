/** Solana live-transition authority. bothPaid must be on-chain deposited stakes, never off-chain receipts. */

export function solanaLiveTransition({ arenaLive, bothPaid } = {}) {
  if (arenaLive !== true) {
    return { state: "matched", reason: "arena-not-live", startFightClock: false, startDepositWindow: false };
  }
  if (bothPaid !== true) {
    return { state: "matched", reason: "stakes-unpaid", startFightClock: false, startDepositWindow: true };
  }
  return { state: "live", reason: "both-paid", startFightClock: true, startDepositWindow: false };
}

export function solanaMayGoLive(onchain) {
  return solanaLiveTransition({
    arenaLive: onchain?.live === true,
    bothPaid: onchain?.bothPaid === true,
  }).state === "live";
}
