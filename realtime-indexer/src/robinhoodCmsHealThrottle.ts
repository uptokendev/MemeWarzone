// A Robinhood campaign that is not launched yet is re-checked by the CMS heal at most this often,
// unless the caller saw new campaign logs (force). Graduation is caught from the CampaignFinalized
// event; the heal is the fallback for a missed one, so an idle bonding coin does not need launched()
// on every indexer pass. 0 restores the old every-pass check.
export const BONDING_RECHECK_MS = Math.max(0, Number(process.env.ROBINHOOD_CMS_HEAL_BONDING_RECHECK_MS ?? 600_000));

/** True when a not-launched campaign was checked within the interval and nothing forces a re-check. */
export function skipBondingRecheck(
  checkedAt: number | undefined,
  nowMs: number,
  force: boolean,
  recheckMs = BONDING_RECHECK_MS,
): boolean {
  return !force && checkedAt != null && nowMs - checkedAt < recheckMs;
}
