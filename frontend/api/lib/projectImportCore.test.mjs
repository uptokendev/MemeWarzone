import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import pg from "pg";
import { ethers } from "ethers";

import projectImports from "../projectImports.js";
import {
  claimExistingProject,
  createProjectImport,
  lookupProjectImport,
  patchProjectMetadata,
  publicProject,
  requestManualProjectClaim,
} from "./projectImportCore.js";

const { Pool } = pg;
const databaseUrl = process.env.PROJECT_IMPORT_TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("PROJECT_IMPORT_TEST_DATABASE_URL or DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseUrl });
const migration = fs.readFileSync(
  new URL("../../../db/migrations/20260908_000001_project_import_onboarding.sql", import.meta.url),
  "utf8",
);

async function resetImportTable() {
  await pool.query("DROP TABLE IF EXISTS public.arena_token_imports CASCADE");
}
async function applyMigration() {
  await pool.query(migration);
}
function resolver({ tokenAddress, match = false, available = true }) {
  return {
    chainId: 56,
    tokenAddress,
    name: "Imported Project",
    symbol: "IMP",
    decimals: 18,
    totalSupply: "1000000",
    automaticOwnershipAvailable: available,
    currentAuthority: available ? "0x00000000000000000000000000000000000000aa" : null,
    signedWalletMatchesAuthority: match,
  };
}
function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(k, v) { this.headers[k] = v; },
    end(v) { this.body = String(v ?? ""); },
  };
}

before(async () => {
  await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
});
after(async () => {
  await resetImportTable();
  await pool.end();
});

test("migration is additive from empty state and replay-safe without Arena/campaign tables", async () => {
  await resetImportTable();
  await applyMigration();
  await applyMigration();
  const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='arena_token_imports'`);
  const names = new Set(cols.rows.map((r) => r.column_name));
  for (const required of [
    "chain_id", "token_address", "name", "symbol", "decimals", "total_supply", "image_url",
    "description", "website", "x_url", "telegram_url", "ownership_status", "project_owner_wallet",
    "ownership_verified_at", "manual_claim_wallet", "manual_claim_requested_at", "metadata_updated_at",
  ]) assert.equal(names.has(required), true, required);
  const forbidden = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('arena_battles','arena_tournaments','arena_league_seasons','campaigns')`);
  assert.deepEqual(forbidden.rows, []);
});

test("historical Arena status survives migration and is not reinterpreted as project ownership", async () => {
  await resetImportTable();
  await pool.query(`CREATE TABLE public.arena_token_imports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), chain_id integer NOT NULL, token_address text NOT NULL,
    owner_wallet text NOT NULL, status text NOT NULL DEFAULT 'needs_review', created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(), UNIQUE(chain_id, token_address)
  )`);
  await pool.query(`INSERT INTO public.arena_token_imports(chain_id,token_address,owner_wallet,status) VALUES (56,'0x0000000000000000000000000000000000000001','0x0000000000000000000000000000000000000002','needs_review')`);
  await applyMigration();
  await applyMigration();
  const row = (await pool.query(`SELECT status, ownership_status, project_owner_wallet FROM public.arena_token_imports LIMIT 1`)).rows[0];
  assert.equal(row.status, "needs_review");
  assert.equal(row.ownership_status, "ownership_pending");
  assert.equal(row.project_owner_wallet, null);
});

test("duplicate identity is singular and first writer is not project owner without authority proof", async () => {
  await resetImportTable();
  await applyMigration();
  const firstWallet = ethers.Wallet.createRandom().address.toLowerCase();
  const token = "0x0000000000000000000000000000000000000011";
  const first = await createProjectImport(pool, { resolverResult: resolver({ tokenAddress: token }), signedWallet: firstWallet });
  const second = await createProjectImport(pool, { resolverResult: resolver({ tokenAddress: token }), signedWallet: ethers.Wallet.createRandom().address.toLowerCase() });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.project.imported_by_wallet, firstWallet);
  assert.equal(first.project.project_owner_wallet, null);
  assert.equal(first.project.ownership_status, "ownership_pending");
  const count = await pool.query(`SELECT count(*)::int AS n FROM public.arena_token_imports WHERE chain_id=56 AND token_address=$1`, [token]);
  assert.equal(count.rows[0].n, 1);
});

test("later resolver-proven real owner can claim a project created by the wrong first importer", async () => {
  const token = "0x0000000000000000000000000000000000000011";
  const owner = ethers.Wallet.createRandom().address.toLowerCase();
  await assert.rejects(
    () => claimExistingProject(pool, { resolverResult: resolver({ tokenAddress: token, match: false }), signedWallet: owner }),
    /authority proof/i,
  );
  const claimed = await claimExistingProject(pool, { resolverResult: resolver({ tokenAddress: token, match: true }), signedWallet: owner });
  assert.equal(claimed.project_owner_wallet, owner);
  assert.equal(claimed.ownership_status, "ownership_verified");
});

