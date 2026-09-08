import assert from "node:assert/strict";
import fs from "node:fs";
import { test, before, after } from "node:test";
import pg from "pg";
import { ethers } from "ethers";
import projectImports from "../projectImports.js";
import {
  claimExistingProject,
  createProjectImport,
  lookupProjectImport,
  patchProjectMetadata,
  requestManualProjectClaim,
} from "./projectImportCore.js";
import { buildProjectImportMessage, requireProjectImportAuth } from "./projectImportAuth.js";

const { Pool } = pg;
const databaseUrl = process.env.PROJECT_IMPORT_TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("PROJECT_IMPORT_TEST_DATABASE_URL or DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseUrl });
const migration = fs.readFileSync(new URL("../../../db/migrations/20260908_000001_project_import_onboarding.sql", import.meta.url), "utf8");

async function resetPublicImportTable() {
  await pool.query("DROP TABLE IF EXISTS public.arena_token_imports CASCADE");
}

async function applyMigration() {
  await pool.query(migration);
}

async function setupAuthNonces() {
  await pool.query(`CREATE TABLE IF NOT EXISTS public.auth_nonces (
    chain_id integer NOT NULL,
    address text NOT NULL,
    nonce text NOT NULL,
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    PRIMARY KEY (chain_id, address)
  )`);
}

function resolver({ tokenAddress, wallet, match = false, available = true }) {
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
    wallet,
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
  await setupAuthNonces();
});

after(async () => {
  await resetPublicImportTable();
  await pool.query("DROP TABLE IF EXISTS public.auth_nonces");
  await pool.end();
});

test("migration is additive from empty state and replay-safe without Arena/campaign tables", async () => {
  await resetPublicImportTable();
  await applyMigration();
  await applyMigration();
  const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='arena_token_imports'`);
  const names = new Set(cols.rows.map((r) => r.column_name));
  for (const required of ["chain_id","token_address","name","symbol","decimals","image_url","description","website","x_url","telegram_url","verified_at","metadata_updated_at","ownership_status"]) {
    assert.equal(names.has(required), true, required);
  }
  const forbidden = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('arena_battles','arena_tournaments','arena_league_seasons','campaigns')`);
  assert.deepEqual(forbidden.rows, []);
});

test("migration is additive when historical arena_token_imports exists and preserves Arena status", async () => {
  await resetPublicImportTable();
  await pool.query(`CREATE TABLE public.arena_token_imports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    chain_id integer NOT NULL,
    token_address text NOT NULL,
    owner_wallet text NOT NULL,
    name text,
    symbol text,
    status text NOT NULL DEFAULT 'needs_review',
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    UNIQUE(chain_id, token_address)
  )`);
  await pool.query(`INSERT INTO public.arena_token_imports(chain_id,token_address,owner_wallet,status) VALUES (56,'0x0000000000000000000000000000000000000001','0x0000000000000000000000000000000000000002','needs_review')`);
  await applyMigration();
  await applyMigration();
  const row = (await pool.query(`SELECT status, ownership_status FROM public.arena_token_imports LIMIT 1`)).rows[0];
  assert.equal(row.status, "needs_review");
  assert.equal(row.ownership_status, "ownership_pending");
});

test("duplicate identity is singular and first writer does not become owner without authority proof", async () => {
  await resetPublicImportTable();
  await applyMigration();
  const wallet = ethers.Wallet.createRandom().address.toLowerCase();
  const token = "0x0000000000000000000000000000000000000011";
  const first = await createProjectImport(pool, { resolverResult: resolver({ tokenAddress: token, wallet, match: false }), signedWallet: wallet });
  const second = await createProjectImport(pool, { resolverResult: resolver({ tokenAddress: token, wallet, match: false }), signedWallet: wallet });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.project.project_owner_wallet, null);
  assert.equal(first.project.ownership_status, "ownership_pending");
  const count = await pool.query(`SELECT count(*)::int AS n FROM public.arena_token_imports WHERE chain_id=56 AND token_address=$1`, [token]);
  assert.equal(count.rows[0].n, 1);
});

