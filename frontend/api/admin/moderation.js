// GET /api/admin/moderation/{airdrops|leagues|recruiters}[?format=csv][&includeTest=1][&modState=held|voided|released|none]
// GET /api/admin/moderation/log[?subject=<key>][&limit=][&before=]   moderation audit log (read permission)
// POST /api/admin/moderation/actions {subjectKind, subjectId, action: hold|release|void, reason}
//   community.manage or finance.manage (lib/moderationActions.js; enforcement in shared/moderationHolds.mjs)
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
// Every row carries `moderation` (its hold state, blanket holds that cover it, allowed actions).
// Actions never sign or move money and never touch a published root.

import { readJson } from "../../server/http.js";
import {
  MODERATION_MANAGE_PERMISSIONS,
  MODERATION_STATE_FILTERS,
  ModerationActionError,
  applyModerationAction,
  decorateModerationRows,
  listModerationLog,
  loadModerationState,
  moderationStateMatches,
  parseModerationAction,
} from "../lib/moderationActions.js";
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

export function createModerationHandler({ getDb, getActionDb = getDb, getPriceService, resolvePrincipal, can, now = () => new Date(), cacheMs = MODERATION_CACHE_MS, env = process.env } = {}) {
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

  async function handleAction(req, res, principal) {
    if (!MODERATION_MANAGE_PERMISSIONS.some((permission) => can(principal, permission))) {
      return res.status(403).json({ ok: false, code: "DASHBOARD_PERMISSION_REQUIRED", error: "Hold, release and void need community.manage or finance.manage.", permissions: MODERATION_MANAGE_PERMISSIONS });
    }
    const input = parseModerationAction(await readJson(req));
    if (input.error) return res.status(400).json({ ok: false, code: "INVALID_MODERATION_ACTION", error: input.error });
    try {
      const requestId = String(req.headers?.["x-request-id"] || "").trim() || null;
      const result = await applyModerationAction(await getActionDb(), { input, principal, requestId });
      if (!result.idempotent) cache = null; // a void changes the rows behind the lists
      res.setHeader?.("Cache-Control", "private, no-store");
      return res.status(200).json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof ModerationActionError) return res.status(error.status).json({ ok: false, code: error.code, error: error.message, ...error.extra });
      console.error("[admin/moderation action]", error);
      return res.status(500).json({ ok: false, error: "The moderation action failed. Nothing was changed." });
    }
  }

  async function handleLog(req, res, url) {
    const query = queryOf(req, url);
    try {
      const log = await listModerationLog(await getDb(), { subjectKey: String(query.subject || "").trim() || null, limit: query.limit, before: query.before });
      res.setHeader?.("Cache-Control", "private, no-store");
      return res.status(200).json({ ok: true, ...log });
    } catch (error) {
      console.error("[admin/moderation log]", error);
      return res.status(500).json({ ok: false, error: "The moderation log could not be read." });
    }
  }

  return async function moderationHandler(req, res) {
    const method = String(req.method || "GET").toUpperCase();
    const url = requestUrl(req);
    const { tab } = moderationTabFromPath(url.pathname);
    const isAction = tab === "actions";
    if (isAction ? method !== "POST" : method !== "GET" && method !== "HEAD") {
      res.setHeader?.("Allow", isAction ? "POST" : "GET, HEAD");
      return res.status(405).json({ ok: false, error: isAction ? "Moderation actions are POST." : "The moderation lists are read-only (GET); actions go to POST /api/admin/moderation/actions." });
    }
    const principal = await authorizeModeration(req, res, { resolvePrincipal, can });
    if (!principal) return;
    if (isAction) return handleAction(req, res, principal);
    if (tab === "log") return handleLog(req, res, url);
    if (!MODERATION_TABS.includes(tab)) {
      return res.status(404).json({ ok: false, error: "Unknown moderation list. Use airdrops, leagues or recruiters." });
    }
    const query = queryOf(req, url);
    const filters = parseModerationQuery(tab, query);
    if (filters.error) return res.status(400).json({ ok: false, error: filters.error });
    const modState = String(query.modState || "").trim().toLowerCase() || null;
    if (modState && !MODERATION_STATE_FILTERS.includes(modState)) return res.status(400).json({ ok: false, error: "modState must be held, voided, released or none." });

    let data;
    let cached;
    try {
      ({ data, cached } = await dataset());
    } catch (error) {
      console.error("[admin/moderation]", error);
      return res.status(500).json({ ok: false, error: "The moderation lists could not be read." });
    }
    let modStateData;
    try {
      modStateData = await loadModerationState(await getDb());
    } catch (error) {
      console.error("[admin/moderation state]", error);
      return res.status(500).json({ ok: false, error: "The moderation states could not be read." });
    }
    const decorated = decorateModerationRows(tab, data[tab] || [], modStateData).filter((row) => moderationStateMatches(row, modState));
    const includeEmail = can(principal, "community.view");
    const csv = String(query.format || "").toLowerCase() === "csv";
    const result = queryModerationTab({ ...data, [tab]: decorated }, tab, filters, { page: !csv });
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
      canManage: MODERATION_MANAGE_PERMISSIONS.some((permission) => can(principal, permission)),
      moderationAvailable: modStateData.available,
      filters: { ...filters, modState },
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
