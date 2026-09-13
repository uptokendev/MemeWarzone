import { pool } from "../../server/db.js";
import {
  countActiveOwners,
  ensureDashboardActorMember,
  getDashboardMember,
  writeDashboardAccessAudit,
} from "./_accessAdmin.js";

export async function deleteDashboardMember({
  principal,
  memberId,
  expectedVersion,
  reason,
  requestId,
  db = pool,
}) {
  const actorMemberId = await ensureDashboardActorMember(principal, db);
  const before = await getDashboardMember(memberId, db);
  if (!before) {
    throw Object.assign(new Error("Dashboard member not found."), { status: 404, code: "MEMBER_NOT_FOUND" });
  }

  const version = Number(expectedVersion);
  if (!Number.isInteger(version) || version < 1) {
    throw Object.assign(new Error("expectedVersion is required."), { status: 400, code: "EXPECTED_VERSION_REQUIRED" });
  }
  if (before.permissionsVersion !== version) {
    throw Object.assign(new Error("Dashboard member access changed since this page was loaded."), {
      status: 409,
      code: "STALE_MEMBER_VERSION",
      currentVersion: before.permissionsVersion,
    });
  }
  if (before.authUserId && before.authUserId === principal.authUserId) {
    throw Object.assign(new Error("You cannot delete your own Command Center account."), {
      status: 409,
      code: "SELF_DELETE_PROTECTION",
    });
  }
  if (before.role === "owner") {
    if (!principal.isOwner) {
      throw Object.assign(new Error("Only an Owner can delete another Owner."), { status: 403, code: "OWNER_REQUIRED" });
    }
    if (await countActiveOwners(db) <= 1) {
      throw Object.assign(new Error("The last active Owner cannot be deleted."), {
        status: 409,
        code: "LAST_OWNER_PROTECTION",
      });
    }
  }

  const client = await db.connect();
  try {
    await client.query("begin");
    const update = await client.query(
      `update public.dashboard_members
          set status = 'deleted',
              auth_user_id = null,
              disabled_at = now(),
              disabled_by_member_id = $2::uuid,
              disable_reason = $3,
              updated_at = now(),
              permissions_version = permissions_version + 1
        where id = $1::uuid and permissions_version = $4
        returning permissions_version`,
      [memberId, actorMemberId, reason || "Removed from Command Center", version],
    );
    if (!update.rowCount) {
      throw Object.assign(new Error("Dashboard member access changed since this page was loaded."), {
        status: 409,
        code: "STALE_MEMBER_VERSION",
      });
    }

    await client.query(`delete from public.dashboard_member_permissions where member_id = $1::uuid`, [memberId]);
    await client.query(
      `update public.dashboard_access_invitations
          set status = 'revoked', revoked_at = now(), version = version + 1
        where email_normalized = $1 and status = 'pending'`,
      [before.email],
    );

    await writeDashboardAccessAudit({
      actorMemberId,
      actorEmail: principal.email,
      subjectMemberId: memberId,
      subjectEmail: before.email,
      action: "MEMBER_DELETED",
      beforeState: before,
      afterState: { status: "deleted", authUserId: null, permissions: [] },
      reason: reason || "Removed from Command Center",
      requestId,
      db: client,
    });

    await client.query("commit");
    return { ok: true, memberId, status: "deleted" };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
