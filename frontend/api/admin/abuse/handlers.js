import { readJson } from "../../../server/http.js";
import {
  ABUSE_PERMISSIONS,
  capabilitiesFromPermissions,
  createAbuseAuth,
  isUuid,
  normalizeAbusePermission,
  normalizeEmail,
} from "../../lib/abuseAuth.js";
import { createAbuseCaseHandlers } from "./cases.js";
import { createBlockedCoinsHandlers } from "./blockedCoins.js";

function requestPath(req) {
  return String(req.originalUrl || req.url || req.path || "").split("?")[0];
}

function methodNotAllowed(res) {
  return res.status(405).json({ ok: false, error: "Method not allowed" });
}

function mapGrant(row) {
  return {
    id: String(row.id),
    employeeId: String(row.employee_id),
    employeeEmail: normalizeEmail(row.employee_email),
    permission: String(row.permission),
    grantedBy: row.granted_by ? String(row.granted_by) : null,
    grantedByEmail: row.granted_by_email ? normalizeEmail(row.granted_by_email) : null,
    grantedAt: row.granted_at instanceof Date ? row.granted_at.toISOString() : String(row.granted_at),
  };
}

export function createAbuseAdminHandlers(deps = {}) {
  const auth = createAbuseAuth(deps);
  const db = deps.pool;

  async function me(req, res) {
    const actor = await auth.requireDashboardActor(req, res);
    if (!actor) return;

    if (String(req.method || "").toUpperCase() !== "GET") return methodNotAllowed(res);

    let permissions = [];
    try {
      permissions = await auth.loadActivePermissions(actor.id);
    } catch (error) {
      console.error("[abuse/me] permission lookup failed", error?.message || error);
      return res.status(503).json({
        ok: false,
        error: "Abuse authorization is unavailable.",
        code: "ABUSE_AUTH_UNAVAILABLE",
      });
    }

    return res.status(200).json({
      ok: true,
      employeeId: actor.id,
      employeeEmail: actor.email,
      permissions,
      capabilities: capabilitiesFromPermissions(permissions),
    });
  }

  const cases = createAbuseCaseHandlers({ pool: db, auth });
  const reports = cases.reports;
  const staff = cases.staff;
  const blockedCoins = createBlockedCoinsHandlers({ pool: db, auth });

  async function listGrants(res) {
    const { rows } = await db.query(
      `select id, employee_id, employee_email, permission, granted_by, granted_by_email, granted_at
         from public.employee_permissions
        where revoked_at is null
        order by granted_at desc, employee_email asc`,
    );
    return res.status(200).json({ ok: true, grants: rows.map(mapGrant) });
  }

  async function grantPermission(req, res, actor) {
    const body = await readJson(req);
    const employeeId = String(body.employeeId || body.employee_id || "").trim();
    const employeeEmail = normalizeEmail(body.employeeEmail || body.employee_email);
    const permission = normalizeAbusePermission(body.permission);

    if (!isUuid(employeeId) || !employeeEmail || !permission) {
      return res.status(400).json({ ok: false, error: "employeeId, employeeEmail, and a valid abuse permission are required." });
    }

    const existing = await db.query(
      `select id, employee_id, employee_email, permission, granted_by, granted_by_email, granted_at
         from public.employee_permissions
        where employee_id = $1
          and permission = $2
          and revoked_at is null
        limit 1`,
      [employeeId, permission],
    );
    if (existing.rows[0]) {
      return res.status(200).json({ ok: true, alreadyGranted: true, grant: mapGrant(existing.rows[0]) });
    }

    let inserted;
    try {
      inserted = await db.query(
        `insert into public.employee_permissions
           (employee_id, employee_email, permission, granted_by, granted_by_email)
         values ($1, $2, $3, $4, $5)
         returning id, employee_id, employee_email, permission, granted_by, granted_by_email, granted_at`,
        [employeeId, employeeEmail, permission, actor.id, actor.email || null],
      );
    } catch (error) {
      if (error?.code === "23505") {
        const raced = await db.query(
          `select id, employee_id, employee_email, permission, granted_by, granted_by_email, granted_at
             from public.employee_permissions
            where employee_id = $1
              and permission = $2
              and revoked_at is null
            limit 1`,
          [employeeId, permission],
        );
        if (raced.rows[0]) {
          return res.status(200).json({ ok: true, alreadyGranted: true, grant: mapGrant(raced.rows[0]) });
        }
      }
      throw error;
    }

    await auth.writeAudit({
      eventType: "PERMISSION_GRANTED",
      actorType: "admin",
      actorId: actor.id,
      actorEmail: actor.email,
      subjectId: employeeId,
      subjectEmail: employeeEmail,
      oldValue: null,
      newValue: permission,
    });

    return res.status(200).json({ ok: true, alreadyGranted: false, grant: mapGrant(inserted.rows[0]) });
  }

  async function revokePermission(req, res, actor) {
    const body = await readJson(req);
    const employeeId = String(body.employeeId || body.employee_id || "").trim();
    const permission = normalizeAbusePermission(body.permission);
    const reason = String(body.reason || "").trim().slice(0, 500) || null;

    if (!isUuid(employeeId) || !permission) {
      return res.status(400).json({ ok: false, error: "employeeId and a valid abuse permission are required." });
    }

    const updated = await db.query(
      `update public.employee_permissions
          set revoked_at = now(),
              revoke_reason = $3
        where employee_id = $1
          and permission = $2
          and revoked_at is null
        returning id, employee_email, permission`,
      [employeeId, permission, reason],
    );

    if (!updated.rows[0]) {
      return res.status(404).json({ ok: false, error: "Active grant not found." });
    }

    await auth.writeAudit({
      eventType: "PERMISSION_REVOKED",
      actorType: "admin",
      actorId: actor.id,
      actorEmail: actor.email,
      subjectId: employeeId,
      subjectEmail: normalizeEmail(updated.rows[0].employee_email),
      oldValue: permission,
      newValue: null,
      metadata: reason ? { reason } : {},
    });

    return res.status(200).json({
      ok: true,
      revoked: true,
      employeeId,
      permission,
    });
  }

  async function permissions(req, res) {
    const actor = await auth.requireAbusePermission(req, res, ABUSE_PERMISSIONS.ADMIN);
    if (!actor) return;

    const method = String(req.method || "").toUpperCase();
    const path = requestPath(req);

    if (path.endsWith("/revoke")) {
      if (method !== "POST") return methodNotAllowed(res);
      return revokePermission(req, res, actor);
    }

    if (method === "GET") return listGrants(res);
    if (method === "POST") return grantPermission(req, res, actor);
    return methodNotAllowed(res);
  }

  return { me, reports, permissions, staff, blockedCoins };
}

export default createAbuseAdminHandlers;
