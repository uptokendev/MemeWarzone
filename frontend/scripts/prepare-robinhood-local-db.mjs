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

    let applied = 0;
    for (const filename of files) {
      const seen = await client.query("select 1 from public._mwz_local_migrations where filename=$1", [filename]);
      if (seen.rowCount) continue;

      const sql = fs.readFileSync(path.join(migrationsDir, filename), "utf8");
      console.log(`[robinhood-local-db] applying ${filename}`);
      try {
        await client.query(sql);
        await client.query("insert into public._mwz_local_migrations(filename) values($1)", [filename]);
        applied += 1;
      } catch (error) {
        console.error(`[robinhood-local-db] migration failed: ${filename}`);
        throw error;
      }
    }

    console.log(`[robinhood-local-db] schema ready (${applied} new migration${applied === 1 ? "" : "s"}).`);
  } finally {
    await client.end();
  }
}

await ensureDatabase();
await applyMigrations();
console.log(`[robinhood-local-db] ready: ${targetUrl.hostname}:${targetUrl.port || "5432"}/${dbName}`);
