import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import pg from "pg";
import { ethers } from "ethers";

import projectImports from "../projectImports.js";
import {
  bindRegistrationImage,
  claimExistingProject,
  createProjectImport,
  listRecentProjectImports,
  lookupProjectImport,
  patchProjectMetadata,
  persistProjectImage,
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

test("Robinhood chain fails closed while its independent import switch is disabled", async () => {
  await assert.rejects(() => lookupProjectImport(pool, { chainId: 4663, tokenAddress: "0x0000000000000000000000000000000000000011" }), (error) => error?.code === "PROJECT_IMPORT_CHAIN_DISABLED" && /Robinhood project import is disabled/.test(error.message));
});

test("unknown project import chains remain unsupported", async () => {
  await assert.rejects(() => lookupProjectImport(pool, { chainId: 999999, tokenAddress: "0x0000000000000000000000000000000000000011" }), /Unsupported project import chain/);
});

test("recent public list hides pending and manual-review projects even when review image exists", async () => {
  await resetImportTable();
  await applyMigration();
  await pool.query(`ALTER TABLE public.arena_token_imports ADD COLUMN IF NOT EXISTS status text`);

  const pendingWallet = ethers.Wallet.createRandom().address.toLowerCase();
  const pendingToken = "0x00000000000000000000000000000000000000b1";
  const pending = await createProjectImport(pool, { resolverResult: resolver({ tokenAddress: pendingToken }), signedWallet: pendingWallet });
  assert.equal(pending.project.ownership_status, "ownership_pending");

  const manualWallet = ethers.Wallet.createRandom().address.toLowerCase();
  const manualToken = "0x00000000000000000000000000000000000000b5";
  await createProjectImport(pool, { resolverResult: resolver({ tokenAddress: manualToken }), signedWallet: manualWallet });
  const manual = await requestManualProjectClaim(pool, { chainId: 56, tokenAddress: manualToken, signedWallet: manualWallet, note: "manual review" });
  assert.equal(manual.ownership_status, "ownership_manual_review");
  const manualWithImage = await bindRegistrationImage(pool, { chainId: 56, tokenAddress: manualToken, signedWallet: manualWallet, imageUrl: "https://cdn.example/manual.png" });
  assert.equal(manualWithImage.image_url, "https://cdn.example/manual.png");
  assert.equal(manualWithImage.project_owner_wallet, null);

  const nullToken = "0x00000000000000000000000000000000000000b2";
  const nullWallet = ethers.Wallet.createRandom().address.toLowerCase();
  await createProjectImport(pool, { resolverResult: resolver({ tokenAddress: nullToken, match: true }), signedWallet: nullWallet });

  const blankToken = "0x00000000000000000000000000000000000000b3";
  const blankWallet = ethers.Wallet.createRandom().address.toLowerCase();
  const blank = await createProjectImport(pool, { resolverResult: resolver({ tokenAddress: blankToken, match: true }), signedWallet: blankWallet });
  await pool.query(`UPDATE public.arena_token_imports SET image_url='' WHERE chain_id=56 AND token_address=$1`, [blank.project.token_address]);

  const arenaToken = "0x00000000000000000000000000000000000000b4";
  const arenaWallet = ethers.Wallet.createRandom().address.toLowerCase();
  await createProjectImport(pool, { resolverResult: resolver({ tokenAddress: arenaToken, match: true }), signedWallet: arenaWallet });
  await bindRegistrationImage(pool, { chainId: 56, tokenAddress: arenaToken, signedWallet: arenaWallet, imageUrl: "https://cdn.example/arena.png" });
  await pool.query(`UPDATE public.arena_token_imports SET status='needs_review' WHERE chain_id=56 AND token_address=$1`, [arenaToken]);

  const items = await listRecentProjectImports(pool, { limit: 10 });
  const tokens = items.map((row) => String(row.token_address));
  assert.equal(tokens.includes(pendingToken), false);
  assert.equal(tokens.includes(manualToken), false);
  assert.equal(tokens.includes(nullToken), false);
  assert.equal(tokens.includes(blankToken), false);
  assert.equal(tokens.includes(arenaToken), true);
  const arenaRow = items.find((row) => row.token_address === arenaToken);
  assert.equal(arenaRow.ownership_status, "ownership_verified");
  assert.equal(arenaRow.status, "needs_review");
  assert.ok(arenaRow.image_url);

  const req = { method: "GET", url: "/project-imports?limit=10" };
  const res = mockRes();
  await projectImports(req, res);
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  const publicTokens = payload.items.map((item) => String(item.tokenAddress));
  assert.equal(publicTokens.includes(pendingToken), false);
  assert.equal(publicTokens.includes(manualToken), false);
  assert.equal(publicTokens.includes(nullToken), false);
  assert.equal(publicTokens.includes(blankToken), false);
  assert.equal(publicTokens.includes(arenaToken), true);
});

test("registration image is blocked while merely pending and allowed for the active manual-review claimant", async () => {
  await resetImportTable();
  await applyMigration();
  const registrar = ethers.Wallet.createRandom().address.toLowerCase();
  const stranger = ethers.Wallet.createRandom().address.toLowerCase();
  const owner = ethers.Wallet.createRandom().address.toLowerCase();
  const token = "0x00000000000000000000000000000000000000aa";
  const created = await createProjectImport(pool, { resolverResult: resolver({ tokenAddress: token }), signedWallet: registrar });
  assert.equal(created.project.ownership_status, "ownership_pending");
  assert.equal(created.project.project_owner_wallet, null);

  await assert.rejects(
    () => persistProjectImage(pool, { chainId: 56, tokenAddress: token, signedWallet: registrar, imageUrl: "https://cdn.example/owner.png" }),
    (error) => error?.code === "IMPORT_OWNER_NOT_VERIFIED",
  );
  await assert.rejects(
    () => bindRegistrationImage(pool, { chainId: 56, tokenAddress: token, signedWallet: registrar, imageUrl: "https://cdn.example/pending.png" }),
    (error) => error?.code === "PROJECT_REGISTRAR_REQUIRED",
  );

  const review = await requestManualProjectClaim(pool, { chainId: 56, tokenAddress: token, signedWallet: registrar, note: "manual verification" });
  assert.equal(review.ownership_status, "ownership_manual_review");
  assert.equal(review.manual_claim_wallet, registrar);

  await assert.rejects(
    () => bindRegistrationImage(pool, { chainId: 56, tokenAddress: token, signedWallet: stranger, imageUrl: "https://cdn.example/nope.png" }),
    (error) => error?.code === "PROJECT_REGISTRAR_REQUIRED",
  );
  const bound = await bindRegistrationImage(pool, { chainId: 56, tokenAddress: token, signedWallet: registrar, imageUrl: "https://cdn.example/registered.png" });
  assert.equal(bound.image_url, "https://cdn.example/registered.png");
  assert.equal(bound.project_owner_wallet, null);
  assert.equal(bound.ownership_status, "ownership_manual_review");
  await assert.rejects(
    () => bindRegistrationImage(pool, { chainId: 56, tokenAddress: token, signedWallet: registrar, imageUrl: "https://cdn.example/second.png" }),
    /already registered/i,
  );

  const claimed = await claimExistingProject(pool, { resolverResult: resolver({ tokenAddress: token, match: true }), signedWallet: owner });
  assert.equal(claimed.project_owner_wallet, owner);
  assert.equal(claimed.ownership_status, "ownership_verified");
  const replaced = await persistProjectImage(pool, { chainId: 56, tokenAddress: token, signedWallet: owner, imageUrl: "https://cdn.example/owner.png" });
  assert.equal(replaced.image_url, "https://cdn.example/owner.png");
  assert.equal(replaced.ownership_status, "ownership_verified");
});
