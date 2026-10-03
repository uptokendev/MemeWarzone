import { geckoTerminalNetwork } from "./arenaImportMarketFeed.js";
import { sharedCandleSource } from "./arenaImportCandles.js";

/**
 * Keeps every listed import's default chart (1h) in the API's candle cache, so opening a coin in the
 * War Trade Room or on its page shows its chart even when the GeckoTerminal budget for the minute is
 * spent (2026-10-03: most imports showed an empty chart until the window reset). Uses spare budget
 * only (candleSource.warm keeps a reserve for people opening coins), refreshes a chart at most every
 * 10 minutes, busiest coins first. Runs in the API server process, where the cache lives.
 * IMPORT_CHART_WARMER=off disables it.
 */
export const WARM_INTERVAL_MS = 60_000;

export async function warmImportChartsOnce({ pool, source = sharedCandleSource(), resolution = "1h", maxAgeMs = 10 * 60_000 } = {}) {
  const { rows } = await pool.query(
    `select i.chain_id, i.token_address, s.pair_address
       from public.arena_token_imports i
       join public.arena_import_market_stats s on s.chain_id = i.chain_id and s.token_address = i.token_address
      where i.status = 'passed' and coalesce(s.pair_address, '') <> ''
      order by s.volume_24h_usd desc nulls last
      limit 200`,
  );
  let warmed = 0;
  for (const row of rows) {
    if (source.budgetLeft() <= 4) break;
    const network = geckoTerminalNetwork(row.chain_id);
    if (!network) continue;
    if (await source.warm({ network, pairAddress: row.pair_address, tokenAddress: row.token_address, resolution, maxAgeMs })) warmed += 1;
  }
  return { candidates: rows.length, warmed };
}

export function startImportChartWarmer({ pool, env = process.env, intervalMs = WARM_INTERVAL_MS } = {}) {
  if (!pool || String(env.IMPORT_CHART_WARMER || "").trim().toLowerCase() === "off") return null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await warmImportChartsOnce({ pool });
    } catch (error) {
      console.warn("[import-chart-warmer]", error?.message || error);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, 15_000);
  const timer = setInterval(tick, intervalMs);
  first.unref?.();
  timer.unref?.();
  console.log("[import-chart-warmer] active (1h charts of listed imports, spare GeckoTerminal budget)");
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
