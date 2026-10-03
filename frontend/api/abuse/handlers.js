import crypto from "node:crypto";
import formidable from "formidable";
import fs from "node:fs";
import { readJson } from "../../server/http.js";
import {
  ABUSE_STATUSES,
  DESCRIPTION_MAX,
  DESCRIPTION_MIN,
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MAX_FILES,
  MESSAGE_MAX,
  OPEN_REPORTS_PER_DAY,
  REPORTER_REPLY_STATUSES,
  SUBJECT_MAX,
  adminSafeReport,
  clampText,
  findOpenDuplicateReport,
  normalizeCategory,
  normalizeEmail,
  normalizeEntityType,
  normalizePublicReference,
  publicReferenceFromSeq,
  reporterSafeReport,
  sanitizeHttpUrl,
  writeReportEvent,
} from "../lib/abuseReports.js";
import { createAbuseReporterAuth } from "../lib/abuseReporterAuth.js";
import {
  createEvidenceSignedUrl,
  detectEvidenceType,
  safeEvidenceFilename,
  storePrivateEvidence,
} from "../lib/abuseEvidence.js";
import { ABUSE_NOTIFY_EVENTS, notifyAbuseReporter } from "../lib/abuseNotify.js";

function methodNotAllowed(res) {
  return res.status(405).json({ ok: false, error: "Method not allowed" });
}

function requestPath(req) {
  return String(req.originalUrl || req.url || req.path || "").split("?")[0];
}

function pathParts(req) {
  return requestPath(req).replace(/^\/api\/abuse\/?/, "").split("/").filter(Boolean);
}

async function loadOwnedReport(db, reference, wallet) {
  const { rows } = await db.query(
    `select *
       from public.abuse_reports
      where public_reference = $1
        and reporter_wallet = $2
      limit 1`,
    [reference, wallet],
  );
  return rows[0] || null;
}

async function loadVisibleThread(db, reportId) {
  const messages = await db.query(
    `select id, sender_type, message, created_at
       from public.abuse_report_messages
      where report_id = $1
        and visibility = 'reporter'
      order by created_at asc`,
    [reportId],
  );
  const evidence = await db.query(
    `select id, message_id, original_filename, mime_type, size_bytes, created_at
       from public.abuse_report_evidence
      where report_id = $1
      order by created_at asc`,
    [reportId],
  );
  return { messages: messages.rows, evidence: evidence.rows };
}

function parseReportFields(body) {
  const category = normalizeCategory(body.category);
  const description = clampText(body.description, DESCRIPTION_MAX);
  const email = normalizeEmail(body.email || body.reporterEmail || body.reporter_email);
  const subject = clampText(body.subject, SUBJECT_MAX);
  const entityType = normalizeEntityType(body.entityType || body.reportedEntityType || body.reported_entity_type);
  const reportedWallet = clampText(body.reportedWallet || body.reported_wallet, 128).toLowerCase();
  const reportedProfileId = clampText(body.reportedProfileId || body.reported_profile_id, 128);
  const reportedCampaignAddress = clampText(body.reportedCampaignAddress || body.reported_campaign_address, 128);
  const reportedTokenAddress = clampText(body.reportedTokenAddress || body.reported_token_address, 128);
  const reportedUrl = sanitizeHttpUrl(body.reportedUrl || body.reported_url || body.url);

  // CO-30 (founder 2026-10-03): the "…" menu on posts, comments and profiles files a quick in-app
  // report (one textbox). It may come without an email; the reporter follows it in Command Center.
  const inApp = String(body.source || "") === "in_app" && (entityType === "post" || entityType === "profile");

  const errors = [];
  if (!category) errors.push("Choose an abuse category.");
  if (!email && !inApp) errors.push("A notification email is required.");
  if (description.length < DESCRIPTION_MIN) errors.push("Describe what happened in more detail.");
  return {
    errors,
    values: {
      category,
      description,
      email,
      subject: subject || ABUSE_CATEGORY_SUBJECT[category] || "Abuse report",
      entityType: entityType || null,
      reportedWallet: reportedWallet || null,
      reportedProfileId: reportedProfileId || null,
      reportedCampaignAddress: reportedCampaignAddress || null,
      reportedTokenAddress: reportedTokenAddress || null,
      reportedUrl: reportedUrl || null,
      inApp,
    },
  };
}

