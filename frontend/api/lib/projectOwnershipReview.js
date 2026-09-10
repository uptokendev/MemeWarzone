import { latestImportEvidence } from "./projectImportEvidenceStore.js";
import { assertReviewApproval } from "./projectImportAssessment.js";
const MANUAL_REVIEW = "ownership_manual_review";
const VERIFIED = "ownership_verified";
const PENDING = "ownership_pending";

export function projectOwnershipClaimItem(row) {
  if (!row) return null;
  return {
    id: String(row.id), chainId: Number(row.chain_id), tokenAddress: String(row.token_address),
    name: row.name ?? null, symbol: row.symbol ?? null, imageUrl: row.image_url ?? null,
    importedByWallet: row.imported_by_wallet ?? null, claimantWallet: row.manual_claim_wallet ?? null,
    projectOwnerWallet: row.project_owner_wallet ?? null, ownershipStatus: String(row.ownership_status || PENDING),
    ownershipVerifiedAt: row.ownership_verified_at ?? null, manualClaimRequestedAt: row.manual_claim_requested_at ?? null,
    manualClaimNote: row.manual_claim_note ?? null, arenaStatus: row.status ?? null,
    arenaReviewRequestedAt: row.review_requested_at ?? null, ownershipEvidence: row.import_evidence ?? null, evidenceId: row.import_evidence_id ?? null,
    createdAt: row.created_at ?? null, metadataUpdatedAt: row.metadata_updated_at ?? null,
    updatedAt: row.updated_at ?? null, stateVersion: String(row.state_version || ""),
  };
}

export async function listProjectOwnershipClaims(db) {
  const result = await db.query(`
    SELECT i.*, i.xmin::text AS state_version
      FROM public.arena_token_imports i
     WHERE i.ownership_status = $1
       AND i.manual_claim_wallet IS NOT NULL
       AND btrim(i.manual_claim_wallet) <> ''
       AND i.manual_claim_requested_at IS NOT NULL
     ORDER BY i.manual_claim_requested_at ASC, i.created_at ASC
  `, [MANUAL_REVIEW]);
  return result.rows || [];
}

export async function getProjectOwnershipClaim(db, projectId) {
  const result = await db.query(`SELECT i.*, i.xmin::text AS state_version FROM public.arena_token_imports i WHERE i.id=$1 LIMIT 1`, [projectId]);
  return result.rows?.[0] || null;
}

export async function getProjectOwnershipAudit(db, projectId) {
  const result = await db.query(`
    SELECT id,admin_user_id,action,target_type,target_id,before,after,created_at
      FROM public.wm_admin_audit_log
     WHERE target_type='project_ownership_claim' AND target_id=$1
     ORDER BY created_at DESC LIMIT 100
  `, [projectId]);
  return result.rows || [];
}

function reviewError(message, code, extra = {}) { return Object.assign(new Error(message), { code, ...extra }); }

function auditPayload(item, admin, reason) {
  return {
    ...item,
    operatorAuthUserId: String(admin.id),
    operatorEmail: admin.email || null,
    operatorReason: reason,
  };
}

