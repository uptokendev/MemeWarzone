#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  buildRobinhoodLocalEnv,
  configPathFromRepoRoot,
  loadSimpleEnvFile,
} from "./robinhood-local-env.mjs";

const { Client } = pg;
const here = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(here, "..");
const repoRoot = path.resolve(frontendDir, "..");
const configPath = configPathFromRepoRoot(repoRoot);
const fileEnv = loadSimpleEnvFile(configPath);

let env;
try {
  env = buildRobinhoodLocalEnv(process.env, fileEnv);
} catch (error) {
  console.error(`[robinhood-local-db] preflight failed: ${error?.message || error}`);
  process.exit(1);
}

const targetUrl = new URL(env.DATABASE_URL);
const dbName = decodeURIComponent(targetUrl.pathname.replace(/^\//, ""));
if (!/^[A-Za-z0-9_]+$/.test(dbName)) {
  throw new Error(`Unsafe local database name: ${dbName}`);
}

const adminUrl = new URL(targetUrl.toString());
adminUrl.pathname = "/postgres";

async function ensureDatabase() {
  const admin = new Client({ connectionString: adminUrl.toString(), ssl: false });
  await admin.connect();
  try {
    const exists = await admin.query("select 1 from pg_database where datname=$1", [dbName]);
    if (!exists.rowCount) {
      await admin.query(`create database "${dbName}"`);
      console.log(`[robinhood-local-db] created ${dbName}`);
    } else {
      console.log(`[robinhood-local-db] database exists: ${dbName}`);
    }
  } finally {
    await admin.end();
  }
}

async function ensureCompatibilityRoles(client) {
  for (const role of ["anon", "authenticated", "service_role"]) {
    try {
      await client.query(`do $$ begin create role ${role} nologin; exception when duplicate_object then null; end $$;`);
    } catch (error) {
      console.warn(`[robinhood-local-db] could not create compatibility role ${role}: ${error?.message || error}`);
      console.warn("[robinhood-local-db] If a migration later needs this role, run the bootstrap with your local PostgreSQL admin account.");
    }
  }
}

const DEFERABLE_DEPENDENCY_CODES = new Set([
  "42P01", // undefined_table / relation
  "42703", // undefined_column
  "42883", // undefined_function
  "42704", // undefined_object / type / role-like dependency
  "3F000", // invalid_schema_name
]);

function migrationErrorSummary(error) {
  const code = String(error?.code || "unknown");
  const message = String(error?.message || error || "unknown error").replace(/\s+/g, " ").trim();
  return `${code}: ${message}`;
}

async function runMigrationTransaction(client, filename, sql) {
  await client.query("begin");
  try {
    await client.query(sql);
    await client.query("insert into public._mwz_local_migrations(filename) values($1)", [filename]);
    await client.query("commit");
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {}
    throw error;
  }
}

async function applyMigrations() {
  const client = new Client({ connectionString: targetUrl.toString(), ssl: false });
  await client.connect();
  try {
    await ensureCompatibilityRoles(client);
    await client.query(`
      create table if not exists public._mwz_local_migrations (
        filename text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const migrationsDir = path.join(repoRoot, "db", "migrations");
    const files = fs
      .readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort((a, b) => a.localeCompare(b, "en"));

    const appliedRows = await client.query("select filename from public._mwz_local_migrations");
    const alreadyApplied = new Set(appliedRows.rows.map((row) => String(row.filename)));
    let pending = files.filter((filename) => !alreadyApplied.has(filename));
    let applied = 0;
    const lastErrors = new Map();

    // Historical production migrations were accumulated incrementally and a few
    // early numeric filenames alter objects introduced by later dated migrations.
    // For a brand-new local DB we therefore replay dependency-aware: missing
    // object dependencies are deferred, then retried after later migrations have
    // had a chance to create them. We never rewrite or reorder production files.
    while (pending.length) {
      let progress = 0;
      const deferred = [];

      for (const filename of pending) {
        const sql = fs.readFileSync(path.join(migrationsDir, filename), "utf8");
        console.log(`[robinhood-local-db] applying ${filename}`);
        try {
          await runMigrationTransaction(client, filename, sql);
          applied += 1;
          progress += 1;
          lastErrors.delete(filename);
        } catch (error) {
          const code = String(error?.code || "");
          if (DEFERABLE_DEPENDENCY_CODES.has(code)) {
            const summary = migrationErrorSummary(error);
            lastErrors.set(filename, summary);
            deferred.push(filename);
            console.log(`[robinhood-local-db] deferring ${filename} (${summary})`);
            continue;
          }
          console.error(`[robinhood-local-db] migration failed: ${filename}`);
          throw error;
        }
      }

      if (!deferred.length) break;
      if (progress === 0) {
        const details = deferred
          .map((filename) => `- ${filename}: ${lastErrors.get(filename) || "unresolved dependency"}`)
          .join("\n");
        throw new Error(
          `Local migration replay is blocked by unresolved dependencies after a full pass:\n${details}`,
        );
      }
      pending = deferred;
    }

    const remaining = await client.query(`
      select count(*)::int as count
      from (
        select unnest($1::text[]) as filename
        except
        select filename from public._mwz_local_migrations
      ) missing
    `, [files]);
    if (Number(remaining.rows[0]?.count || 0) !== 0) {
      throw new Error(`Local migration ledger incomplete: ${remaining.rows[0]?.count || 0} migration(s) missing.`);
    }

    console.log(`[robinhood-local-db] schema ready (${applied} new migration${applied === 1 ? "" : "s"}).`);
  } finally {
    await client.end();
  }
}

await ensureDatabase();
await applyMigrations();
console.log(`[robinhood-local-db] ready: ${targetUrl.hostname}:${targetUrl.port || "5432"}/${dbName}`);
