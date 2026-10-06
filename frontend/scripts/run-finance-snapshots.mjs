/**
 * Finance snapshots (Coolify scheduled task on the API service, every 5 minutes, "*\/5 * * * *"):
 *   npm run cron:finance-snapshots
 * Reads the chain-derived finance data (fee routing, payouts, indexer and API LP reads, UP vote fee
 * receiver, spot prices, ECB rates) for BNB 56, Robinhood 4663 and Solana mainnet, and stores
 * it in public.finance_snapshots, so the Command Center finance pages read the database
 * instead of waiting on RPCs. View calls only: nothing is signed or sent.
 * Optional: --chain 101|56|4663 for one chain.
 */
import "../api/load-local-env.mjs";
import { pool } from "../server/db.js";
import { refreshFinanceSnapshots } from "../api/lib/financeSnapshotJobs.js";
import { defaultSummaryBuild, readIndexerLpFeesLive } from "../api/admin/finance.js";
import { apiLpFeesSnapshotKey, lpFeesSnapshotBuild } from "../api/dashboard/lp-fees.js";

const chainArg = process.argv.indexOf("--chain");
const chainIds = chainArg > -1 ? [Number(process.argv[chainArg + 1])] : null;

refreshFinanceSnapshots({
  db: pool,
  chainIds,
  readIndexerLp: readIndexerLpFeesLive,
  readApiLpFees: { key: apiLpFeesSnapshotKey, build: (q) => lpFeesSnapshotBuild(q) },
  buildSummary: chainIds ? null : defaultSummaryBuild,
})
  .then((summary) => {
    console.log("[finance-snapshots]", JSON.stringify(summary));
    if (summary.failed > 0) process.exitCode = 1;
  })
  .catch((error) => {
    console.error("[finance-snapshots]", error);
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => undefined));
