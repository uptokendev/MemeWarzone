import { pool } from "../db.js";
import { ENV } from "../env.js";

// Designed to be run as a cron-style one-off process.
// Sweeps expired, unclaimed league winners into the next epoch rollover pool.
// Production defaults are BNB mainnet (56) + Solana mainnet (101).
// Testnet/devnet must be opted into explicitly through LEAGUE_CHAINS.
//
// Usage:
//   npm run cron:sweep-expired-claims

function parseChainIds(): number[] {
  const ids = String(process.env.LEAGUE_CHAINS || "56,101")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
  return [...new Set(ids)];
}

async function main() {
  if (!ENV.DATABASE_URL) throw new Error("DATABASE_URL missing");

  const sha = process.env.SOURCE_COMMIT || process.env.COOLIFY_GIT_COMMIT_SHA || process.env.GIT_SHA || "unset";
  const chainIds = parseChainIds();
  console.log(`[sweepExpiredClaims] BUILD_SHA=${sha} chains=${chainIds.join(",")}`);

  let totalSwept = 0;
  for (const chainId of chainIds) {
    const r = await pool.query(`select public.league_sweep_expired_unclaimed($1) as swept`, [chainId]);
    const swept = Number(r.rows?.[0]?.swept ?? 0);
    totalSwept += swept;
    console.log(`[sweepExpiredClaims] chainId=${chainId} swept=${swept}`);
  }

  console.log(`[sweepExpiredClaims] done totalSwept=${totalSwept}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("sweepExpiredClaims failed", e);
    process.exit(1);
  });
