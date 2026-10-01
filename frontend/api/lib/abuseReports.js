export const ABUSE_CATEGORIES = Object.freeze({
  impersonation: "Impersonation",
  stolen_content: "Stolen content",
  fake_project: "Fake project",
  phishing: "Phishing",
  other: "Other abuse",
});

export const ABUSE_ENTITY_TYPES = Object.freeze({
  profile: "MemeWarzone user/profile",
  campaign: "Campaign",
  token: "Token",
  wallet: "Wallet",
  post: "Feed post",
  external_account: "External account",
  external_website: "External website",
  other: "Other",
});

export const ABUSE_STATUSES = Object.freeze({
  OPEN: "OPEN",
  UNDER_REVIEW: "UNDER_REVIEW",
  WAITING_FOR_REPORTER: "WAITING_FOR_REPORTER",
  RESOLVED: "RESOLVED",
  CLOSED: "CLOSED",
});

export const REPORTER_REPLY_STATUSES = new Set([
  ABUSE_STATUSES.OPEN,
  ABUSE_STATUSES.UNDER_REVIEW,
  ABUSE_STATUSES.WAITING_FOR_REPORTER,
  ABUSE_STATUSES.RESOLVED,
]);

export const DESCRIPTION_MIN = 20;
export const DESCRIPTION_MAX = 8000;
export const MESSAGE_MAX = 4000;
export const SUBJECT_MAX = 200;
export const URL_MAX = 500;
export const OPEN_REPORTS_PER_DAY = 3;
export const EVIDENCE_MAX_FILES = 5;
export const EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;
export const OPEN_DUPLICATE_STATUSES = Object.freeze([
  ABUSE_STATUSES.OPEN,
  ABUSE_STATUSES.UNDER_REVIEW,
  ABUSE_STATUSES.WAITING_FOR_REPORTER,
]);

export function normalizeCategory(value) {
  const raw = String(value || "").trim().toLowerCase();
  return Object.hasOwn(ABUSE_CATEGORIES, raw) ? raw : "";
}

export function normalizeEntityType(value) {
  const raw = String(value || "").trim().toLowerCase();
  return Object.hasOwn(ABUSE_ENTITY_TYPES, raw) ? raw : "";
}

export function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return "";
  return email;
}

export function sanitizeHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.length > URL_MAX) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (url.username || url.password) return "";
    return url.toString();
  } catch {
    return "";
  }
}

export function clampText(value, max) {
  return String(value || "").trim().slice(0, max);
}

export function publicReferenceFromSeq(seq) {
  const n = Number(seq);
  if (!Number.isFinite(n) || n < 1) return "";
  return `MWZ-AB-${String(Math.trunc(n)).padStart(6, "0")}`;
}

export function isPublicReference(value) {
  return /^MWZ-AB-\d{6,}$/i.test(String(value || "").trim());
}

export function normalizePublicReference(value) {
  const raw = String(value || "").trim().toUpperCase();
  return isPublicReference(raw) ? raw : "";
}

export function normalizeStatus(value) {
  const raw = String(value || "").trim().toUpperCase();
  return Object.hasOwn(ABUSE_STATUSES, raw) ? raw : "";
}

export function normalizePriority(value) {
  const raw = String(value || "").trim().toUpperCase();
  return raw === "LOW" || raw === "NORMAL" || raw === "HIGH" || raw === "URGENT" ? raw : "";
}

export function formatStatusLabel(status) {
  const raw = String(status || "").trim().toUpperCase();
  if (raw === "UNDER_REVIEW") return "Under Review";
  if (raw === "WAITING_FOR_REPORTER") return "Waiting for reporter";
  if (raw === "RESOLVED") return "Resolved";
  if (raw === "CLOSED") return "Closed";
  return "Open";
}

