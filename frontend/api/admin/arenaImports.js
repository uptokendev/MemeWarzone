import { createHash } from "node:crypto";
import { pool } from "../../server/db.js";
import { getQuery, json, readJson } from "../../server/http.js";
import { requireAdminOrOps } from "../lib/apiAuth.js";
import { scanEvm, scanSolana } from "../lib/arenaImportScan.js";
import { evaluateImportedCompetitionEligibility, hasNonOverridableFinding } from "../lib/arenaImportEligibility.js";

const STATUSES = new Set(["scanning", "passed", "needs_review", "declined", "stale"]);

function evidenceVersion(scan) {
  return createHash("sha256").update(JSON.stringify(scan || {})).digest("hex");
}

function reviewerIdentity(admin) {
  return String(admin?.admin?.id || admin?.admin?.email || "").trim();
}

function isSelfReview(row, admin) {
  const owner = String(row?.owner_wallet || "").trim().toLowerCase();
  if (!owner) return false;
  return [admin?.admin?.id, admin?.admin?.email]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean)
    .includes(owner);
}

function actionPolicy(row, admin = null) {
  const hardBlocked = hasNonOverridableFinding(row);
  const selfReview = admin ? isSelfReview(row, admin) : false;
  return {
    canRescan: Boolean(row),
    canApprove: Boolean(row) && !hardBlocked && !selfReview && String(row.status) !== "passed",
    canReject: Boolean(row) && !selfReview && String(row.status) !== "declined",
    hardBlocked,
    selfReview,
    requiresReason: true,
    requiresExpectedVersion: true,
  };
}

