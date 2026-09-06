import { getQuery, json, readJson } from "../../server/http.js";
import { requireDashboardAdmin } from "../dashboard/_auth.js";
import {
  RegistryVersionConflictError,
  getRobinhoodStockRegistryDetail,
  listRobinhoodStockRegistry,
  refreshAllRobinhoodStockHealth,
  refreshRobinhoodStockHealthById,
  setRobinhoodStockAdminState,
  syncCanonicalRobinhoodStockTokens,
} from "../lib/robinhoodStockGraduationRegistry.js";

function operatorIdentity(admin) {
  return `admin:${String(admin?.id || "unknown")}:${String(admin?.email || "").toLowerCase()}`;
}

function requireExpectedVersion(body, res) {
  const value = Number(body?.expectedVersion);
  if (!Number.isInteger(value) || value < 1) {
    json(res, 400, { ok: false, error: "expectedVersion is required", code: "EXPECTED_VERSION_REQUIRED" });
    return null;
  }
  return value;
}

function requiredReason(body, res) {
  const reason = String(body?.reason || "").trim();
  if (!reason) {
    json(res, 400, { ok: false, error: "reason is required", code: "REASON_REQUIRED" });
    return null;
  }
  return reason;
}

function actionFromPath(req) {
  const parts = String(req.path || req.url || "").split("?")[0].split("/").filter(Boolean);
  return parts.at(-1) || "";
}

export default async function robinhoodStockGraduationRegistryAdmin(req, res) {
  try {
    const admin = await requireDashboardAdmin(req, res);
    if (!admin) return;

    const q = getQuery(req);
    const id = String(req.params?.id || q.id || "").trim();
    const action = actionFromPath(req);

    if (req.method === "GET") {
      if (id) {
        const detail = await getRobinhoodStockRegistryDetail(id);
        if (!detail) return json(res, 404, { ok: false, error: "Stock Token registry entry not found", code: "REGISTRY_ENTRY_NOT_FOUND" });
        return json(res, 200, { ok: true, ...detail });
      }
      const items = await listRobinhoodStockRegistry();
      return json(res, 200, { ok: true, items, updatedAt: new Date().toISOString() });
    }

    if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed" });
    const body = await readJson(req);
    const operator = operatorIdentity(admin);

    if (!id && action === "sync") {
      const reason = requiredReason(body, res);
      if (!reason) return;
      const sync = await syncCanonicalRobinhoodStockTokens({ operatorIdentity: operator });
      const items = await refreshAllRobinhoodStockHealth();
      return json(res, 200, { ok: true, sync, rescanned: items.length, items });
    }

    if (!id && action === "rescan") {
      const reason = requiredReason(body, res);
      if (!reason) return;
      const items = await refreshAllRobinhoodStockHealth();
      return json(res, 200, { ok: true, rescanned: items.length, items });
    }

    if (!id) return json(res, 400, { ok: false, error: "Registry id is required", code: "REGISTRY_ID_REQUIRED" });
    const expectedVersion = requireExpectedVersion(body, res);
    if (expectedVersion == null) return;

    if (action === "rescan") {
      const item = await refreshRobinhoodStockHealthById(id, { expectedVersion, operatorIdentity: operator });
      if (!item) return json(res, 404, { ok: false, error: "Stock Token registry entry not found", code: "REGISTRY_ENTRY_NOT_FOUND" });
      const detail = await getRobinhoodStockRegistryDetail(id);
      return json(res, 200, { ok: true, ...detail });
    }

    if (action === "enable" || action === "disable" || action === "clear-override") {
      const reason = action === "clear-override" ? String(body.reason || "").trim() : requiredReason(body, res);
      if (action !== "clear-override" && !reason) return;
      const nextState = action === "enable" ? "force_enabled" : action === "disable" ? "force_disabled" : "default";
      const result = await setRobinhoodStockAdminState({ id, adminState: nextState, expectedVersion, reason, operatorIdentity: operator });
      if (!result) return json(res, 404, { ok: false, error: "Stock Token registry entry not found", code: "REGISTRY_ENTRY_NOT_FOUND" });
      const detail = await getRobinhoodStockRegistryDetail(id);
      return json(res, 200, { ok: true, ...detail });
    }

    return json(res, 404, { ok: false, error: "Unknown Robinhood Stock Token registry action", code: "REGISTRY_ACTION_NOT_FOUND" });
  } catch (error) {
    if (error instanceof RegistryVersionConflictError) {
      return json(res, 409, { ok: false, error: error.message, code: "STATE_VERSION_CONFLICT", current: error.current });
    }
    console.error("[admin/robinhood/stock-graduation-registry]", error);
    return json(res, 503, { ok: false, error: String(error?.message || error), code: "ROBINHOOD_STOCK_REGISTRY_ADMIN_FAILED" });
  }
}
