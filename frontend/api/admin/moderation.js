// GET /api/admin/moderation/{airdrops|leagues|recruiters}[?format=csv][&includeTest=1]
//
// Test and internal rows (hidden test coins, owner wallets, test recruiters,
// voided rows) are left out unless includeTest=1; `testHidden` counts them.
// The CSV follows the same switch.
//
// Command Center moderation lists (read-only): airdrop winners, league
// winners and recruiters on the mainnets, with moderation flags. Readable with
// community.view or finance.view (existing capabilities, none added).
// Recruiter emails are included only for community.view, the permission that
// already returns recruiter sign-up metadata on /api/dashboard/recruiters.
//
// GET only. No payout, void or hold action lives here.

import { buildModerationDataset, moderationCsv, MODERATION_FLAGS, MODERATION_TABS, MODERATION_CHAINS, parseModerationQuery, queryModerationTab, TEST_DATA_REASONS } from "../lib/moderationLists.js";

export const MODERATION_READ_PERMISSIONS = Object.freeze(["community.view", "finance.view"]);
export const MODERATION_CACHE_MS = 60_000;

const PATH = /^\/api\/admin\/moderation(?:\/([a-z]+))?\/?$/;

export function moderationTabFromPath(pathname) {
  const match = String(pathname || "").match(PATH);
  if (!match) return { matched: false, tab: null };
  return { matched: true, tab: match[1] || null };
}

function requestUrl(req) {
  const raw = String(req.originalUrl || req.url || "/").replace(/^\/\.netlify\/functions\/api(?=\/|$)/, "");
  try {
    return new URL(raw, "http://localhost");
  } catch {
    return new URL("/", "http://localhost");
  }
}

function queryOf(req, url) {
  if (req.query && typeof req.query === "object" && Object.keys(req.query).length > 0) return req.query;
  return Object.fromEntries(url.searchParams.entries());
}

/**
 * Principal with community.view or finance.view, or null after the refusal.
 * `resolvePrincipal` is injected in tests; in the API it is getDashboardPrincipal.
 */
export async function authorizeModeration(req, res, { resolvePrincipal, can }) {
  const authorization = String(req.headers?.authorization || "").trim();
  if (!req.dashboardPrincipal && !/^Bearer\s+/i.test(authorization)) {
    res.status(401).json({ ok: false, code: "DASHBOARD_SIGN_IN_REQUIRED", error: "Dashboard sign-in with community.view or finance.view is required.", permissions: MODERATION_READ_PERMISSIONS });
    return null;
  }
  const principal = req.dashboardPrincipal || (await resolvePrincipal(req, res));
  if (!principal) return null;
  if (!MODERATION_READ_PERMISSIONS.some((permission) => can(principal, permission))) {
    res.status(403).json({ ok: false, code: "DASHBOARD_PERMISSION_REQUIRED", error: "You do not have permission to access this Command Center section.", permissions: MODERATION_READ_PERMISSIONS });
    return null;
  }
  return principal;
}

function withoutEmail(row) {
  if (!("email" in row)) return row;
  const { email: _email, ...rest } = row;
  return rest;
}

export function createModerationHandler({ getDb, getPriceService, resolvePrincipal, can, now = () => new Date(), cacheMs = MODERATION_CACHE_MS, env = process.env } = {}) {
  let cache = null;

  async function dataset() {
    const at = now().getTime();
    if (cache && cache.data && at - cache.at < cacheMs) return { data: cache.data, cached: true };
    if (cache?.promise) return { data: await cache.promise, cached: true };
    const promise = (async () => buildModerationDataset({ db: await getDb(), priceService: await getPriceService(), now: new Date(at).toISOString(), env }))();
    cache = { at, promise, data: cache?.data || null };
    try {
      const data = await promise;
      cache = { at, data, promise: null };
      return { data, cached: false };
    } catch (error) {
      cache = null;
      throw error;
    }
  }

  return async function moderationHandler(req, res) {
    const method = String(req.method || "GET").toUpperCase();
    const url = requestUrl(req);
    const { tab } = moderationTabFromPath(url.pathname);
    if (method !== "GET" && method !== "HEAD") {
      res.setHeader?.("Allow", "GET, HEAD");
      return res.status(405).json({ ok: false, error: "The moderation lists are read-only (GET)." });
    }
    const principal = await authorizeModeration(req, res, { resolvePrincipal, can });
    if (!principal) return;
    if (!MODERATION_TABS.includes(tab)) {
      return res.status(404).json({ ok: false, error: "Unknown moderation list. Use airdrops, leagues or recruiters." });
    }
    const query = queryOf(req, url);
    const filters = parseModerationQuery(tab, query);
    if (filters.error) return res.status(400).json({ ok: false, error: filters.error });

    let data;
    let cached;
    try {
      ({ data, cached } = await dataset());
    } catch (error) {
      console.error("[admin/moderation]", error);
      return res.status(500).json({ ok: false, error: "The moderation lists could not be read." });
    }
    const includeEmail = can(principal, "community.view");
    const csv = String(query.format || "").toLowerCase() === "csv";
    const result = queryModerationTab(data, tab, filters, { page: !csv });
    const rows = includeEmail ? result.rows : result.rows.map(withoutEmail);

    res.setHeader?.("Cache-Control", "private, no-store");
    if (csv) {
      const body = moderationCsv(tab, rows, { includeEmail });
      res.setHeader?.("Content-Type", "text/csv; charset=utf-8");
      res.setHeader?.("Content-Disposition", `attachment; filename="moderation-${tab}-${data.generatedAt.slice(0, 10)}.csv"`);
      res.status(200);
      return typeof res.send === "function" ? res.send(body) : res.end(body);
    }
    return res.status(200).json({
      ok: true,
      tab,
      generatedAt: data.generatedAt,
      cached,
      cacheSeconds: Math.round(cacheMs / 1000),
      chains: MODERATION_CHAINS.map(({ chainId, label, asset }) => ({ chainId, label, asset })),
      flagDefinitions: MODERATION_FLAGS,
      testReasonLabels: TEST_DATA_REASONS,
      emailVisible: includeEmail,
      filters: { ...filters },
      ...result,
      rows,
      notes: data.notes,
      internalWallets: data.internalWallets,
    });
  };
}

let defaultHandler = null;

export default async function adminModeration(req, res) {
  if (!defaultHandler) {
    const access = await import("../dashboard/_access.js");
    defaultHandler = createModerationHandler({
      getDb: async () => (await import("../../server/db.js")).pool,
      getPriceService: async () => (await import("../lib/financePrices.js")).defaultPriceService(),
      resolvePrincipal: access.getDashboardPrincipal,
      can: access.dashboardPrincipalCan,
    });
  }
  return defaultHandler(req, res);
}
