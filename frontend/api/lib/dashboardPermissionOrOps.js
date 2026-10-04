// Fail-closed auth for dashboard routes (Reward Ops, recruiter payouts, Security).
//
// A request passes only when either:
//   - the railwayProxy capability gate already resolved a dashboard principal
//     (req.dashboardPrincipal) that holds the permission for this method, or
//   - it carries the server-to-server ops key (x-ops-key / DASHBOARD_OPS_KEY).
// Anything else is refused with 401/403, whatever API_AUTH_ENFORCE_* says, so
// these routes never fall back to the legacy no-auth path.

import { timingSafeEqual } from "node:crypto";
import { dashboardPrincipalAsAdmin, getExpectedOpsKey, readOpsKey } from "./apiAuth.js";
import { dashboardPrincipalCan } from "../dashboard/_access.js";

function sameSecret(provided, expected) {
  const a = Buffer.from(String(provided || ""), "utf8");
  const b = Buffer.from(String(expected || ""), "utf8");
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** True only when an ops key is configured and the request carries exactly it. */
export function opsKeyMatches(req) {
  return sameSecret(readOpsKey(req), getExpectedOpsKey());
}

export function permissionForMethod(method, { read, write }) {
  const verb = String(method || "GET").toUpperCase();
  return verb === "GET" || verb === "HEAD" ? read : write;
}

/**
 * Returns the auth context ({ mode: "admin", principal, admin } or { mode: "ops-key" })
 * or null after writing the refusal.
 */
export function requireDashboardPermissionOrOpsKey(req, res, permission) {
  const principal = req.dashboardPrincipal;
  if (principal) {
    if (dashboardPrincipalCan(principal, permission)) {
      // `admin` mirrors requireAdminOrOps so handlers that record the acting
      // admin (security_actions.admin_email) keep seeing the signed-in email.
      return { mode: "admin", principal, admin: dashboardPrincipalAsAdmin(principal), authorizationSource: "dashboard-permission" };
    }
    if (!res.headersSent) {
      res.status(403).json({ ok: false, error: "You do not have permission to access this Command Center section.", permission, code: "DASHBOARD_PERMISSION_REQUIRED" });
    }
    return null;
  }

  if (opsKeyMatches(req)) return { mode: "ops-key" };

  if (!res.headersSent) {
    res.status(401).json({ ok: false, error: `Dashboard sign-in with ${permission} is required.`, permission, code: "DASHBOARD_SIGN_IN_REQUIRED" });
  }
  return null;
}

export function withDashboardPermissionOrOpsKey(handler, routeLabel, permissions) {
  return async function dashboardPermissionOrOpsWrapped(req, res, next) {
    try {
      const auth = requireDashboardPermissionOrOpsKey(req, res, permissionForMethod(req.method, permissions));
      if (!auth) return;
      req.apiAuth = auth;
      return await handler(req, res, next);
    } catch (error) {
      if (typeof next === "function") return next(error);
      console.error(`[dashboardPermissionOrOps] ${routeLabel || req.path}`, error);
      if (!res.headersSent) res.status(500).json({ ok: false, error: "Server error" });
    }
  };
}
