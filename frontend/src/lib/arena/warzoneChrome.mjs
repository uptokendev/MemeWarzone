export const WARZONE_CONTENT_MAX_WIDTH_PX = 1280;
export const WARZONE_CONTENT_MAX_CLASS = "max-w-[1280px]";

// Keep QF presentation rules in the client bundle. Importing frontend/api/lib
// becomes `/api/lib/...` in Vite dev, which the API proxy 404s and blanks Warzone.
const QF_MIN_FIGHTS = 3;
const QF_SEED_SIZE = 8;

function canonicalTokenKey(value) {
  const raw = String(value || "").trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(raw)) return raw.toLowerCase();
  return raw;
}

function quarterFinalSeeds(entries) {
  return [...(entries || [])]
    .filter((entry) => Number(entry.finishedFights ?? entry.finished_fights ?? 0) >= QF_MIN_FIGHTS)
    .sort((left, right) => Number(right.points || 0) - Number(left.points || 0) || Number(right.wins || 0) - Number(left.wins || 0))
    .slice(0, QF_SEED_SIZE);
}

export function presentWarzoneFeedTone(source) {
  const value = String(source || "");
  if (value === "api") return { label: "LIVE DATA", tone: "success" };
  if (value === "empty") return { label: "FEED UNAVAILABLE", tone: "default" };
  return { label: "AWAITING DATA", tone: "default" };
}

export function presentWarzoneCommandStrip({ liveBattleCount = 0, liveTournamentCount = 0, season } = {}) {
  return {
    liveBattleCount: Math.max(0, Number(liveBattleCount) || 0),
    liveTournamentCount: Math.max(0, Number(liveTournamentCount) || 0),
    week: Number(season?.week) > 0 ? Number(season.week) : null,
    seasonLabel: String(season?.label || "").trim() || null,
  };
}

export const MWL_PUBLIC_TABLE_START = 4;
export const MWL_PUBLIC_TABLE_END = 10;

export function tokenIdentityKey(value) {
  return canonicalTokenKey(value);
}

export function presentRankedLeagueEntries(entries) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  const ranked = list.every((entry) => Number.isFinite(Number(entry.rank)) && Number(entry.rank) > 0);
  const ordered = ranked
    ? [...list].sort((left, right) => Number(left.rank) - Number(right.rank))
    : [...list].sort(
        (left, right) => Number(right.points || 0) - Number(left.points || 0) || Number(right.wins || 0) - Number(left.wins || 0),
      );
  return ordered.map((entry, index) => ({
    ...entry,
    rank: ranked ? Number(entry.rank) : index + 1,
  }));
}

export function presentWarzoneLeagueBoard(entries) {
  const ranked = presentRankedLeagueEntries(entries);
  return {
    ranked,
    podium: ranked.filter((entry) => entry.rank >= 1 && entry.rank <= 3),
    table: ranked.filter((entry) => entry.rank >= MWL_PUBLIC_TABLE_START && entry.rank <= MWL_PUBLIC_TABLE_END),
  };
}

export function presentOwnedLeagueTokens(rankedEntries, ownedIds) {
  const ranked = Array.isArray(rankedEntries) ? rankedEntries : [];
  const wanted = new Set(
    (Array.isArray(ownedIds) ? ownedIds : []).map((value) => tokenIdentityKey(value)).filter(Boolean),
  );
  if (!wanted.size) return [];
  return ranked.filter((entry) => wanted.has(tokenIdentityKey(entry.tokenId || entry.tokenAddress)));
}

export function presentLeaguePhase(season = {}) {
  const state = String(season?.state || "").trim().toLowerCase();
  const frozen = Boolean(season?.frozenAt || season?.regularSeasonClosed);
  const official = frozen || state === "quarter_finals" || state === "playoffs" || Boolean(season?.quarterFinalsTournamentId);
  if (state === "completed") {
    return { key: "completed", label: "COMPLETED", live: false, projected: false, official: true };
  }
  if (official) {
    return { key: "qualified", label: "QUALIFIED", live: false, projected: false, official: true };
  }
  return { key: "live", label: "LIVE", live: true, projected: true, official: false };
}

export function presentQuarterFinalField(season = {}, rankedEntries = []) {
  const ranked = Array.isArray(rankedEntries) && rankedEntries.length
    ? rankedEntries
    : presentRankedLeagueEntries(season?.entries);
  const phase = presentLeaguePhase(season);
  const seeds = quarterFinalSeeds(ranked);
  const seedKeys = new Set(seeds.map((entry) => tokenIdentityKey(entry.tokenId || entry.tokenAddress)));
  const field = seeds.map((entry) => ranked.find((row) => tokenIdentityKey(row.tokenId || row.tokenAddress) === tokenIdentityKey(entry.tokenId || entry.tokenAddress)) || entry);
  const outside = ranked.find((entry) => !seedKeys.has(tokenIdentityKey(entry.tokenId || entry.tokenAddress)));
  const inside = field[field.length - 1] || null;
  return {
    phase,
    size: QF_SEED_SIZE,
    field,
    cut: inside && outside ? { inside, outside } : null,
    label: phase.projected ? "PROJECTED QUALIFIERS · LIVE" : "QUARTER FINALISTS",
    statusLabel: phase.projected ? "PROJECTED" : "QUALIFIED",
    tournamentId: String(season?.quarterFinalsTournamentId || "").trim() || null,
  };
}

export function presentWarzoneLeagueStatus(entry) {
  const movement = String(entry?.movement || "").toLowerCase();
  if (movement === "promoted") return "PROMOTED";
  if (movement === "relegated") return "RELEGATED";
  return null;
}

export function presentWarzoneLeagueEmpty(source) {
  if (source === "empty") {
    return {
      kind: "unavailable",
      title: "STANDINGS UNAVAILABLE",
      body: "Major War League data is not available right now.",
    };
  }
  return {
    kind: "initializing",
    title: "STANDINGS INITIALIZING",
    body: "League positions appear after settled competition.",
  };
}

export function warzoneTokenInitials(symbol, name) {
  const ticker = String(symbol || "").replace(/^\$/, "").trim();
  if (ticker) return ticker.slice(0, 3).toUpperCase();
  return String(name || "MWZ").replace(/^\$/, "").slice(0, 3).toUpperCase() || "MWZ";
}
