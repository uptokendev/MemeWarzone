import { pool } from "../../server/db.js";
import { requireDashboardPermission } from "./_access.js";

const VALID_RECRUITER_STATUSES = new Set(["active", "inactive", "closed", "suspended"]);
const VALID_MEMBER_ROLES = new Set(["creator", "trader", "member"]);
const VALID_LINK_STATUSES = new Set(["active", "inactive"]);

function positiveId(value) {
  const normalized = String(value ?? "").trim();
  return /^[1-9][0-9]*$/.test(normalized) ? normalized : null;
}

function normalizeWallet(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeCode(value) {
  return String(value ?? "").trim().toLowerCase();
}

function requiredReason(value) {
  const reason = String(value ?? "").trim();
  if (!reason) throw new Error("Reason is required.");
  if (reason.length > 500) throw new Error("Reason must be 500 characters or fewer.");
  return reason;
}

function adminLabel(admin) {
  return String(admin?.email || admin?.id || "dashboard_admin");
}

function databaseErrorResponse(error) {
  if (error?.code === "23505") return { status: 409, error: "The requested change conflicts with an existing unique record." };
  if (error?.code === "23503") return { status: 400, error: "The requested recruiter relationship is invalid." };
  if (error?.code === "23514") return { status: 400, error: "The requested value violates a recruiter data rule." };
  return null;
}

async function requireCommunity(req, res, manage = false) {
  const principal = await requireDashboardPermission(req, res, manage ? "community.manage" : "community.view");
  if (!principal) return null;
  return { id: principal.authUserId, email: principal.email, principal };
}

async function writeAudit(client, {
  recruiter,
  targetWallet = null,
  actionType,
  action,
  before,
  after,
  reason,
  admin,
  details = {},
}) {
  const actor = adminLabel(admin);
  await client.query(
    `insert into public.recruiter_admin_actions
      (recruiter_id, wallet_address, action_type, acted_by, reason, details_json,
       target_wallet, action, before, after, admin_id)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10::jsonb, $11)`,
    [
      recruiter?.id ?? null,
      recruiter?.wallet_address ?? null,
      actionType,
      actor,
      reason,
      JSON.stringify(details),
      targetWallet,
      action,
      JSON.stringify(before ?? null),
      JSON.stringify(after ?? null),
      actor,
    ],
  );
}

async function selectRecruiter(client, id, { forUpdate = false } = {}) {
  const result = await client.query(
    `select id, wallet_address, code, display_name, is_og, status, closed_at,
            metadata, created_at, updated_at, squad_image_url
     from public.recruiters
     where id = $1${forUpdate ? " for update" : ""}`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function selectMembership(client, wallet, recruiterId, { forUpdate = false } = {}) {
  const result = await client.query(
    `select id, wallet_address, recruiter_id, joined_at, left_at, leave_reason,
            is_active, created_at, updated_at, member_role, link_source,
            legacy_ref_wallet_key
     from public.wallet_squad_memberships
     where wallet_address = $1 and recruiter_id = $2
     order by updated_at desc
     limit 1${forUpdate ? " for update" : ""}`,
    [wallet, recruiterId],
  );
  return result.rows[0] ?? null;
}

async function selectRecruiterLink(client, wallet, recruiterId, { forUpdate = false } = {}) {
  const result = await client.query(
    `select id, wallet_address, recruiter_id, link_source, linked_at, locked_at,
            detached_at, detach_reason, is_active, created_at, updated_at
     from public.wallet_recruiter_links
     where wallet_address = $1 and recruiter_id = $2
     order by updated_at desc
     limit 1${forUpdate ? " for update" : ""}`,
    [wallet, recruiterId],
  );
  return result.rows[0] ?? null;
}

export async function dashboardRecruiters(req, res) {
  const method = String(req.method || "GET").toUpperCase();
  const admin = await requireCommunity(req, res, method !== "GET" && method !== "HEAD");
  if (!admin) return;

  if (method === "GET") {
    const [recruiters, memberships, links] = await Promise.all([
      pool.query(`
        select id, wallet_address, code, display_name, is_og, status, closed_at,
               metadata, created_at, updated_at, squad_image_url
        from public.recruiters
        order by created_at desc
      `),
      pool.query(`
        select id, wallet_address, recruiter_id, joined_at, left_at, leave_reason,
               is_active, created_at, updated_at, member_role, link_source,
               legacy_ref_wallet_key
        from public.wallet_squad_memberships
      `),
      pool.query(`
        select id, wallet_address, recruiter_id, link_source, linked_at, locked_at,
               detached_at, detach_reason, is_active, created_at, updated_at
        from public.wallet_recruiter_links
      `),
    ]);

    return res.status(200).json({
      ok: true,
      recruiters: recruiters.rows,
      memberships: memberships.rows,
      links: links.rows,
      warnings: [],
    });
  }

  const id = positiveId(req.params?.id);
  if (!id) return res.status(400).json({ ok: false, error: "Invalid recruiter id." });
  if (method !== "PATCH") return res.status(405).json({ ok: false, error: "Method not allowed." });

  let reason;
  try {
    reason = requiredReason(req.body?.reason);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }

  const patch = {};
  if (Object.prototype.hasOwnProperty.call(req.body || {}, "displayName")) {
    const displayName = req.body.displayName == null ? null : String(req.body.displayName).trim();
    if (displayName && displayName.length > 120) {
      return res.status(400).json({ ok: false, error: "Display name must be 120 characters or fewer." });
    }
    patch.display_name = displayName || null;
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, "status")) {
    const status = String(req.body.status || "").trim().toLowerCase();
    if (!VALID_RECRUITER_STATUSES.has(status)) {
      return res.status(400).json({ ok: false, error: "Invalid recruiter status." });
    }
    patch.status = status;
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, "code")) {
    const code = normalizeCode(req.body.code);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(code)) {
      return res.status(400).json({ ok: false, error: "Recruiter code must use 1-64 lowercase letters, numbers, underscores, or hyphens." });
    }
    patch.code = code;
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ ok: false, error: "No supported recruiter fields supplied." });
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await selectRecruiter(client, id, { forUpdate: true });
    if (!before) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "Recruiter not found." });
    }

    const fields = [];
    const values = [];
    for (const [column, value] of Object.entries(patch)) {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    }
    values.push(new Date().toISOString());
    fields.push(`updated_at = $${values.length}`);
    values.push(id);

    const updated = await client.query(
      `update public.recruiters
       set ${fields.join(", ")}
       where id = $${values.length}
       returning id, wallet_address, code, display_name, is_og, status, closed_at,
                 metadata, created_at, updated_at, squad_image_url`,
      values,
    );
    const after = updated.rows[0];
    const actionType = Object.prototype.hasOwnProperty.call(patch, "status") ? "status_change" : "recruiter_upsert";

    await writeAudit(client, {
      recruiter: after,
      actionType,
      action: "update_recruiter",
      before,
      after,
      reason,
      admin,
      details: { fields: Object.keys(patch), route: "dashboard_recruiter_update" },
    });

    await client.query("commit");
    return res.status(200).json({ ok: true, recruiter: after });
  } catch (error) {
    await client.query("rollback");
    const known = databaseErrorResponse(error);
    if (known) return res.status(known.status).json({ ok: false, error: known.error });
    console.error("[dashboard recruiters] recruiter update failed", error);
    return res.status(500).json({ ok: false, error: "Recruiter update failed." });
  } finally {
    client.release();
  }
}

