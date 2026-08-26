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
const SOLANA_WALLET_CASE_MIGRATION = "20260708_000001_recruiter_solana_wallet_case.sql";
const WAR_TRADE_ROOM_MIGRATION = "202607290001_war_trade_room_market_continuity_foundation.sql";
const REQUIRED_POSTGRES_VERSION_NUM = 160000;

// These files belong to historical subsystems whose source tables were created by
// database streams outside db/migrations (legacy league, waitlist, WM, reward and
// admin schemas). They are intentionally outside the isolated Robinhood launchpad
// runtime. Do not invent placeholder production tables merely to make them replay.
const LOCAL_REPLAY_OPTIONAL_MIGRATIONS = new Set([
  "20260213_000003_claim_expiry_rollover.sql",
  "20260512_000021_recruiter_waitlist_to_recruiters_sync.sql",
  "20260518_000024_wm_telegram_link_challenges.sql",
  "20260518_000025_wm_discord_link_challenges.sql",
  "20260710_000002_weekly_airdrop_automation_guards.sql",
  "20260821_000004_partner_listings_rls.sql",
  "20260821_000005_sponsorship_admin_rls.sql",
]);

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

async function ensurePostgresVersion(client) {
  const result = await client.query(`
    select
      current_setting('server_version_num')::int as version_num,
      current_setting('server_version') as version
  `);
  const versionNum = Number(result.rows[0]?.version_num || 0);
  const version = String(result.rows[0]?.version || "unknown");
  if (versionNum < REQUIRED_POSTGRES_VERSION_NUM) {
    throw new Error(
      `Robinhood local development requires PostgreSQL 16+ to match CI; connected server is ${version}. ` +
      `Point DATABASE_URL at the PostgreSQL 16 local cluster before bootstrapping.`,
    );
  }
  console.log(`[robinhood-local-db] PostgreSQL ${version} compatibility confirmed`);
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

async function ensureCompatibilityHelpers(client) {
  // The production database acquired this helper through the historical Supabase
  // migration stream, while db/migrations later assumes it already exists. A clean
  // local replay only consumes db/migrations, so reproduce the exact canonical
  // helper locally rather than rewriting production migration history.
  await client.query(`
    create or replace function public.set_updated_at()
    returns trigger
    language plpgsql
    as $$
    begin
      new.updated_at = now();
      return new;
    end;
    $$
  `);
}

async function ensureLaunchpadCompatibilitySchema(client) {
  const exists = await client.query("select to_regclass('public.campaigns') as relation");
  if (!exists.rows[0]?.relation) return false;

  // Production acquired these campaign fields through the canonical indexer schema
  // repair (realtime-indexer/SUPABASE_SCHEMA_FIX.sql). Later ticker/WTR migrations
  // legitimately depend on them, but a clean db/migrations-only replay never sees
  // that repair file. Reproduce only those canonical campaign columns locally.
  await client.query(`
    alter table public.campaigns
      add column if not exists logo_uri text,
      add column if not exists created_at_chain timestamptz,
      add column if not exists factory_address text,
      add column if not exists graduated_at_chain timestamptz,
      add column if not exists graduated_block bigint,
      add column if not exists fee_recipient_address text
  `);

  const createdBlock = await client.query(`
    select 1
    from information_schema.columns
    where table_schema='public' and table_name='campaigns' and column_name='created_block'
  `);
  if (createdBlock.rowCount) {
    await client.query(`
      create index if not exists campaigns_chain_factory_idx
        on public.campaigns(chain_id, factory_address);
      create index if not exists campaigns_chain_created_block_idx
        on public.campaigns(chain_id, created_block);
      create index if not exists campaigns_chain_graduated_at_idx
        on public.campaigns(chain_id, graduated_at_chain desc)
    `);
  }

  return true;
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

function stripStandaloneTransactionControl(sql) {
  // A number of historical files carry their own BEGIN/COMMIT lines. The local
  // replay engine supplies the transaction so a failed/deferred migration can
  // always roll back cleanly. Only standalone control lines are removed; PL/pgSQL
  // BEGIN blocks do not match because they are not written as `BEGIN;` lines.
  return String(sql)
    .split(/\r?\n/)
    .filter((line) => !/^\s*(BEGIN|COMMIT)\s*;\s*(?:--.*)?$/i.test(line))
    .join("\n");
}

function applyLocalReplayCompatibility(filename, sql) {
  if (filename !== WAR_TRADE_ROOM_MIGRATION) return sql;

  // 003_indexer.sql historically created bonding raw amounts as NUMERIC while
  // the later unified market view unions them with DEX raw amounts stored as TEXT.
  // Existing production databases had evolved schema state when WTR was applied;
  // a brand-new replay does not. Cast only the bonding side in the local replay so
  // the view exposes the intended raw-string API without changing historical SQL.
  const replacements = [
    ['t.token_amount_raw as "tokenAmountRaw"', 't.token_amount_raw::text as "tokenAmountRaw"'],
    ['t.bnb_amount_raw as "nativeAmountRaw"', 't.bnb_amount_raw::text as "nativeAmountRaw"'],
  ];
  let patched = sql;
  for (const [from, to] of replacements) {
    const count = patched.split(from).length - 1;
    if (count !== 1) {
      throw new Error(
        `Local WTR compatibility patch expected exactly one occurrence of ${from}; found ${count}.`,
      );
    }
    patched = patched.replace(from, to);
  }
  console.log("[robinhood-local-db] applying clean-replay raw amount compatibility for WTR view");
  return patched;
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function capturePublicViews(client) {
  const viewRows = await client.query(`
    select
      c.oid::text as oid,
      n.nspname as schema_name,
      c.relname as view_name,
      pg_get_viewdef(c.oid, true) as definition
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'v'
      and n.nspname = 'public'
    order by c.relname
  `);

  const dependencyRows = await client.query(`
    select distinct
      v.oid::text as view_oid,
      dep.oid::text as dependency_oid
    from pg_class v
    join pg_namespace vn on vn.oid = v.relnamespace
    join pg_rewrite r on r.ev_class = v.oid
    join pg_depend d on d.objid = r.oid
    join pg_class dep on dep.oid = d.refobjid
    join pg_namespace dn on dn.oid = dep.relnamespace
    where v.relkind = 'v'
      and dep.relkind = 'v'
      and vn.nspname = 'public'
      and dn.nspname = 'public'
      and dep.oid <> v.oid
  `);

  const views = viewRows.rows.map((row) => ({
    oid: String(row.oid),
    schema: String(row.schema_name),
    name: String(row.view_name),
    definition: String(row.definition),
    dependencies: new Set(),
  }));
  const byOid = new Map(views.map((view) => [view.oid, view]));
  for (const row of dependencyRows.rows) {
    const view = byOid.get(String(row.view_oid));
    if (view && byOid.has(String(row.dependency_oid))) {
      view.dependencies.add(String(row.dependency_oid));
    }
  }
  return views;
}

function topologicalViews(views) {
  const remaining = new Map(views.map((view) => [view.oid, view]));
  const ordered = [];
  while (remaining.size) {
    const ready = [...remaining.values()].filter((view) =>
      [...view.dependencies].every((oid) => !remaining.has(oid)),
    );
    if (!ready.length) {
      throw new Error(`Could not resolve public view dependency order: ${[...remaining.values()].map((v) => v.name).join(", ")}`);
    }
    ready.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const view of ready) {
      ordered.push(view);
      remaining.delete(view.oid);
    }
  }
  return ordered;
}

async function dropAndRestoreViewsAroundMigration(client, sql) {
  const views = await capturePublicViews(client);
  if (!views.length) {
    await client.query(sql);
    return;
  }

  const ordered = topologicalViews(views);
  console.log(`[robinhood-local-db] preserving ${ordered.length} public view(s) around wallet type migration`);

  // Dependents first, no CASCADE: if a non-view object unexpectedly depends on a
  // read-model view, the local bootstrap fails instead of silently deleting it.
  for (const view of [...ordered].reverse()) {
    await client.query(`drop view ${quoteIdent(view.schema)}.${quoteIdent(view.name)}`);
  }

  await client.query(sql);

  for (const view of ordered) {
    await client.query(
      `create view ${quoteIdent(view.schema)}.${quoteIdent(view.name)} as ${view.definition}`,
    );
  }
}

async function runMigrationTransaction(client, filename, rawSql) {
  const strippedSql = stripStandaloneTransactionControl(rawSql);
  const sql = applyLocalReplayCompatibility(filename, strippedSql);
  await client.query("begin");
  try {
    if (filename === SOLANA_WALLET_CASE_MIGRATION) {
      await dropAndRestoreViewsAroundMigration(client, sql);
    } else {
      await client.query(sql);
    }
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
    await ensurePostgresVersion(client);
    await ensureCompatibilityRoles(client);
    await ensureCompatibilityHelpers(client);
    await ensureLaunchpadCompatibilitySchema(client);
    await client.query(`
      create table if not exists public._mwz_local_migrations (
        filename text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const migrationsDir = path.join(repoRoot, "db", "migrations");
    const allFiles = fs
      .readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort((a, b) => a.localeCompare(b, "en"));
    const skippedOptional = allFiles.filter((filename) => LOCAL_REPLAY_OPTIONAL_MIGRATIONS.has(filename));
    const files = allFiles.filter((filename) => !LOCAL_REPLAY_OPTIONAL_MIGRATIONS.has(filename));

    if (skippedOptional.length) {
      console.log(
        `[robinhood-local-db] excluding ${skippedOptional.length} unrelated historical migration(s) from isolated launchpad replay: ` +
        skippedOptional.join(", "),
      );
    }

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
          if (filename === "003_indexer.sql") {
            await ensureLaunchpadCompatibilitySchema(client);
          }
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
          `Local launchpad migration replay is blocked by unresolved required dependencies after a full pass:\n${details}`,
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
      throw new Error(`Local launchpad migration ledger incomplete: ${remaining.rows[0]?.count || 0} required migration(s) missing.`);
    }

    console.log(`[robinhood-local-db] schema ready (${applied} new migration${applied === 1 ? "" : "s"}; ${skippedOptional.length} unrelated historical migration${skippedOptional.length === 1 ? "" : "s"} excluded).`);
  } finally {
    await client.end();
  }
}

await ensureDatabase();
await applyMigrations();
console.log(`[robinhood-local-db] ready: ${targetUrl.hostname}:${targetUrl.port || "5432"}/${dbName}`);
