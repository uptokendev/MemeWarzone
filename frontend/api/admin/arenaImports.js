import { pool } from "../../server/db.js";
import { getQuery, json, readJson } from "../../server/http.js";
import { requireAdminOrOps } from "../lib/apiAuth.js";

const STATUSES = new Set(["scanning", "passed", "needs_review", "declined"]);

function mapImport(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    chainId: Number(row.chain_id),
    tokenAddress: String(row.token_address),
    ownerWallet: String(row.owner_wallet),
    name: row.name || null,
    symbol: row.symbol || null,
    status: String(row.status),
    scan: row.scan_json && typeof row.scan_json === "object" ? row.scan_json : {},
    reviewRequestedAt: row.review_requested_at || null,
    reviewReason: row.review_reason || null,
    reviewer: row.reviewer || null,
    reviewedAt: row.reviewed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export default async function handler(req, res) {
  const method = String(req.method || "GET").toUpperCase();
  const path = String(req.path || new URL(req.url, "http://localhost").pathname);
  const admin = await requireAdminOrOps(req, res, { routeLabel: "admin/arena/imports", allowOps: true });
  if (!admin) return;

  try {
    if (method === "GET" && (path === "/admin/arena/imports" || path === "/api/admin/arena/imports")) {
      const query = getQuery(req);
      const status = String(query.status || "").trim();
      const values = [];
      let where = "";
      if (STATUSES.has(status) || status === "review_requested") {
        if (status === "review_requested") {
          where = "where review_requested_at is not null and status in ('declined', 'needs_review')";
        } else {
          values.push(status);
          where = "where status = $1";
        }
      }
      const result = await pool.query(
        `select * from public.arena_token_imports ${where} order by coalesce(review_requested_at, updated_at) desc limit 200`,
        values,
      );
      return json(res, 200, { items: result.rows.map(mapImport), updatedAt: new Date().toISOString() });
    }

    const decide = path.match(/\/admin\/arena\/imports\/([^/]+)\/decide$/);
    if (decide && method === "POST") {
      const body = await readJson(req);
      const id = decodeURIComponent(decide[1]);
      const status = String(body.status || "").trim();
      if (status !== "passed" && status !== "declined") return json(res, 400, { error: "status must be passed or declined" });
      const reason = String(body.reason || "").trim().slice(0, 500);
      if (!reason) return json(res, 400, { error: "reason is required" });
      const updated = await pool.query(
        `update public.arena_token_imports
            set status = $2, review_reason = $3, reviewer = $4, reviewed_at = now(), updated_at = now()
          where id = $1::uuid
          returning *`,
        [id, status, reason, String(admin.admin?.email || admin.mode || "ops")],
      );
      if (!updated.rows[0]) return json(res, 404, { error: "Import not found" });
      return json(res, 200, { ok: true, item: mapImport(updated.rows[0]) });
    }

    return json(res, 404, { error: "Unknown admin arena imports route" });
  } catch (error) {
    console.error("[admin/arenaImports]", error);
    return json(res, 503, { error: "Import admin storage is unavailable", detail: String(error?.message || error) });
  }
}
