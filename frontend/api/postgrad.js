import arenaBattles from "./arenaBattles.js";
import arenaBattleMetrics from "./arenaBattleMetrics.js";
import arenaEvents from "./arenaEvents.js";
import arenaImports from "./arenaImports.js";
import arenaTournaments from "./arenaTournaments.js";
import arenaLeague from "./arenaLeague.js";
import arenaNotifications from "./arenaNotifications.js";
import arenaVotes from "./arenaVotes.js";
import arenaOps from "./arenaOps.js";
import arenaWarPools from "./arenaWarPools.js";
import sponsored from "./sponsored.js";
import sponsorshipApplications from "./sponsorship-applications.js";
import sponsorshipPackages from "./sponsorship-packages.js";
import sponsorshipSettings from "./sponsorship-settings.js";
import warRoom from "./warRoom.js";

const ROUTES = [
  { pattern: /^\/arena\/ops\/health$/, flag: "POSTGRAD_ARENA_OPS_ENABLED", handler: arenaOps },
  { pattern: /^\/arena\/battle-metrics\/[^/]+$/, flag: "POSTGRAD_BATTLES_ENABLED", handler: arenaBattleMetrics },
  { pattern: /^\/arena\/battles(?:\/.*)?$/, flag: "POSTGRAD_BATTLES_ENABLED", handler: arenaBattles },
  { pattern: /^\/arena\/imports(?:\/.*)?$/, flag: "POSTGRAD_ARENA_IMPORTS_ENABLED", handler: arenaImports },
  { pattern: /^\/arena\/tournaments(?:\/.*)?$/, flag: "POSTGRAD_EVENTS_ENABLED", handler: arenaTournaments },
  { pattern: /^\/arena\/events(?:\/.*)?$/, flag: "POSTGRAD_EVENTS_ENABLED", handler: arenaEvents },
  { pattern: /^\/arena\/league(?:\/.*)?$/, flag: "POSTGRAD_LEAGUE_ENABLED", handler: arenaLeague },
  { pattern: /^\/arena\/notifications(?:\/.*)?$/, flag: "POSTGRAD_BATTLES_ENABLED", handler: arenaNotifications },
  { pattern: /^\/arena\/votes(?:\/.*)?$/, flag: "POSTGRAD_BATTLES_ENABLED", handler: arenaVotes },
  { pattern: /^\/arena\/war-pools(?:\/.*)?$/, flag: "POSTGRAD_WAR_POOLS_ENABLED", handler: arenaWarPools },
  // Sponsored product is independent of battles; keep available without battle flags.
  { pattern: /^\/sponsored$/, flag: "POSTGRAD_SPONSORSHIPS_ENABLED", handler: sponsored, alwaysOn: true },
  { pattern: /^\/sponsorship-applications$/, flag: "POSTGRAD_SPONSORSHIPS_ENABLED", handler: sponsorshipApplications, alwaysOn: true },
  { pattern: /^\/sponsorship-packages$/, flag: "POSTGRAD_SPONSORSHIPS_ENABLED", handler: sponsorshipPackages, alwaysOn: true },
  { pattern: /^\/sponsorship-settings$/, flag: "POSTGRAD_SPONSORSHIPS_ENABLED", handler: sponsorshipSettings, alwaysOn: true },
  {
    pattern: /^\/war-room(?:\/.*)?$/,
    flag: "WAR_ROOM_ENABLED",
    legacyFlag: "POSTGRAD_WAR_ROOM_ENABLED",
    handler: warRoom,
  },
];

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

function enabled(name) {
  return truthy(process.env[name]);
}

function routeEnabled(route) {
  if (route.alwaysOn) return true;
  return enabled(route.flag) || Boolean(route.legacyFlag && enabled(route.legacyFlag));
}

function routePath(req) {
  return String(req.path || new URL(req.url, "http://localhost").pathname);
}

function routeQuery(req) {
  return new URL(req.url, "http://localhost").searchParams;
}

function warRoomTestnetReadEnabled(req, path) {
  if (path !== "/war-room") return false;
  if (String(req.method || "GET").toUpperCase() !== "GET") return false;
  const query = routeQuery(req);
  return (
    truthy(query.get("includeTestnet")) ||
    truthy(query.get("testnet")) ||
    truthy(process.env.VITE_ENABLE_TESTNET_CAMPAIGNS) ||
    truthy(process.env.VITE_WAR_ROOM_INCLUDE_TESTNET) ||
    truthy(process.env.WAR_ROOM_INCLUDE_TESTNET)
  );
}

function disabledReadPayload(path, flag) {
  const base = {
    disabled: true,
    featureFlag: flag,
    warning: "Postgrad API route is disabled.",
  };

  if (path === "/arena/league") return { ...base, season: null, history: [] };
  if (path === "/arena/battles") return { ...base, liveBattles: [], openForBattleQueue: [], archivedBattles: [] };
  if (path === "/arena/battles/creator-status") return { ...base, items: [], statuses: [], updatedAt: new Date().toISOString() };
  if (/^\/arena\/battle-metrics\/[^/]+$/.test(path)) return { ...base, metrics: null, updatedAt: new Date().toISOString() };
  if (path === "/arena/imports") return { ...base, items: [], updatedAt: new Date().toISOString() };
  if (path === "/arena/events") return { ...base, events: [], archivedEvents: [] };
  if (path === "/arena/tournaments") return { ...base, events: [], archivedEvents: [] };
  if (path === "/arena/votes/featured") return { ...base, items: [], votingLive: false };
  if (path === "/arena/war-pools") {
    return {
      ...base,
      summary: { pools: [], totalPotUsd: 0, openPools: 0, lockedPools: 0, paidPools: 0 },
    };
  }
  if (/^\/arena\/war-pools\/[^/]+$/.test(path)) return { ...base, pool: null, settlementSummary: null };
  if (path === "/sponsored") return { ...base, items: [], updatedAt: new Date().toISOString() };
  if (path === "/sponsorship-applications") return { ...base, items: [], updatedAt: new Date().toISOString() };
  if (path === "/war-room") return { ...base, items: [], updatedAt: new Date().toISOString() };
  return { ...base, ok: false };
}

function isSafeDisabledRead(req, path) {
  const method = String(req.method || "GET").toUpperCase();
  if (method !== "GET") return false;
  return (
    path === "/arena/league" ||
    path === "/arena/battles" ||
    path === "/arena/battles/creator-status" ||
    /^\/arena\/battle-metrics\/[^/]+$/.test(path) ||
    path === "/arena/imports" ||
    path === "/arena/events" ||
    path === "/arena/tournaments" ||
    path === "/arena/votes/featured" ||
    path === "/arena/war-pools" ||
    /^\/arena\/war-pools\/[^/]+$/.test(path) ||
    path === "/sponsored" ||
    path === "/sponsorship-applications" ||
    path === "/war-room"
  );
}

export default async function handler(req, res) {
  const path = routePath(req);
  const route = ROUTES.find((candidate) => candidate.pattern.test(path));
  if (!route) return res.status(404).json({ error: `Unknown postgrad route: ${path}` });

  if (!routeEnabled(route)) {
    if (warRoomTestnetReadEnabled(req, path)) {
      return route.handler(req, res);
    }

    if (isSafeDisabledRead(req, path)) {
      return res.status(200).json(disabledReadPayload(path, route.flag));
    }

    return res.status(503).json({
      ok: false,
      error: "Postgrad API route is disabled",
      featureFlag: route.flag,
    });
  }

  return route.handler(req, res);
}
