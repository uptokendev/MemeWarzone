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
const ADMIN_AUTH_ID = "00000000-0000-4000-8000-000000000001";
const ADMIN_WM_USER_ID = "00000000-0000-4000-8000-0000000000aa";
const CLAIMANT = "7ZkEpeo8zcawdj39wpDtB7MbzkbyhNoQyVXLsswazohv";
const OPERATOR_EMAIL = "operator@example.com";

async function reset() {
  await pool.query("DROP TABLE IF EXISTS public.wm_admin_audit_log CASCADE");
  await pool.query("DROP TABLE IF EXISTS public.wm_users CASCADE");
  await pool.query("DROP TABLE IF EXISTS public.arena_token_imports CASCADE");
  await pool.query(migration);
  await pool.query("ALTER TABLE public.arena_token_imports ADD COLUMN IF NOT EXISTS status text DEFAULT 'scanning'");
  await pool.query("ALTER TABLE public.arena_token_imports ADD COLUMN IF NOT EXISTS review_requested_at timestamptz");
  await pool.query("ALTER TABLE public.arena_token_imports ADD COLUMN IF NOT EXISTS scan_json jsonb");
  await pool.query(`CREATE TABLE public.wm_users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address text NOT NULL UNIQUE,
    display_name text,
    role text NOT NULL DEFAULT 'user',
    created_at timestamptz NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE public.wm_admin_audit_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_user_id uuid,
    action text NOT NULL,
    target_type text NOT NULL,
    target_id uuid,
    before jsonb,
    after jsonb,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT wm_admin_audit_log_admin_user_id_fkey FOREIGN KEY (admin_user_id) REFERENCES public.wm_users(id)
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

async function insertWmUser(id) {
  await pool.query(
    `INSERT INTO public.wm_users (id, wallet_address, role) VALUES ($1, $2, 'admin')`,
    [id, `0x${String(id.replace(/-/g, "")).slice(0, 40).padEnd(40, "0")}`],
  );
}

before(async () => {
  await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
  await reset();
});

after(async () => {
  await pool.query("DROP TABLE IF EXISTS public.wm_admin_audit_log CASCADE");
  await pool.query("DROP TABLE IF EXISTS public.wm_users CASCADE");
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

test("VERIFY OWNER succeeds when dashboard admin UUID is absent from wm_users and stores NULL admin_user_id", async () => {
  await reset();
  const id = await insertClaim(511);
  const before = await getProjectOwnershipClaim(pool, id);
  const verified = await reviewProjectOwnership(pool, {
    projectId: id,
    action: "verify_owner",
    reason: "Claimant identity reviewed by operator",
    expectedVersion: before.state_version,
    admin: { id: ADMIN_AUTH_ID, email: OPERATOR_EMAIL },
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
  assert.equal(audit[0].admin_user_id, null);
  assert.equal(audit[0].before.ownershipStatus, "ownership_manual_review");
  assert.equal(audit[0].after.ownershipStatus, "ownership_verified");
  assert.equal(audit[0].after.operatorAuthUserId, ADMIN_AUTH_ID);
  assert.equal(audit[0].before.operatorAuthUserId, ADMIN_AUTH_ID);
  assert.equal(audit[0].after.operatorEmail, OPERATOR_EMAIL);
  assert.equal(audit[0].after.operatorReason, "Claimant identity reviewed by operator");
});

test("VERIFY OWNER records admin_user_id when the authenticated admin UUID exists in wm_users", async () => {
  await reset();
  await insertWmUser(ADMIN_WM_USER_ID);
  const id = await insertClaim(512);
  const before = await getProjectOwnershipClaim(pool, id);
  const verified = await reviewProjectOwnership(pool, {
    projectId: id,
    action: "verify_owner",
    reason: "Matched wm_users administrator",
    expectedVersion: before.state_version,
    admin: { id: ADMIN_WM_USER_ID, email: OPERATOR_EMAIL },
  });
  assert.equal(verified.ownership_status, "ownership_verified");
  assert.equal(verified.project_owner_wallet, CLAIMANT);
  const audit = await getProjectOwnershipAudit(pool, id);
  assert.equal(String(audit[0].admin_user_id), ADMIN_WM_USER_ID);
  assert.equal(audit[0].after.operatorAuthUserId, ADMIN_WM_USER_ID);
  assert.equal(audit[0].after.operatorEmail, OPERATOR_EMAIL);
  assert.equal(audit[0].after.operatorReason, "Matched wm_users administrator");
});

test("REJECT CLAIM follows the same safe audit identity behavior", async () => {
  await reset();
  const missingId = await insertClaim(521);
  const missingBefore = await getProjectOwnershipClaim(pool, missingId);
  const rejected = await reviewProjectOwnership(pool, {
    projectId: missingId,
    action: "reject_claim",
    reason: "Evidence did not establish project control",
    expectedVersion: missingBefore.state_version,
    admin: { id: ADMIN_AUTH_ID, email: OPERATOR_EMAIL },
  });
  assert.equal(rejected.project_owner_wallet, null);
  assert.equal(rejected.ownership_status, "ownership_pending");
  assert.equal(rejected.ownership_verified_at, null);
  assert.equal(rejected.manual_claim_wallet, null);
  assert.equal(rejected.manual_claim_requested_at, null);
  assert.equal(rejected.status, "scanning");
  const count = await pool.query("SELECT count(*)::int AS n FROM public.arena_token_imports WHERE id=$1", [missingId]);
  assert.equal(count.rows[0].n, 1);
  const missingAudit = await getProjectOwnershipAudit(pool, missingId);
  assert.equal(missingAudit[0].action, "reject_claim");
  assert.equal(missingAudit[0].admin_user_id, null);
  assert.equal(missingAudit[0].after.ownershipStatus, "ownership_pending");
  assert.equal(missingAudit[0].after.operatorAuthUserId, ADMIN_AUTH_ID);
  assert.equal(missingAudit[0].after.operatorEmail, OPERATOR_EMAIL);
  assert.equal(missingAudit[0].after.operatorReason, "Evidence did not establish project control");

  await insertWmUser(ADMIN_WM_USER_ID);
  const presentId = await insertClaim(522);
  const presentBefore = await getProjectOwnershipClaim(pool, presentId);
  const rejectedPresent = await reviewProjectOwnership(pool, {
    projectId: presentId,
    action: "reject_claim",
    reason: "Reject with known wm_users admin",
    expectedVersion: presentBefore.state_version,
    admin: { id: ADMIN_WM_USER_ID, email: OPERATOR_EMAIL },
  });
  assert.equal(rejectedPresent.ownership_status, "ownership_pending");
  const presentAudit = await getProjectOwnershipAudit(pool, presentId);
  assert.equal(String(presentAudit[0].admin_user_id), ADMIN_WM_USER_ID);
  assert.equal(presentAudit[0].after.operatorAuthUserId, ADMIN_WM_USER_ID);
});

test("audit write failure rolls back the ownership mutation", async () => {
  await reset();
  await pool.query(`
    CREATE OR REPLACE FUNCTION public.mwz_fail_ownership_audit() RETURNS trigger AS $$
    BEGIN
      IF NEW.after->>'operatorReason' = 'FORCE_AUDIT_FAILURE' THEN
        RAISE EXCEPTION 'forced audit failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await pool.query(`
    DROP TRIGGER IF EXISTS mwz_fail_ownership_audit ON public.wm_admin_audit_log;
    CREATE TRIGGER mwz_fail_ownership_audit
      BEFORE INSERT ON public.wm_admin_audit_log
      FOR EACH ROW EXECUTE FUNCTION public.mwz_fail_ownership_audit();
  `);
  const id = await insertClaim(525);
  const before = await getProjectOwnershipClaim(pool, id);
  await assert.rejects(
    () => reviewProjectOwnership(pool, {
      projectId: id,
      action: "verify_owner",
      reason: "FORCE_AUDIT_FAILURE",
      expectedVersion: before.state_version,
      admin: { id: ADMIN_AUTH_ID, email: OPERATOR_EMAIL },
    }),
    /forced audit failure/,
  );
  const row = await getProjectOwnershipClaim(pool, id);
  assert.equal(row.ownership_status, "ownership_manual_review");
  assert.equal(row.project_owner_wallet, null);
  assert.equal(row.manual_claim_wallet, CLAIMANT);
  assert.equal(row.status, "scanning");
  const audit = await getProjectOwnershipAudit(pool, id);
  assert.equal(audit.length, 0);
  await pool.query("DROP TRIGGER IF EXISTS mwz_fail_ownership_audit ON public.wm_admin_audit_log");
  await pool.query("DROP FUNCTION IF EXISTS public.mwz_fail_ownership_audit()");
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
    admin: { id: ADMIN_AUTH_ID, email: OPERATOR_EMAIL },
  });
  await assert.rejects(
    () => reviewProjectOwnership(pool, {
      projectId: id,
      action: "reject_claim",
      reason: "Stale second decision",
      expectedVersion: before.state_version,
      admin: { id: ADMIN_AUTH_ID, email: "operator2@example.com" },
    }),
    (error) => error?.code === "PROJECT_OWNERSHIP_STATE_CONFLICT",
  );
  const row = await getProjectOwnershipClaim(pool, id);
  assert.equal(row.ownership_status, "ownership_verified");
  assert.equal(row.project_owner_wallet, CLAIMANT);
  assert.equal(row.status, "scanning");
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
      admin: { id: ADMIN_AUTH_ID },
    }),
    (error) => error?.code === "PROJECT_OWNERSHIP_REASON_REQUIRED",
  );
  const row = await getProjectOwnershipClaim(pool, id);
  assert.equal(row.ownership_status, "ownership_manual_review");
});
