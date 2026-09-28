import { DBC_CREATOR_COOLDOWN_SECONDS, DBC_MAX_LIVE_BONDING } from "../../../shared/dbcEconomics.mjs";

export async function loadDbcCreatorLimits(db, { creatorWallet, chainId = 101, now = () => new Date() } = {}) {
  const wallet = String(creatorWallet || "").trim();
  const live = await db.query(
    `select count(*)::int as n
       from public.campaigns
      where chain_id = $1
        and creator_address = $2
        and coalesce(launch_type, 'launchpad') = 'dbc'
        and is_active = true
        and graduated_at_chain is null`,
    [Number(chainId), wallet],
  );
  const last = await db.query(
    `select created_at
       from public.campaigns
      where chain_id = $1
        and creator_address = $2
        and coalesce(launch_type, 'launchpad') = 'dbc'
      order by created_at desc
      limit 1`,
    [Number(chainId), wallet],
  );
  const liveBondingCount = Number(live.rows[0]?.n || 0);
  const lastLaunchAt = last.rows[0]?.created_at ? new Date(last.rows[0].created_at) : null;
  const nowDate = now();
  const cooldownSeconds = DBC_CREATOR_COOLDOWN_SECONDS;
  const nextAllowedAt = lastLaunchAt
    ? Math.floor(lastLaunchAt.getTime() / 1000) + cooldownSeconds
    : 0;
  const chainNow = Math.floor(nowDate.getTime() / 1000);
  const cooldownActive = Boolean(lastLaunchAt) && chainNow < nextAllowedAt;
  const liveLimitReached = liveBondingCount >= DBC_MAX_LIVE_BONDING;
  return {
    liveBondingCount,
    maxLiveBondingCount: DBC_MAX_LIVE_BONDING,
    cooldownSeconds,
    lastLaunchAt,
    nextAllowedAt: nextAllowedAt || null,
    chainNow,
    cooldownActive,
    liveLimitReached,
    allowed: !cooldownActive && !liveLimitReached,
  };
}

export function assertDbcCreatorLimits(limits) {
  if (limits.liveLimitReached) {
    const err = new Error("You already have the maximum number of live DBC coins (3).");
    err.code = "DBC_CREATOR_LAUNCH_LIMIT";
    err.httpStatus = 403;
    throw err;
  }
  if (limits.cooldownActive) {
    const nextIso = new Date(limits.nextAllowedAt * 1000).toISOString();
    const err = new Error(`A DBC launch from this wallet is on a 24 hour cooldown. Next allowed ${nextIso}.`);
    err.code = "DBC_CREATOR_COOLDOWN";
    err.httpStatus = 403;
    throw err;
  }
}
