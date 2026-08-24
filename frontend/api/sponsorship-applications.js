import { pool } from "../server/db.js";
import { badMethod, getQuery, json, readJson } from "../server/http.js";
import { requireAdminOrOps } from "./lib/apiAuth.js";

const VALID_STATUSES = new Set(["submitted", "under_review", "approved", "rejected", "paid", "scheduled", "active", "expired", "paused"]);

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function cleanText(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function normalizeDate(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeStatus(value, fallback = "submitted") {
  const status = String(value ?? "").trim().toLowerCase();
  return VALID_STATUSES.has(status) ? status : fallback;
}

function mapRow(row) {
  return {
    id: row.id,
    projectName: row.projectName,
    contactName: row.contactName,
    contactChannel: row.contactChannel,
    applicantWallet: row.applicantWallet,
    websiteUrl: row.websiteUrl,
    imageUrl: row.imageUrl,
    bio: row.bio,
    preferredSlot: row.preferredSlot,
    preferredStart: row.preferredStart,
    preferredEnd: row.preferredEnd,
    paymentReference: row.paymentReference,
    notes: row.notes,
    status: row.status,
    packageCode: row.packageCode ?? null,
    packageLabel: row.packageLabel ?? null,
    packageDurationDays: row.packageDurationDays != null ? Number(row.packageDurationDays) : null,
    packagePriceUsd: row.packagePriceUsd != null ? Number(row.packagePriceUsd) : null,
    paymentDueUsd: row.paymentDueUsd != null ? Number(row.paymentDueUsd) : null,
    paymentInstructions: row.paymentInstructions ?? null,
    approvedAt: row.approvedAt ?? null,
    paidAt: row.paidAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function resolvePackage(packageCode) {
  const code = cleanText(packageCode, 40);
  if (!code || !pool) return null;
  try {
    const result = await pool.query(
      `select code, label, duration_days as "durationDays", price_usd::float8 as "priceUsd"
         from public.sponsorship_packages
        where lower(code) = lower($1) and coalesce(active, true) = true
        limit 1`,
      [code],
    );
    return result.rows[0] || null;
  } catch {
    return null;
  }
}

async function listApplications(req, res) {
  const q = getQuery(req);
  const status = normalizeStatus(q.status, "all");
  const limit = clamp(toInt(q.limit, 50), 1, 200);
  const values = [];
  let where = "";
  if (status !== "all") {
    values.push(status);
    where = `where status = $${values.length}`;
  }
  values.push(limit);

  const result = await pool.query(
    `select
       id,
       project_name as "projectName",
       contact_name as "contactName",
       contact_channel as "contactChannel",
       applicant_wallet as "applicantWallet",
       website_url as "websiteUrl",
       image_url as "imageUrl",
       bio,
       preferred_slot as "preferredSlot",
       preferred_start as "preferredStart",
       preferred_end as "preferredEnd",
       payment_reference as "paymentReference",
       notes,
       status,
       package_code as "packageCode",
       package_label as "packageLabel",
       package_duration_days as "packageDurationDays",
       package_price_usd as "packagePriceUsd",
       payment_due_usd as "paymentDueUsd",
       payment_instructions as "paymentInstructions",
       approved_at as "approvedAt",
       paid_at as "paidAt",
       created_at as "createdAt",
       updated_at as "updatedAt"
     from public.sponsorship_applications
     ${where}
     order by created_at desc
     limit $${values.length}`,
    values,
  );
  return json(res, 200, { items: result.rows.map(mapRow), updatedAt: new Date().toISOString() });
}

async function createApplication(req, res) {
  const body = await readJson(req);
  const projectName = cleanText(body.projectName, 120);
  const contactName = cleanText(body.contactName, 120);
  const contactChannel = cleanText(body.contactChannel, 160);
  const websiteUrl = cleanText(body.websiteUrl, 500);
  const bio = cleanText(body.bio, 500);
  if (!projectName || !contactName || !contactChannel || !websiteUrl || !bio) {
    return json(res, 400, { error: "projectName, contactName, contactChannel, websiteUrl, and bio are required" });
  }

  // No upfront payment — lock package snapshot at apply time. Admin can adjust before approve.
  const pkg = await resolvePackage(body.packageCode || body.package_code);
  if (!pkg) {
    return json(res, 400, {
      error: "Select a valid sponsorship package (3 days, 1 week, 2 weeks, 1 month, or 3 months).",
      code: "PACKAGE_REQUIRED",
    });
  }

  const values = [
    projectName,
    contactName,
    contactChannel,
    cleanText(body.applicantWallet, 160) || null,
    websiteUrl,
    cleanText(body.imageUrl, 2000) || null,
    bio,
    cleanText(body.preferredSlot, 80) || "featured-top-left",
    normalizeDate(body.preferredStart),
    normalizeDate(body.preferredEnd),
    cleanText(body.paymentReference, 160) || null,
    cleanText(body.notes, 1000) || null,
    "submitted",
    pkg.code,
    pkg.label,
    Number(pkg.durationDays),
    Number(pkg.priceUsd),
    Number(pkg.priceUsd), // payment_due snapshot (still not paid)
  ];

  let result;
  try {
    result = await pool.query(
      `insert into public.sponsorship_applications (
         project_name, contact_name, contact_channel, applicant_wallet, website_url, image_url, bio,
         preferred_slot, preferred_start, preferred_end, payment_reference, notes, status,
         package_code, package_label, package_duration_days, package_price_usd, payment_due_usd
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       returning
         id,
         project_name as "projectName",
         contact_name as "contactName",
         contact_channel as "contactChannel",
         applicant_wallet as "applicantWallet",
         website_url as "websiteUrl",
         image_url as "imageUrl",
         bio,
         preferred_slot as "preferredSlot",
         preferred_start as "preferredStart",
         preferred_end as "preferredEnd",
         payment_reference as "paymentReference",
         notes,
         status,
         package_code as "packageCode",
         package_label as "packageLabel",
         package_duration_days as "packageDurationDays",
         package_price_usd as "packagePriceUsd",
         payment_due_usd as "paymentDueUsd",
         payment_instructions as "paymentInstructions",
         approved_at as "approvedAt",
         paid_at as "paidAt",
         created_at as "createdAt",
         updated_at as "updatedAt"`,
      values,
    );
  } catch (error) {
    // Schema not migrated yet — insert without package columns.
    if (error?.code === "42703") {
      result = await pool.query(
        `insert into public.sponsorship_applications (
           project_name, contact_name, contact_channel, applicant_wallet, website_url, image_url, bio,
           preferred_slot, preferred_start, preferred_end, payment_reference, notes, status
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         returning
           id,
           project_name as "projectName",
           contact_name as "contactName",
           contact_channel as "contactChannel",
           applicant_wallet as "applicantWallet",
           website_url as "websiteUrl",
           image_url as "imageUrl",
           bio,
           preferred_slot as "preferredSlot",
           preferred_start as "preferredStart",
           preferred_end as "preferredEnd",
           payment_reference as "paymentReference",
           notes,
           status,
           created_at as "createdAt",
           updated_at as "updatedAt"`,
        values.slice(0, 13),
      );
    } else {
      throw error;
    }
  }
  return json(res, 201, { item: mapRow(result.rows[0]), updatedAt: new Date().toISOString() });
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const admin = await requireAdminOrOps(req, res, { routeLabel: "sponsorship-applications-list", allowOps: true });
      if (!admin) return;
      return listApplications(req, res);
    }
    if (req.method === "POST") return createApplication(req, res);
    return badMethod(res);
  } catch (error) {
    console.error("[api/sponsorship-applications] request failed", error);
    return json(res, 503, { error: "Sponsorship application storage is unavailable", detail: String(error?.message || error || "unknown error") });
  }
}
