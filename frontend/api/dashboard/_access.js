import { pool } from "../../server/db.js";
import { getDashboardAuthIdentity } from "./_auth.js";

export const DASHBOARD_PERMISSIONS = Object.freeze([
  "dashboard.view",
  "analytics.view",
  "launchpad.view",
  "finance.view",
  "finance.manage",
  "operations.view",
  "operations.manage",
  "community.view",
  "community.manage",
  "security.view",
  "security.manage",
  "controls.view",
  "controls.manage",
  "access.manage",
  "abuse.view",
  "abuse.reply",
  "abuse.manage",
  "abuse.admin",
  "tournaments.manage",
  "project_ownership.manage",
  "arena_imports.manage",
  "lp_harvest.manage",
  "recruiter_payouts.manage",
  "diagnostics.view",
  "deployment.view",
  "deployment.manage",
]);

const ALL_PERMISSIONS = new Set(DASHBOARD_PERMISSIONS);
const LEGACY_ADMIN_EXCLUSIONS = new Set([
  "access.manage",
  "abuse.view",
  "abuse.reply",
  "abuse.manage",
  "abuse.admin",
]);

export const DASHBOARD_ROLE_PRESETS = Object.freeze({
  metrics_reader: ["dashboard.view", "analytics.view", "launchpad.view"],
  finance_reader: ["dashboard.view", "finance.view"],
  finance_manager: ["dashboard.view", "finance.view", "finance.manage"],
  operations_admin: [
    "dashboard.view",
    "analytics.view",
    "launchpad.view",
    "operations.view",
    "operations.manage",
    "community.view",
    "community.manage",
    "security.view",
    "security.manage",
    "controls.view",
    "controls.manage",
    "diagnostics.view",
  ],
  admin: DASHBOARD_PERMISSIONS.filter((permission) => !LEGACY_ADMIN_EXCLUSIONS.has(permission)),
  owner: DASHBOARD_PERMISSIONS,
  custom: [],
});

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

export function expandDashboardPermissions(permissions = []) {
  const result = new Set(
    permissions
      .map((permission) => String(permission || "").trim())
      .filter((permission) => ALL_PERMISSIONS.has(permission)),
  );

  if (result.has("finance.manage")) result.add("finance.view");
  if (result.has("operations.manage")) result.add("operations.view");
  if (result.has("community.manage")) result.add("community.view");
  if (result.has("security.manage")) result.add("security.view");
  if (result.has("controls.manage")) result.add("controls.view");
  if (result.has("abuse.admin")) {
    result.add("abuse.manage");
    result.add("abuse.reply");
    result.add("abuse.view");
  } else if (result.has("abuse.manage")) {
    result.add("abuse.reply");
    result.add("abuse.view");
  } else if (result.has("abuse.reply")) {
    result.add("abuse.view");
  }

  return Array.from(result).sort();
}

function syntheticPrincipal(identity, role, permissions, compatibilitySource) {
  return {
    authUserId: identity.id,
    memberId: null,
    email: identity.email,
    displayName: null,
    role,
    status: "active",
    permissions: expandDashboardPermissions(permissions),
    permissionsVersion: 0,
    isOwner: role === "owner",
    isBreakGlass: role === "owner",
    compatibilitySource,
  };
}

async function loadMembership(identity, db = pool) {
  const email = normalizeEmail(identity.email);
  const result = await db.query(
    `select id,
            auth_user_id,
            email_normalized,
            display_name,
            role,
            status,
            permissions_version
       from public.dashboard_members
      where (auth_user_id = $1::uuid or (auth_user_id is null and email_normalized = $2))
      order by case when auth_user_id = $1::uuid then 0 else 1 end
      limit 1`,
    [identity.id, email],
  );
  return result.rows?.[0] || null;
}