async function resolveAuditAdminUserId(client, adminId) {
  const raw = String(adminId || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return null;
  const found = await client.query("SELECT id FROM public.wm_users WHERE id=$1::uuid LIMIT 1", [raw]);
  return found.rows?.[0]?.id || null;
}

export async function reviewProjectOwnership(db, { projectId, action, reason, expectedVersion, expectedEvidenceId, reviewProof, admin }) {
  const cleanReason = String(reason || "").trim().slice(0, 1000);
  if (cleanReason.length < 3) throw reviewError("Operator reason is required", "PROJECT_OWNERSHIP_REASON_REQUIRED");
  if (!String(expectedVersion || "").trim()) throw reviewError("Expected ownership state version is required", "PROJECT_OWNERSHIP_EXPECTED_STATE_REQUIRED");
  if (!admin?.id) throw reviewError("Authenticated dashboard administrator required", "PROJECT_OWNERSHIP_ADMIN_REQUIRED");
  if (!["verify_owner", "reject_claim"].includes(action)) throw reviewError("Unsupported project ownership action", "PROJECT_OWNERSHIP_ACTION_INVALID");

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(`SELECT i.*, i.xmin::text AS state_version FROM public.arena_token_imports i WHERE i.id=$1 FOR UPDATE`, [projectId]);
    const current = found.rows?.[0];
    if (!current) throw reviewError("Imported project not found", "PROJECT_NOT_FOUND");
    const claimant = String(current.manual_claim_wallet || "").trim();
    if (current.ownership_status !== MANUAL_REVIEW || !claimant || !current.manual_claim_requested_at || String(current.state_version) !== String(expectedVersion)) {
      throw reviewError("Project ownership claim changed before review", "PROJECT_OWNERSHIP_STATE_CONFLICT", {
        currentVersion: String(current.state_version || ""), currentOwnershipStatus: current.ownership_status,
      });
    }
    if (action === "verify_owner" && !String(current.image_url || "").trim()) {
      throw reviewError("Manual ownership approval requires a project image", "PROJECT_OWNERSHIP_IMAGE_REQUIRED");
    }

    if (action === "verify_owner") {
      const evidence = await latestImportEvidence(client,current);
      assertReviewApproval(evidence?.snapshot,{project:current,evidenceId:evidence?.id,expectedEvidenceId,reviewProof});
      current.import_evidence=evidence.snapshot; current.import_evidence_id=evidence.id;
    }
    const updatedResult = action === "verify_owner"
      ? await client.query(`
          UPDATE public.arena_token_imports
             SET project_owner_wallet=manual_claim_wallet, ownership_status=$2, ownership_verified_at=NOW(), verified_at=NOW(),
                 manual_claim_wallet=NULL, manual_claim_requested_at=NULL, manual_claim_note=NULL, updated_at=NOW(), metadata_updated_at=NOW()
           WHERE id=$1 AND xmin::text=$3 AND ownership_status=$4
           RETURNING *, xmin::text AS state_version
        `, [projectId, VERIFIED, String(expectedVersion), MANUAL_REVIEW])
      : await client.query(`
          UPDATE public.arena_token_imports
             SET project_owner_wallet=NULL, ownership_status=$2, ownership_verified_at=NULL,
                 manual_claim_wallet=NULL, manual_claim_requested_at=NULL, manual_claim_note=NULL, updated_at=NOW()
           WHERE id=$1 AND xmin::text=$3 AND ownership_status=$4
           RETURNING *, xmin::text AS state_version
        `, [projectId, PENDING, String(expectedVersion), MANUAL_REVIEW]);

    const updated = updatedResult.rows?.[0];
    if (!updated) throw reviewError("Project ownership claim changed before review", "PROJECT_OWNERSHIP_STATE_CONFLICT");

    if(action==='verify_owner') { updated.import_evidence=current.import_evidence; updated.import_evidence_id=current.import_evidence_id; }
    const before = projectOwnershipClaimItem(current);
    const after = projectOwnershipClaimItem(updated);
    const auditAdminUserId = await resolveAuditAdminUserId(client, admin.id);
    await client.query(`
      INSERT INTO public.wm_admin_audit_log(admin_user_id,action,target_type,target_id,before,after)
      VALUES($1,$2,'project_ownership_claim',$3,$4::jsonb,$5::jsonb)
    `, [auditAdminUserId, action, projectId,
      JSON.stringify(auditPayload(before, admin, cleanReason)),
      JSON.stringify({...auditPayload(after, admin, cleanReason),reviewProof:reviewProof?{method:String(reviewProof.method||""),reference:String(reviewProof.reference||"").slice(0,1000),marketMethod:String(reviewProof.marketMethod||""),marketReference:String(reviewProof.marketReference||"").slice(0,1000)}:null})]);
    await client.query("COMMIT");
    return updated;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}
