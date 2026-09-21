#!/usr/bin/env node
/**
 * Sync the approved quote catalog manifest into the quote_asset_* tables.
 *
 *   node scripts/sync-quote-asset-catalog.mjs --chains 101,56,4663            # dry run (default)
 *   node scripts/sync-quote-asset-catalog.mjs --chains 101,56,4663 --apply    # write, one transaction
 *   node scripts/sync-quote-asset-catalog.mjs --db production ...             # DATABASE_URL instead of STAGING_DATABASE_URL
 *
 * Reads STAGING_DATABASE_URL (default) or DATABASE_URL from the environment or
 * frontend/.env.local / frontend/.env. Dry run only reads. Idempotent: a
 * second run after apply reports zero changes.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const require = createRequire(path.join(root, "frontend", "package.json"));
const { default: pg } = await import(require.resolve("pg"));

function envFromFiles(name) {
  if (process.env[name]) return process.env[name];
  for (const file of [path.join(root, "frontend", ".env.local"), path.join(root, "frontend", ".env")]) {
    if (!fs.existsSync(file)) continue;
    const line = fs.readFileSync(file, "utf8").split("\n").find((l) => l.startsWith(`${name}=`));
    if (line) return line.slice(name.length + 1).trim().replace(/^["']|["']$/g, "");
  }
  return "";
}

const argv = process.argv.slice(2);
const arg = (flag, fallback = "") => (argv.includes(flag) ? String(argv[argv.indexOf(flag) + 1] || "") : fallback);
const apply = argv.includes("--apply");
const target = arg("--db", "staging");
const chainIds = arg("--chains", "101,56,4663").split(",").map((s) => s.trim()).filter(Boolean);
const urlName = target === "production" ? "DATABASE_URL" : "STAGING_DATABASE_URL";
const url = envFromFiles(urlName);
if (!url) { console.error(`${urlName} is not set`); process.exit(1); }
if (target === "staging" && !url.includes("vrnsbguutnwgtekcexls")) { console.error("refusing: STAGING_DATABASE_URL does not point at the staging project"); process.exit(1); }

process.env.DATABASE_URL = url;
process.env.PG_SSL_ALLOW_SELF_SIGNED ||= "1";
const { syncApprovedQuoteCatalog } = await import(path.join(root, "frontend", "api", "lib", "quoteAssetCatalogSync.js"));

const db = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 });
try {
  const { plan, report } = await syncApprovedQuoteCatalog({ db, chainIds, dryRun: !apply });
  console.log(JSON.stringify({
    target, chainIds, mode: apply ? "apply" : "dry-run",
    planned: { providers: plan.providers.length, assets: plan.assets.length, deployments: plan.deployments.length, activePolicies: plan.policies.filter((p) => p.policy_status === "active").length, draftPolicies: plan.policies.filter((p) => p.policy_status === "draft").length },
    report,
  }, null, 2));
  process.exit(0);
} catch (error) {
  console.error(error?.message || error);
  process.exit(1);
} finally {
  await db.end().catch(() => {});
}
