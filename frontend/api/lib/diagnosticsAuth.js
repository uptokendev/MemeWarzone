// Auth for /api/diagnostics.
//
// A request passes only when either:
//   - it comes from a Command Center user with diagnostics.view (the
//     railwayProxy gate puts the resolved principal on req.dashboardPrincipal;
//     entry points without that gate resolve the bearer here), or
//   - it carries DIAGNOSTICS_TOKEN (?token= or x-diagnostics-token) for
//     non-dashboard callers such as the standalone ?ui=1 page.
// Anything else is refused. An unset DIAGNOSTICS_TOKEN disables the token path.

import { timingSafeEqual } from "node:crypto";

export const DIAGNOSTICS_PERMISSION = "diagnostics.view";

function sameSecret(provided, expected) {
  const a = Buffer.from(String(provided || ""), "utf8");
  const b = Buffer.from(String(expected || ""), "utf8");
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function readDiagnosticsToken(req) {
  return String(req.query?.token || req.headers?.["x-diagnostics-token"] || "").trim();
}

export function diagnosticsTokenMatches(req) {
  return sameSecret(readDiagnosticsToken(req), String(process.env.DIAGNOSTICS_TOKEN || "").trim());
}

function hasBearer(req) {
  return /^Bearer\s+\S/i.test(String(req.headers?.authorization || "").trim());
}

function refuse(res, status, code, error) {
  if (!res.headersSent) res.status(status).json({ ok: false, error, permission: DIAGNOSTICS_PERMISSION, code });
  return null;
}

/**
 * Returns { mode: "dashboard", principal } or { mode: "token", token }, or null
 * after writing the refusal.
 */
export async function authorizeDiagnostics(req, res, { resolvePermission } = {}) {
  const gated = req.dashboardPrincipal;
  if (gated) {
    const { dashboardPrincipalCan } = await import("../dashboard/_access.js");
    if (dashboardPrincipalCan(gated, DIAGNOSTICS_PERMISSION)) return { mode: "dashboard", principal: gated };
    return refuse(res, 403, "DASHBOARD_PERMISSION_REQUIRED", "You do not have permission to access this Command Center section.");
  }

  if (diagnosticsTokenMatches(req)) return { mode: "token", token: readDiagnosticsToken(req) };

  if (hasBearer(req)) {
    const resolve = resolvePermission || (await import("../dashboard/_access.js")).requireDashboardPermission;
    const principal = await resolve(req, res, DIAGNOSTICS_PERMISSION);
    if (!principal) return null;
    req.dashboardPrincipal = principal;
    return { mode: "dashboard", principal };
  }

  return refuse(res, 401, "DASHBOARD_SIGN_IN_REQUIRED", `Dashboard sign-in with ${DIAGNOSTICS_PERMISSION} is required.`);
}
