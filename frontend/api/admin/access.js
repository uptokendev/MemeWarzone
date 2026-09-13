import { requireDashboardUser } from "../dashboard/_access.js";

function methodNotAllowed(res, allowed) {
  res.setHeader("Allow", allowed.join(", "));
  return res.status(405).json({ ok: false, error: "Method not allowed." });
}

export default async function dashboardAccess(req, res) {
  const pathname = new URL(req.originalUrl || req.url || "/", "http://localhost").pathname;

  if (pathname !== "/api/admin/access/me") {
    return res.status(404).json({ ok: false, error: "Unknown dashboard access route." });
  }

  if (String(req.method || "GET").toUpperCase() !== "GET") {
    return methodNotAllowed(res, ["GET"]);
  }

  try {
    const principal = await requireDashboardUser(req, res);
    if (!principal) return;

    return res.status(200).json({
      ok: true,
      user: {
        id: principal.authUserId,
        memberId: principal.memberId,
        email: principal.email,
        name: principal.displayName,
        role: principal.role,
      },
      status: principal.status,
      permissionsVersion: principal.permissionsVersion,
      permissions: principal.permissions,
      owner: principal.isOwner,
      breakGlass: principal.isBreakGlass,
    });
  } catch (error) {
    console.error("[dashboard-access] /me failed", error);
    return res.status(500).json({
      ok: false,
      code: "DASHBOARD_ACCESS_LOOKUP_FAILED",
      error: "Unable to resolve Command Center access.",
    });
  }
}
