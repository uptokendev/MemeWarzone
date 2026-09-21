#!/usr/bin/env node
/**
 * Automated verification of the Quote Asset Catalog for one chain.
 *
 *   node scripts/verify-quote-catalog.mjs --chain 101 [--ids id1,id2] [--no-auto-activate] [--db staging]
 *   node scripts/verify-quote-catalog.mjs --chain all        every chain in turn (the scheduled task)
 *
 * Runs the same verifier the Command Center's VERIFY button uses: chain
 * identity, market data, routes and feeds; writes the snapshot and history;
 * activates assets that pass every gate (unless --no-auto-activate). Meant
 * for a scheduled task on the API container so the catalog stays current.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, fallback = "") => { const i = argv.indexOf(name); return i >= 0 ? String(argv[i + 1] || "") : fallback; };
const chain = arg("--chain");
if (!chain) { console.error("usage: --chain <all|101|101:devnet|56|97|4663|46630> [--ids a,b] [--no-auto-activate] [--db staging]"); process.exit(2); }
const ids = arg("--ids") ? arg("--ids").split(",").map((v) => v.trim()).filter(Boolean) : null;
const autoActivate = !argv.includes("--no-auto-activate");

if (arg("--db") === "staging") {
  const envLocal = fs.readFileSync(path.resolve(here, "../.env.local"), "utf8");
  const url = (envLocal.match(/^STAGING_DATABASE_URL=(.+)$/m) || [])[1]?.trim();
  if (!url || !url.includes("vrnsbguutnwgtekcexls")) { console.error("STAGING_DATABASE_URL (vrnsbguutnwgtekcexls) is required in frontend/.env.local"); process.exit(2); }
  process.env.DATABASE_URL = url;
  process.env.PG_SSL_ALLOW_SELF_SIGNED = process.env.PG_SSL_ALLOW_SELF_SIGNED || "1";
}

const { pool } = await import("../server/db.js");
const { verifyQuoteCatalogChain } = await import("../api/lib/quoteAssetVerification.js");
const { QUOTE_CATALOG_CHAINS } = await import("../api/lib/quoteAssetCatalogAdmin.js");

const chains = chain === "all" ? QUOTE_CATALOG_CHAINS.map((entry) => entry.key) : [chain];
let failures = 0;
for (const key of chains) {
  console.log(`=== ${key}`);
  try {
    const summary = await verifyQuoteCatalogChain({ chain: key, ids, autoActivate, log: (line) => console.log(line) });
    console.log(JSON.stringify({ chain: summary.chain, checked: summary.checked, passed: summary.passed, review: summary.review, failed: summary.failed, activated: summary.activated }));
  } catch (error) {
    failures += 1;
    console.error(`[verify-quote-catalog] ${key} failed: ${String(error?.message || error)}`);
  }
}
await pool.end().catch(() => undefined);
process.exitCode = failures ? 1 : 0;
