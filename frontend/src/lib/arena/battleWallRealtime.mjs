import { wallTabForBattle } from "./battleWallPresentation.mjs";

export const WALL_REALTIME_CAP = 2;
export const WALL_VISIBLE_RATIO = 0.2;

export function isWallRealtimeEligible(battle) {
  return String(battle?.state || "").toLowerCase() === "live" && wallTabForBattle(battle) === "live";
}

export function classifyWallViewport(entry) {
  const ratio = Number(entry?.intersectionRatio);
  const intersecting = entry?.isIntersecting === true;
  const safeRatio = Number.isFinite(ratio) ? ratio : 0;
  if (!intersecting || safeRatio <= 0) return "offscreen";
  if (safeRatio >= WALL_VISIBLE_RATIO) return "visible";
  return "near";
}

export function viewportDistanceFromCenter(entry) {
  const root = entry?.rootBounds;
  const rect = entry?.boundingClientRect;
  if (!root || !rect) return Number.POSITIVE_INFINITY;
  const rootCenter = Number(root.top) + Number(root.height) / 2;
  const itemCenter = Number(rect.top) + Number(rect.height) / 2;
  if (![rootCenter, itemCenter].every(Number.isFinite)) return Number.POSITIVE_INFINITY;
  return Math.abs(itemCenter - rootCenter);
}

export function upsertWallViewportReport(reports, report) {
  const next = reports instanceof Map ? new Map(reports) : new Map();
  const id = String(report?.battleId || "").trim();
  if (!id) return next;
  if (report.visibility === "offscreen") {
    next.delete(id);
    return next;
  }
  next.set(id, {
    battleId: id,
    live: report.live === true,
    visibility: report.visibility || "offscreen",
    ratio: Number(report.ratio) || 0,
    distanceFromCenter: Number.isFinite(Number(report.distanceFromCenter))
      ? Number(report.distanceFromCenter)
      : Number.POSITIVE_INFINITY,
    index: Number.isFinite(Number(report.index)) ? Number(report.index) : Number.MAX_SAFE_INTEGER,
  });
  return next;
}

function compareWallRealtimeReports(left, right, focusedId) {
  const ratioDelta = (Number(right.ratio) || 0) - (Number(left.ratio) || 0);
  if (ratioDelta) return ratioDelta;
  const distanceDelta = (Number(left.distanceFromCenter) || 0) - (Number(right.distanceFromCenter) || 0);
  if (distanceDelta) return distanceDelta;
  if (focusedId) {
    if (left.battleId === focusedId && right.battleId !== focusedId) return -1;
    if (right.battleId === focusedId && left.battleId !== focusedId) return 1;
  }
  return (Number(left.index) || 0) - (Number(right.index) || 0);
}

export function selectActiveWallRealtimeIds(reports, options = {}) {
  const cap = Math.max(0, Number(options.cap ?? WALL_REALTIME_CAP) || WALL_REALTIME_CAP);
  const focusedId = String(options.focusedId || "").trim();
  const unique = new Map();
  for (const report of reports || []) {
    const id = String(report?.battleId || "").trim();
    if (!id) continue;
    unique.set(id, report);
  }
  const eligible = [...unique.values()].filter(
    (report) => report?.live === true && report?.visibility === "visible",
  );
  eligible.sort((left, right) => compareWallRealtimeReports(left, right, focusedId));
  return eligible.slice(0, cap).map((report) => String(report.battleId));
}

export function sameIdList(left, right) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  if (a.length !== b.length) return false;
  return a.every((id, index) => String(id) === String(b[index]));
}

export function isWallRealtimeActive(battleId, activeIds) {
  const id = String(battleId || "").trim();
  return Boolean(id) && (Array.isArray(activeIds) ? activeIds : []).some((item) => String(item) === id);
}

export function selectWallModuleMetrics({
  realtimeActive = false,
  snapshotReady = false,
  realtimeMetrics = undefined,
  retained = null,
  feedMetrics = undefined,
  feedRequested = false,
  feedLoaded = false,
} = {}) {
  if (realtimeActive && snapshotReady) {
    return { metrics: realtimeMetrics ?? null, source: "realtime", requested: true, loaded: true };
  }
  if (retained && Object.prototype.hasOwnProperty.call(retained, "value")) {
    return { metrics: retained.value ?? null, source: "retained", requested: true, loaded: true };
  }
  return {
    metrics: feedMetrics ?? null,
    source: "feed",
    requested: feedRequested === true,
    loaded: feedLoaded === true,
  };
}

export function retainWallRealtimeMetrics(previous, realtimeActive, snapshotReady, realtimeMetrics) {
  if (realtimeActive && snapshotReady) return { value: realtimeMetrics ?? null };
  return previous && Object.prototype.hasOwnProperty.call(previous, "value") ? previous : null;
}

export function shouldMountWallCombatEffects({ live = false, realtimeActive = false, snapshotReady = false } = {}) {
  return live === true && realtimeActive === true && snapshotReady === true;
}

export function wallEffectsScopeSelector(battleId) {
  const id = String(battleId || "").trim();
  return id ? `[data-battle-id="${id}"] [data-battle-combat-effects]` : "";
}
