const ADMIN_ROLES = new Set(["admin", "dashboard_admin"]);
const MASTER_ADMIN_ROLES = new Set(["master_admin", "founder"]);

function csvSet(name, { lower = false } = {}) {
  return new Set(
    String(process.env[name] || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => (lower ? value.toLowerCase() : value)),
  );
}

export function dashboardBearerToken(req) {
  const header = String(req.headers?.authorization || "").trim();
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

export function dashboardAppMetadataRoles(user) {
  const metadata = user?.app_metadata && typeof user.app_metadata === "object"
    ? user.app_metadata
    : {};
  const roles = new Set();

  if (typeof metadata.role === "string") roles.add(metadata.role.toLowerCase());
  if (Array.isArray(metadata.roles)) {
    for (const role of metadata.roles) {
      if (typeof role === "string") roles.add(role.toLowerCase());
    }
  }

  return roles;
}

/**
 * Which Supabase Auth issues Command Center sessions. Normally the service's
 * own project (SUPABASE_URL). A test deployment whose data lives on the
 * staging project can still accept sessions from production Auth (where the
 * dashboard users exist) by setting DASHBOARD_AUTH_SUPABASE_URL and
 * DASHBOARD_AUTH_SUPABASE_ANON_KEY; only session validation uses them, every
 * data and storage call keeps SUPABASE_URL.
 */
export function dashboardAuthProject() {
  const supabaseUrl = String(process.env.DASHBOARD_AUTH_SUPABASE_URL || process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const anonKey = String(process.env.DASHBOARD_AUTH_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "").trim();
  return { supabaseUrl, anonKey };
}

function authFailure(message, code, status = 502) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

/** Project ref of the Auth the dashboard sessions are validated against; for /health. */
export function dashboardAuthProjectRef() {
  try {
    return new URL(dashboardAuthProject().supabaseUrl).hostname.split(".")[0] || "unset";
  } catch {
    return "unparsed";
  }
}

export async function fetchDashboardSupabaseUser(accessToken) {
  const { supabaseUrl, anonKey } = dashboardAuthProject();

  if (!supabaseUrl || !anonKey) {
    throw authFailure(
      "SUPABASE_URL and SUPABASE_ANON_KEY (or DASHBOARD_AUTH_SUPABASE_URL / DASHBOARD_AUTH_SUPABASE_ANON_KEY) are required for dashboard authorization.",
      "DASHBOARD_AUTH_NOT_CONFIGURED",
      500,
    );
  }
  let host;
  try {
    host = new URL(supabaseUrl).host;
  } catch {
    throw authFailure(
      `Dashboard auth Supabase URL is not a valid URL (${supabaseUrl.slice(0, 60)}); set DASHBOARD_AUTH_SUPABASE_URL or SUPABASE_URL to https://<project-ref>.supabase.co.`,
      "DASHBOARD_AUTH_URL_INVALID",
      500,
    );
  }

  let response;
  try {
    response = await fetch(`${supabaseUrl}/auth/v1/user`, {
      method: "GET",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${accessToken}`,
      },
      cache: "no-store",
    });
  } catch (error) {
    console.error("[dashboard-auth] Supabase Auth unreachable", { host, error: String(error?.message || error) });
    throw authFailure(`Supabase Auth at ${host} is unreachable from the API: ${String(error?.message || error).slice(0, 160)}`, "DASHBOARD_AUTH_UPSTREAM_UNREACHABLE");
  }

  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.error("[dashboard-auth] Supabase Auth rejected the validation call", { host, status: response.status, body: body.slice(0, 200) });
    throw authFailure(`Supabase user validation failed (${response.status}) at ${host}: ${body.slice(0, 200)}`, "DASHBOARD_AUTH_UPSTREAM_FAILED");
  }

  return await response.json();
}

function approvedAdminMatch(user) {
  const approvedIds = csvSet("DASHBOARD_ADMIN_USER_IDS");
  const approvedEmails = csvSet("DASHBOARD_ADMIN_EMAILS", { lower: true });
  const userId = String(user?.id || "").trim();
  const email = String(user?.email || "").trim().toLowerCase();
  return Boolean((userId && approvedIds.has(userId)) || (email && approvedEmails.has(email)));
}

export function isApprovedDashboardAdmin(user) {
  if (approvedAdminMatch(user)) return true;
  const roles = dashboardAppMetadataRoles(user);
  return Array.from(roles).some((role) => ADMIN_ROLES.has(role) || MASTER_ADMIN_ROLES.has(role));
}

export function isDashboardMasterAdmin(user) {
  const masterIds = csvSet("DASHBOARD_MASTER_ADMIN_USER_IDS");
  const masterEmails = csvSet("DASHBOARD_MASTER_ADMIN_EMAILS", { lower: true });
  const userId = String(user?.id || "").trim();
  const email = String(user?.email || "").trim().toLowerCase();
  const roles = dashboardAppMetadataRoles(user);

  if (Array.from(roles).some((role) => MASTER_ADMIN_ROLES.has(role))) return true;
  if ((userId && masterIds.has(userId)) || (email && masterEmails.has(email))) return true;

  // Backwards-compatible owner setup. Once explicit master allowlists are configured,
  // the generic admin allowlist stops acting as break-glass owner authority.
  if (masterIds.size === 0 && masterEmails.size === 0) return approvedAdminMatch(user);
  return false;
}

export async function getDashboardAuthIdentity(req, res) {
  const token = dashboardBearerToken(req);
  if (!token) {
    res.status(401).json({ ok: false, error: "Supabase access token required." });
    return null;
  }

  const user = await fetchDashboardSupabaseUser(token);
  if (!user) {
    res.status(401).json({ ok: false, error: "Invalid or expired Supabase session." });
    return null;
  }

  return {
    id: String(user.id),
    email: String(user.email || "").trim().toLowerCase(),
    roles: Array.from(dashboardAppMetadataRoles(user)),
    isApprovedAdmin: isApprovedDashboardAdmin(user),
    isMasterAdmin: isDashboardMasterAdmin(user),
    rawUser: user,
  };
}

export async function requireDashboardAdmin(req, res) {
  const identity = await getDashboardAuthIdentity(req, res);
  if (!identity) return null;

  if (!identity.isApprovedAdmin) {
    res.status(403).json({ ok: false, error: "Dashboard administrator access required." });
    return null;
  }

  return {
    id: identity.id,
    email: identity.email,
    roles: identity.roles,
    isMasterAdmin: identity.isMasterAdmin,
  };
}