export function reporterSafeReport(row, { messages = [], evidence = [] } = {}) {
  return {
    id: String(row.public_reference),
    category: String(row.category),
    categoryLabel: ABUSE_CATEGORIES[row.category] || "Other abuse",
    subject: row.subject || "",
    description: String(row.description || ""),
    entityType: row.reported_entity_type || "",
    reportedWallet: row.reported_wallet || "",
    reportedProfileId: row.reported_profile_id || "",
    reportedCampaignAddress: row.reported_campaign_address || "",
    reportedTokenAddress: row.reported_token_address || "",
    reportedUrl: row.reported_url || "",
    status: String(row.status),
    statusLabel: formatStatusLabel(row.status),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    resolvedAt: toIso(row.resolved_at),
    closedAt: toIso(row.closed_at),
    messages: messages.map(reporterSafeMessage),
    evidence: evidence.map(reporterSafeEvidence),
  };
}

export function reporterSafeMessage(row) {
  return {
    id: String(row.id),
    senderType: String(row.sender_type),
    message: String(row.message || ""),
    createdAt: toIso(row.created_at),
  };
}

export function reporterSafeEvidence(row) {
  return {
    id: String(row.id),
    messageId: row.message_id ? String(row.message_id) : null,
    originalFilename: String(row.original_filename || "evidence"),
    mimeType: String(row.mime_type || ""),
    sizeBytes: Number(row.size_bytes || 0),
    createdAt: toIso(row.created_at),
  };
}

export function adminSafeMessage(row) {
  return {
    id: String(row.id),
    senderType: String(row.sender_type),
    visibility: String(row.visibility || "reporter"),
    senderAdminId: row.sender_admin_id ? String(row.sender_admin_id) : null,
    message: String(row.message || ""),
    createdAt: toIso(row.created_at),
  };
}

export function adminSafeReport(row, extras = {}) {
  return {
    id: String(row.public_reference),
    internalId: String(row.id),
    category: String(row.category),
    categoryLabel: ABUSE_CATEGORIES[row.category] || "Other abuse",
    subject: row.subject || "",
    description: extras.includeDescription ? String(row.description || "") : undefined,
    reporterWallet: String(row.reporter_wallet || ""),
    reporterChain: Number(row.reporter_chain || 0),
    reporterEmail: String(row.reporter_email || ""),
    entityType: row.reported_entity_type || "",
    reportedWallet: row.reported_wallet || "",
    reportedProfileId: row.reported_profile_id || "",
    reportedCampaignAddress: row.reported_campaign_address || "",
    reportedTokenAddress: row.reported_token_address || "",
    reportedUrl: row.reported_url || "",
    status: String(row.status),
    statusLabel: formatStatusLabel(row.status),
    priority: String(row.priority || "NORMAL"),
    assignedAdminId: row.assigned_admin_id ? String(row.assigned_admin_id) : null,
    assignedAdminEmail: row.assigned_admin_email ? String(row.assigned_admin_email) : null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    resolvedAt: toIso(row.resolved_at),
    closedAt: toIso(row.closed_at),
    messages: Array.isArray(extras.messages) ? extras.messages.map(adminSafeMessage) : undefined,
    evidence: Array.isArray(extras.evidence) ? extras.evidence.map(reporterSafeEvidence) : undefined,
  };
}

export async function findOpenDuplicateReport(db, {
  reporterWallet,
  category,
  reportedWallet = "",
  reportedCampaignAddress = "",
  reportedTokenAddress = "",
  reportedUrl = "",
}) {
  const { rows } = await db.query(
    `select public_reference
       from public.abuse_reports
      where reporter_wallet = $1
        and category = $2
        and status = any($3::text[])
        and coalesce(reported_wallet, '') = $4
        and coalesce(reported_campaign_address, '') = $5
        and coalesce(reported_token_address, '') = $6
        and coalesce(reported_url, '') = $7
      order by created_at desc
      limit 1`,
    [
      reporterWallet,
      category,
      [...OPEN_DUPLICATE_STATUSES],
      String(reportedWallet || ""),
      String(reportedCampaignAddress || ""),
      String(reportedTokenAddress || ""),
      String(reportedUrl || ""),
    ],
  );
  return rows[0] || null;
}

export async function writeReportEvent(db, {
  reportId,
  eventType,
  actorType,
  actorId = null,
  oldValue = null,
  newValue = null,
  metadata = {},
}) {
  await db.query(
    `insert into public.abuse_report_events
       (report_id, event_type, actor_type, actor_id, old_value, new_value, metadata)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [reportId, eventType, actorType, actorId, oldValue, newValue, JSON.stringify(metadata || {})],
  );
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