async function activateInvitedMembership(identity, member, db = pool) {
  const client = await db.connect();
  try {
    await client.query("begin");
    const invitation = await client.query(
      `select id, status, version, expires_at
         from public.dashboard_access_invitations
        where email_normalized = $1
          and status = 'pending'
          and (expires_at is null or expires_at > now())
        order by created_at desc
        limit 1
        for update`,
      [normalizeEmail(identity.email)],
    );
    if (!invitation.rowCount) {
      await client.query("rollback");
      return null;
    }

    const activated = await client.query(
      `update public.dashboard_members
          set auth_user_id = $2::uuid,
              status = 'active',
              activated_at = coalesce(activated_at, now()),
              last_seen_at = now(),
              updated_at = now(),
              permissions_version = permissions_version + 1
        where id = $1::uuid
          and status = 'invited'
          and (auth_user_id is null or auth_user_id = $2::uuid)
        returning id, auth_user_id, email_normalized, display_name, role, status, permissions_version`,
      [member.id, identity.id],
    );
    if (!activated.rowCount) {
      await client.query("rollback");
      return null;
    }

    const inviteRow = invitation.rows[0];
    await client.query(
      `update public.dashboard_access_invitations
          set status = 'accepted', accepted_at = now(), supabase_user_id = $2::uuid, version = version + 1
        where id = $1::uuid and status = 'pending'`,
      [inviteRow.id, identity.id],
    );
    await client.query(
      `insert into public.dashboard_access_audit (
         actor_member_id, actor_email, subject_member_id, subject_email, action, before_state, after_state
       ) values ($1::uuid, $2, $1::uuid, $2, 'INVITATION_ACCEPTED', $3::jsonb, $4::jsonb)`,
      [
        member.id,
        normalizeEmail(identity.email),
        JSON.stringify({ status: "invited", invitationId: String(inviteRow.id) }),
        JSON.stringify({ status: "active", authUserId: identity.id }),
      ],
    );
    await client.query("commit");
    return activated.rows[0];
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function loadMemberPermissions(memberId, role, db = pool) {
  if (role === "owner") return expandDashboardPermissions(DASHBOARD_ROLE_PRESETS.owner);

  const result = await db.query(
    `select permission
       from public.dashboard_member_permissions
      where member_id = $1::uuid
      order by permission asc`,
    [memberId],
  );

  return expandDashboardPermissions((result.rows || []).map((row) => row.permission));
}

export async function getDashboardPrincipal(req, res, { db = pool } = {}) {
  const identity = await getDashboardAuthIdentity(req, res);
  if (!identity) return null;

  // Founder/master-admin break glass remains a wildcard even before IAM rows exist.
  if (identity.isMasterAdmin) {
    return syntheticPrincipal(identity, "owner", DASHBOARD_ROLE_PRESETS.owner, "master_admin");
  }

  let member = null;
  try {
    member = await loadMembership(identity, db);
  } catch (error) {
    // During additive rollout, current approved dashboard admins must not be locked out
    // merely because the IAM migration has not yet been applied in an environment.
    if (identity.isApprovedAdmin && error?.code === "42P01") {
      return syntheticPrincipal(identity, "admin", DASHBOARD_ROLE_PRESETS.admin, "legacy_admin_schema_fallback");
    }
    throw error;
  }

  if (!member) {
    // Transitional compatibility for existing non-owner dashboard admins.
    // Abuse remains governed by the existing employee_permissions subsystem.
    if (identity.isApprovedAdmin) {
      return syntheticPrincipal(identity, "admin", DASHBOARD_ROLE_PRESETS.admin, "legacy_admin");
    }
    res.status(403).json({
      ok: false,
      code: "DASHBOARD_MEMBERSHIP_REQUIRED",
      error: "You do not have Command Center access.",
    });
    return null;
  }

  if (member.status === "invited") {
    member = await activateInvitedMembership(identity, member, db);
    if (!member) {
      res.status(403).json({
        ok: false,
        code: "DASHBOARD_INVITATION_INVALID",
        error: "This Command Center invitation is no longer valid.",
      });
      return null;
    }
  }

  if (member.status !== "active") {
    res.status(403).json({
      ok: false,
      code: member.status === "disabled" ? "DASHBOARD_MEMBERSHIP_DISABLED" : "DASHBOARD_MEMBERSHIP_INACTIVE",
      error: member.status === "disabled"
        ? "Your Command Center access has been disabled."
        : "Your Command Center membership is not active.",
    });
    return null;
  }

  if (member.auth_user_id && String(member.auth_user_id) !== identity.id) {
    res.status(403).json({
      ok: false,
      code: "DASHBOARD_IDENTITY_MISMATCH",
      error: "This Command Center membership belongs to a different authenticated identity.",
    });
    return null;
  }

  await db.query(
    `update public.dashboard_members set last_seen_at = now() where id = $1::uuid`,
    [member.id],
  ).catch(() => {});

  const permissions = await loadMemberPermissions(member.id, member.role, db);
  return {
    authUserId: identity.id,
    memberId: String(member.id),
    email: normalizeEmail(member.email_normalized || identity.email),
    displayName: member.display_name || null,
    role: member.role,
    status: member.status,
    permissions,
    permissionsVersion: Number(member.permissions_version || 1),
    isOwner: member.role === "owner",
    isBreakGlass: false,
    compatibilitySource: null,
  };
}

export function dashboardPrincipalCan(principal, permission) {
  if (!principal || !ALL_PERMISSIONS.has(permission)) return false;
  if (principal.isOwner) return true;
  return principal.permissions.includes(permission);
}

export async function requireDashboardUser(req, res, options) {
  return getDashboardPrincipal(req, res, options);
}

export async function requireDashboardPermission(req, res, permission, options) {
  if (!ALL_PERMISSIONS.has(permission)) {
    throw new Error(`Unknown dashboard permission: ${permission}`);
  }
  const principal = await getDashboardPrincipal(req, res, options);
  if (!principal) return null;
  if (!dashboardPrincipalCan(principal, permission)) {
    res.status(403).json({
      ok: false,
      code: "DASHBOARD_PERMISSION_REQUIRED",
      error: "You do not have permission to access this Command Center section.",
      permission,
    });
    return null;
  }
  return principal;
}

export async function requireDashboardOwner(req, res, options) {
  const principal = await getDashboardPrincipal(req, res, options);
  if (!principal) return null;
  if (!principal.isOwner) {
    res.status(403).json({
      ok: false,
      code: "DASHBOARD_OWNER_REQUIRED",
      error: "Command Center Owner access required.",
    });
    return null;
  }
  return principal;
}