test("existing project can be claimed only from resolver-proven current authority", async () => {
  const token = "0x0000000000000000000000000000000000000011";
  const owner = ethers.Wallet.createRandom().address.toLowerCase();
  await assert.rejects(() => claimExistingProject(pool, { resolverResult: resolver({ tokenAddress: token, wallet: owner, match: false }), signedWallet: owner }), /authority proof/i);
  const claimed = await claimExistingProject(pool, { resolverResult: resolver({ tokenAddress: token, wallet: owner, match: true }), signedWallet: owner });
  assert.equal(claimed.project_owner_wallet, owner);
  assert.equal(claimed.ownership_status, "ownership_verified");
});

test("verified owner metadata patch works and non-owner patch fails", async () => {
  const token = "0x0000000000000000000000000000000000000011";
  const project = await lookupProjectImport(pool, { chainId: 56, tokenAddress: token });
  const owner = project.project_owner_wallet;
  const changed = await patchProjectMetadata(pool, { chainId: 56, tokenAddress: token, signedWallet: owner, patch: { description: "New description", website: "https://example.com" } });
  assert.equal(changed.description, "New description");
  assert.equal(changed.website, "https://example.com");
  const stranger = ethers.Wallet.createRandom().address.toLowerCase();
  await assert.rejects(() => patchProjectMetadata(pool, { chainId: 56, tokenAddress: token, signedWallet: stranger, patch: { description: "nope" } }), /Verified project owner required/);
});

test("manual claim requires strict signature and does not alter Arena status", async () => {
  await pool.query(`ALTER TABLE public.arena_token_imports ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'scanning'`);
  await pool.query(`UPDATE public.arena_token_imports SET project_owner_wallet=NULL, ownership_status='ownership_pending', status='needs_review' WHERE chain_id=56`);
  const wallet = ethers.Wallet.createRandom();
  const address = wallet.address.toLowerCase();
  const token = "0x0000000000000000000000000000000000000011";
  const nonce = "manual-claim-nonce";
  await pool.query(`INSERT INTO public.auth_nonces(chain_id,address,nonce,expires_at,used_at) VALUES(56,$1,$2,NOW()+interval '10 minutes',NULL) ON CONFLICT(chain_id,address) DO UPDATE SET nonce=EXCLUDED.nonce,expires_at=EXCLUDED.expires_at,used_at=NULL`, [address, nonce]);
  const action = "project-import-manual-claim";
  const message = buildProjectImportMessage({ action, walletAddress: address, chainId: 56, nonce, tokenAddress: token });
  const signature = await wallet.signMessage(message);
  const res = mockRes();
  const auth = await requireProjectImportAuth({ res, pool, auth: { walletAddress: address, chainId: 56, action, nonce, signature }, chainId: 56, action, tokenAddress: token });
  assert.equal(auth.walletAddress, address);
  const beforeStatus = (await pool.query(`SELECT status FROM public.arena_token_imports WHERE chain_id=56 AND token_address=$1`, [token])).rows[0].status;
  const result = await requestManualProjectClaim(pool, { chainId: 56, tokenAddress: token, signedWallet: address, note: "ownership review" });
  const afterStatus = (await pool.query(`SELECT status FROM public.arena_token_imports WHERE chain_id=56 AND token_address=$1`, [token])).rows[0].status;
  assert.equal(result.ownership_status, "ownership_manual_review");
  assert.equal(afterStatus, beforeStatus);
});

test("project import module graph is isolated from Arena competition modules", () => {
  const files = [
    new URL("../projectImports.js", import.meta.url),
    new URL("./projectImportCore.js", import.meta.url),
    new URL("./projectImportAuth.js", import.meta.url),
    new URL("./projectImportResolvers.js", import.meta.url),
  ];
  const source = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  for (const forbidden of ["arenaBattles", "arenaTournaments", "arenaLeague", "postgrad", "arenaFeatureFlags"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test("dedicated import API works with imports ON and Arena OFF", async () => {
  process.env.ENABLE_PROJECT_IMPORTS = "true";
  process.env.ENABLE_ARENA = "false";
  const source = fs.readFileSync(new URL("../projectImports.js", import.meta.url), "utf8");
  assert.match(source, /ENABLE_PROJECT_IMPORTS/);
  assert.doesNotMatch(source, /ENABLE_ARENA|ENABLE_POSTGRAD/);
  const req = { method: "GET", url: "/project-imports?chainId=56&tokenAddress=0x0000000000000000000000000000000000000011" };
  const res = mockRes();
  await projectImports(req, res);
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.project.token_address, "0x0000000000000000000000000000000000000011");
});