export async function dashboardRecruiterMember(req, res) {
  const admin = await requireCommunity(req, res, true);
  if (!admin) return;
  if (String(req.method || "").toUpperCase() !== "PATCH") return res.status(405).json({ ok: false, error: "Method not allowed." });

  const recruiterId = positiveId(req.params?.id);
  if (!recruiterId) return res.status(400).json({ ok: false, error: "Invalid recruiter id." });

  const wallet = normalizeWallet(req.body?.wallet);
  if (!wallet || wallet.length > 128) return res.status(400).json({ ok: false, error: "A valid member wallet is required." });

  let reason;
  try {
    reason = requiredReason(req.body?.reason);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }

  let memberRole;
  if (Object.prototype.hasOwnProperty.call(req.body || {}, "memberRole")) {
    memberRole = String(req.body.memberRole || "").trim().toLowerCase();
    if (!VALID_MEMBER_ROLES.has(memberRole)) {
      return res.status(400).json({ ok: false, error: "Invalid squad member role." });
    }
  }

  let linkStatus;
  if (Object.prototype.hasOwnProperty.call(req.body || {}, "linkStatus")) {
    linkStatus = String(req.body.linkStatus || "").trim().toLowerCase();
    if (!VALID_LINK_STATUSES.has(linkStatus)) {
      return res.status(400).json({ ok: false, error: "Invalid squad link status." });
    }
  }

  if (memberRole === undefined && linkStatus === undefined) {
    return res.status(400).json({ ok: false, error: "No supported squad member fields supplied." });
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const recruiter = await selectRecruiter(client, recruiterId, { forUpdate: true });
    if (!recruiter) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "Recruiter not found." });
    }

    let membership = await selectMembership(client, wallet, recruiterId, { forUpdate: true });
    let link = await selectRecruiterLink(client, wallet, recruiterId, { forUpdate: true });
    if (!membership && !link) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "Squad member relationship not found." });
    }

    const before = { membership, link };
    const now = new Date().toISOString();

    if (memberRole !== undefined) {
      if (membership) {
        const result = await client.query(
          `update public.wallet_squad_memberships
           set member_role = $1, updated_at = $2
           where id = $3
           returning *`,
          [memberRole, now, membership.id],
        );
        membership = result.rows[0];
      } else {
        const shouldBeActive = link?.is_active === true;
        if (shouldBeActive) {
          await client.query(
            `update public.wallet_squad_memberships
             set is_active = false, left_at = coalesce(left_at, $1),
                 leave_reason = coalesce(leave_reason, $2), updated_at = $1
             where wallet_address = $3 and is_active = true`,
            [now, reason, wallet],
          );
        }
        const result = await client.query(
          `insert into public.wallet_squad_memberships
            (wallet_address, recruiter_id, member_role, link_source, is_active,
             joined_at, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $6, $6)
           returning *`,
          [wallet, recruiterId, memberRole, link?.link_source || "admin_override", shouldBeActive, now],
        );
        membership = result.rows[0];
      }
    }

    if (linkStatus !== undefined) {
      const wantsActive = linkStatus === "active";
      if (wantsActive) {
        await client.query(
          `update public.wallet_squad_memberships
           set is_active = false, left_at = coalesce(left_at, $1),
               leave_reason = coalesce(leave_reason, $2), updated_at = $1
           where wallet_address = $3 and is_active = true`,
          [now, reason, wallet],
        );
        await client.query(
          `update public.wallet_recruiter_links
           set is_active = false, detached_at = coalesce(detached_at, $1),
               detach_reason = coalesce(detach_reason, $2), updated_at = $1
           where wallet_address = $3 and is_active = true`,
          [now, reason, wallet],
        );

        if (membership) {
          const result = await client.query(
            `update public.wallet_squad_memberships
             set is_active = true, left_at = null, leave_reason = null, updated_at = $1
             where id = $2
             returning *`,
            [now, membership.id],
          );
          membership = result.rows[0];
        } else {
          const result = await client.query(
            `insert into public.wallet_squad_memberships
              (wallet_address, recruiter_id, member_role, link_source, is_active,
               joined_at, created_at, updated_at)
             values ($1, $2, 'member', 'admin_override', true, $3, $3, $3)
             returning *`,
            [wallet, recruiterId, now],
          );
          membership = result.rows[0];
        }

        if (link) {
          const result = await client.query(
            `update public.wallet_recruiter_links
             set is_active = true, detached_at = null, detach_reason = null, updated_at = $1
             where id = $2
             returning *`,
            [now, link.id],
          );
          link = result.rows[0];
        } else {
          const result = await client.query(
            `insert into public.wallet_recruiter_links
              (wallet_address, recruiter_id, link_source, linked_at, is_active,
               created_at, updated_at)
             values ($1, $2, 'admin_override', $3, true, $3, $3)
             returning *`,
            [wallet, recruiterId, now],
          );
          link = result.rows[0];
        }
      } else {
        if (membership) {
          const result = await client.query(
            `update public.wallet_squad_memberships
             set is_active = false, left_at = $1, leave_reason = $2, updated_at = $1
             where id = $3
             returning *`,
            [now, reason, membership.id],
          );
          membership = result.rows[0];
        }
        if (link) {
          const result = await client.query(
            `update public.wallet_recruiter_links
             set is_active = false, detached_at = $1, detach_reason = $2, updated_at = $1
             where id = $3
             returning *`,
            [now, reason, link.id],
          );
          link = result.rows[0];
        }
      }
    }

    const after = { membership, link };
    const action = linkStatus === "inactive"
      ? "detach_member"
      : linkStatus === "active"
        ? "reactivate_member"
        : "update_member_role";

    await writeAudit(client, {
      recruiter,
      targetWallet: wallet,
      actionType: linkStatus === undefined ? "dispute_override" : "status_change",
      action,
      before,
      after,
      reason,
      admin,
      details: { memberRole: memberRole ?? null, linkStatus: linkStatus ?? null, route: "dashboard_recruiter_member_update" },
    });

    await client.query("commit");
    return res.status(200).json({ ok: true, recruiterId, wallet, membership, link });
  } catch (error) {
    await client.query("rollback");
    const known = databaseErrorResponse(error);
    if (known) return res.status(known.status).json({ ok: false, error: known.error });
    console.error("[dashboard recruiters] member update failed", error);
    return res.status(500).json({ ok: false, error: "Squad member update failed." });
  } finally {
    client.release();
  }
}
