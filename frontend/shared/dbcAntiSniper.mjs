import {
  DBC_ANTI_SNIPER_DURATION_SECONDS,
  DBC_ANTI_SNIPER_END_FEE_BPS,
  DBC_ANTI_SNIPER_PERIODS,
  DBC_ANTI_SNIPER_START_FEE_BPS,
} from "./dbcEconomics.mjs";

/** Linear 90% -> 2% over 60 s (D14; 50% until 2026-10-01). */
export function antiSniperFeeBps(elapsedSeconds) {
  const elapsed = Number(elapsedSeconds);
  if (!Number.isFinite(elapsed) || elapsed <= 0) return DBC_ANTI_SNIPER_START_FEE_BPS;
  if (elapsed >= DBC_ANTI_SNIPER_DURATION_SECONDS) return DBC_ANTI_SNIPER_END_FEE_BPS;
  // Meteora's linear scheduler, in its own units: fee numerators over 1e9, a whole reduction per
  // elapsed period, floored. At 90% this is what the chain charges to the bps (t=5s -> 8266).
  const BPS_TO_NUMERATOR = 100_000;
  const start = DBC_ANTI_SNIPER_START_FEE_BPS * BPS_TO_NUMERATOR;
  const end = DBC_ANTI_SNIPER_END_FEE_BPS * BPS_TO_NUMERATOR;
  const reduction = Math.floor((start - end) / DBC_ANTI_SNIPER_PERIODS);
  const period = Math.min(DBC_ANTI_SNIPER_PERIODS, Math.floor((elapsed * DBC_ANTI_SNIPER_PERIODS) / DBC_ANTI_SNIPER_DURATION_SECONDS));
  return Math.max(DBC_ANTI_SNIPER_END_FEE_BPS, Math.floor((start - reduction * period) / BPS_TO_NUMERATOR));
}

export function antiSniperFeeLine({ activationUnix, nowUnix, timeZone } = {}) {
  const now = Number(nowUnix ?? Math.floor(Date.now() / 1000));
  const start = Number(activationUnix || 0);
  const elapsed = start > 0 ? now - start : 0;
  const bps = antiSniperFeeBps(elapsed);
  const pct = Math.round(bps / 100);
  if (bps <= DBC_ANTI_SNIPER_END_FEE_BPS) {
    return `Launch fee: ${pct}% now.`;
  }
  const until = start + DBC_ANTI_SNIPER_DURATION_SECONDS;
  const when = new Date(until * 1000).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone,
  });
  return `Launch fee: ${pct}% now, 2% from ${when}.`;
}

export function solanaQuoteSource({ launchType, migrated } = {}) {
  if (String(launchType || "") === "dbc" && !migrated) return "dbc";
  if (String(launchType || "") === "dbc" && migrated) return "meteora-dbc";
  return "launchpad";
}

export function shouldUseLaunchpadBondingQuote(launchType) {
  return String(launchType || "launchpad") !== "dbc";
}

/** The launch-fee note on the DBC create page, from the config's own numbers (90% -> 2% in 60 s). */
export const DBC_LAUNCH_FEE_NOTE =
  `The fee starts at ${DBC_ANTI_SNIPER_START_FEE_BPS / 100}% and falls to ${DBC_ANTI_SNIPER_END_FEE_BPS / 100}% within ${DBC_ANTI_SNIPER_DURATION_SECONDS} seconds, so bots that buy at launch pay for it. Your own first buy does not.`;