test("manual project claim is independent of first importer and never auto-verifies claimant", async () => {
  await pool.query(`UPDATE public.arena_token_imports SET project_owner_wallet=NULL, ownership_status='ownership_pending' WHERE chain_id=56`);
  const token = "0x0000000000000000000000000000000000000011";
  const claimant = ethers.Wallet.createRandom().address.toLowerCase();
  const row = await requestManualProjectClaim(pool, { chainId: 56, tokenAddress: token, signedWallet: claimant, note: "recovery" });
  assert.equal(row.manual_claim_wallet, claimant);
  assert.equal(row.ownership_status, "ownership_manual_review");
  assert.equal(row.project_owner_wallet, null);
  assert.ok(row.manual_claim_requested_at);
});

test("verified project owner cannot be overwritten by manual or competing automatic claim", async () => {
  const token = "0x0000000000000000000000000000000000000011";
  const owner = ethers.Wallet.createRandom().address.toLowerCase();
  await pool.query(`UPDATE public.arena_token_imports SET project_owner_wallet=$1, ownership_status='ownership_verified', ownership_verified_at=NOW() WHERE chain_id=56 AND token_address=$2`, [owner, token]);
  const other = ethers.Wallet.createRandom().address.toLowerCase();
  await assert.rejects(() => requestManualProjectClaim(pool, { chainId: 56, tokenAddress: token, signedWallet: other }), /cannot overwrite/i);
  await assert.rejects(() => claimExistingProject(pool, { resolverResult: resolver({ tokenAddress: token, match: true }), signedWallet: other }), /different verified project owner/i);
  const row = await lookupProjectImport(pool, { chainId: 56, tokenAddress: token });
  assert.equal(row.project_owner_wallet, owner);
});

test("verified owner metadata patch works; non-owner and protected fields fail", async () => {
  const token = "0x0000000000000000000000000000000000000011";
  const row = await lookupProjectImport(pool, { chainId: 56, tokenAddress: token });
  const owner = row.project_owner_wallet;
  const changed = await patchProjectMetadata(pool, { chainId: 56, tokenAddress: token, signedWallet: owner, patch: { description: "New description", website: "https://example.com" } });
  assert.equal(changed.description, "New description");
  const stranger = ethers.Wallet.createRandom().address.toLowerCase();
  await assert.rejects(() => patchProjectMetadata(pool, { chainId: 56, tokenAddress: token, signedWallet: stranger, patch: { description: "nope" } }), /verified project owner/i);
  await assert.rejects(() => patchProjectMetadata(pool, { chainId: 56, tokenAddress: token, signedWallet: owner, patch: { arenaStatus: "passed" } }), /not editable/i);
});

test("public response contract exposes project ownership explicitly and Arena status separately", async () => {
  await pool.query(`ALTER TABLE public.arena_token_imports ADD COLUMN IF NOT EXISTS status text`);
  await pool.query(`UPDATE public.arena_token_imports SET status='needs_review' WHERE chain_id=56`);
  const token = "0x0000000000000000000000000000000000000011";
  const raw = await lookupProjectImport(pool, { chainId: 56, tokenAddress: token });
  const item = publicProject(raw);
  assert.equal(item.ownershipStatus, "ownership_verified");
  assert.equal(item.projectOwnerWallet, raw.project_owner_wallet);
  assert.ok(item.ownershipVerifiedAt);
  assert.equal(item.arenaStatus, "needs_review");
  assert.equal("ownerWallet" in item, false);
  assert.equal("verifiedAt" in item, false);
});

test("dedicated project-import API works with imports ON and Arena OFF", async () => {
  process.env.ENABLE_PROJECT_IMPORTS = "true";
  process.env.ENABLE_ARENA = "false";
  process.env.ENABLE_POSTGRAD_ARENA = "false";
  const source = fs.readFileSync(new URL("../projectImports.js", import.meta.url), "utf8");
  assert.match(source, /ENABLE_PROJECT_IMPORTS/);
  assert.doesNotMatch(source, /ENABLE_ARENA|ENABLE_POSTGRAD/);
  const req = { method: "GET", url: "/project-imports?chainId=56&tokenAddress=0x0000000000000000000000000000000000000011" };
  const res = mockRes();
  await projectImports(req, res);
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.project.tokenAddress, "0x0000000000000000000000000000000000000011");
  assert.equal(payload.project.ownershipStatus, "ownership_verified");
  assert.equal(payload.project.arenaStatus, "needs_review");
});

test("unsupported chain fails closed", async () => {
  await assert.rejects(() => lookupProjectImport(pool, { chainId: 4663, tokenAddress: "0x0000000000000000000000000000000000000011" }), /Unsupported project import chain/);
});
