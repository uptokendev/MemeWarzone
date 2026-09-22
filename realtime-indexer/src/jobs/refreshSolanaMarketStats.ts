/**
 * One pass of the Solana normalized market-stats writer, for a scheduled
 * task or a manual backfill:
 *
 *   npm run job:refresh-solana-market-stats
 *
 * Exits non-zero when nothing could be refreshed so a scheduler notices.
 */
import { pool } from "../db.js";
import { refreshAllSolanaMarketStats } from "../solanaMarketStats.js";

const watchdog = setTimeout(() => {
  console.error("[refresh-solana-market-stats] watchdog: exceeded 10 minutes");
  process.exit(2);
}, 10 * 60_000);
watchdog.unref?.();

try {
  const result = await refreshAllSolanaMarketStats({ log: (line) => console.warn(line) });
  console.log(JSON.stringify({ ok: true, ...result }));
  process.exitCode = result.candidates > 0 && result.refreshed === 0 ? 1 : 0;
} catch (error) {
  console.error("[refresh-solana-market-stats] failed", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => undefined);
}
