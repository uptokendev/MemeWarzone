/**
 * Throwaway local Postgres for DBC step-5 tests and the devnet proof.
 * initdb into a temp dir, listen on 55432, apply the minimum schema, stop and remove.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requireFromIndexer = createRequire(new URL("../../realtime-indexer/package.json", import.meta.url));
const { Pool } = requireFromIndexer("pg");

const PORT = Number(process.env.DBC_THROWAY_PG_PORT || 55432);
const PG_BIN = process.env.DBC_PG_BIN || "/usr/lib/postgresql/14/bin";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function run(bin, args, opts = {}) {
  const result = spawnSync(path.join(PG_BIN, bin), args, { encoding: "utf8", ...opts });
  if (result.status !== 0) {
    throw new Error(`${bin} ${args.join(" ")} failed: ${result.stderr || result.stdout || result.status}`);
  }
  return result.stdout;
}

export async function startThrowawayPostgres() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mwz-dbc-pg-"));
  run("initdb", ["-D", dir, "--auth=trust", "-U", "postgres", "--no-instructions"]);
  fs.appendFileSync(path.join(dir, "pg_hba.conf"), "\nhost all all 127.0.0.1/32 trust\nhost all all ::1/128 trust\n");
  const logFile = path.join(dir, "pg.log");
  run("pg_ctl", ["-D", dir, "-l", logFile, "-o", `-p ${PORT} -k ${dir}`, "start"]);
  const url = `postgres://postgres@127.0.0.1:${PORT}/postgres`;
  const admin = new Pool({ connectionString: url, ssl: false });
  for (let i = 0; i < 20; i += 1) {
    try {
      await admin.query("select 1");
      break;
    } catch (error) {
      if (i === 19) throw error;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  await admin.query("create database mwz");
  await admin.end();
  const dbUrl = `postgres://postgres@127.0.0.1:${PORT}/mwz`;
  const psql = path.join(PG_BIN, "psql");
  const apply = (file) => {
    const result = spawnSync(psql, ["-h", "127.0.0.1", "-p", String(PORT), "-U", "postgres", "-d", "mwz", "-v", "ON_ERROR_STOP=1", "-f", file], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`psql ${file} failed: ${result.stderr || result.stdout}`);
    }
  };
  apply(path.join(ROOT, "scripts/dbc/throwaway-postgres-schema.sql"));
  apply(path.join(ROOT, "db/migrations/20260929_000006_dbc_fee_accruals.sql"));
  apply(path.join(ROOT, "db/migrations/20260929_000007_dbc_graduation.sql"));
  apply(path.join(ROOT, "db/migrations/20260929_000008_dbc_creator_choice.sql"));
  apply(path.join(ROOT, "db/migrations/20260929_000009_dbc_quote_binding.sql"));
  apply(path.join(ROOT, "db/migrations/20260929_000010_dbc_payout_quote.sql"));
  const pool = new Pool({ connectionString: dbUrl, ssl: false });
  async function stop() {
    await pool.end().catch(() => {});
    spawnSync(path.join(PG_BIN, "pg_ctl"), ["-D", dir, "-m", "immediate", "stop"], { encoding: "utf8" });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { dir, url: dbUrl, pool, stop, port: PORT };
}
