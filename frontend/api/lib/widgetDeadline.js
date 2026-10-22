// Deadline jitter for swap-widget builds that record a partner fingerprint (gen8Swap.js, importSwap.js Robinhood).
// A build's deadline is "now + base"; two wallets building the same coin and amount in the same second would get the
// same bytes and so the same fingerprint. A random 0..3599 s on top (never shorter than the base) makes each build's
// bytes its own; finance also requires the landed wallet to be the recorded one (importSwapFingerprint.partnersForSwaps).
import { randomInt } from "node:crypto";

export const WIDGET_DEADLINE_JITTER_SECONDS = 3600;

/** Seconds to add to a widget build's deadline: random 0..3599, or deps.deadlineJitterSec (tests). */
export function widgetDeadlineJitter(deps = {}) {
  const fixed = deps?.deadlineJitterSec;
  if (fixed != null) {
    if (!Number.isInteger(fixed) || fixed < 0 || fixed >= WIDGET_DEADLINE_JITTER_SECONDS) throw new Error("deadlineJitterSec must be an integer from 0 to 3599");
    return fixed;
  }
  return randomInt(0, WIDGET_DEADLINE_JITTER_SECONDS);
}
