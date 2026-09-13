import { pool } from "../../server/db.js";
import { requireDashboardPermission } from "../dashboard/_access.js";
import analyticsAdmin from "./admin.js";
import analyticsGeography from "./geography.js";
import {
  analyticsPerformanceEnvironment,
  analyticsPerformancePages,
  analyticsPerformanceVitals,
} from "./performance.js";

function parseWindow(req) {
  const fromRaw = String(req.query?.from || "").trim();
  const toRaw = String(req.query?.to || "").trim();
  const app = String(req.query?.app || "public").trim() || "public";
  const to = toRaw && !Number.isNaN(new Date(toRaw).getTime()) ? new Date(toRaw) : new Date();
  const from = fromRaw && !Number.isNaN(new Date(fromRaw).getTime())
    ? new Date(fromRaw)
    : new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString(), app };
}

function routeTail(req) {
  const path = String(req.originalUrl || req.url || "").split("?")[0];
  return path.replace(/^\/api\/admin\/analytics\/?/, "");
}

function isMissingSchema(error) {
  return error?.code === "42P01" || error?.code === "42703";
}

export default async function analyticsAdminEnhanced(req, res) {
  const tail = routeTail(req);
  const enhanced = new Set([
    "geography",
    "performance/vitals",
    "performance/pages",
    "performance/environment",
  ]);
  if (!enhanced.has(tail)) return analyticsAdmin(req, res);
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const principal = await requireDashboardPermission(req, res, "analytics.view");
  if (!principal) return;
  const { from, to, app } = parseWindow(req);

  try {
    if (tail === "geography") return res.status(200).json(await analyticsGeography({ pool, from, to, app }));
    if (tail === "performance/vitals") return res.status(200).json(await analyticsPerformanceVitals({ pool, from, to, app }));
    if (tail === "performance/pages") return res.status(200).json(await analyticsPerformancePages({ pool, from, to, app }));
    if (tail === "performance/environment") return res.status(200).json(await analyticsPerformanceEnvironment({ pool, from, to, app }));
  } catch (error) {
    if (isMissingSchema(error)) {
      return res.status(200).json({ schemaMissing: true, from, to, app, rows: [], countries: [], regions: [], coverage: { pageviews: 0, locatedPageviews: 0, rate: 0 } });
    }
    throw error;
  }

  return res.status(404).json({ error: "Unknown analytics route." });
}
