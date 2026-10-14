#!/usr/bin/env node
/**
 * One-off admission scan for imported tokens still at status=scanning.
 *
 *   node scripts/backfill-import-admission.mjs
 *   node scripts/backfill-import-admission.mjs --db staging
 *   node scripts/backfill-import-admission.mjs --limit 20
 *   node scripts/backfill-import-admission.mjs --rescan-stale
 *
 * Default: rows still at status=scanning. --rescan-stale also rescans every
 * import whose scan is older than arenaImportEligibility's freshness window
 * (or the wrong scan version). Idempotent. A failed scan stores needs_review
 * and never deletes the import. Founder runs the hourly Coolify task with
 * --rescan-stale so IMPORT_SCAN_STALE never silently drops a coin from battles.
 * --rescan-stale also rescans imports declined only because their chain was not
 * scanned yet (unsupported_chain, no admin decision) once the scanner supports
 * that chain -- Robinhood since 2026-10-11.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, fallback = "") => {
  const i = argv.indexOf(name);
  return i >= 0 ? String(argv[i + 1] || "") : fallback;
};

if (arg("--db") === "staging") {
  const envLocal = fs.readFileSync(path.resolve(here, "../.env.local"), "utf8");
  const url = (envLocal.match(/^STAGING_DATABASE_URL=(.+)$/m) || [])[1]?.trim();
  if (!url || !url.includes("vrnsbguutnwgtekcexls")) {
    console.error("STAGING_DATABASE_URL (vrnsbguutnwgtekcexls) is required in frontend/.env.local");
    process.exit(2);
  }
  process.env.DATABASE_URL = url;
  process.env.PG_SSL_ALLOW_SELF_SIGNED = process.env.PG_SSL_ALLOW_SELF_SIGNED || "1";
}

await import("../api/load-local-env.mjs");
const { pool } = await import("../server/db.js");
const { runAdmissionScanForProject } = await import("../api/lib/arenaImportAdmission.js");
const { importScanFreshness } = await import("../api/lib/arenaImportEligibility.js");
const { importScannerChainFamily } = await import("../api/lib/arenaImportScan.js");

const limit = Math.max(1, Math.min(500, Number(arg("--limit", "100")) || 100));
const rescanStale = argv.includes("--rescan-stale");
// Declined rows on a chain the scanner still cannot read would otherwise sit at the front of the
// oldest-first queue every hour and crowd out real rescans.
const SCANNABLE_CHAINS = [56, 97, 101, 102, 4663, 46630].filter((id) => importScannerChainFamily(id) !== null);
const listed = await pool.query(
  rescanStale
    ? `select * from public.arena_token_imports
        where status in ('scanning', 'passed', 'needs_review')
           or (status = 'declined' and reviewed_at is null and scan_json -> 'reasons' ? 'unsupported_chain'
               and chain_id = any($2::int[]))
        order by scanned_at asc nulls first, created_at asc
        limit $1`
    : `select * from public.arena_token_imports
        where status = 'scanning'
        order by created_at asc
        limit $1`,
  rescanStale ? [limit, SCANNABLE_CHAINS] : [limit],
);
// A declined row is only listed when its chain became scannable (query above): rescan it now.
const rows = rescanStale
  ? listed.rows.filter((row) => String(row.status) === "declined" || importScanFreshness(row).stale)
  : listed.rows;

console.log(
  rescanStale
    ? `rescanning ${rows.length} stale import(s) of ${listed.rows.length} considered`
    : `scanning ${rows.length} import(s) still at status=scanning`,
);
for (const row of rows) {
  try {
    const next = await runAdmissionScanForProject((text, params) => pool.query(text, params), row);
    console.log(JSON.stringify({
      id: row.id,
      chainId: row.chain_id,
      tokenAddress: row.token_address,
      from: row.status,
      to: next?.status || row.status,
      scanVersion: next?.scan_version || null,
    }));
  } catch (error) {
    console.log(JSON.stringify({
      id: row.id,
      chainId: row.chain_id,
      tokenAddress: row.token_address,
      from: row.status,
      to: "needs_review",
      error: String(error?.message || error),
    }));
  }
}

await pool.end();
