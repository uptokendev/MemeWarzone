export const WARZONE_CONTENT_MAX_WIDTH_PX = 1280;
export const WARZONE_CONTENT_MAX_CLASS = "max-w-[1280px]";

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

export function presentWarzoneLeagueBoard(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return {
    podium: list.slice(0, 3),
    table: list.slice(3).map((entry, index) => ({
      ...entry,
      rank: index + 4,
    })),
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
