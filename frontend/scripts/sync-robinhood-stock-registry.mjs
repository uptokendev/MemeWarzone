#!/usr/bin/env node
/**
 * Pull Robinhood's canonical stock-token list into the registry and rescan
 * every entry's health -- the same two calls the Command Center's
 * SYNC ROBINHOOD REGISTRY button makes, runnable from a terminal.
 *
 *   node scripts/sync-robinhood-stock-registry.mjs                 # production DATABASE_URL
 *   node scripts/sync-robinhood-stock-registry.mjs --db staging    # STAGING_DATABASE_URL from frontend/.env.local
 *   node scripts/sync-robinhood-stock-registry.mjs --rescan-only   # skip the canonical pull, rescan health
 *   node scripts/sync-robinhood-stock-registry.mjs --rescan-only --symbols SPY,NVDA,AAPL   # only these
 *   node scripts/sync-robinhood-stock-registry.mjs --rescan-only --concurrency 4 --limit 50
 *
 * Prints one line per token as it finishes. Every canonical token is a candidate since
 * 2026-09-24, so a full rescan certifies all 195 against the Robinhood RPC (~20 reads each);
 * run the routed symbols first for a fast answer, then the full list.
 *
 * Run it inside the API container (Coolify > API service > Terminal / Execute
 * command) so the health certification reads the same RPC, factory and stock
 * gate env the API itself uses. A token passes only when its route is
 * configured on the stock adapter, its Chainlink price is fresh and its LP
 * custody checks out; the others report `review` with the reason printed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, fallback = "") => { const i = argv.indexOf(name); return i >= 0 ? String(argv[i + 1] || "") : fallback; };
const rescanOnly = argv.includes("--rescan-only");
const symbols = arg("--symbols").split(",").map((v) => v.trim().toUpperCase()).filter(Boolean);
const concurrency = Math.max(1, Math.min(8, Number(arg("--concurrency", "4")) || 4));
const limit = Math.max(0, Number(arg("--limit", "0")) || 0);

if (arg("--db") === "staging") {
  const envLocal = fs.readFileSync(path.resolve(here, "../.env.local"), "utf8");
  const url = (envLocal.match(/^STAGING_DATABASE_URL=(.+)$/m) || [])[1]?.trim();
  if (!url || !url.includes("vrnsbguutnwgtekcexls")) { console.error("STAGING_DATABASE_URL (vrnsbguutnwgtekcexls) is required in frontend/.env.local"); process.exit(2); }
  process.env.DATABASE_URL = url;
  process.env.PG_SSL_ALLOW_SELF_SIGNED = process.env.PG_SSL_ALLOW_SELF_SIGNED || "1";
}

await import("../api/load-local-env.mjs");
const { pool } = await import("../server/db.js");
const { syncCanonicalRobinhoodStockTokens, refreshRobinhoodStockHealthById } = await import("../api/lib/robinhoodStockGraduationRegistry.js");

const started = Date.now();
const statusOf = (item) => String(item?.automatedHealthStatus || item?.automated_health_status || "?");
const reasonOf = (item) => String(item?.automatedHealthReason || item?.automated_health_reason || "").replace("runtime-parity certification pending: ", "").slice(0, 150);
try {
  if (!rescanOnly) {
    const sync = await syncCanonicalRobinhoodStockTokens({ operatorIdentity: "terminal:sync-robinhood-stock-registry" });
    console.log("canonical sync:", JSON.stringify(sync));
  }
  const where = symbols.length ? "and upper(symbol) = any($2)" : "";
  const params = symbols.length ? [4663, symbols] : [4663];
  const rows = (await pool.query(`select id, symbol from public.robinhood_stock_token_registry where chain_id = $1 ${where} order by symbol asc`, params)).rows;
  const todo = limit ? rows.slice(0, limit) : rows;
  console.log(`rescanning ${todo.length} entries, ${concurrency} at a time${symbols.length ? ` (symbols: ${symbols.join(",")})` : ""}`);
  const items = [];
  let index = 0;
  let done = 0;
  const worker = async () => {
    while (index < todo.length) {
      const row = todo[index++];
      try {
        const item = await refreshRobinhoodStockHealthById(row.id);
        items.push(item);
        done += 1;
        console.log(`[${String(done).padStart(3)}/${todo.length}] ${String(row.symbol).padEnd(6)} ${statusOf(item).padEnd(9)} ${statusOf(item) === "healthy" ? "" : reasonOf(item)}`);
      } catch (error) {
        done += 1;
        console.log(`[${String(done).padStart(3)}/${todo.length}] ${String(row.symbol).padEnd(6)} ERROR     ${String(error?.message || error).slice(0, 150)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  const byStatus = new Map();
  for (const item of items) byStatus.set(statusOf(item), (byStatus.get(statusOf(item)) || 0) + 1);
  console.log(`rescanned ${items.length} entries in ${Math.round((Date.now() - started) / 1000)}s:`, [...byStatus].map(([s, n]) => `${s}=${n}`).join("  "));
  const healthy = items.filter((item) => statusOf(item) === "healthy").map((item) => item.symbol);
  console.log("enabled for new graduations:", healthy.length ? healthy.join(" ") : "none");
  const reasons = new Map();
  for (const item of items) {
    if (statusOf(item) === "healthy") continue;
    const reason = reasonOf(item);
    reasons.set(reason, (reasons.get(reason) || 0) + 1);
  }
  for (const [reason, n] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  [${n}] ${reason}`);
  process.exitCode = 0;
} catch (error) {
  console.error("sync failed:", error?.message || error);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
