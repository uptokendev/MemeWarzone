/**
 * GET /api/admin/widget/usage?from&to&chainId?&partner?  (Command Center Analytics, "Swap widget")
 *
 * Daily swap widget usage per event, the funnel load -> quote -> build -> landed, by chain, by partner and the top
 * websites (api/lib/widgetAnalytics.js buildWidgetUsage). Read-only. Bearer only with finance.view, like the finance
 * reads: the dashboard gate in server/railwayProxy.js resolves the principal; ops keys and requests without a
 * dashboard sign-in are refused. partner=none selects the swaps without a partner.
 */
import { pool } from "../../server/db.js";
import { dashboardPrincipalCan } from "../dashboard/_access.js";
import { WidgetQueryError, buildWidgetUsage, usageChainFilter, usagePartnerFilter, widgetWindow } from "../lib/widgetAnalytics.js";

export async function widgetUsage(req, res, { db = pool, build = buildWidgetUsage } = {}) {
  const method = String(req.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Widget usage is read-only (GET)." });
  }
  if (!req.dashboardPrincipal || !dashboardPrincipalCan(req.dashboardPrincipal, "finance.view")) {
    return res.status(401).json({ ok: false, error: "Dashboard sign-in with finance.view is required.", code: "FINANCE_VIEW_REQUIRED" });
  }
  let input;
  try {
    input = { ...widgetWindow(req.query || {}), chainId: usageChainFilter(req.query?.chainId), partner: usagePartnerFilter(req.query?.partner) };
  } catch (error) {
    if (error instanceof WidgetQueryError) return res.status(400).json({ ok: false, error: error.message });
    throw error;
  }
  try {
    const payload = await build({ db, ...input });
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(payload);
  } catch (error) {
    console.error("[api/admin/widget/usage]", error);
    return res.status(500).json({ ok: false, error: "Widget usage read failed." });
  }
}

export default async function widgetAdmin(req, res) {
  const routePath = String(req.path || new URL(req.url, "http://localhost").pathname).replace(/\/+$/, "");
  if (routePath === "/api/admin/widget/usage") return widgetUsage(req, res);
  return res.status(404).json({ ok: false, error: "Unknown widget admin route." });
}
