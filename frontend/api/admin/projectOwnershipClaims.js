import { pool as defaultPool } from "../../server/db.js";
import { requireDashboardAdmin as defaultRequireDashboardAdmin } from "../dashboard/_auth.js";

const MANUAL_REVIEW = "ownership_manual_review";
const PENDING = "ownership_pending";
const VERIFIED = "ownership_verified";

function pathParts(req) {
  const pathname = new URL(req.url, "http://localhost").pathname
    .replace(/^\/api/, "")
    .replace(/^\/admin\/project-ownership-claims\/?/, "");
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function send(res, status, body) {
  if (typeof res.status === "function") return res.status(status).json(body);
  res.statusCode = status;
  res.setHeader?.("Content-Type", "application/json; charset=utf-8");
  res.end?.(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function requiredReason(value) {
  const reason = String(value || "").trim();
  if (reason.length < 3 || reason.length > 1000) {
    const error = new Error("Operator reason must be between 3 and 1000 characters.");
    error.code = "PROJECT_OWNERSHIP_REASON_REQUIRED";
    throw error;
  }
  return reason;
}

function publicClaim(row) {
  return {
    id: String(row.id),
    chainId: Number(row.chain_id),
    tokenAddress: String(row.token_address),
    name: row.name ?? null,
    symbol: row.symbol ?? null,
    imageUrl: row.image_url ?? null,
    importedByWallet: row.imported_by_wallet ?? null,
    claimantWallet: row.manual_claim_wallet ?? null,
    projectOwnerWallet: row.project_owner_wallet ?? null,
    ownershipStatus: String(row.ownership_status || PENDING),
    ownershipVerifiedAt: row.ownership_verified_at ?? null,
    manualClaimRequestedAt: row.manual_claim_requested_at ?? null,
    manualClaimNote: row.manual_claim_note ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    metadataUpdatedAt: row.metadata_updated_at ?? null,
    arenaStatus: row.status ?? null,
    arenaReviewRequestedAt: row.review_requested_at ?? null,
    ownershipEvidence: row.scan_json ?? null,
    stateVersion: String(row.state_version || ""),
  };
}

function publicAudit(row) {
  return {
    id: String(row.id),
    action: String(row.action),
    operatorId: String(row.operator_id),
    operatorEmail: row.operator_email ?? null,
    reason: String(row.reason),
    claimantWallet: row.claimant_wallet ?? null,
    claimRequestedAt: row.claim_requested_at ?? null,
    claimNote: row.claim_note ?? null,
    previousOwnerWallet: row.previous_owner_wallet ?? null,
    nextOwnerWallet: row.next_owner_wallet ?? null,
    previousOwnershipStatus: String(row.previous_ownership_status),
    nextOwnershipStatus: String(row.next_ownership_status),
    projectUpdatedAtBefore: row.project_updated_at_before ?? null,
    createdAt: row.created_at ?? null,
  };
}

async function listClaims(db) {
  const result = await db.query(`
    SELECT i.*, i.xmin::text AS state_version
      FROM public.arena_token_imports i
     WHERE i.ownership_status = $1
       AND i.manual_claim_wallet IS NOT NULL
       AND btrim(i.manual_claim_wallet) <> ''
       AND i.manual_claim_requested_at IS NOT NULL
     ORDER BY i.manual_claim_requested_at ASC, i.created_at ASC
  `, [MANUAL_REVIEW]);
  return result.rows.map(publicClaim);
}

async function loadClaim(db, id) {
  const result = await db.query(`
    SELECT i.*, i.xmin::text AS state_version
      FROM public.arena_token_imports i
     WHERE i.id = $1
     LIMIT 1
  `, [id]);
  if (!result.rows[0]) return null;
  const audit = await db.query(`
    SELECT *
      FROM public.project_ownership_review_audit
     WHERE project_id = $1
     ORDER BY created_at DESC
     LIMIT 100
  `, [id]);
  return { item: publicClaim(result.rows[0]), history: audit.rows.map(publicAudit) };
}

async function reviewClaim(db, { id, action, expectedVersion, reason, operator }) {
  if (!expectedVersion) {
    const error = new Error("Expected ownership state version is required.");
    error.code = "PROJECT_OWNERSHIP_STATE_VERSION_REQUIRED";
    throw error;
  }
  const cleanReason = requiredReason(reason);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const beforeResult = await client.query(`
      SELECT i.*, i.xmin::text AS state_version
        FROM public.arena_token_imports i
       WHERE i.id = $1
       FOR UPDATE
    `, [id]);
    const before = beforeResult.rows[0];
    if (!before) {
      const error = new Error("Project ownership claim not found.");
      error.code = "PROJECT_OWNERSHIP_CLAIM_NOT_FOUND";
      throw error;
    }
    if (String(before.state_version) !== String(expectedVersion)
      || before.ownership_status !== MANUAL_REVIEW
      || !String(before.manual_claim_wallet || "").trim()
      || !before.manual_claim_requested_at) {
      const error = new Error("Project ownership claim changed before review.");
      error.code = "PROJECT_OWNERSHIP_STATE_CONFLICT";
      error.currentVersion = String(before.state_version || "");
      error.currentStatus = String(before.ownership_status || "");
      throw error;
    }

    const claimant = String(before.manual_claim_wallet).trim();
    const nextStatus = action === "verify_owner" ? VERIFIED : PENDING;
    const nextOwner = action === "verify_owner" ? claimant : null;
    const update = action === "verify_owner"
      ? await client.query(`
          UPDATE public.arena_token_imports
             SET project_owner_wallet = $2,
                 ownership_status = $3,
                 ownership_verified_at = NOW(),
                 manual_claim_wallet = NULL,
                 manual_claim_requested_at = NULL,
                 manual_claim_note = NULL,
                 updated_at = NOW()
           WHERE id = $1
             AND xmin::text = $4
             AND ownership_status = $5
           RETURNING *, xmin::text AS state_version
        `, [id, claimant, VERIFIED, expectedVersion, MANUAL_REVIEW])
      : await client.query(`
          UPDATE public.arena_token_imports
             SET project_owner_wallet = NULL,
                 ownership_status = $2,
                 ownership_verified_at = NULL,
                 manual_claim_wallet = NULL,
                 manual_claim_requested_at = NULL,
                 manual_claim_note = NULL,
                 updated_at = NOW()
           WHERE id = $1
             AND xmin::text = $3
             AND ownership_status = $4
           RETURNING *, xmin::text AS state_version
        `, [id, PENDING, expectedVersion, MANUAL_REVIEW]);

    if (!update.rows[0]) {
      const error = new Error("Project ownership claim changed before review.");
      error.code = "PROJECT_OWNERSHIP_STATE_CONFLICT";
      throw error;
    }

    await client.query(`
      INSERT INTO public.project_ownership_review_audit (
        project_id, action, operator_id, operator_email, reason,
        claimant_wallet, claim_requested_at, claim_note,
        previous_owner_wallet, next_owner_wallet,
        previous_ownership_status, next_ownership_status,
        project_updated_at_before
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    `, [
      before.id,
      action,
      operator.id,
      operator.email || null,
      cleanReason,
      claimant,
      before.manual_claim_requested_at,
      before.manual_claim_note ?? null,
      before.project_owner_wallet ?? null,
      nextOwner,
      before.ownership_status,
      nextStatus,
      before.updated_at,
    ]);

    await client.query("COMMIT");
    return publicClaim(update.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function errorStatus(error) {
  if (error?.code === "PROJECT_OWNERSHIP_CLAIM_NOT_FOUND") return 404;
  if (error?.code === "PROJECT_OWNERSHIP_STATE_CONFLICT") return 409;
  if (error?.code === "PROJECT_OWNERSHIP_REASON_REQUIRED" || error?.code === "PROJECT_OWNERSHIP_STATE_VERSION_REQUIRED") return 400;
  return 500;
}

export function createProjectOwnershipClaimsHandler({
  db = defaultPool,
  requireAdmin = defaultRequireDashboardAdmin,
} = {}) {
  return async function projectOwnershipClaims(req, res) {
    try {
      if (!db) return send(res, 503, { error: "Project ownership review requires DATABASE_URL." });
      const operator = await requireAdmin(req, res);
      if (!operator) return;
      const parts = pathParts(req);

      if (req.method === "GET" && parts.length === 0) {
        return send(res, 200, { items: await listClaims(db) });
      }
      if (req.method === "GET" && parts.length === 1) {
        const detail = await loadClaim(db, parts[0]);
        if (!detail) return send(res, 404, { error: "Project ownership claim not found.", code: "PROJECT_OWNERSHIP_CLAIM_NOT_FOUND" });
        return send(res, 200, detail);
      }
      if (req.method === "POST" && parts.length === 2 && ["verify", "reject"].includes(parts[1])) {
        const body = await readBody(req);
        const action = parts[1] === "verify" ? "verify_owner" : "reject_claim";
        const item = await reviewClaim(db, {
          id: parts[0],
          action,
          expectedVersion: body.expectedVersion,
          reason: body.reason,
          operator,
        });
        return send(res, 200, { item });
      }
      return send(res, 405, { error: "Method or project ownership review operation not allowed." });
    } catch (error) {
      console.error("[api/admin/projectOwnershipClaims]", error);
      return send(res, errorStatus(error), {
        error: String(error?.message || error),
        code: error?.code || "PROJECT_OWNERSHIP_REVIEW_ERROR",
        currentVersion: error?.currentVersion,
        currentStatus: error?.currentStatus,
      });
    }
  };
}

export default createProjectOwnershipClaimsHandler();
