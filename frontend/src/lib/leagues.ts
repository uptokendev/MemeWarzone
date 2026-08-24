export type LeagueKey =
  | "perfect_run"
  | "fastest_finish"
  | "biggest_hit"
  | "top_earner"
  | "crowd_favorite"
  | "recruiter_league";

export type LeagueChain = "bnb" | "solana";
export type Period = "weekly" | "monthly";
export type LeaguePeriod = Period;
export type LeagueRowType = "token" | "wallet" | "recruiter";

export type LeagueDef = {
  key: LeagueKey;
  title: string;
  shortLabel: string;
  image: string;
  rowType: LeagueRowType;
  supports: Period[];
  supportedPeriods: Period[];
  metricLabel: string;
  ruleSummary: string;
  emptyStateCopy: string;
  weeklyLimit?: number;
  monthlyLimit?: number;
};

export type LeaguePayoutPolicy = {
  minWinners: number;
  paidFieldPct: number;
  alpha: number;
  monthlyPlayerPrizeCapUsd: number;
};

export const DEFAULT_PAID_FIELD_PCT = 0.15;
export const FUTURE_PAID_FIELD_PCT = 0.2;
export const PAYOUT_ALPHA = 0.72;
export const MONTHLY_PLAYER_PRIZE_CAP_USD = 1_500_000;

export const LEAGUES: LeagueDef[] = [
  {
    key: "perfect_run",
    title: "Perfect Run",
    shortLabel: "Perfect",
    image: "/assets/perfectrun.png",
    rowType: "token",
    supports: ["monthly"],
    supportedPeriods: ["monthly"],
    metricLabel: "Duration / sells",
    ruleSummary: "Monthly only. Graduate with no bonding-curve sells.",
    emptyStateCopy: "Perfect Run standings will appear once a monthly epoch has qualified graduations.",
    monthlyLimit: 25,
  },
  {
    key: "fastest_finish",
    title: "Fastest Finish",
    shortLabel: "Fastest",
    image: "/assets/fastestfinish.png",
    rowType: "token",
    supports: ["weekly", "monthly"],
    supportedPeriods: ["weekly", "monthly"],
    metricLabel: "Time to graduate",
    ruleSummary: "Fastest graduation time. Creator buys are excluded from scoring.",
    emptyStateCopy: "Fastest Finish standings will appear once qualified graduations are indexed.",
    weeklyLimit: 50,
    monthlyLimit: 100,
  },
  {
    key: "biggest_hit",
    title: "Biggest Hit",
    shortLabel: "Hit",
    image: "/assets/biggesthit.png",
    rowType: "token",
    supports: ["weekly", "monthly"],
    supportedPeriods: ["weekly", "monthly"],
    metricLabel: "Largest buy",
    ruleSummary: "Single largest bonding-curve buy in the selected epoch.",
    emptyStateCopy: "Biggest Hit standings will appear once buy events are indexed.",
    weeklyLimit: 50,
    monthlyLimit: 100,
  },
  {
    key: "top_earner",
    title: "Top Earner",
    shortLabel: "Earner",
    image: "/assets/topearner.png",
    rowType: "wallet",
    supports: ["weekly", "monthly"],
    supportedPeriods: ["weekly", "monthly"],
    metricLabel: "Trader PnL",
    ruleSummary: "Trader PnL inside the bonding curve, measured as net sells minus buys.",
    emptyStateCopy: "Top Earner standings will appear once trader PnL is finalized.",
    weeklyLimit: 50,
    monthlyLimit: 100,
  },
  {
    key: "crowd_favorite",
    title: "Crowd Favorite",
    shortLabel: "Crowd",
    image: "/assets/crowdfavorite.png",
    rowType: "token",
    supports: ["weekly", "monthly"],
    supportedPeriods: ["weekly", "monthly"],
    metricLabel: "Confirmed UpVotes",
    ruleSummary: "Most UpVotes from unique voters in the selected week or month.",
    emptyStateCopy: "Crowd Favorite standings will appear once confirmed votes are indexed.",
    weeklyLimit: 50,
    monthlyLimit: 100,
  },
  {
    key: "recruiter_league",
    title: "Recruiter League",
    shortLabel: "Recruiter",
    image: "/assets/logo.png",
    rowType: "recruiter",
    supports: ["weekly", "monthly"],
    supportedPeriods: ["weekly", "monthly"],
    metricLabel: "Epoch referral score",
    ruleSummary:
      "Universal All-Chains board. Active recruiter network counts now; BNB and SOL referred volume this epoch are converted to USD separately then combined.",
    emptyStateCopy:
      "No active recruiters yet. Existing linked wallets still count this week; only trades and earnings are limited to the current epoch.",
    weeklyLimit: 50,
    monthlyLimit: 100,
  },
];

export const LEAGUE_CONFIGS = LEAGUES;

export function getLimit(def: LeagueDef, period: Period) {
  return period === "weekly" ? def.weeklyLimit ?? 50 : def.monthlyLimit ?? 100;
}

export function periodLabel(p: Period) {
  return p === "weekly" ? "Weekly" : "Monthly";
}

export function getPayoutPolicy(period: Period, paidFieldPct = DEFAULT_PAID_FIELD_PCT): LeaguePayoutPolicy {
  return {
    minWinners: period === "weekly" ? 3 : 5,
    paidFieldPct,
    alpha: PAYOUT_ALPHA,
    monthlyPlayerPrizeCapUsd: MONTHLY_PLAYER_PRIZE_CAP_USD,
  };
}

export function calculatePaidPlaces(qualifiedEntrants: number, policy: LeaguePayoutPolicy) {
  const entrants = Math.max(0, Math.floor(qualifiedEntrants));
  if (entrants <= 0) return 0;
  // Never invent more paid places than actual entrants (was forcing Rank #2–#5 with 1 entrant).
  const target = Math.max(policy.minWinners, Math.floor(entrants * policy.paidFieldPct));
  return Math.min(entrants, target);
}

export function calculatePayoutCurve(qualifiedEntrants: number, prizePoolUsd: number, policy: LeaguePayoutPolicy) {
  const paidPlaces = calculatePaidPlaces(qualifiedEntrants, policy);
  const safePool = Math.max(0, Number.isFinite(prizePoolUsd) ? prizePoolUsd : 0);
  const weights = Array.from({ length: paidPlaces }, (_, index) => 1 / (index + 1) ** policy.alpha);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;

  return weights.map((weight, index) => ({
    rank: index + 1,
    percentage: weight / totalWeight,
    payoutUsd: safePool * (weight / totalWeight),
  }));
}
