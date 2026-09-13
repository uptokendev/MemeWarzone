import { pool } from "../../server/db.js";
import { requireDashboardPermission } from "./_access.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_ROLES = new Set(["founder", "team", "ambassador", "kol", "contributor"]);
const FETCH_TIMEOUT_MS = 10_000;

function normalizeHandle(value) {
  return String(value || "").trim().toLowerCase().replace(/^@/, "");
}

function parseMetadata(body) {
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(body || {}, "role")) {
    const role = body.role == null || body.role === "" ? null : String(body.role).trim().toLowerCase();
    if (role !== null && !VALID_ROLES.has(role)) throw new Error("Invalid promoter role.");
    patch.role = role;
  }
  if (Object.prototype.hasOwnProperty.call(body || {}, "is_paid")) {
    if (body.is_paid !== null && typeof body.is_paid !== "boolean") throw new Error("is_paid must be boolean or null.");
    patch.is_paid = body.is_paid;
  }
  return patch;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function deriveIsClean(shadowbanData) {
  if (!shadowbanData || typeof shadowbanData !== "object") return null;
  const profile = shadowbanData.profile ?? {};
  const tests = shadowbanData.tests ?? {};
  if (profile.exists === false || profile.suspended === true || profile.protected === true) return false;

  const searchBanned = tests.search != null && tests.search !== "_implied_good";
  const typeaheadBanned = tests.typeahead === false;
  const ghostBanned = tests.ghost?.ban === true;
  const moreRepliesBanned = tests.more_replies?.ban === true;
  if (typeof tests.typeahead !== "boolean" && tests.search == null && tests.ghost == null) return null;
  return !(searchBanned || typeaheadBanned || ghostBanned || moreRepliesBanned);
}

async function fetchPromotorData(handle) {
  const encoded = encodeURIComponent(normalizeHandle(handle));
  const [shadowbanResult, metricsResult] = await Promise.allSettled([
    fetchJson(`https://shadowban-api.yuzurisa.com:444/${encoded}`),
    fetchJson(`https://tools.tweethunter.io/api/metrics-data?handle=${encoded}`),
  ]);

  return {
    shadowbanData: shadowbanResult.status === "fulfilled" ? shadowbanResult.value : null,
    metricsData: metricsResult.status === "fulfilled" ? metricsResult.value : null,
    errors: {
      shadowban: shadowbanResult.status === "rejected" ? String(shadowbanResult.reason?.message || shadowbanResult.reason) : null,
      metrics: metricsResult.status === "rejected" ? String(metricsResult.reason?.message || metricsResult.reason) : null,
    },
  };
}

