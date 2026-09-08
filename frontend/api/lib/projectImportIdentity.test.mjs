import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import pg from "pg";

import { enrichExistingProjectIdentity } from "../projectImports.js";

const { Pool } = pg;
const databaseUrl = process.env.PROJECT_IMPORT_TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("PROJECT_IMPORT_TEST_DATABASE_URL or DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseUrl });
const migration = fs.readFileSync(
  new URL("../../../db/migrations/20260908_000001_project_import_onboarding.sql", import.meta.url),
  "utf8",
);

const BNB_TOKEN = "0x0000000000000000000000000000000000000a61";
const SOL_MINT = "So11111111111111111111111111111111111111112";

async function reset() {
  await pool.query("DROP TABLE IF EXISTS public.arena_token_imports CASCADE");
  await pool.query(migration);
}

async function insertProject(chainId, tokenAddress, name = null, symbol = null) {
  await pool.query(`
    INSERT INTO public.arena_token_imports(chain_id, token_address, owner_wallet, name, symbol)
    VALUES($1,$2,'', $3, $4)
  `, [chainId, tokenAddress, name, symbol]);
}

before(async () => {
  await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
});

after(async () => {
  await pool.query("DROP TABLE IF EXISTS public.arena_token_imports CASCADE");
  await pool.end();
});

test("BNB existing blank identity is backfilled from resolver display metadata", async () => {
  await reset();
  await insertProject(56, BNB_TOKEN);
  await enrichExistingProjectIdentity(
    { chainId: 56, tokenAddress: BNB_TOKEN },
    { name: "BNB Meme", symbol: "BNBM" },
  );
  const row = (await pool.query("SELECT name,symbol FROM public.arena_token_imports WHERE chain_id=56 AND token_address=$1", [BNB_TOKEN])).rows[0];
  assert.equal(row.name, "BNB Meme");
  assert.equal(row.symbol, "BNBM");
});

test("Solana existing blank identity is backfilled from resolver display metadata", async () => {
  await reset();
  await insertProject(101, SOL_MINT);
  await enrichExistingProjectIdentity(
    { chainId: 101, tokenAddress: SOL_MINT },
    { name: "Derpy Dave", symbol: "DERPY" },
  );
  const row = (await pool.query("SELECT name,symbol FROM public.arena_token_imports WHERE chain_id=101 AND token_address=$1", [SOL_MINT])).rows[0];
  assert.equal(row.name, "Derpy Dave");
  assert.equal(row.symbol, "DERPY");
});

test("identity refresh preserves intentionally nonblank profile name and symbol", async () => {
  await reset();
  await insertProject(56, BNB_TOKEN, "Edited Project Name", "EDIT");
  await enrichExistingProjectIdentity(
    { chainId: 56, tokenAddress: BNB_TOKEN },
    { name: "Chain Name", symbol: "CHAIN" },
  );
  const row = (await pool.query("SELECT name,symbol FROM public.arena_token_imports WHERE chain_id=56 AND token_address=$1", [BNB_TOKEN])).rows[0];
  assert.equal(row.name, "Edited Project Name");
  assert.equal(row.symbol, "EDIT");
});

test("partial blank identity only fills the missing field", async () => {
  await reset();
  await insertProject(101, SOL_MINT, "Custom Derpy", null);
  await enrichExistingProjectIdentity(
    { chainId: 101, tokenAddress: SOL_MINT },
    { name: "On-chain Derpy", symbol: "DERPY" },
  );
  const row = (await pool.query("SELECT name,symbol FROM public.arena_token_imports WHERE chain_id=101 AND token_address=$1", [SOL_MINT])).rows[0];
  assert.equal(row.name, "Custom Derpy");
  assert.equal(row.symbol, "DERPY");
});

test("unavailable display metadata leaves project usable and unchanged", async () => {
  await reset();
  await insertProject(101, SOL_MINT);
  const result = await enrichExistingProjectIdentity(
    { chainId: 101, tokenAddress: SOL_MINT },
    { name: null, symbol: null },
  );
  assert.equal(result, null);
  const row = (await pool.query("SELECT name,symbol,ownership_status FROM public.arena_token_imports WHERE chain_id=101 AND token_address=$1", [SOL_MINT])).rows[0];
  assert.equal(row.name, null);
  assert.equal(row.symbol, null);
  assert.equal(row.ownership_status, "ownership_pending");
});
