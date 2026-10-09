/**
 * /api/admin/import-fee-partners: Command Center "Partners" (swap-widget partners, lib/importFeePartnersAdmin.js).
 *
 *   GET                         partners with earnings + the last changes      finance.view
 *   POST                        add { id, chainId, name, payoutWallet, creatorBps?, partnerBps? }   finance.manage
 *   POST /:id/:chainId          change { name?, payoutWallet?, creatorBps?, partnerBps?, active? }  finance.manage
 */
import { pool } from "../../server/db.js";
import { json, readJson } from "../../server/http.js";
import { requireDashboardPermission } from "../dashboard/_access.js";
import { PartnerAdminError, createPartner, listPartnerAudit, listPartners, updatePartner } from "../lib/importFeePartnersAdmin.js";

function actorOf(principal) {
  return { id: principal?.authUserId || null, email: principal?.email || "unknown" };
}

export default async function importFeePartnersAdmin(req, res) {
  try {
    if (!pool) return json(res, 503, { ok: false, error: "Database unavailable" });
    if (req.method === "GET") {
      const principal = await requireDashboardPermission(req, res, "finance.view");
      if (!principal) return;
      const [partners, changes] = await Promise.all([
        listPartners(pool),
        listPartnerAudit(pool).catch((error) => (error?.code === "42P01" ? null : Promise.reject(error))),
      ]);
      return json(res, 200, { ok: true, partners, changes: changes || [], auditReady: changes !== null, updatedAt: new Date().toISOString() });
    }
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed" });
    const principal = await requireDashboardPermission(req, res, "finance.manage");
    if (!principal) return;
    if (!principal.email) return json(res, 401, { ok: false, error: "Your dashboard sign-in has no email.", code: "PARTNER_ACTOR_REQUIRED" });
    const body = (await readJson(req)) || {};
    const id = String(req.params?.id || "").trim();
    if (!id) return json(res, 201, { ok: true, partner: await createPartner(pool, body, actorOf(principal)) });
    return json(res, 200, { ok: true, partner: await updatePartner(pool, { id, chainId: req.params?.chainId, body }, actorOf(principal)) });
  } catch (error) {
    if (error instanceof PartnerAdminError) return json(res, error.status, { ok: false, error: error.message, code: error.code });
    if (error?.code === "42P01") return json(res, 503, { ok: false, error: "Partner tables are missing on this database.", code: "PARTNER_SCHEMA_MISSING" });
    console.error("[api/admin/importFeePartners]", error);
    return json(res, 500, { ok: false, error: "Partner request failed" });
  }
}
