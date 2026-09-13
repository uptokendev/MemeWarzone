import { pool } from "../../server/db.js";
import { requireDashboardPermission } from "./_access.js";

const PAGE_SIZE = 20;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pathnameOf(req) {
  return new URL(req.originalUrl || req.url || "/", "http://localhost").pathname;
}

function pageOf(req) {
  const raw = Number(req.query?.page ?? new URL(req.originalUrl || req.url || "/", "http://localhost").searchParams.get("page") ?? 0);
  if (!Number.isInteger(raw) || raw < 0) return 0;
  return Math.min(raw, 100000);
}

async function submissions(req, res) {
  const page = pageOf(req);
  const offset = page * PAGE_SIZE;
  const [rows, count] = await Promise.all([
    pool.query(
      `select *
         from public.submissions
        order by created_at desc
        limit $1 offset $2`,
      [PAGE_SIZE, offset],
    ),
    pool.query(`select count(*)::int as n from public.submissions`),
  ]);
  return res.status(200).json({ ok: true, submissions: rows.rows, count: Number(count.rows[0]?.n || 0), page, pageSize: PAGE_SIZE });
}

async function submissionCounts(res) {
  const result = await pool.query(
    `select count(*)::int as total,
            count(*) filter (where source = 'discord')::int as discord_count,
            count(*) filter (where source = 'telegram')::int as telegram_count
       from public.submissions`,
  );
  const row = result.rows[0] || {};
  return res.status(200).json({
    ok: true,
    total: Number(row.total || 0),
    discordCount: Number(row.discord_count || 0),
    telegramCount: Number(row.telegram_count || 0),
  });
}

async function tickets(req, res) {
  const page = pageOf(req);
  const offset = page * PAGE_SIZE;
  const [rows, count] = await Promise.all([
    pool.query(
      `select *
         from public.tickets
        order by created_at desc
        limit $1 offset $2`,
      [PAGE_SIZE, offset],
    ),
    pool.query(`select count(*)::int as n from public.tickets`),
  ]);
  return res.status(200).json({ ok: true, tickets: rows.rows, count: Number(count.rows[0]?.n || 0), page, pageSize: PAGE_SIZE });
}

async function ticketCounts(res) {
  const result = await pool.query(
    `select count(*)::int as total,
            count(*) filter (where status = 'open')::int as open_count,
            count(*) filter (where status = 'claimed')::int as claimed_count,
            count(*) filter (where status = 'closed')::int as closed_count
       from public.tickets`,
  );
  const row = result.rows[0] || {};
  return res.status(200).json({
    ok: true,
    total: Number(row.total || 0),
    openCount: Number(row.open_count || 0),
    claimedCount: Number(row.claimed_count || 0),
    closedCount: Number(row.closed_count || 0),
  });
}

async function ticketTranscript(req, res, ticketId) {
  if (!UUID_RE.test(ticketId)) return res.status(400).json({ ok: false, error: "Invalid ticket id." });
  const result = await pool.query(
    `select *
       from public.ticket_transcripts
      where ticket_id = $1::uuid
      limit 1`,
    [ticketId],
  );
  return res.status(200).json({ ok: true, transcript: result.rows[0] || null });
}

export async function dashboardOperations(req, res) {
  const principal = await requireDashboardPermission(req, res, "operations.view");
  if (!principal) return;
  const method = String(req.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).json({ ok: false, error: "Method not allowed." });
  }

  const pathname = pathnameOf(req);
  try {
    if (pathname === "/api/dashboard/operations/submissions") return await submissions(req, res);
    if (pathname === "/api/dashboard/operations/submission-counts") return await submissionCounts(res);
    if (pathname === "/api/dashboard/operations/tickets") return await tickets(req, res);
    if (pathname === "/api/dashboard/operations/ticket-counts") return await ticketCounts(res);
    const transcript = pathname.match(/^\/api\/dashboard\/operations\/tickets\/([0-9a-f-]{36})\/transcript$/i);
    if (transcript) return await ticketTranscript(req, res, transcript[1]);
    return res.status(404).json({ ok: false, error: "Unknown dashboard Operations route." });
  } catch (error) {
    console.error("[dashboard-operations]", pathname, error);
    return res.status(500).json({ ok: false, error: "Operations query failed." });
  }
}
