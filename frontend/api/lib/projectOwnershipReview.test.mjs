import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import pg from "pg";

import {
  getProjectOwnershipAudit,
  getProjectOwnershipClaim,
  listProjectOwnershipClaims,
  reviewProjectOwnership as originalReviewProjectOwnership,
} from "./projectOwnershipReview.js";

import { assessProjectImport } from "./projectImportAssessment.js";
import { appendImportEvidence } from "./projectImportEvidenceStore.js";
const evidenceIds = new Map();
const reviewProjectOwnership = (db,options) => originalReviewProjectOwnership(db,{expectedEvidenceId:evidenceIds.get(options.projectId),...options});
const evidenceMigration = fs.readFileSync(new URL("../../../supabase/migrations/20260909213428_project_import_review_evidence.sql",import.meta.url),"utf8");
const { Pool } = pg;
const databaseUrl = process.env.PROJECT_IMPORT_TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("PROJECT_IMPORT_TEST_DATABASE_URL or DATABASE_URL is required");
if(!['localhost','127.0.0.1','postgres'].includes(new URL(databaseUrl).hostname)) throw new Error('Ownership tests require an isolated localhost/Postgres service, never production');
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
  await pool.query("DROP TABLE IF EXISTS public.project_import_review_evidence CASCADE");
  await pool.query("DROP TABLE IF EXISTS public.arena_token_imports CASCADE");
  await pool.query(migration);
  await pool.query(evidenceMigration);
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

async function insertClaim(suffix,withEvidence=true) {
  const token = `0x${String(suffix).padStart(40, "0")}`;
  const result = await pool.query(`
    INSERT INTO public.arena_token_imports (
      chain_id, token_address, owner_wallet, imported_by_wallet,
      ownership_status, manual_claim_wallet, manual_claim_requested_at,
      manual_claim_note, status, image_url
    ) VALUES (56, $1, '', $2, 'ownership_manual_review', $2, NOW(), 'manual evidence', 'scanning', 'https://cdn.example/project.png')
    RETURNING id
  `, [token, CLAIMANT]);
  const id=result.rows[0].id;
  const row=(await pool.query("SELECT * FROM public.arena_token_imports WHERE id=$1",[id])).rows[0];
  if(!withEvidence)return id;
  const assessment=assessProjectImport({resolved:{chainId:56,tokenAddress:token,currentAuthority:CLAIMANT,automaticOwnershipAvailable:true,signedWalletMatchesAuthority:true,market:{phase:'postgrad',verified:true,liquidityAvailable:true}},security:{status:'pass',criticalRisks:[],reviewRisks:[]},claimantWallet:CLAIMANT,proof:{verifiedBy:'server_wallet_action',signedWallet:CLAIMANT}});
  const evidence=await appendImportEvidence(pool,{project:row,assessment,source:'manual_claim'});
  evidenceIds.set(id,evidence.id);
  return id;
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
  await pool.query("DROP TABLE IF EXISTS public.project_import_review_evidence CASCADE");
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

test("legacy empty evidence prevents approval without changing owner or Arena",async()=>{
 await reset();const id=await insertClaim(9991,false);const row=await getProjectOwnershipClaim(pool,id);
 await assert.rejects(()=>reviewProjectOwnership(pool,{projectId:id,action:'verify_owner',reason:'Legacy review attempt',expectedVersion:row.state_version,admin:{id:ADMIN_AUTH_ID}}),{code:'PROJECT_IMPORT_EVIDENCE_REQUIRED'});
 const after=await getProjectOwnershipClaim(pool,id);assert.equal(after.ownership_status,'ownership_manual_review');assert.equal(after.status,'scanning');assert.equal((await getProjectOwnershipAudit(pool,id)).length,0);
});
test("a new snapshot invalidates an operator's old evidence id even if row version is unchanged",async()=>{
 await reset();const id=await insertClaim(9992);const row=await getProjectOwnershipClaim(pool,id);const previous=(await pool.query("SELECT * FROM public.project_import_review_evidence WHERE project_id=$1",[id])).rows[0];
 const next=await appendImportEvidence(pool,{project:row,assessment:previous.snapshot,source:'admin_recheck'});assert.notEqual(next.id,evidenceIds.get(id));
 await assert.rejects(()=>reviewProjectOwnership(pool,{projectId:id,action:'verify_owner',reason:'Stale snapshot test',expectedVersion:row.state_version,admin:{id:ADMIN_AUTH_ID}}),{code:'PROJECT_IMPORT_EVIDENCE_REQUIRED'});
 assert.equal((await pool.query("SELECT count(*)::int n FROM public.project_import_review_evidence WHERE project_id=$1",[id])).rows[0].n,2);
});

test("import evidence is append-only and RLS-enabled",async()=>{
 await reset();const id=await insertClaim(9993);
 await assert.rejects(()=>pool.query("UPDATE public.project_import_review_evidence SET snapshot='{}' WHERE project_id=$1",[id]),/append-only/);
 await assert.rejects(()=>pool.query("DELETE FROM public.project_import_review_evidence WHERE project_id=$1",[id]),/append-only/);
 const r=await pool.query("SELECT relrowsecurity FROM pg_class WHERE oid='public.project_import_review_evidence'::regclass");assert.equal(r.rows[0].relrowsecurity,true);
});

test('direct DEX launch provenance is required, audited, and cannot grant Arena access',async()=>{
 await reset();const id=await insertClaim(9994);const row=await getProjectOwnershipClaim(pool,id);
 const original=(await pool.query('SELECT snapshot FROM public.project_import_review_evidence WHERE project_id=$1',[id])).rows[0].snapshot;
 const assessment={...original,market:{...original.market,phase:'dex_market',requiresLaunchReview:true,launchStageVerified:false},automaticImportAllowed:false,decision:'manual_review'};
 const entry=await appendImportEvidence(pool,{project:row,assessment,source:'admin_recheck'});evidenceIds.set(id,entry.id);
 const args={projectId:id,action:'verify_owner',reason:'Independent launch history inspected',expectedVersion:row.state_version,admin:{id:ADMIN_AUTH_ID}};
 await assert.rejects(()=>reviewProjectOwnership(pool,args),{code:'PROJECT_IMPORT_MARKET_PROOF_REQUIRED'});
 assert.equal((await getProjectOwnershipClaim(pool,id)).ownership_status,'ownership_manual_review');
 const reviewProof={marketMethod:'independent_launch_history',marketReference:'operator ticket 987: actual launch records and no active external bonding'};
 await reviewProjectOwnership(pool,{...args,reviewProof});
 const audit=(await pool.query('SELECT after FROM public.wm_admin_audit_log WHERE target_id=$1',[id])).rows[0].after;
 assert.equal(audit.reviewProof.marketReference,reviewProof.marketReference);assert.equal(audit.reviewProof.marketMethod,reviewProof.marketMethod);
 assert.equal((await getProjectOwnershipClaim(pool,id)).status,'scanning');
});
