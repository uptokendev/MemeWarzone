/**
 * Shared API auth helpers for MemeWarzone frontend-api gateway.
 * Dual-auth: when enforce flags are off, privileged routes still accept legacy
 * unauthenticated callers (log via console.warn). When enforce is on, fail closed.
 *
 * Go-live defaults (production / Railway):
 *   Unset flags default to ON so open legacy paths are not accidental.
 *   Explicit 0/false/off still disables a single class for rollback.
 */

import { requireDashboardAdmin } from "../dashboard/_auth.js";

function isProductionLike() {
  const nodeEnv = String(process.env.NODE_ENV || "").trim().toLowerCase();
  if (nodeEnv === "production") return true;
  // Railway always injects these; treat as production-like for enforce defaults.
  if (String(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || "").trim()) return true;
  return ["1", "true", "yes", "on"].includes(String(process.env.API_AUTH_ENFORCE_DEFAULT || "").trim().toLowerCase());
}

function parseBoolEnv(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const v = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return null;
}

/** @returns {boolean} explicit value, else production-like default ON */
function enforceFlag(name) {
  const parsed = parseBoolEnv(name);
  if (parsed !== null) return parsed;
  return isProductionLike();
}

function truthyEnv(name) {
  return parseBoolEnv(name) === true;
}

export function isAuthEnforceInternal() {
  return enforceFlag("API_AUTH_ENFORCE_INTERNAL");
}

export function isAuthEnforceSecurityMutations() {
  return enforceFlag("API_AUTH_ENFORCE_SECURITY_MUTATIONS");
}

export function isAuthEnforceUserWrites() {
  return enforceFlag("API_AUTH_ENFORCE_USER_WRITES");
}

export function isAuthEnforceArenaMutations() {
  return enforceFlag("API_AUTH_ENFORCE_ARENA_MUTATIONS");
}

/** Snapshot for boot logs / diagnostics. */
export function getAuthEnforceSnapshot() {
  return {
    productionLike: isProductionLike(),
    defaultWhenUnset: isProductionLike() ? "on" : "off",
    INTERNAL: isAuthEnforceInternal(),
    SECURITY_MUTATIONS: isAuthEnforceSecurityMutations(),
    USER_WRITES: isAuthEnforceUserWrites(),
    ARENA_MUTATIONS: isAuthEnforceArenaMutations(),
    raw: {
      API_AUTH_ENFORCE_INTERNAL: process.env.API_AUTH_ENFORCE_INTERNAL ?? "(unset)",
      API_AUTH_ENFORCE_SECURITY_MUTATIONS: process.env.API_AUTH_ENFORCE_SECURITY_MUTATIONS ?? "(unset)",
      API_AUTH_ENFORCE_USER_WRITES: process.env.API_AUTH_ENFORCE_USER_WRITES ?? "(unset)",
      API_AUTH_ENFORCE_ARENA_MUTATIONS: process.env.API_AUTH_ENFORCE_ARENA_MUTATIONS ?? "(unset)",
    },
  };
}

export function readBearerToken(req) {
  const header = String(req.headers?.authorization || "").trim();
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return "";
}

export function readInternalToken(req) {
  return (
    readBearerToken(req) ||
    String(req.headers?.["x-rank-events-token"] || "").trim() ||
    String(req.headers?.["x-internal-token"] || "").trim()
  );
}

export function getExpectedInternalToken() {
  return String(process.env.RANK_EVENTS_TOKEN || process.env.INTERNAL_API_TOKEN || "").trim();
}

export function readOpsKey(req) {
  const q = req.query || {};
  return String(req.headers?.["x-ops-key"] || q.opsKey || "").trim();
}

export function getExpectedOpsKey() {
  return String(process.env.DASHBOARD_OPS_KEY || process.env.OPS_READ_KEY || "").trim();
}

/**
 * Internal / service-to-service auth (indexer parity).
 * @returns {boolean} true if request may proceed
 */
export function requireInternalAuth(req, res, { routeLabel = "internal" } = {}) {
  const expected = getExpectedInternalToken();
  const provided = readInternalToken(req);
  const enforce = isAuthEnforceInternal();

  if (!expected) {
    if (enforce) {
      res.status(503).json({
        ok: false,
        error: "Internal endpoints are disabled: RANK_EVENTS_TOKEN / INTERNAL_API_TOKEN missing",
        code: "INTERNAL_AUTH_NOT_CONFIGURED",
      });
      return false;
    }
    console.warn(`[apiAuth] ${routeLabel}: internal token unset; allowing legacy unauth (enforce off)`);
    return true;
  }

  if (provided && provided === expected) return true;

  if (!enforce) {
    console.warn(`[apiAuth] ${routeLabel}: missing/invalid internal token; allowing legacy unauth (enforce off)`);
    return true;
  }

  res.status(401).json({ ok: false, error: "Unauthorized", code: "INTERNAL_AUTH_REQUIRED" });
  return false;
}

/**
 * Dashboard admin Bearer and/or shared ops key.
 * A route that has already performed capability authorization may place the
 * resulting principal on req.dashboardPrincipal; this avoids reinterpreting
 * a DB-authorized member as a legacy app-metadata admin.
 * @returns {Promise<object|null>} admin context or ops context, or null after response sent
 */
export async function requireAdminOrOps(req, res, { routeLabel = "admin", allowOps = true } = {}) {
  if (req.dashboardPrincipal) {
    return { mode: "dashboard-permission", principal: req.dashboardPrincipal };
  }

  const enforce = isAuthEnforceSecurityMutations();
  const opsExpected = getExpectedOpsKey();
  const opsProvided = readOpsKey(req);

  if (allowOps && opsExpected && opsProvided && opsProvided === opsExpected) {
    return { mode: "ops-key" };
  }

  const token = readBearerToken(req);
  if (token) {
    const admin = await requireDashboardAdmin(req, res);
    // requireDashboardAdmin already wrote 401/403 when invalid
    if (admin) return { mode: "admin", admin };
    return null;
  }

  if (!enforce) {
    console.warn(`[apiAuth] ${routeLabel}: no admin/ops auth; allowing legacy unauth (enforce off)`);
    return { mode: "legacy-open" };
  }

  if (!res.headersSent) {
    res.status(401).json({
      ok: false,
      error: "Dashboard administrator access or ops key required.",
      code: "ADMIN_OR_OPS_REQUIRED",
    });
  }
  return null;
}

/**
 * Wrap an Express-style async handler with internal auth.
 */
export function withInternalAuth(handler, routeLabel) {
  return async function internalAuthWrapped(req, res, next) {
    try {
      if (!requireInternalAuth(req, res, { routeLabel: routeLabel || req.path })) return;
      return await handler(req, res, next);
    } catch (error) {
      if (typeof next === "function") return next(error);
      console.error(`[apiAuth] ${routeLabel || req.path}`, error);
      if (!res.headersSent) res.status(500).json({ ok: false, error: "Server error" });
    }
  };
}

/**
 * Wrap handler with admin/ops auth (for security mutations & sensitive admin GETs).
 */
export function withAdminOrOps(handler, routeLabel, options = {}) {
  return async function adminOrOpsWrapped(req, res, next) {
    try {
      const auth = await requireAdminOrOps(req, res, { routeLabel: routeLabel || req.path, ...options });
      if (!auth) return;
      req.apiAuth = auth;
      return await handler(req, res, next);
    } catch (error) {
      if (typeof next === "function") return next(error);
      console.error(`[apiAuth] ${routeLabel || req.path}`, error);
      if (!res.headersSent) res.status(500).json({ ok: false, error: "Server error" });
    }
  };
}