const ABUSE_CATEGORY_SUBJECT = {
  impersonation: "Someone is impersonating me",
  stolen_content: "Someone is using my images/content",
  fake_project: "A fake project is pretending to represent me",
  phishing: "Phishing/scam impersonation",
  other: "Other abuse",
};

export function createAbuseReporterHandlers({ pool }) {
  const auth = createAbuseReporterAuth({ pool });

  async function session(req, res) {
    if (String(req.method || "").toUpperCase() !== "POST") return methodNotAllowed(res);
    const body = await readJson(req);
    req.body = body;
    const opened = await auth.openSession(req, res);
    if (!opened) return;
    return res.status(200).json(opened);
  }

  async function createReport(req, res, actor) {
    const parsed = parseReportFields(await readJson(req));
    if (parsed.errors.length) {
      return res.status(400).json({ ok: false, error: parsed.errors[0] });
    }

    const duplicate = await findOpenDuplicateReport(pool, {
      reporterWallet: actor.walletAddress,
      category: parsed.values.category,
      reportedWallet: parsed.values.reportedWallet,
      reportedCampaignAddress: parsed.values.reportedCampaignAddress,
      reportedTokenAddress: parsed.values.reportedTokenAddress,
      reportedUrl: parsed.values.reportedUrl,
    });
    if (duplicate?.public_reference) {
      return res.status(409).json({
        ok: false,
        error: "You already have an open report about this.",
        reportId: String(duplicate.public_reference),
      });
    }

    const recent = await pool.query(
      `select count(*)::int as count
         from public.abuse_reports
        where reporter_wallet = $1
          and created_at > now() - interval '24 hours'`,
      [actor.walletAddress],
    );
    if (Number(recent.rows[0]?.count || 0) >= OPEN_REPORTS_PER_DAY) {
      return res.status(429).json({ ok: false, error: "Too many reports from this wallet right now. Try again later." });
    }

    // In-app reports without an email use the wallet's verified notification email, else stay empty
    // (reporter_email is NOT NULL; abuseNotify skips an empty address).
    let reporterEmail = parsed.values.email;
    if (!reporterEmail && parsed.values.inApp) {
      try {
        const verified = await pool.query(
          `select email from public.wallet_notification_emails
            where lower(wallet) = lower($1) and verified_at is not null
            limit 1`,
          [actor.walletAddress],
        );
        reporterEmail = String(verified.rows[0]?.email || "");
      } catch {
        reporterEmail = "";
      }
    }

    const seq = await pool.query("select nextval('public.abuse_report_reference_seq') as seq");
    const publicReference = publicReferenceFromSeq(seq.rows[0].seq);
    const inserted = await pool.query(
      `insert into public.abuse_reports (
          public_reference, reporter_wallet, reporter_chain, reporter_email,
          category, subject, description, reported_entity_type,
          reported_wallet, reported_profile_id, reported_campaign_address,
          reported_token_address, reported_url, status, priority
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'OPEN','NORMAL')
        returning *`,
      [
        publicReference,
        actor.walletAddress,
        actor.chainId,
        reporterEmail || "",
        parsed.values.category,
        parsed.values.subject,
        parsed.values.description,
        parsed.values.entityType,
        parsed.values.reportedWallet,
        parsed.values.reportedProfileId,
        parsed.values.reportedCampaignAddress,
        parsed.values.reportedTokenAddress,
        parsed.values.reportedUrl,
      ],
    );
    const report = inserted.rows[0];
    const message = await pool.query(
      `insert into public.abuse_report_messages
         (report_id, sender_type, sender_wallet, message, visibility)
       values ($1, 'reporter', $2, $3, 'reporter')
       returning id, sender_type, message, created_at`,
      [report.id, actor.walletAddress, parsed.values.description],
    );
    await writeReportEvent(pool, {
      reportId: report.id,
      eventType: "REPORT_CREATED",
      actorType: "reporter",
      actorId: actor.walletAddress,
      newValue: publicReference,
    });
    await writeReportEvent(pool, {
      reportId: report.id,
      eventType: "MESSAGE_SENT",
      actorType: "reporter",
      actorId: actor.walletAddress,
    });

    void notifyAbuseReporter({
      eventType: ABUSE_NOTIFY_EVENTS.REPORT_SUBMITTED,
      report,
    });

    return res.status(200).json({
      ok: true,
      report: reporterSafeReport(report, { messages: message.rows, evidence: [] }),
    });
  }

  async function listReports(req, res, actor) {
    const { rows } = await pool.query(
      `select *
         from public.abuse_reports
        where reporter_wallet = $1
        order by updated_at desc, created_at desc
        limit 100`,
      [actor.walletAddress],
    );
    return res.status(200).json({
      ok: true,
      reports: rows.map((row) => reporterSafeReport(row)),
    });
  }

  async function readReport(req, res, actor, reference) {
    const report = await loadOwnedReport(pool, reference, actor.walletAddress);
    if (!report) return res.status(404).json({ ok: false, error: "Report not found." });
    const thread = await loadVisibleThread(pool, report.id);
    return res.status(200).json({
      ok: true,
      report: reporterSafeReport(report, thread),
    });
  }

  async function addMessage(req, res, actor, reference) {
    const report = await loadOwnedReport(pool, reference, actor.walletAddress);
    if (!report) return res.status(404).json({ ok: false, error: "Report not found." });
    if (!REPORTER_REPLY_STATUSES.has(report.status)) {
      return res.status(409).json({ ok: false, error: "This report is closed." });
    }

    const body = await readJson(req);
    const message = clampText(body.message, MESSAGE_MAX);
    if (message.length < 2) {
      return res.status(400).json({ ok: false, error: "Message is required." });
    }

    const inserted = await pool.query(
      `insert into public.abuse_report_messages
         (report_id, sender_type, sender_wallet, message, visibility)
       values ($1, 'reporter', $2, $3, 'reporter')
       returning id, sender_type, message, created_at`,
      [report.id, actor.walletAddress, message],
    );

    let nextStatus = report.status;
    if (report.status === ABUSE_STATUSES.RESOLVED) {
      nextStatus = ABUSE_STATUSES.UNDER_REVIEW;
      await pool.query(
        `update public.abuse_reports
            set status = $2, updated_at = now(), resolved_at = null
          where id = $1`,
        [report.id, nextStatus],
      );
      await writeReportEvent(pool, {
        reportId: report.id,
        eventType: "REPORT_REOPENED",
        actorType: "reporter",
        actorId: actor.walletAddress,
        oldValue: report.status,
        newValue: nextStatus,
      });
    } else {
      await pool.query(`update public.abuse_reports set updated_at = now() where id = $1`, [report.id]);
    }

    await writeReportEvent(pool, {
      reportId: report.id,
      eventType: "MESSAGE_SENT",
      actorType: "reporter",
      actorId: actor.walletAddress,
    });

    return res.status(200).json({
      ok: true,
      status: nextStatus,
      message: {
        id: String(inserted.rows[0].id),
        senderType: "reporter",
        message,
        createdAt: inserted.rows[0].created_at,
      },
    });
  }

  async function addEvidence(req, res, actor, reference) {
    const report = await loadOwnedReport(pool, reference, actor.walletAddress);
    if (!report) return res.status(404).json({ ok: false, error: "Report not found." });
    if (report.status === ABUSE_STATUSES.CLOSED) {
      return res.status(409).json({ ok: false, error: "This report is closed." });
    }

    const form = formidable({
      multiples: false,
      maxFileSize: EVIDENCE_MAX_BYTES,
      maxTotalFileSize: EVIDENCE_MAX_BYTES,
    });
    const [fields, files] = await form.parse(req);
    const fileRaw = files.file;
    const file = Array.isArray(fileRaw) ? fileRaw[0] : fileRaw;
    if (!file) return res.status(400).json({ ok: false, error: "Missing file (field name: file)." });

    const filepath = file.filepath || file.path;
    const buffer = fs.readFileSync(filepath);
    try { fs.unlinkSync(filepath); } catch {}

    const detected = detectEvidenceType(buffer, file.mimetype);
    if (!detected) {
      return res.status(400).json({ ok: false, error: "Unsupported or disguised file. Use JPG, PNG, WEBP, or PDF." });
    }

    const messageIdRaw = String(fields?.messageId?.[0] || fields?.messageId || fields?.message_id || "").trim();
    let messageId = messageIdRaw || null;
    if (!messageId) {
      const latest = await pool.query(
        `select id
           from public.abuse_report_messages
          where report_id = $1
            and sender_type = 'reporter'
            and visibility = 'reporter'
          order by created_at desc
          limit 1`,
        [report.id],
      );
      messageId = latest.rows[0]?.id || null;
    }

    if (messageId) {
      const count = await pool.query(
        `select count(*)::int as count
           from public.abuse_report_evidence
          where report_id = $1
            and message_id = $2`,
        [report.id, messageId],
      );
      if (Number(count.rows[0]?.count || 0) >= EVIDENCE_MAX_FILES) {
        return res.status(400).json({ ok: false, error: "This message already has the maximum number of attachments." });
      }
    }

    const stored = await storePrivateEvidence({
      buffer,
      mimeType: detected.mime,
      reportId: report.id,
      ext: detected.ext,
    });
    const filename = safeEvidenceFilename(file.originalFilename || file.newFilename || "evidence", detected.ext);
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    const inserted = await pool.query(
      `insert into public.abuse_report_evidence
         (report_id, message_id, uploaded_by_type, uploaded_by_wallet, storage_path, original_filename, mime_type, size_bytes, sha256)
       values ($1,$2,'reporter',$3,$4,$5,$6,$7,$8)
       returning id, message_id, original_filename, mime_type, size_bytes, created_at`,
      [report.id, messageId, actor.walletAddress, stored.path, filename, detected.mime, buffer.length, sha256],
    );
    await pool.query(`update public.abuse_reports set updated_at = now() where id = $1`, [report.id]);
    await writeReportEvent(pool, {
      reportId: report.id,
      eventType: "EVIDENCE_ADDED",
      actorType: "reporter",
      actorId: actor.walletAddress,
      metadata: { mimeType: detected.mime, sizeBytes: buffer.length },
    });

    return res.status(200).json({
      ok: true,
      evidence: {
        id: String(inserted.rows[0].id),
        messageId: inserted.rows[0].message_id,
        originalFilename: inserted.rows[0].original_filename,
        mimeType: inserted.rows[0].mime_type,
        sizeBytes: Number(inserted.rows[0].size_bytes),
        createdAt: inserted.rows[0].created_at,
      },
    });
  }

  async function downloadEvidence(req, res, actor, reference, evidenceId) {
    const report = await loadOwnedReport(pool, reference, actor.walletAddress);
    if (!report) return res.status(404).json({ ok: false, error: "Report not found." });
    const { rows } = await pool.query(
      `select storage_path
         from public.abuse_report_evidence
        where id = $1
          and report_id = $2
        limit 1`,
      [evidenceId, report.id],
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "Evidence not found." });
    const url = await createEvidenceSignedUrl(rows[0].storage_path, 60);
    return res.status(200).json({ ok: true, url, expiresIn: 60 });
  }

  async function reports(req, res) {
    const actor = await auth.requireSession(req, res);
    if (!actor) return;

    const method = String(req.method || "").toUpperCase();
    const parts = pathParts(req);
    const reference = normalizePublicReference(parts[1] || "");
    const tail = parts[2] || "";
    const evidenceId = parts[3] || "";

    try {
      if (parts.length <= 1) {
        if (method === "GET") return listReports(req, res, actor);
        if (method === "POST") return createReport(req, res, actor);
        return methodNotAllowed(res);
      }

      if (!reference) return res.status(404).json({ ok: false, error: "Report not found." });

      if (tail === "messages") {
        if (method !== "POST") return methodNotAllowed(res);
        return addMessage(req, res, actor, reference);
      }

      if (tail === "evidence" && evidenceId) {
        if (method !== "GET") return methodNotAllowed(res);
        return downloadEvidence(req, res, actor, reference, evidenceId);
      }

      if (tail === "evidence") {
        if (method !== "POST") return methodNotAllowed(res);
        return addEvidence(req, res, actor, reference);
      }

      if (!tail) {
        if (method !== "GET") return methodNotAllowed(res);
        return readReport(req, res, actor, reference);
      }

      return res.status(404).json({ ok: false, error: "Report not found." });
    } catch (error) {
      console.error("[abuse/reports]", error);
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: "Could not process the abuse report request." });
      }
    }
  }

  return { session, reports };
}

export function createAbuseAdminReportReader({ pool }) {
  return async function listAdminReports(res) {
    try {
      const { rows } = await pool.query(
        `select *
           from public.abuse_reports
          order by updated_at desc, created_at desc
          limit 200`,
      );
      return res.status(200).json({
        ok: true,
        reports: rows.map(adminSafeReport),
      });
    } catch (error) {
      if (error?.code === "42P01") {
        return res.status(200).json({ ok: true, reports: [] });
      }
      throw error;
    }
  };
}
