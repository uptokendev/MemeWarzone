#!/usr/bin/env node
/**
 * Pull Robinhood's canonical stock-token list into the registry and rescan
 * every entry's health -- the same two calls the Command Center's
 * SYNC ROBINHOOD REGISTRY button makes, runnable from a terminal.
 *
 *   node scripts/sync-robinhood-stock-registry.mjs                 # production DATABASE_URL
 *   node scripts/sync-robinhood-stock-registry.mjs --db staging    # STAGING_DATABASE_URL from frontend/.env.local
 *   node scripts/sync-robinhood-stock-registry.mjs --rescan-only   # skip the canonical pull, rescan health
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

if (arg("--db") === "staging") {
  const envLocal = fs.readFileSync(path.resolve(here, "../.env.local"), "utf8");
  const url = (envLocal.match(/^STAGING_DATABASE_URL=(.+)$/m) || [])[1]?.trim();
  if (!url || !url.includes("vrnsbguutnwgtekcexls")) { console.error("STAGING_DATABASE_URL (vrnsbguutnwgtekcexls) is required in frontend/.env.local"); process.exit(2); }
  process.env.DATABASE_URL = url;
  process.env.PG_SSL_ALLOW_SELF_SIGNED = process.env.PG_SSL_ALLOW_SELF_SIGNED || "1";
}

await import("../api/load-local-env.mjs");
const { pool } = await import("../server/db.js");
const { syncCanonicalRobinhoodStockTokens, refreshAllRobinhoodStockHealth } = await import("../api/lib/robinhoodStockGraduationRegistry.js");

const started = Date.now();
try {
  if (!rescanOnly) {
    const sync = await syncCanonicalRobinhoodStockTokens({ operatorIdentity: "terminal:sync-robinhood-stock-registry" });
    console.log("canonical sync:", JSON.stringify(sync));
  }
  const items = await refreshAllRobinhoodStockHealth();
  const byStatus = new Map();
  for (const item of items) {
    const status = String(item?.automatedHealthStatus || item?.automated_health_status || "?");
    byStatus.set(status, (byStatus.get(status) || 0) + 1);
  }
  console.log(`rescanned ${items.length} entries in ${Math.round((Date.now() - started) / 1000)}s:`, [...byStatus].map(([s, n]) => `${s}=${n}`).join("  "));
  const healthy = items.filter((item) => String(item?.automatedHealthStatus || item?.automated_health_status) === "healthy").map((item) => item.symbol);
  console.log("enabled for new graduations:", healthy.length ? healthy.join(" ") : "none");
  const reasons = new Map();
  for (const item of items) {
    const status = String(item?.automatedHealthStatus || item?.automated_health_status);
    if (status === "healthy") continue;
    const reason = String(item?.automatedHealthReason || item?.automated_health_reason || "").slice(0, 160);
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
