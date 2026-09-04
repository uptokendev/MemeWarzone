/** Solana live-transition authority. bothPaid must be on-chain deposited stakes, never off-chain receipts. */

export function solanaLiveTransition({ arenaLive, bothPaid } = {}) {
  if (arenaLive !== true) {
    return {
      state: "matched",
      reason: "arena-not-live",
      startFightClock: false,
      startDepositWindow: false,
      clearTiming: true,
    };
  }
  if (bothPaid !== true) {
    return {
      state: "matched",
      reason: "stakes-unpaid",
      startFightClock: false,
      startDepositWindow: true,
      clearTiming: false,
    };
  }
  return {
    state: "live",
    reason: "both-paid",
    startFightClock: true,
    startDepositWindow: false,
    clearTiming: false,
  };
}

export function solanaMayGoLive(onchain) {
  return solanaLiveTransition({
    arenaLive: onchain?.live === true,
    bothPaid: onchain?.bothPaid === true,
  }).state === "live";
}

/** Normalize matched-row clocks. Deposit time only runs while canonical Arena is available. */
export function solanaMatchedLifecyclePatch(transition, row = {}, { nowMs = Date.now(), depositEndsAt } = {}) {
  if (transition?.state === "live") {
    return { action: "go-live", expire: false, patch: null };
  }
  if (transition?.clearTiming) {
    if (row.ends_at || row.started_at) {
      return {
        action: "clear-timing",
        expire: false,
        patch: { state: "matched", started_at: null, ends_at: null },
      };
    }
    return { action: "keep", expire: false, patch: null };
  }
  if (transition?.startDepositWindow) {
    const ends = row.ends_at ? Date.parse(row.ends_at) : NaN;
    const hasFutureWindow = Number.isFinite(ends) && ends > nowMs;
    if (hasFutureWindow) return { action: "keep", expire: false, patch: null };
    return {
      action: "refresh-deposit",
      expire: false,
      patch: { state: "matched", started_at: null, ends_at: depositEndsAt },
    };
  }
  return { action: "keep", expire: false, patch: null };
}
