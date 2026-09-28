import {
  DBC_ANTI_SNIPER_DURATION_SECONDS,
  DBC_ANTI_SNIPER_END_FEE_BPS,
  DBC_ANTI_SNIPER_START_FEE_BPS,
} from "./dbcEconomics.mjs";

/** Linear 50% -> 2% over 60 s (D14). */
export function antiSniperFeeBps(elapsedSeconds) {
  const elapsed = Number(elapsedSeconds);
  if (!Number.isFinite(elapsed) || elapsed <= 0) return DBC_ANTI_SNIPER_START_FEE_BPS;
  if (elapsed >= DBC_ANTI_SNIPER_DURATION_SECONDS) return DBC_ANTI_SNIPER_END_FEE_BPS;
  const span = DBC_ANTI_SNIPER_START_FEE_BPS - DBC_ANTI_SNIPER_END_FEE_BPS;
  return Math.round(DBC_ANTI_SNIPER_START_FEE_BPS - (span * elapsed) / DBC_ANTI_SNIPER_DURATION_SECONDS);
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
