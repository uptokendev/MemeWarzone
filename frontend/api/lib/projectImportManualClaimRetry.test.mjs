import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import pg from "pg";

import { createProjectImport, requestManualProjectClaim } from "./projectImportCore.js";

const { Pool } = pg;
const databaseUrl = process.env.PROJECT_IMPORT_TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("PROJECT_IMPORT_TEST_DATABASE_URL or DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseUrl });
const migration = fs.readFileSync(
  new URL("../../../db/migrations/20260908_000001_project_import_onboarding.sql", import.meta.url),
  "utf8",
);
const TOKEN = "0x0000000000000000000000000000000000000777";
const REGISTRAR = "0x0000000000000000000000000000000000000111";
const CLAIMANT = "0x0000000000000000000000000000000000000222";
const OTHER = "0x0000000000000000000000000000000000000333";

before(async () => {
  await pool.query("DROP TABLE IF EXISTS public.arena_token_imports CASCADE");
  await pool.query(migration);
  await createProjectImport(pool, {
    resolverResult: {
      chainId: 56,
      tokenAddress: TOKEN,
      name: "Retry Token",
      symbol: "RETRY",
      decimals: 18,
      totalSupply: "1000000",
      automaticOwnershipAvailable: false,
      currentAuthority: null,
      signedWalletMatchesAuthority: false,
    },
    signedWallet: REGISTRAR,
  });
});

after(async () => {
  await pool.query("DROP TABLE IF EXISTS public.arena_token_imports CASCADE");
  await pool.end();
});

test("same signed claimant retry is idempotent and does not open a second request", async () => {
  const first = await requestManualProjectClaim(pool, {
    chainId: 56,
    tokenAddress: TOKEN,
    signedWallet: CLAIMANT,
    note: "manual evidence",
  });
  const firstRequestedAt = new Date(first.manual_claim_requested_at).toISOString();
  const second = await requestManualProjectClaim(pool, {
    chainId: 56,
    tokenAddress: TOKEN,
    signedWallet: CLAIMANT,
    note: "manual evidence",
  });
  assert.equal(second.ownership_status, "ownership_manual_review");
  assert.equal(second.manual_claim_wallet, CLAIMANT);
  assert.equal(new Date(second.manual_claim_requested_at).toISOString(), firstRequestedAt);
  assert.equal(second.project_owner_wallet, null);
  const count = await pool.query("SELECT count(*)::int AS n FROM public.arena_token_imports WHERE chain_id=56 AND token_address=$1", [TOKEN]);
  assert.equal(count.rows[0].n, 1);
});

test("different claimant cannot replace an in-review project ownership claim", async () => {
  await assert.rejects(
    () => requestManualProjectClaim(pool, {
      chainId: 56,
      tokenAddress: TOKEN,
      signedWallet: OTHER,
      note: "competing claim",
    }),
    (error) => error?.code === "OWNERSHIP_CONFLICT",
  );
  const row = (await pool.query("SELECT manual_claim_wallet,ownership_status,project_owner_wallet FROM public.arena_token_imports WHERE chain_id=56 AND token_address=$1", [TOKEN])).rows[0];
  assert.equal(row.manual_claim_wallet, CLAIMANT);
  assert.equal(row.ownership_status, "ownership_manual_review");
  assert.equal(row.project_owner_wallet, null);
});
