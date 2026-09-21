/**
 * /api/admin/quote-catalog — Command Center "Graduation Markets".
 *
 *   GET  /chains                 chains with counts
 *   GET  ?chain=<key>            every deployment on a chain (any state) + RH stock registry rows
 *   GET  /:id                    deployment with policies, scans and decisions
 *   POST /                       add a candidate  { chain, providerKey, symbol, assetClass, category, contractAddressOrMint, decimals, reason, ... }
 *   POST /:id/approve            { expectedVersion, reason, policyOverrides?, evidence? }  (no overrides = verified proposal)
 *   POST /:id/suspend|reject|review  { expectedVersion, reason }
 *   POST /:id/verify             { autoActivate? }   automated verification of one entry
 *   POST /verify                 { chain, ids?, autoActivate? }   whole chain, paced
 */
import { getQuery, json, readJson } from "../../server/http.js";
import { requireDashboardAdmin } from "../dashboard/_auth.js";
import {
  QUOTE_CATALOG_ACTIONS,
  QuoteCatalogAdminError,
  createQuoteCatalogCandidate,
  decideQuoteCatalogDeployment,
  getQuoteCatalogAdminDetail,
  listQuoteCatalogAdmin,
  listQuoteCatalogChains,
} from "../lib/quoteAssetCatalogAdmin.js";
import { verifyQuoteCatalogChain, verifyQuoteCatalogDeployment } from "../lib/quoteAssetVerification.js";

function operatorIdentity(admin) {
  return `admin:${String(admin?.id || "unknown")}:${String(admin?.email || "").toLowerCase()}`;
}

function pathParts(req) {
  return String(req.path || req.url || "").split("?")[0].split("/").filter(Boolean);
}

export default async function quoteAssetCatalogAdmin(req, res) {
  try {
    const admin = await requireDashboardAdmin(req, res);
    if (!admin) return;
    const q = getQuery(req);
    const parts = pathParts(req);
    const tail = parts.at(-1) || "";
    const id = String(req.params?.id || "").trim();

    if (req.method === "GET") {
      if (!id && tail === "chains") return json(res, 200, { ok: true, chains: await listQuoteCatalogChains(), updatedAt: new Date().toISOString() });
      if (id) {
        const detail = await getQuoteCatalogAdminDetail(id);
        if (!detail) return json(res, 404, { ok: false, error: "Catalog entry not found", code: "QUOTE_CATALOG_ENTRY_NOT_FOUND" });
        return json(res, 200, { ok: true, ...detail, updatedAt: new Date().toISOString() });
      }
      const listed = await listQuoteCatalogAdmin({ chain: q.chain || q.chainId });
      return json(res, 200, { ok: true, ...listed, updatedAt: new Date().toISOString() });
    }

    if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed" });
    const body = await readJson(req);
    const actorIdentity = operatorIdentity(admin);

    if (!id && tail === "verify") {
      const summary = await verifyQuoteCatalogChain({
        chain: body?.chain || q.chain,
        ids: Array.isArray(body?.ids) && body.ids.length ? body.ids : null,
        autoActivate: body?.autoActivate !== false,
      });
      return json(res, 200, { ok: true, ...summary, actorIdentity });
    }
    if (!id) {
      const detail = await createQuoteCatalogCandidate(body, { actorIdentity });
      return json(res, 201, { ok: true, ...detail });
    }
    if (tail === "verify") {
      const detail = await verifyQuoteCatalogDeployment(id, { autoActivate: body?.autoActivate !== false, actorIdentity: `${operatorIdentity(admin)}|${"system:quote-verifier"}` });
      if (!detail) return json(res, 404, { ok: false, error: "Catalog entry not found", code: "QUOTE_CATALOG_ENTRY_NOT_FOUND" });
      return json(res, 200, { ok: true, ...detail });
    }
    if (!QUOTE_CATALOG_ACTIONS.includes(tail)) return json(res, 404, { ok: false, error: "Unknown catalog action", code: "QUOTE_CATALOG_ACTION_UNKNOWN" });
    const detail = await decideQuoteCatalogDeployment({
      id,
      action: tail,
      expectedVersion: body?.expectedVersion,
      reason: body?.reason,
      policyOverrides: body?.policyOverrides || {},
      evidence: body?.evidence || [],
      actorIdentity,
    });
    if (!detail) return json(res, 404, { ok: false, error: "Catalog entry not found", code: "QUOTE_CATALOG_ENTRY_NOT_FOUND" });
    return json(res, 200, { ok: true, ...detail });
  } catch (error) {
    if (error instanceof QuoteCatalogAdminError) {
      return json(res, error.httpStatus || 400, { ok: false, error: error.message, code: error.code, ...(error.current ? { current: error.current } : {}) });
    }
    console.error("[admin/quote-catalog]", error);
    return json(res, 500, { ok: false, error: "Quote catalog admin request failed", code: "QUOTE_CATALOG_ADMIN_INTERNAL_ERROR" });
  }
}