async function refreshPromotorById(id) {
  const selected = await pool.query(
    "select id, x_handle, shadowban_data, metrics_data, is_clean from public.promotors where id = $1",
    [id],
  );
  if (selected.rowCount === 0) return { status: 404, payload: { ok: false, error: "Promoter not found." } };

  const current = selected.rows[0];
  const fetched = await fetchPromotorData(current.x_handle);
  const shadowbanData = fetched.shadowbanData ?? current.shadowban_data;
  const metricsData = fetched.metricsData ?? current.metrics_data;
  const isClean = fetched.shadowbanData ? deriveIsClean(fetched.shadowbanData) : current.is_clean;
  const checkedAt = new Date().toISOString();

  const client = await pool.connect();
  try {
    await client.query("begin");
    const updated = await client.query(
      `update public.promotors
       set shadowban_data = $1, metrics_data = $2, is_clean = $3, last_checked_at = $4
       where id = $5
       returning id, x_handle, added_by_email, added_at, last_checked_at,
                 shadowban_data, metrics_data, is_clean, role, is_paid`,
      [shadowbanData, metricsData, isClean, checkedAt, id],
    );
    await client.query(
      `insert into public.promotor_snapshots
       (promotor_id, checked_at, shadowban_data, metrics_data, is_clean)
       values ($1, $2, $3, $4, $5)`,
      [id, checkedAt, shadowbanData, metricsData, isClean],
    );
    await client.query("commit");
    return { status: 200, payload: { ok: true, promotor: updated.rows[0], errors: fetched.errors } };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function requireCommunity(req, res, manage = false) {
  return requireDashboardPermission(req, res, manage ? "community.manage" : "community.view");
}

export async function dashboardPromotors(req, res) {
  const method = String(req.method || "GET").toUpperCase();
  const principal = await requireCommunity(req, res, method !== "GET" && method !== "HEAD");
  if (!principal) return;

  if (method === "GET") {
    const result = await pool.query(`
      select id, x_handle, added_by_email, added_at, last_checked_at,
             shadowban_data, metrics_data, is_clean, role, is_paid
      from public.promotors
      order by added_at desc
    `);
    return res.status(200).json({ ok: true, promotors: result.rows });
  }

  if (method === "POST") {
    const handle = normalizeHandle(req.body?.x_handle);
    if (!handle || !/^[a-z0-9_]{1,15}$/.test(handle)) {
      return res.status(400).json({ ok: false, error: "A valid X handle is required." });
    }

    let metadata;
    try {
      metadata = parseMetadata(req.body || {});
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }

    const result = await pool.query(
      `insert into public.promotors (x_handle, added_by_email, role, is_paid)
       values ($1, $2, $3, $4)
       returning id, x_handle, added_by_email, added_at, last_checked_at,
                 shadowban_data, metrics_data, is_clean, role, is_paid`,
      [handle, principal.email, metadata.role ?? null, metadata.is_paid ?? null],
    );
    return res.status(201).json({ ok: true, promotor: result.rows[0] });
  }

  const id = String(req.params?.id || "");
  if (!UUID_RE.test(id)) return res.status(400).json({ ok: false, error: "Invalid promoter id." });

  if (method === "PATCH") {
    let metadata;
    try {
      metadata = parseMetadata(req.body || {});
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }

    const fields = [];
    const values = [];
    for (const [column, value] of Object.entries(metadata)) {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    }
    if (fields.length === 0) return res.status(400).json({ ok: false, error: "No supported fields supplied." });

    values.push(id);
    const result = await pool.query(
      `update public.promotors set ${fields.join(", ")} where id = $${values.length}
       returning id, x_handle, added_by_email, added_at, last_checked_at,
                 shadowban_data, metrics_data, is_clean, role, is_paid`,
      values,
    );
    if (result.rowCount === 0) return res.status(404).json({ ok: false, error: "Promoter not found." });
    return res.status(200).json({ ok: true, promotor: result.rows[0] });
  }

  if (method === "DELETE") {
    const result = await pool.query("delete from public.promotors where id = $1 returning id", [id]);
    if (result.rowCount === 0) return res.status(404).json({ ok: false, error: "Promoter not found." });
    return res.status(200).json({ ok: true, id });
  }

  return res.status(405).json({ ok: false, error: "Method not allowed." });
}

export async function dashboardPromotorRefresh(req, res) {
  const principal = await requireCommunity(req, res, true);
  if (!principal) return;
  if (String(req.method || "").toUpperCase() !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed." });

  const id = String(req.params?.id || "");
  if (!UUID_RE.test(id)) return res.status(400).json({ ok: false, error: "Invalid promoter id." });
  const result = await refreshPromotorById(id);
  return res.status(result.status).json(result.payload);
}

export async function dashboardPromotorsRefreshAll(req, res) {
  const principal = await requireCommunity(req, res, true);
  if (!principal) return;
  if (String(req.method || "").toUpperCase() !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed." });

  const rows = await pool.query("select id from public.promotors order by added_at asc");
  const results = [];
  for (const row of rows.rows) {
    try {
      const result = await refreshPromotorById(row.id);
      results.push({ id: row.id, status: result.status, ok: Boolean(result.payload?.ok), error: result.payload?.error || null });
    } catch (error) {
      results.push({ id: row.id, status: 500, ok: false, error: error?.message || String(error) });
    }
  }

  return res.status(200).json({ ok: true, total: results.length, results });
}
