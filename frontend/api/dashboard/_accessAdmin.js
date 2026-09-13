import { pool } from "../../server/db.js";
import {
  DASHBOARD_PERMISSIONS,
  DASHBOARD_ROLE_PRESETS,
  expandDashboardPermissions,
} from "./_access.js";

const VALID_ROLES = new Set(Object.keys(DASHBOARD_ROLE_PRESETS));
const VALID_PERMISSIONS = new Set(DASHBOARD_PERMISSIONS);
const MEMBER_STATUSES = new Set(["invited", "active", "disabled", "suspended"]);

export function normalizeDashboardEmail(value) {
  return String(value || "").trim().toLowerCase();
}

export function normalizeDashboardRole(value) {
  const role = String(value || "custom").trim().toLowerCase();
  return VALID_ROLES.has(role) ? role : "";
}

export function normalizeDashboardPermissions(value, role = "custom") {
  if (!Array.isArray(value)) return expandDashboardPermissions(DASHBOARD_ROLE_PRESETS[role] || []);
  const permissions = value
    .map((permission) => String(permission || "").trim())
    .filter((permission) => VALID_PERMISSIONS.has(permission));
  return expandDashboardPermissions(permissions);
}

export async function ensureDashboardActorMember(principal, db = pool) {
  if (principal.memberId) return principal.memberId;
  if (!principal.isOwner) throw new Error("Dashboard actor membership is required.");

  const email = normalizeDashboardEmail(principal.email);
  const result = await db.query(
    `insert into public.dashboard_members (
       auth_user_id, email_normalized, display_name, role, status, activated_at, permissions_version
     ) values ($1::uuid, $2, $3, 'owner', 'active', now(), 1)
     on conflict (email_normalized) do update
       set auth_user_id = excluded.auth_user_id,
           role = 'owner',
           status = 'active',
           disabled_at = null,
           disabled_by_member_id = null,
           disable_reason = null,
           updated_at = now(),
           permissions_version = public.dashboard_members.permissions_version + 1
     returning id`,
    [principal.authUserId, email, principal.displayName || null],
  );
  return String(result.rows[0].id);
}

export async function writeDashboardAccessAudit({
  actorMemberId = null,
  actorEmail = null,
  subjectMemberId = null,
  subjectEmail = null,
  action,
  beforeState = null,
  afterState = null,
  reason = null,
  requestId = null,
  db = pool,
}) {
  await db.query(
    `insert into public.dashboard_access_audit (
       actor_member_id, actor_email, subject_member_id, subject_email,
       action, before_state, after_state, reason, request_id
     ) values ($1::uuid, $2, $3::uuid, $4, $5, $6::jsonb, $7::jsonb, $8, $9)`,
    [
      actorMemberId,
      actorEmail,
      subjectMemberId,
      subjectEmail,
      action,
      beforeState == null ? null : JSON.stringify(beforeState),
      afterState == null ? null : JSON.stringify(afterState),
      reason,
      requestId,
    ],
  );
}

