export const QUARTERLY_CHAMPIONSHIP_PUBLIC_NAME = "Quarterly Championship";

export function isQuarterlyChampionshipRuntime(source = {}) {
  const origin = String(source?.origin || source?.eventOrigin || source?.event_origin || "").trim().toLowerCase();
  const eventType = String(source?.eventType || source?.event_type || "").trim().toLowerCase();
  return origin === "quarter_finals" || origin === "quarterly_championship" || origin === "championship" || eventType === "quarterly_championship" || eventType === "mwl_quarter_finals";
}

export function presentQuarterlyChampionshipCard(card = {}, source = {}) {
  if (!isQuarterlyChampionshipRuntime(source)) return card;
  const statusKey = String(card?.status?.key || "");
  return {
    ...card,
    title: QUARTERLY_CHAMPIONSHIP_PUBLIC_NAME,
    bracketStage: null,
    progression: null,
    bracketCta: null,
    liveRoundCta: null,
    remaining: null,
    liveBattleCount: null,
    champion: null,
    primaryCta: statusKey === "finished" ? "View results" : "View championship",
    quarterlyChampionship: true,
  };
}

export function quarterlyChampionshipSponsorVariant(source = {}) {
  return isQuarterlyChampionshipRuntime(source) ? "premium" : "prominent";
}
