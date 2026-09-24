#!/usr/bin/env node
/**
 * One-off admission scan for imported tokens still at status=scanning.
 *
 *   node scripts/backfill-import-admission.mjs
 *   node scripts/backfill-import-admission.mjs --db staging
 *   node scripts/backfill-import-admission.mjs --limit 20
 *
 * Idempotent: rows that are no longer scanning are skipped. A failed scan
 * stores needs_review and never deletes the import. Founder runs this in the
 * API container after deploy.
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

const limit = Math.max(1, Math.min(500, Number(arg("--limit", "100")) || 100));
const listed = await pool.query(
  `select * from public.arena_token_imports
    where status = 'scanning'
    order by created_at asc
    limit $1`,
  [limit],
);

console.log(`scanning ${listed.rows.length} import(s) still at status=scanning`);
for (const row of listed.rows) {
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