export async function listDashboardMembers(db = pool) {
  const { rows } = await db.query(
    `select m.id, m.auth_user_id, m.email_normalized, m.display_name, m.role, m.status,
            m.invited_by_member_id, m.invited_at, m.activated_at, m.disabled_at,
            m.disable_reason, m.last_seen_at, m.permissions_version, m.created_at, m.updated_at,
            inviter.email_normalized as invited_by_email,
            coalesce(array_agg(p.permission order by p.permission) filter (where p.permission is not null), '{}') as permissions
       from public.dashboard_members m
       left join public.dashboard_members inviter on inviter.id = m.invited_by_member_id
       left join public.dashboard_member_permissions p on p.member_id = m.id
      group by m.id, inviter.email_normalized
      order by case m.status when 'active' then 0 when 'invited' then 1 when 'disabled' then 2 else 3 end,
               lower(m.email_normalized) asc`,
  );
  return rows.map((row) => ({
    id: String(row.id),
    authUserId: row.auth_user_id ? String(row.auth_user_id) : null,
    email: row.email_normalized,
    name: row.display_name || null,
    role: row.role,
    status: row.status,
    invitedBy: row.invited_by_email || null,
    invitedAt: row.invited_at || null,
    activatedAt: row.activated_at || null,
    disabledAt: row.disabled_at || null,
    disableReason: row.disable_reason || null,
    lastSeenAt: row.last_seen_at || null,
    permissionsVersion: Number(row.permissions_version || 1),
    permissions: row.role === "owner"
      ? expandDashboardPermissions(DASHBOARD_ROLE_PRESETS.owner)
      : expandDashboardPermissions(row.permissions || []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function listDashboardInvitations(db = pool) {
  const { rows } = await db.query(
    `select i.id, i.email_normalized, i.role, i.status, i.permissions_snapshot,
            i.version, i.created_at, i.expires_at, i.revoked_at, i.accepted_at,
            inviter.email_normalized as invited_by_email
       from public.dashboard_access_invitations i
       left join public.dashboard_members inviter on inviter.id = i.invited_by_member_id
      order by i.created_at desc`,
  );
  return rows.map((row) => ({
    id: String(row.id),
    email: row.email_normalized,
    role: row.role,
    status: row.status,
    permissions: expandDashboardPermissions(Array.isArray(row.permissions_snapshot) ? row.permissions_snapshot : []),
    version: Number(row.version || 1),
    createdAt: row.created_at,
    expiresAt: row.expires_at || null,
    revokedAt: row.revoked_at || null,
    acceptedAt: row.accepted_at || null,
    invitedBy: row.invited_by_email || null,
  }));
}

export async function listDashboardAccessAudit(limit = 100, db = pool) {
  const safeLimit = Math.max(1, Math.min(250, Number(limit) || 100));
  const { rows } = await db.query(
    `select id, actor_email, subject_email, action, before_state, after_state, reason, request_id, created_at
       from public.dashboard_access_audit
      order by created_at desc
      limit $1`,
    [safeLimit],
  );
  return rows.map((row) => ({
    id: String(row.id),
    actorEmail: row.actor_email || null,
    subjectEmail: row.subject_email || null,
    action: row.action,
    beforeState: row.before_state || null,
    afterState: row.after_state || null,
    reason: row.reason || null,
    requestId: row.request_id || null,
    createdAt: row.created_at,
  }));
}

export async function sendSupabaseDashboardInvite(email) {
  const supabaseUrl = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const serviceRole = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const redirectTo = String(process.env.DASHBOARD_INVITE_REDIRECT_URL || "").trim();
  if (!supabaseUrl || !serviceRole) {
    throw Object.assign(new Error("Supabase Admin invitation is not configured."), { code: "DASHBOARD_INVITE_NOT_CONFIGURED" });
  }
  if (!redirectTo) {
    throw Object.assign(new Error("DASHBOARD_INVITE_REDIRECT_URL is required."), { code: "DASHBOARD_INVITE_REDIRECT_MISSING" });
  }

  const inviteUrl = new URL(`${supabaseUrl}/auth/v1/invite`);
  inviteUrl.searchParams.set("redirect_to", redirectTo);
  const response = await fetch(inviteUrl, {
    method: "POST",
    headers: {
      apikey: serviceRole,
      Authorization: `Bearer ${serviceRole}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email }),
    cache: "no-store",
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = String(body?.msg || body?.message || body?.error_description || `Supabase invite failed (${response.status}).`);
    throw Object.assign(new Error(message), { code: "DASHBOARD_INVITE_DELIVERY_FAILED", status: response.status });
  }
  return { id: body?.id || null };
}

export async function createDashboardInvitation({ principal, email, role, permissions, reason, requestId, db = pool }) {
  const normalizedEmail = normalizeDashboardEmail(email);
  if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
    throw Object.assign(new Error("A valid email address is required."), { status: 400, code: "INVALID_EMAIL" });
  }
  const normalizedRole = normalizeDashboardRole(role);
  if (!normalizedRole) {
    throw Object.assign(new Error("Unknown dashboard role."), { status: 400, code: "INVALID_ROLE" });
  }
  if (normalizedRole === "owner" && !principal.isOwner) {
    throw Object.assign(new Error("Only an Owner can invite another Owner."), { status: 403, code: "OWNER_REQUIRED" });
  }
  const normalizedPermissions = normalizedRole === "owner"
    ? expandDashboardPermissions(DASHBOARD_ROLE_PRESETS.owner)
    : normalizeDashboardPermissions(permissions, normalizedRole);

  const client = await db.connect();
  try {
    await client.query("begin");
    const actorMemberId = await ensureDashboardActorMember(principal, client);
    const existing = await client.query(
      `select id, status from public.dashboard_members where email_normalized = $1 limit 1`,
      [normalizedEmail],
    );
    if (existing.rowCount && existing.rows[0].status === "active") {
      throw Object.assign(new Error("This user already has active Command Center access."), { status: 409, code: "MEMBER_ALREADY_ACTIVE" });
    }

    let memberId;
    if (existing.rowCount) {
      memberId = String(existing.rows[0].id);
      await client.query(
        `update public.dashboard_members
            set display_name = coalesce(display_name, $2), role = $3, status = 'invited',
                invited_by_member_id = $4::uuid, invited_at = now(), disabled_at = null,
                disabled_by_member_id = null, disable_reason = null, updated_at = now(),
                permissions_version = permissions_version + 1
          where id = $1::uuid`,
        [memberId, null, normalizedRole, actorMemberId],
      );
      await client.query(`delete from public.dashboard_member_permissions where member_id = $1::uuid`, [memberId]);
    } else {
      const inserted = await client.query(
        `insert into public.dashboard_members (
           email_normalized, role, status, invited_by_member_id, invited_at
         ) values ($1, $2, 'invited', $3::uuid, now()) returning id`,
        [normalizedEmail, normalizedRole, actorMemberId],
      );
      memberId = String(inserted.rows[0].id);
    }

    if (normalizedRole !== "owner") {
      for (const permission of normalizedPermissions) {
        await client.query(
          `insert into public.dashboard_member_permissions (member_id, permission, granted_by_member_id)
           values ($1::uuid, $2, $3::uuid)
           on conflict (member_id, permission) do nothing`,
          [memberId, permission, actorMemberId],
        );
      }
    }

    const priorPending = await client.query(
      `select id from public.dashboard_access_invitations where email_normalized = $1 and status = 'pending' limit 1`,
      [normalizedEmail],
    );
    if (priorPending.rowCount) {
      await client.query(
        `update public.dashboard_access_invitations
            set status = 'revoked', revoked_at = now(), version = version + 1
          where id = $1::uuid`,
        [priorPending.rows[0].id],
      );
    }

    const invitation = await client.query(
      `insert into public.dashboard_access_invitations (
         email_normalized, role, status, invited_by_member_id, permissions_snapshot, expires_at
       ) values ($1, $2, 'pending', $3::uuid, $4::jsonb, now() + interval '7 days')
       returning id, version, created_at, expires_at`,
      [normalizedEmail, normalizedRole, actorMemberId, JSON.stringify(normalizedPermissions)],
    );

    await writeDashboardAccessAudit({
      actorMemberId,
      actorEmail: principal.email,
      subjectMemberId: memberId,
      subjectEmail: normalizedEmail,
      action: "INVITATION_CREATED",
      afterState: { role: normalizedRole, permissions: normalizedPermissions, status: "invited" },
      reason,
      requestId,
      db: client,
    });

    await client.query("commit");
    return {
      memberId,
      invitationId: String(invitation.rows[0].id),
      email: normalizedEmail,
      role: normalizedRole,
      permissions: normalizedPermissions,
      version: Number(invitation.rows[0].version || 1),
      createdAt: invitation.rows[0].created_at,
      expiresAt: invitation.rows[0].expires_at,
    };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function getDashboardMember(memberId, db = pool) {
  const result = await db.query(
    `select id, auth_user_id, email_normalized, display_name, role, status, permissions_version,
            disabled_at, disable_reason, updated_at
       from public.dashboard_members where id = $1::uuid`,
    [memberId],
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  const permissionsResult = await db.query(
    `select permission from public.dashboard_member_permissions where member_id = $1::uuid order by permission`,
    [memberId],
  );
  return {
    id: String(row.id),
    authUserId: row.auth_user_id ? String(row.auth_user_id) : null,
    email: row.email_normalized,
    name: row.display_name || null,
    role: row.role,
    status: row.status,
    permissionsVersion: Number(row.permissions_version || 1),
    permissions: row.role === "owner"
      ? expandDashboardPermissions(DASHBOARD_ROLE_PRESETS.owner)
      : expandDashboardPermissions(permissionsResult.rows.map((item) => item.permission)),
    disabledAt: row.disabled_at || null,
    disableReason: row.disable_reason || null,
    updatedAt: row.updated_at,
  };
}

export async function countActiveOwners(db = pool) {
  const result = await db.query(`select count(*)::int as n from public.dashboard_members where role = 'owner' and status = 'active'`);
  return Number(result.rows[0]?.n || 0);
}

export async function updateDashboardMemberAccess({ principal, memberId, expectedVersion, role, permissions, displayName, reason, requestId, db = pool }) {
  const actorMemberId = await ensureDashboardActorMember(principal, db);
  const before = await getDashboardMember(memberId, db);
  if (!before) throw Object.assign(new Error("Dashboard member not found."), { status: 404, code: "MEMBER_NOT_FOUND" });
  const version = Number(expectedVersion);
  if (!Number.isInteger(version) || version < 1) {
    throw Object.assign(new Error("expectedVersion is required."), { status: 400, code: "EXPECTED_VERSION_REQUIRED" });
  }
  if (before.permissionsVersion !== version) {
    throw Object.assign(new Error("Dashboard member access changed since this page was loaded."), {
      status: 409,
      code: "STALE_MEMBER_VERSION",
      expectedVersion: version,
      currentVersion: before.permissionsVersion,
    });
  }

  const normalizedRole = role == null ? before.role : normalizeDashboardRole(role);
  if (!normalizedRole) throw Object.assign(new Error("Unknown dashboard role."), { status: 400, code: "INVALID_ROLE" });
  if ((before.role === "owner" || normalizedRole === "owner") && !principal.isOwner) {
    throw Object.assign(new Error("Only an Owner can change Owner status."), { status: 403, code: "OWNER_REQUIRED" });
  }
  if (before.authUserId === principal.authUserId && before.role === "owner" && normalizedRole !== "owner") {
    throw Object.assign(new Error("Owners cannot remove their own Owner status."), { status: 409, code: "OWNER_SELF_PROTECTION" });
  }
  if (before.role === "owner" && normalizedRole !== "owner" && await countActiveOwners(db) <= 1) {
    throw Object.assign(new Error("The last active Owner cannot be demoted."), { status: 409, code: "LAST_OWNER_PROTECTION" });
  }

  const normalizedPermissions = normalizedRole === "owner"
    ? expandDashboardPermissions(DASHBOARD_ROLE_PRESETS.owner)
    : normalizeDashboardPermissions(permissions, normalizedRole);

  const client = await db.connect();
  try {
    await client.query("begin");
    const update = await client.query(
      `update public.dashboard_members
          set display_name = $2, role = $3, updated_at = now(), permissions_version = permissions_version + 1
        where id = $1::uuid and permissions_version = $4
        returning permissions_version`,
      [memberId, displayName == null ? before.name : String(displayName).trim() || null, normalizedRole, version],
    );
    if (!update.rowCount) {
      throw Object.assign(new Error("Dashboard member access changed since this page was loaded."), { status: 409, code: "STALE_MEMBER_VERSION" });
    }
    await client.query(`delete from public.dashboard_member_permissions where member_id = $1::uuid`, [memberId]);
    if (normalizedRole !== "owner") {
      for (const permission of normalizedPermissions) {
        await client.query(
          `insert into public.dashboard_member_permissions (member_id, permission, granted_by_member_id)
           values ($1::uuid, $2, $3::uuid)`,
          [memberId, permission, actorMemberId],
        );
      }
    }
    await writeDashboardAccessAudit({
      actorMemberId,
      actorEmail: principal.email,
      subjectMemberId: memberId,
      subjectEmail: before.email,
      action: "MEMBER_ACCESS_UPDATED",
      beforeState: before,
      afterState: { role: normalizedRole, permissions: normalizedPermissions, displayName: displayName ?? before.name },
      reason,
      requestId,
      db: client,
    });
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return getDashboardMember(memberId, db);
}

export async function setDashboardMemberDisabled({ principal, memberId, expectedVersion, disabled, reason, requestId, db = pool }) {
  const actorMemberId = await ensureDashboardActorMember(principal, db);
  const before = await getDashboardMember(memberId, db);
  if (!before) throw Object.assign(new Error("Dashboard member not found."), { status: 404, code: "MEMBER_NOT_FOUND" });
  const version = Number(expectedVersion);
  if (before.permissionsVersion !== version) {
    throw Object.assign(new Error("Dashboard member access changed since this page was loaded."), { status: 409, code: "STALE_MEMBER_VERSION", currentVersion: before.permissionsVersion });
  }
  if (disabled && before.authUserId === principal.authUserId) {
    throw Object.assign(new Error("You cannot disable your own Command Center account."), { status: 409, code: "SELF_DISABLE_PROTECTION" });
  }
  if (disabled && before.role === "owner" && await countActiveOwners(db) <= 1) {
    throw Object.assign(new Error("The last active Owner cannot be disabled."), { status: 409, code: "LAST_OWNER_PROTECTION" });
  }

  const targetStatus = disabled ? "disabled" : "active";
  const update = await db.query(
    `update public.dashboard_members
        set status = $2,
            disabled_at = case when $2 = 'disabled' then now() else null end,
            disabled_by_member_id = case when $2 = 'disabled' then $3::uuid else null end,
            disable_reason = case when $2 = 'disabled' then $4 else null end,
            updated_at = now(), permissions_version = permissions_version + 1
      where id = $1::uuid and permissions_version = $5
      returning permissions_version`,
    [memberId, targetStatus, actorMemberId, reason || null, version],
  );
  if (!update.rowCount) {
    throw Object.assign(new Error("Dashboard member access changed since this page was loaded."), { status: 409, code: "STALE_MEMBER_VERSION" });
  }
  await writeDashboardAccessAudit({
    actorMemberId,
    actorEmail: principal.email,
    subjectMemberId: memberId,
    subjectEmail: before.email,
    action: disabled ? "MEMBER_DISABLED" : "MEMBER_RESTORED",
    beforeState: before,
    afterState: { status: targetStatus },
    reason,
    requestId,
    db,
  });
  return getDashboardMember(memberId, db);
}

export async function revokeDashboardInvitation({ principal, invitationId, expectedVersion, reason, requestId, db = pool }) {
  const actorMemberId = await ensureDashboardActorMember(principal, db);
  const found = await db.query(
    `select id, email_normalized, status, version from public.dashboard_access_invitations where id = $1::uuid`,
    [invitationId],
  );
  if (!found.rowCount) throw Object.assign(new Error("Invitation not found."), { status: 404, code: "INVITATION_NOT_FOUND" });
  const row = found.rows[0];
  if (row.status !== "pending") throw Object.assign(new Error("Only pending invitations can be revoked."), { status: 409, code: "INVITATION_NOT_PENDING" });
  if (Number(row.version) !== Number(expectedVersion)) {
    throw Object.assign(new Error("Invitation changed since this page was loaded."), { status: 409, code: "STALE_INVITATION_VERSION", currentVersion: Number(row.version) });
  }
  const updated = await db.query(
    `update public.dashboard_access_invitations
        set status = 'revoked', revoked_at = now(), version = version + 1
      where id = $1::uuid and version = $2 and status = 'pending'
      returning version`,
    [invitationId, Number(expectedVersion)],
  );
  if (!updated.rowCount) throw Object.assign(new Error("Invitation changed since this page was loaded."), { status: 409, code: "STALE_INVITATION_VERSION" });
  await db.query(
    `update public.dashboard_members
        set status = 'disabled', disabled_at = now(), disabled_by_member_id = $2::uuid,
            disable_reason = 'Invitation revoked', updated_at = now(), permissions_version = permissions_version + 1
      where email_normalized = $1 and status = 'invited'`,
    [row.email_normalized, actorMemberId],
  );
  await writeDashboardAccessAudit({
    actorMemberId,
    actorEmail: principal.email,
    subjectEmail: row.email_normalized,
    action: "INVITATION_REVOKED",
    beforeState: { status: "pending", version: Number(row.version) },
    afterState: { status: "revoked", version: Number(updated.rows[0].version) },
    reason,
    requestId,
    db,
  });
  return { ok: true, version: Number(updated.rows[0].version) };
}

export function assertMemberStatus(value) {
  return MEMBER_STATUSES.has(String(value || "").trim().toLowerCase());
}
