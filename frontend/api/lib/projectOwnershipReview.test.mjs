import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import pg from "pg";

import {
  getProjectOwnershipAudit,
  getProjectOwnershipClaim,
  listProjectOwnershipClaims,
  reviewProjectOwnership,
} from "./projectOwnershipReview.js";

const { Pool } = pg;
const databaseUrl = process.env.PROJECT_IMPORT_TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("PROJECT_IMPORT_TEST_DATABASE_URL or DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseUrl });
const migration = fs.readFileSync(
  new URL("../../../db/migrations/20260908_000001_project_import_onboarding.sql", import.meta.url),
  "utf8",
);
const ADMIN_ID = "00000000-0000-4000-8000-000000000001";
const CLAIMANT = "7ZkEpeo8zcawdj39wpDtB7MbzkbyhNoQyVXLsswazohv";

async function reset() {
  await pool.query("DROP TABLE IF EXISTS public.wm_admin_audit_log CASCADE");
  await pool.query("DROP TABLE IF EXISTS public.arena_token_imports CASCADE");
  await pool.query(migration);
  await pool.query("ALTER TABLE public.arena_token_imports ADD COLUMN IF NOT EXISTS status text DEFAULT 'scanning'");
  await pool.query("ALTER TABLE public.arena_token_imports ADD COLUMN IF NOT EXISTS review_requested_at timestamptz");
  await pool.query("ALTER TABLE public.arena_token_imports ADD COLUMN IF NOT EXISTS scan_json jsonb");
  await pool.query(`CREATE TABLE public.wm_admin_audit_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_user_id uuid,
    action text NOT NULL,
    target_type text NOT NULL,
    target_id uuid,
    before jsonb,
    after jsonb,
    created_at timestamptz NOT NULL DEFAULT NOW()
  )`);
}

async function insertClaim(suffix) {
  const token = `0x${String(suffix).padStart(40, "0")}`;
  const result = await pool.query(`
    INSERT INTO public.arena_token_imports (
      chain_id, token_address, owner_wallet, imported_by_wallet,
      ownership_status, manual_claim_wallet, manual_claim_requested_at,
      manual_claim_note, status, image_url
    ) VALUES (56, $1, '', $2, 'ownership_manual_review', $2, NOW(), 'manual evidence', 'scanning', 'https://cdn.example/project.png')
    RETURNING id
  `, [token, CLAIMANT]);
  return result.rows[0].id;
}

before(async () => {
  await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
  await reset();
});

after(async () => {
  await pool.query("DROP TABLE IF EXISTS public.wm_admin_audit_log CASCADE");
  await pool.query("DROP TABLE IF EXISTS public.arena_token_imports CASCADE");
  await pool.end();
});

test("manual project ownership queue is driven only by ownership state and claim fields", async () => {
  const id = await insertClaim(501);
  await pool.query(`INSERT INTO public.arena_token_imports(chain_id,token_address,owner_wallet,ownership_status,status) VALUES(56,$1,'','ownership_pending','review_requested')`, ["0x0000000000000000000000000000000000000502"]);
  const queue = await listProjectOwnershipClaims(pool);
  assert.equal(queue.length, 1);
  assert.equal(String(queue[0].id), String(id));
  assert.equal(queue[0].ownership_status, "ownership_manual_review");
  assert.equal(queue[0].status, "scanning");
});

test("VERIFY OWNER changes project ownership only and records reasoned audit", async () => {
  await reset();
  const id = await insertClaim(511);
  const before = await getProjectOwnershipClaim(pool, id);
  const verified = await reviewProjectOwnership(pool, {
    projectId: id,
    action: "verify_owner",
    reason: "Claimant identity reviewed by operator",
    expectedVersion: before.state_version,
    admin: { id: ADMIN_ID, email: "operator@example.com" },
  });
  assert.equal(verified.project_owner_wallet, CLAIMANT);
  assert.equal(verified.ownership_status, "ownership_verified");
  assert.ok(verified.ownership_verified_at);
  assert.equal(verified.manual_claim_wallet, null);
  assert.equal(verified.manual_claim_requested_at, null);
  assert.equal(verified.manual_claim_note, null);
  assert.equal(verified.status, "scanning");
  assert.equal(verified.review_requested_at, null);

  const audit = await getProjectOwnershipAudit(pool, id);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, "verify_owner");
  assert.equal(audit[0].target_type, "project_ownership_claim");
  assert.equal(audit[0].before.ownershipStatus, "ownership_manual_review");
  assert.equal(audit[0].after.ownershipStatus, "ownership_verified");
  assert.equal(audit[0].after.operatorReason, "Claimant identity reviewed by operator");
  assert.equal(audit[0].after.operatorEmail, "operator@example.com");
});

test("REJECT CLAIM keeps registration and Arena state while returning ownership to pending", async () => {
  await reset();
  const id = await insertClaim(521);
  const before = await getProjectOwnershipClaim(pool, id);
  const rejected = await reviewProjectOwnership(pool, {
    projectId: id,
    action: "reject_claim",
    reason: "Evidence did not establish project control",
    expectedVersion: before.state_version,
    admin: { id: ADMIN_ID, email: "operator@example.com" },
  });
  assert.equal(rejected.project_owner_wallet, null);
  assert.equal(rejected.ownership_status, "ownership_pending");
  assert.equal(rejected.ownership_verified_at, null);
  assert.equal(rejected.manual_claim_wallet, null);
  assert.equal(rejected.manual_claim_requested_at, null);
  assert.equal(rejected.status, "scanning");
  const count = await pool.query("SELECT count(*)::int AS n FROM public.arena_token_imports WHERE id=$1", [id]);
  assert.equal(count.rows[0].n, 1);
  const audit = await getProjectOwnershipAudit(pool, id);
  assert.equal(audit[0].action, "reject_claim");
  assert.equal(audit[0].after.ownershipStatus, "ownership_pending");
});

test("stale or concurrent ownership review fails closed", async () => {
  await reset();
  const id = await insertClaim(531);
  const before = await getProjectOwnershipClaim(pool, id);
  await reviewProjectOwnership(pool, {
    projectId: id,
    action: "verify_owner",
    reason: "First operator decision",
    expectedVersion: before.state_version,
    admin: { id: ADMIN_ID, email: "operator@example.com" },
  });
  await assert.rejects(
    () => reviewProjectOwnership(pool, {
      projectId: id,
      action: "reject_claim",
      reason: "Stale second decision",
      expectedVersion: before.state_version,
      admin: { id: ADMIN_ID, email: "operator2@example.com" },
    }),
    (error) => error?.code === "PROJECT_OWNERSHIP_STATE_CONFLICT",
  );
  const row = await getProjectOwnershipClaim(pool, id);
  assert.equal(row.ownership_status, "ownership_verified");
  assert.equal(row.project_owner_wallet, CLAIMANT);
});

test("review core refuses missing admin identity or reason", async () => {
  await reset();
  const id = await insertClaim(541);
  const before = await getProjectOwnershipClaim(pool, id);
  await assert.rejects(
    () => reviewProjectOwnership(pool, {
      projectId: id,
      action: "verify_owner",
      reason: "valid reason",
      expectedVersion: before.state_version,
      admin: null,
    }),
    (error) => error?.code === "PROJECT_OWNERSHIP_ADMIN_REQUIRED",
  );
  await assert.rejects(
    () => reviewProjectOwnership(pool, {
      projectId: id,
      action: "verify_owner",
      reason: "",
      expectedVersion: before.state_version,
      admin: { id: ADMIN_ID },
    }),
    (error) => error?.code === "PROJECT_OWNERSHIP_REASON_REQUIRED",
  );
});