function mapImport(row, admin = null) {
  if (!row) return null;
  const item = {
    id: String(row.id),
    chainId: Number(row.chain_id),
    tokenAddress: String(row.token_address),
    ownerWallet: String(row.owner_wallet),
    name: row.name || null,
    symbol: row.symbol || null,
    status: String(row.status),
    scan: row.scan_json && typeof row.scan_json === "object" ? row.scan_json : {},
    scanVersion: row.scan_version || row.scan_json?.scanVersion || null,
    scannedAt: row.scanned_at || row.scan_json?.scannedAt || null,
    evidenceVersion: row.evidence_version || null,
    stateVersion: Number(row.state_version || 0),
    reviewRequestedAt: row.review_requested_at || null,
    reviewReason: row.review_reason || null,
    reviewer: row.reviewer || null,
    reviewedAt: row.reviewed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  item.eligibility = evaluateImportedCompetitionEligibility(row);
  item.actionPolicy = actionPolicy(row, admin);
  return item;
}

async function strictAdmin(req, res) {
  const admin = await requireAdminOrOps(req, res, { routeLabel: "admin/arena/imports", allowOps: false });
  if (!admin) return null;
  if (admin.mode !== "admin" || !admin.admin?.id) {
    if (!res.headersSent) {
      json(res, 401, { ok: false, error: "Authenticated dashboard administrator required.", code: "IMPORT_ADMIN_AUTH_REQUIRED" });
    }
    return null;
  }
  return admin;
}

async function loadHistory(importId) {
  const history = await pool.query(
    `select id, event_type, previous_status, next_status, evidence, scan_version, evidence_version,
            decision, reviewer, reason, state_version, created_at
       from public.arena_token_import_history
      where import_id = $1::uuid
      order by created_at asc, id asc`,
    [importId],
  );
  return history.rows.map((row) => ({
    id: Number(row.id),
    eventType: row.event_type,
    previousStatus: row.previous_status,
    nextStatus: row.next_status,
    evidence: row.evidence || {},
    scanVersion: row.scan_version || null,
    evidenceVersion: row.evidence_version || null,
    decision: row.decision || null,
    reviewer: row.reviewer || null,
    reason: row.reason || null,
    stateVersion: Number(row.state_version || 0),
    timestamp: row.created_at,
  }));
}

async function scanToken(chainId, token) {
  return Number(chainId) === 101 || Number(chainId) === 102 ? scanSolana(chainId, token) : scanEvm(chainId, token);
}

async function mutateDecision({ id, body, admin, desiredStatus, decision }) {
  const expectedVersion = Number(body.expectedVersion);
  const reason = String(body.reason || "").trim().slice(0, 500);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    return { http: 400, body: { ok: false, error: "expectedVersion is required", code: "IMPORT_EXPECTED_VERSION_REQUIRED" } };
  }
  if (!reason) return { http: 400, body: { ok: false, error: "reason is required", code: "IMPORT_REASON_REQUIRED" } };

  const client = await pool.connect();
  try {
    await client.query("begin");
    const loaded = await client.query(`select * from public.arena_token_imports where id = $1::uuid for update`, [id]);
    const row = loaded.rows[0];
    if (!row) {
      await client.query("rollback");
      return { http: 404, body: { ok: false, error: "Import not found", code: "IMPORT_NOT_FOUND" } };
    }
    if (isSelfReview(row, admin)) {
      await client.query("rollback");
      return { http: 403, body: { ok: false, error: "Importer cannot adjudicate their own import.", code: "IMPORT_SELF_REVIEW_FORBIDDEN" } };
    }
    if (decision === "approve" && hasNonOverridableFinding(row)) {
      await client.query("rollback");
      return { http: 422, body: { ok: false, error: "Non-overridable scanner finding blocks approval.", code: "IMPORT_NON_OVERRIDABLE_FINDING", actionPolicy: actionPolicy(row, admin) } };
    }

    const currentVersion = Number(row.state_version || 0);
    if (currentVersion !== expectedVersion) {
      if (String(row.status) === desiredStatus && String(row.review_reason || "") === reason) {
        await client.query("commit");
        return { http: 200, body: { ok: true, idempotent: true, item: mapImport(row, admin) } };
      }
      await client.query("rollback");
      return {
        http: 409,
        body: {
          ok: false,
          error: "Import state changed before this decision.",
          code: "IMPORT_STATE_CONFLICT",
          expectedVersion,
          currentVersion,
          currentStatus: String(row.status),
        },
      };
    }

    const reviewer = reviewerIdentity(admin);
    const updated = await client.query(
      `update public.arena_token_imports
          set status = $2,
              review_reason = $3,
              reviewer = $4,
              reviewed_at = now(),
              state_version = state_version + 1,
              updated_at = now()
        where id = $1::uuid and state_version = $5
        returning *`,
      [id, desiredStatus, reason, reviewer, expectedVersion],
    );
    if (!updated.rows[0]) {
      await client.query("rollback");
      return { http: 409, body: { ok: false, error: "Import state changed before this decision.", code: "IMPORT_STATE_CONFLICT" } };
    }
    const next = updated.rows[0];
    await client.query(
      `insert into public.arena_token_import_history
       (import_id,event_type,previous_status,next_status,evidence,scan_version,evidence_version,decision,reviewer,reason,state_version)
       values ($1::uuid,'decision',$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10)`,
      [id, row.status, next.status, JSON.stringify(next.scan_json || {}), next.scan_version, next.evidence_version, decision, reviewer, reason, next.state_version],
    );
    await client.query("commit");
    return { http: 200, body: { ok: true, idempotent: false, item: mapImport(next, admin) } };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function rescanImport({ id, body, admin }) {
  const expectedVersion = Number(body.expectedVersion);
  const reason = String(body.reason || "rescan").trim().slice(0, 500) || "rescan";
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    return { http: 400, body: { ok: false, error: "expectedVersion is required", code: "IMPORT_EXPECTED_VERSION_REQUIRED" } };
  }

  const before = await pool.query(`select * from public.arena_token_imports where id = $1::uuid limit 1`, [id]);
  const snapshot = before.rows[0];
  if (!snapshot) return { http: 404, body: { ok: false, error: "Import not found", code: "IMPORT_NOT_FOUND" } };
  const scan = await scanToken(Number(snapshot.chain_id), String(snapshot.token_address));
  const version = evidenceVersion(scan.scan);

  const client = await pool.connect();
  try {
    await client.query("begin");
    const locked = await client.query(`select * from public.arena_token_imports where id = $1::uuid for update`, [id]);
    const row = locked.rows[0];
    if (Number(row.state_version || 0) !== expectedVersion) {
      await client.query("rollback");
      return { http: 409, body: { ok: false, error: "Import state changed before rescan completed.", code: "IMPORT_STATE_CONFLICT", expectedVersion, currentVersion: Number(row.state_version || 0) } };
    }
    const updated = await client.query(
      `update public.arena_token_imports
          set status=$2, name=coalesce($3,name), symbol=coalesce($4,symbol), scan_json=$5::jsonb,
              scan_version=$6, scanned_at=$7::timestamptz, evidence_version=$8,
              state_version=state_version+1, updated_at=now()
        where id=$1::uuid and state_version=$9
        returning *`,
      [id, scan.status, scan.name, scan.symbol, JSON.stringify(scan.scan || {}), scan.scanVersion, scan.scannedAt, version, expectedVersion],
    );
    if (!updated.rows[0]) {
      await client.query("rollback");
      return { http: 409, body: { ok: false, error: "Import state changed before rescan completed.", code: "IMPORT_STATE_CONFLICT" } };
    }
    const next = updated.rows[0];
    await client.query(
      `insert into public.arena_token_import_history
       (import_id,event_type,previous_status,next_status,evidence,scan_version,evidence_version,decision,reviewer,reason,state_version)
       values ($1::uuid,'rescan',$2,$3,$4::jsonb,$5,$6,'rescan',$7,$8,$9)`,
      [id, row.status, next.status, JSON.stringify(next.scan_json || {}), next.scan_version, next.evidence_version, reviewerIdentity(admin), reason, next.state_version],
    );
    await client.query("commit");
    return { http: 200, body: { ok: true, item: mapImport(next, admin) };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  const method = String(req.method || "GET").toUpperCase();
  const path = String(req.path || new URL(req.url, "http://localhost").pathname);
  const admin = await strictAdmin(req, res);
  if (!admin) return;

  try {
    if (method === "GET" && (path === "/admin/arena/imports" || path === "/api/admin/arena/imports")) {
      const query = getQuery(req);
      const id = String(query.id || "").trim();
      if (id) {
        const result = await pool.query(`select * from public.arena_token_imports where id=$1::uuid limit 1`, [id]);
        if (!result.rows[0]) return json(res, 404, { ok: false, error: "Import not found", code: "IMPORT_NOT_FOUND" });
        return json(res, 200, { ok: true, item: mapImport(result.rows[0], admin), history: await loadHistory(id) });
      }
      const status = String(query.status || "").trim();
      const values = [];
      let where = "";
      if (STATUSES.has(status) || status === "review_requested") {
        if (status === "review_requested") where = "where review_requested_at is not null and status in ('declined','needs_review')";
        else { values.push(status); where = "where status = $1"; }
      }
      const result = await pool.query(`select * from public.arena_token_imports ${where} order by coalesce(review_requested_at, updated_at) desc limit 200`, values);
      return json(res, 200, { ok: true, items: result.rows.map((row) => mapImport(row, admin)), updatedAt: new Date().toISOString() });
    }

    const action = path.match(/\/admin\/arena\/imports\/([^/]+)\/(rescan|approve|reject|decide)$/);
    if (action && method === "POST") {
      const body = await readJson(req);
      const id = decodeURIComponent(action[1]);
      let verb = action[2];
      if (verb === "decide") verb = String(body.status) === "passed" ? "approve" : "reject";
      const result = verb === "rescan"
        ? await rescanImport({ id, body, admin })
        : await mutateDecision({ id, body, admin, desiredStatus: verb === "approve" ? "passed" : "declined", decision: verb });
      return json(res, result.http, result.body);
    }

    return json(res, 404, { ok: false, error: "Unknown admin arena imports route", code: "IMPORT_ADMIN_ROUTE_NOT_FOUND" });
  } catch (error) {
    console.error("[admin/arenaImports]", error);
    return json(res, 503, { ok: false, error: "Import admin storage is unavailable", code: "IMPORT_ADMIN_UNAVAILABLE", detail: String(error?.message || error) });
  }
}