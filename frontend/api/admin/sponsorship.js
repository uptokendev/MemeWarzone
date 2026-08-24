/**
 * Authenticated sponsorship admin API.
 * Browser roles cannot mutate sponsorship tables; this route uses the backend pool.
 */
import { pool } from "../../server/db.js";
import { getQuery, json, readJson } from "../../server/http.js";
import { requireAdminOrOps } from "../lib/apiAuth.js";

const APP_STATUSES = new Set([
  "submitted", "under_review", "approved", "rejected", "paid",
  "scheduled", "active", "expired", "paused",
]);
const PAYMENT_STATUSES = new Set(["pending", "invoice_sent", "paid", "verified", "refunded", "waived"]);

function clean(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function iso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function requireAdmin(req, res) {
  return requireAdminOrOps(req, res, { routeLabel: "admin/sponsorship", allowOps: true });
}

async function listApplications(req, res) {
  const q = getQuery(req);
  const status = String(q.status || "").trim().toLowerCase();
  const values = [];
  let where = "";
  if (APP_STATUSES.has(status)) {
    values.push(status);
    where = `where status = $1`;
  }
  const result = await pool.query(
    `select * from public.sponsorship_applications ${where} order by created_at desc limit 200`,
    values,
  );
  return json(res, 200, { items: result.rows, updatedAt: new Date().toISOString() });
}

async function patchApplication(req, res) {
  const body = await readJson(req);
  const id = clean(body.id || body.applicationId, 80);
  if (!id) return json(res, 400, { error: "id is required" });
  const status = body.status != null ? String(body.status).trim().toLowerCase() : null;
  if (status && !APP_STATUSES.has(status)) return json(res, 400, { error: "invalid status" });
  const notes = body.notes != null ? clean(body.notes, 1000) : null;
  const paymentReference = body.paymentReference != null ? clean(body.paymentReference, 160) : null;
  const paymentDueUsd = body.paymentDueUsd != null ? Number(body.paymentDueUsd) : null;
  const paymentInstructions = body.paymentInstructions != null ? clean(body.paymentInstructions, 1000) : null;
  const packagePriceUsd = body.packagePriceUsd != null ? Number(body.packagePriceUsd) : null;
  const imageUrl = body.imageUrl != null ? clean(body.imageUrl, 2000) : null;
  const result = await pool.query(
    `update public.sponsorship_applications
        set status = coalesce($2, status),
            notes = coalesce($3, notes),
            payment_reference = coalesce($4, payment_reference),
            payment_due_usd = coalesce($5, payment_due_usd),
            payment_instructions = coalesce($6, payment_instructions),
            package_price_usd = coalesce($7, package_price_usd),
            image_url = coalesce($8, image_url),
            approved_at = case when $2 = 'approved' then now() else approved_at end,
            paid_at = case when $2 = 'paid' then now() else paid_at end,
            updated_at = now()
      where id = $1::uuid
      returning *`,
    [id, status, notes, paymentReference, paymentDueUsd, paymentInstructions, packagePriceUsd, imageUrl],
  );
  if (!result.rows[0]) return json(res, 404, { error: "application not found" });
  return json(res, 200, { item: result.rows[0] });
}

async function listPlacements(req, res) {
  const result = await pool.query(
    `select * from public.sponsored_placements order by created_at desc limit 200`,
  );
  return json(res, 200, { items: result.rows });
}

async function upsertPlacement(req, res) {
  const body = await readJson(req);
  const id = clean(body.id, 80) || null;
  const projectName = clean(body.projectName, 120);
  const bio = clean(body.bio, 500);
  const websiteUrl = clean(body.websiteUrl, 500);
  if (!projectName || !bio || !websiteUrl) {
    return json(res, 400, { error: "projectName, bio, and websiteUrl are required" });
  }
  const paymentStatus = String(body.paymentStatus || "pending").trim().toLowerCase();
  if (!PAYMENT_STATUSES.has(paymentStatus)) return json(res, 400, { error: "invalid paymentStatus" });
  const values = [
    id,
    body.applicationId || null,
    Number(body.chainId || 97),
    clean(body.campaignAddress, 160) || null,
    clean(body.tokenAddress, 160) || null,
    clean(body.creatorAddress, 160) || null,
    projectName,
    clean(body.symbol, 24) || null,
    clean(body.imageUrl, 2000) || null,
    bio,
    websiteUrl,
    clean(body.targetUrl, 500) || websiteUrl,
    clean(body.projectType, 24) || "external",
    clean(body.placementLabel, 80) || "Homepage rail",
    clean(body.slotCode, 80) || "homepage-sponsored-rail",
    Number(body.priority || 1000),
    Boolean(body.active),
    paymentStatus,
    iso(body.startsAt),
    iso(body.endsAt),
    clean(body.adminNotes, 1000) || null,
    clean(body.packageCode, 80) || null,
    body.packageDurationDays != null ? Number(body.packageDurationDays) : null,
    body.packagePriceUsd != null ? Number(body.packagePriceUsd) : null,
  ];
  const result = await pool.query(
    `insert into public.sponsored_placements (
       id, application_id, chain_id, campaign_address, token_address, creator_address,
       project_name, symbol, image_url, bio, website_url, target_url, project_type,
       placement_label, slot_code, priority, active, payment_status, starts_at, ends_at, admin_notes,
       package_code, package_duration_days, package_price_usd
     ) values (
       coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6,
       $7, $8, $9, $10, $11, $12, $13,
       $14, $15, $16, $17, $18, $19, $20, $21,
       $22, $23, $24
     )
     on conflict (id) do update set
       application_id = excluded.application_id,
       chain_id = excluded.chain_id,
       campaign_address = excluded.campaign_address,
       token_address = excluded.token_address,
       creator_address = excluded.creator_address,
       project_name = excluded.project_name,
       symbol = excluded.symbol,
       image_url = excluded.image_url,
       bio = excluded.bio,
       website_url = excluded.website_url,
       target_url = excluded.target_url,
       project_type = excluded.project_type,
       placement_label = excluded.placement_label,
       slot_code = excluded.slot_code,
       priority = excluded.priority,
       active = excluded.active,
       payment_status = excluded.payment_status,
       starts_at = excluded.starts_at,
       ends_at = excluded.ends_at,
       admin_notes = excluded.admin_notes,
       package_code = excluded.package_code,
       package_duration_days = excluded.package_duration_days,
       package_price_usd = excluded.package_price_usd,
       paused_at = case when excluded.active then null else now() end,
       updated_at = now()
     returning *`,
    values,
  );
  return json(res, 200, { item: result.rows[0] });
}

async function patchPlacement(req, res) {
  const body = await readJson(req);
  const id = clean(body.id, 80);
  if (!id) return json(res, 400, { error: "id is required" });
  const paymentStatus = body.paymentStatus != null ? String(body.paymentStatus).trim().toLowerCase() : null;
  if (paymentStatus && !PAYMENT_STATUSES.has(paymentStatus)) {
    return json(res, 400, { error: "invalid paymentStatus" });
  }
  const result = await pool.query(
    `update public.sponsored_placements
        set project_name = coalesce($2, project_name),
            image_url = coalesce($3, image_url),
            bio = coalesce($4, bio),
            website_url = coalesce($5, website_url),
            target_url = coalesce($6, target_url),
            slot_code = coalesce($7, slot_code),
            placement_label = coalesce($8, placement_label),
            project_type = coalesce($9, project_type),
            priority = coalesce($10, priority),
            starts_at = coalesce($11::timestamptz, starts_at),
            ends_at = coalesce($12::timestamptz, ends_at),
            active = coalesce($13::boolean, active),
            payment_status = coalesce($14, payment_status),
            paused_at = case
              when $13::boolean is true then null
              when $13::boolean is false then now()
              else paused_at
            end,
            updated_at = now()
      where id = $1::uuid
      returning *`,
    [
      id,
      body.projectName != null ? clean(body.projectName, 120) : null,
      body.imageUrl != null ? clean(body.imageUrl, 2000) : null,
      body.bio != null ? clean(body.bio, 500) : null,
      body.websiteUrl != null ? clean(body.websiteUrl, 500) : null,
      body.targetUrl != null ? clean(body.targetUrl, 500) : null,
      body.slotCode != null ? clean(body.slotCode, 80) : null,
      body.placementLabel != null ? clean(body.placementLabel, 80) : null,
      body.projectType != null ? clean(body.projectType, 24) : null,
      body.priority != null ? Number(body.priority) : null,
      iso(body.startsAt),
      iso(body.endsAt),
      body.active == null ? null : Boolean(body.active),
      paymentStatus,
    ],
  );
  if (!result.rows[0]) return json(res, 404, { error: "placement not found" });
  return json(res, 200, { item: result.rows[0] });
}

async function deletePlacement(req, res) {
  const body = await readJson(req);
  const id = clean(body.id, 80);
  if (!id) return json(res, 400, { error: "id is required" });
  const result = await pool.query(
    `delete from public.sponsored_placements where id = $1::uuid returning id`,
    [id],
  );
  if (!result.rows[0]) return json(res, 404, { error: "placement not found" });
  return json(res, 200, { ok: true, id });
}

async function listPackages(req, res) {
  const result = await pool.query(
    `select * from public.sponsorship_packages order by sort_order asc, code asc limit 200`,
  );
  return json(res, 200, { items: result.rows });
}

async function patchPackage(req, res) {
  const body = await readJson(req);
  const id = clean(body.id, 80);
  if (!id) return json(res, 400, { error: "id is required" });
  const result = await pool.query(
    `update public.sponsorship_packages
        set label = coalesce($2, label),
            price_usd = coalesce($3, price_usd),
            duration_days = coalesce($4, duration_days),
            active = coalesce($5::boolean, active),
            sort_order = coalesce($6, sort_order),
            notes = coalesce($7, notes),
            updated_at = now()
      where id = $1::uuid
      returning *`,
    [
      id,
      body.label != null ? clean(body.label, 120) : null,
      body.priceUsd != null ? Number(body.priceUsd) : null,
      body.durationDays != null ? Number(body.durationDays) : null,
      body.active == null ? null : Boolean(body.active),
      body.sortOrder != null ? Number(body.sortOrder) : null,
      body.notes != null ? clean(body.notes, 1000) : null,
    ],
  );
  if (!result.rows[0]) return json(res, 404, { error: "package not found" });
  return json(res, 200, { item: result.rows[0] });
}

export default async function handler(req, res) {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    if (!pool) return json(res, 503, { error: "Database unavailable" });
    const q = getQuery(req);
    const resource = String(q.resource || "applications").trim().toLowerCase();
    if (resource === "applications") {
      if (req.method === "GET") return listApplications(req, res);
      if (req.method === "PATCH" || req.method === "POST") return patchApplication(req, res);
    }
    if (resource === "placements") {
      if (req.method === "GET") return listPlacements(req, res);
      if (req.method === "PATCH") return patchPlacement(req, res);
      if (req.method === "PUT" || req.method === "POST") return upsertPlacement(req, res);
      if (req.method === "DELETE") return deletePlacement(req, res);
    }
    if (resource === "packages") {
      if (req.method === "GET") return listPackages(req, res);
      if (req.method === "PATCH" || req.method === "POST") return patchPackage(req, res);
    }
    return json(res, 400, { error: "Unknown resource. Use applications, placements, or packages." });
  } catch (error) {
    console.error("[admin/sponsorship]", error);
    return json(res, 503, { error: "Sponsorship admin API unavailable", detail: String(error?.message || error) });
  }
}

