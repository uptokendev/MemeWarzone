import { pool } from "../../server/db.js";
import { readJson } from "../../server/http.js";
import { requireDashboardPermission, requireDashboardUser } from "../dashboard/_access.js";
import {
  createDashboardInvitation,
  ensureDashboardActorMember,
  listDashboardAccessAudit,
  listDashboardInvitations,
  listDashboardMembers,
  revokeDashboardInvitation,
  setDashboardMemberDisabled,
  updateDashboardMemberAccess,
  writeDashboardAccessAudit,
} from "../dashboard/_accessAdmin.js";
import { sendDashboardAccessEmail } from "../dashboard/_inviteDelivery.js";

function requestId(req) {
  return String(req.headers?.["x-request-id"] || req.headers?.["x-correlation-id"] || "").trim() || null;
}

function pathnameOf(req) {
  return new URL(req.originalUrl || req.url || "/", "http://localhost").pathname;
}

function methodOf(req) {
  return String(req.method || "GET").toUpperCase();
}

function fail(res, error) {
  const status = Number(error?.status || 500);
  const payload = {
    ok: false,
    code: error?.code || (status >= 500 ? "DASHBOARD_ACCESS_OPERATION_FAILED" : "DASHBOARD_ACCESS_REQUEST_FAILED"),
    error: status >= 500 && !error?.code ? "Command Center access operation failed." : String(error?.message || "Command Center access operation failed."),
  };
  if (error?.expectedVersion != null) payload.expectedVersion = error.expectedVersion;
  if (error?.currentVersion != null) payload.currentVersion = error.currentVersion;
  return res.status(status).json(payload);
}

async function requireAccessManager(req, res) {
  return requireDashboardPermission(req, res, "access.manage");
}

async function handleMe(req, res) {
  if (methodOf(req) !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed." });
  }
  const principal = await requireDashboardUser(req, res);
  if (!principal) return;
  return res.status(200).json({
    ok: true,
    user: {
      id: principal.authUserId,
      memberId: principal.memberId,
      email: principal.email,
      name: principal.displayName,
      role: principal.role,
    },
    status: principal.status,
    permissionsVersion: principal.permissionsVersion,
    permissions: principal.permissions,
    owner: principal.isOwner,
    breakGlass: principal.isBreakGlass,
  });
}

async function handleMembers(req, res) {
  const principal = await requireAccessManager(req, res);
  if (!principal) return;
  if (methodOf(req) !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed." });
  }
  return res.status(200).json({ ok: true, members: await listDashboardMembers() });
}

async function handleInvitations(req, res) {
  const principal = await requireAccessManager(req, res);
  if (!principal) return;

  if (methodOf(req) === "GET") {
    return res.status(200).json({ ok: true, invitations: await listDashboardInvitations() });
  }
  if (methodOf(req) !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "Method not allowed." });
  }

  const body = await readJson(req);
  const invitation = await createDashboardInvitation({
    principal,
    email: body?.email,
    role: body?.role,
    permissions: body?.permissions,
    reason: String(body?.reason || "").trim() || null,
    requestId: requestId(req),
  });

  let delivery = { sent: false, error: null, mode: null };
  try {
    const result = await sendDashboardAccessEmail(invitation.email);
    delivery = { sent: true, error: null, mode: result.mode };
  } catch (error) {
    delivery = { sent: false, error: String(error?.message || "Invitation delivery failed."), mode: null };
  }

  return res.status(delivery.sent ? 201 : 202).json({
    ok: true,
    invitation,
    delivery,
  });
}

async function loadInvitation(invitationId) {
  const result = await pool.query(
    `select id, email_normalized, role, status, version, permissions_snapshot, created_at, expires_at
       from public.dashboard_access_invitations
      where id = $1::uuid`,
    [invitationId],
  );
  return result.rows?.[0] || null;
}

