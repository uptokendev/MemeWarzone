import { pool } from "../../server/db.js";
import { requireDashboardPermission } from "./_access.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOTE_LENGTH = 4000;

function submissionIdFromRequest(req) {
  const direct = String(req.query?.submissionId || req.query?.submission_id || "").trim();
  if (direct) return direct;

  try {
    const parsed = new URL(String(req.originalUrl || req.url || ""), "http://localhost");
    return String(parsed.searchParams.get("submissionId") || parsed.searchParams.get("submission_id") || "").trim();
  } catch {
    return "";
  }
}

function parseContent(body) {
  const content = String(body?.content || "").trim();
  if (!content) throw new Error("Note content is required.");
  if (content.length > MAX_NOTE_LENGTH) throw new Error(`Note content must be ${MAX_NOTE_LENGTH} characters or fewer.`);
  return content;
}

async function submissionExists(submissionId) {
  const result = await pool.query("select 1 from public.submissions where id = $1 limit 1", [submissionId]);
  return result.rowCount > 0;
}

export async function dashboardSubmissionNotes(req, res) {
  const method = String(req.method || "GET").toUpperCase();
  const permission = method === "GET" || method === "HEAD" ? "operations.view" : "operations.manage";
  const principal = await requireDashboardPermission(req, res, permission);
  if (!principal) return;

  if (method === "GET") {
    const submissionId = submissionIdFromRequest(req);
    if (!UUID_RE.test(submissionId)) {
      return res.status(400).json({ ok: false, error: "A valid submissionId is required." });
    }

    const result = await pool.query(
      `select id, submission_id, admin_id, admin_email, content, created_at
         from public.submission_notes
        where submission_id = $1
        order by created_at asc, id asc`,
      [submissionId],
    );
    return res.status(200).json({ ok: true, notes: result.rows });
  }

  if (method === "POST") {
    const submissionId = String(req.body?.submission_id || req.body?.submissionId || "").trim();
    if (!UUID_RE.test(submissionId)) {
      return res.status(400).json({ ok: false, error: "A valid submission_id is required." });
    }

    let content;
    try {
      content = parseContent(req.body);
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }

    if (!(await submissionExists(submissionId))) {
      return res.status(404).json({ ok: false, error: "Submission not found." });
    }

    const result = await pool.query(
      `insert into public.submission_notes (submission_id, admin_id, admin_email, content)
       values ($1, $2, $3, $4)
       returning id, submission_id, admin_id, admin_email, content, created_at`,
      [submissionId, principal.authUserId, principal.email, content],
    );
    return res.status(201).json({ ok: true, note: result.rows[0] });
  }

  return res.status(405).json({ ok: false, error: "Method not allowed." });
}
