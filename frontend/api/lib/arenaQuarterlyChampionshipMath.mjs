export const CHAMPIONSHIP_EVENT_TYPE = "quarterly_championship";
export const CHAMPIONSHIP_STATE = Object.freeze({ OPEN: "open", CLOSED: "closed" });
export const BONUS_POLICY_STATUS = Object.freeze({
  NOT_CONFIGURED: "not_authoritative",
  CONFIGURED: "configured",
});

function positiveInt(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

export function quarterForMonth(month) {
  const m = positiveInt(month, "month");
  if (m > 12) throw new Error("month must be between 1 and 12");
  return Math.floor((m - 1) / 3) + 1;
}

export function canonicalChampionshipId({ chainId, year, quarter }) {
  const chain = positiveInt(chainId, "chainId");
  const y = positiveInt(year, "year");
  const q = positiveInt(quarter, "quarter");
  if (q > 4) throw new Error("quarter must be between 1 and 4");
  return `quarterly-championship-${y}-q${q}-c${chain}`;
}

export function canonicalMonthlyMwlId({ chainId, year, month }) {
  const chain = positiveInt(chainId, "chainId");
  const y = positiveInt(year, "year");
  const m = positiveInt(month, "month");
  if (m > 12) throw new Error("month must be between 1 and 12");
  return `mwl-${y}-m${String(m).padStart(2, "0")}-c${chain}`;
}

export function quarterBoundsUtc({ year, quarter }) {
  const y = positiveInt(year, "year");
  const q = positiveInt(quarter, "quarter");
  if (q > 4) throw new Error("quarter must be between 1 and 4");
  const startMonth = (q - 1) * 3;
  return {
    opensAt: new Date(Date.UTC(y, startMonth, 1, 0, 0, 0, 0)).toISOString(),
    closesAt: new Date(Date.UTC(y, startMonth + 3, 1, 0, 0, 0, 0)).toISOString(),
  };
}

export function currentMwlEpoch(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid epoch date");
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  return { year, month, quarter: quarterForMonth(month) };
}

function score(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function tokenKey(value) {
  return String(value || "").trim();
}

// Product points decide rank. Exact score ties use token identity only as a
// deterministic technical fallback; it does not mint points or change source weights.
export function rankChampionshipEntries(entries = []) {
  return [...entries]
    .map((entry) => ({
      ...entry,
      tokenAddress: tokenKey(entry.tokenAddress ?? entry.token_address),
      basePoints: score(entry.basePoints ?? entry.base_points),
      mwlBonusPoints: score(entry.mwlBonusPoints ?? entry.mwl_bonus_points),
      totalPoints: score(entry.totalPoints ?? entry.total_points ?? (score(entry.basePoints ?? entry.base_points) + score(entry.mwlBonusPoints ?? entry.mwl_bonus_points))),
    }))
    .filter((entry) => entry.tokenAddress)
    .sort((left, right) => {
      const pointDelta = right.totalPoints - left.totalPoints;
      if (pointDelta !== 0) return pointDelta;
      return left.tokenAddress < right.tokenAddress ? -1 : left.tokenAddress > right.tokenAddress ? 1 : 0;
    })
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
}

export function rankMwlFinalEntries(entries = []) {
  return [...entries]
    .map((entry) => ({
      ...entry,
      tokenAddress: tokenKey(entry.tokenAddress ?? entry.token_address),
      points: score(entry.points),
      wins: Math.max(0, Number(entry.wins || 0) || 0),
      losses: Math.max(0, Number(entry.losses || 0) || 0),
      finishedFights: Math.max(0, Number(entry.finishedFights ?? entry.finished_fights ?? 0) || 0),
    }))
    .filter((entry) => entry.tokenAddress)
    .sort((left, right) => {
      const pointDelta = right.points - left.points;
      if (pointDelta !== 0) return pointDelta;
      const winDelta = right.wins - left.wins;
      if (winDelta !== 0) return winDelta;
      return left.tokenAddress < right.tokenAddress ? -1 : left.tokenAddress > right.tokenAddress ? 1 : 0;
    })
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
}

export function planMwlBonusAwards(finalEntries = [], rules = []) {
  const byPlacement = new Map();
  for (const rule of rules) {
    const placement = Number(rule.placement);
    const points = Number(rule.bonusPoints ?? rule.bonus_points);
    if (!Number.isInteger(placement) || placement < 1 || !Number.isFinite(points) || points <= 0) continue;
    if (byPlacement.has(placement)) throw new Error(`duplicate championship bonus placement ${placement}`);
    byPlacement.set(placement, points);
  }
  return rankMwlFinalEntries(finalEntries)
    .map((entry) => ({ ...entry, bonusPoints: byPlacement.get(entry.rank) || 0 }))
    .filter((entry) => entry.bonusPoints > 0);
}

export function championshipPublicDto(epoch, entries = [], finalEntries = []) {
  if (!epoch) return null;
  const closed = String(epoch.state) === CHAMPIONSHIP_STATE.CLOSED;
  const ranked = closed && finalEntries.length ? finalEntries : rankChampionshipEntries(entries);
  return {
    id: String(epoch.id),
    eventType: CHAMPIONSHIP_EVENT_TYPE,
    chainId: Number(epoch.chain_id ?? epoch.chainId),
    year: Number(epoch.year),
    quarter: Number(epoch.quarter),
    state: closed ? CHAMPIONSHIP_STATE.CLOSED : CHAMPIONSHIP_STATE.OPEN,
    opensAt: epoch.opens_at ?? epoch.opensAt ?? null,
    closesAt: epoch.closes_at ?? epoch.closesAt ?? null,
    closedAt: epoch.closed_at ?? epoch.closedAt ?? null,
    entries: ranked.map((entry) => ({
      tokenAddress: String(entry.tokenAddress ?? entry.token_address),
      tokenName: String(entry.tokenName ?? entry.token_name ?? ""),
      symbol: String(entry.symbol ?? ""),
      rank: Number(entry.rank ?? entry.final_rank),
      basePoints: score(entry.basePoints ?? entry.base_points),
      mwlBonusPoints: score(entry.mwlBonusPoints ?? entry.mwl_bonus_points),
      totalPoints: score(entry.totalPoints ?? entry.total_points),
    })),
  };
}