async function handleInvitationAction(req, res, invitationId, action) {
  const principal = await requireAccessManager(req, res);
  if (!principal) return;
  if (methodOf(req) !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed." });
  }
  const body = await readJson(req);
  const expectedVersion = Number(body?.expectedVersion);
  const reason = String(body?.reason || "").trim() || null;

  if (action === "revoke") {
    const result = await revokeDashboardInvitation({
      principal,
      invitationId,
      expectedVersion,
      reason,
      requestId: requestId(req),
    });
    return res.status(200).json(result);
  }

  const invitation = await loadInvitation(invitationId);
  if (!invitation) return res.status(404).json({ ok: false, code: "INVITATION_NOT_FOUND", error: "Invitation not found." });
  if (invitation.status !== "pending") return res.status(409).json({ ok: false, code: "INVITATION_NOT_PENDING", error: "Only pending invitations can be resent." });
  if (!Number.isInteger(expectedVersion) || Number(invitation.version) !== expectedVersion) {
    return res.status(409).json({
      ok: false,
      code: "STALE_INVITATION_VERSION",
      error: "Invitation changed since this page was loaded.",
      currentVersion: Number(invitation.version),
    });
  }

  const delivery = await sendDashboardAccessEmail(invitation.email_normalized);
  const actorMemberId = await ensureDashboardActorMember(principal);
  const updated = await pool.query(
    `update public.dashboard_access_invitations
        set version = version + 1,
            expires_at = greatest(coalesce(expires_at, now()), now() + interval '7 days')
      where id = $1::uuid and version = $2 and status = 'pending'
      returning version, expires_at`,
    [invitationId, expectedVersion],
  );
  if (!updated.rowCount) {
    return res.status(409).json({ ok: false, code: "STALE_INVITATION_VERSION", error: "Invitation changed since this page was loaded." });
  }
  await writeDashboardAccessAudit({
    actorMemberId,
    actorEmail: principal.email,
    subjectEmail: invitation.email_normalized,
    action: "INVITATION_RESENT",
    beforeState: { version: expectedVersion },
    afterState: { version: Number(updated.rows[0].version), expiresAt: updated.rows[0].expires_at, deliveryMode: delivery.mode },
    reason,
    requestId: requestId(req),
  });
  return res.status(200).json({ ok: true, version: Number(updated.rows[0].version), expiresAt: updated.rows[0].expires_at, deliveryMode: delivery.mode });
}

async function handleMemberUpdate(req, res, memberId) {
  const principal = await requireAccessManager(req, res);
  if (!principal) return;
  if (methodOf(req) !== "PATCH") {
    res.setHeader("Allow", "PATCH");
    return res.status(405).json({ ok: false, error: "Method not allowed." });
  }
  const body = await readJson(req);
  const member = await updateDashboardMemberAccess({
    principal,
    memberId,
    expectedVersion: body?.expectedVersion,
    role: body?.role,
    permissions: body?.permissions,
    displayName: body?.displayName,
    reason: String(body?.reason || "").trim() || null,
    requestId: requestId(req),
  });
  return res.status(200).json({ ok: true, member });
}

async function handleMemberStatus(req, res, memberId, disabled) {
  const principal = await requireAccessManager(req, res);
  if (!principal) return;
  if (methodOf(req) !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed." });
  }
  const body = await readJson(req);
  const member = await setDashboardMemberDisabled({
    principal,
    memberId,
    expectedVersion: body?.expectedVersion,
    disabled,
    reason: String(body?.reason || "").trim() || null,
    requestId: requestId(req),
  });
  return res.status(200).json({ ok: true, member });
}

async function handleAudit(req, res) {
  const principal = await requireAccessManager(req, res);
  if (!principal) return;
  if (methodOf(req) !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed." });
  }
  const url = new URL(req.originalUrl || req.url || "/", "http://localhost");
  const events = await listDashboardAccessAudit(url.searchParams.get("limit") || 100);
  return res.status(200).json({ ok: true, events });
}

export default async function dashboardAccess(req, res) {
  const pathname = pathnameOf(req);
  try {
    if (pathname === "/api/admin/access/me") return await handleMe(req, res);
    if (pathname === "/api/admin/access/members") return await handleMembers(req, res);
    if (pathname === "/api/admin/access/invitations") return await handleInvitations(req, res);
    if (pathname === "/api/admin/access/audit") return await handleAudit(req, res);

    const invitationMatch = pathname.match(/^\/api\/admin\/access\/invitations\/([0-9a-f-]{36})\/(resend|revoke)$/i);
    if (invitationMatch) return await handleInvitationAction(req, res, invitationMatch[1], invitationMatch[2].toLowerCase());

    const memberStatusMatch = pathname.match(/^\/api\/admin\/access\/members\/([0-9a-f-]{36})\/(disable|restore)$/i);
    if (memberStatusMatch) return await handleMemberStatus(req, res, memberStatusMatch[1], memberStatusMatch[2].toLowerCase() === "disable");

    const memberMatch = pathname.match(/^\/api\/admin\/access\/members\/([0-9a-f-]{36})$/i);
    if (memberMatch) return await handleMemberUpdate(req, res, memberMatch[1]);

    return res.status(404).json({ ok: false, error: "Unknown dashboard access route." });
  } catch (error) {
    console.error("[dashboard-access]", pathname, error?.code || error?.message || error);
    return fail(res, error);
  }
}
