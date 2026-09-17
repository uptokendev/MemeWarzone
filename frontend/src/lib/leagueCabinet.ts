import { ethers } from "ethers";
import { LEAGUES, type LeagueKey, type Period } from "@/lib/leagues";
import { getNativeSymbol } from "@/lib/chainConfig";

export type LeagueCabinetWin = {
  id: string;
  chainId: number;
  period: Period;
  epochStart: string;
  epochEnd: string;
  category: LeagueKey;
  rank: number;
  recipientAddress: string;
  amountRaw: string;
  expiresAt: string | null;
  isTitle: boolean;
  meta: Record<string, any>;
};

export type LeagueCabinetMastery = {
  category: LeagueKey;
  wins: number;
  titles: number;
  bestRank: number | null;
  latestEpochEnd: string | null;
  dominantPeriod: Period;
  tier: string;
  nextTier: string | null;
  nextThreshold: number | null;
  progressPercent: number;
};

export type LeagueCabinetSummary = {
  totalWins: number;
  totalTitles: number;
  uniqueLeagues: number;
  latestWinAt: string | null;
  favoriteLeague: LeagueKey | null;
  bestTier: string | null;
};

export type LeagueCabinet = {
  summary: LeagueCabinetSummary;
  items: LeagueCabinetWin[];
  mastery: LeagueCabinetMastery[];
};

export const LEAGUE_TIER_STEPS = [
  { tier: "Bronze", minWins: 1 },
  { tier: "Silver", minWins: 3 },
  { tier: "Gold", minWins: 5 },
  { tier: "Platinum", minWins: 10 },
  { tier: "Diamond", minWins: 25 },
  { tier: "Legend", minWins: 50 },
] as const;

export function getLeagueMeta(category: LeagueKey) {
  return LEAGUES.find((league) => league.key === category) ?? null;
}

export function getLeagueTitle(category: LeagueKey) {
  return getLeagueMeta(category)?.title ?? category;
}

export function getLeagueImage(category: LeagueKey) {
  return getLeagueMeta(category)?.image ?? "/assets/leaguelogo.png";
}

export function formatEpochLabel(item: Pick<LeagueCabinetWin, "period" | "epochStart">) {
  const date = new Date(item.epochStart);
  if (Number.isNaN(date.getTime())) return item.epochStart;

  if (item.period === "monthly") {
    return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(date);
  }

  return `Week of ${new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date)}`;
}

export function formatWinPlacement(item: Pick<LeagueCabinetWin, "rank" | "period">) {
  if (item.rank === 1) return `${item.period === "weekly" ? "Weekly" : "Monthly"} Champion`;
  return `${item.period === "weekly" ? "Weekly" : "Monthly"} #${item.rank}`;
}

export function formatMetric(item: Pick<LeagueCabinetWin, "category" | "meta" | "chainId">) {
  const nativeSymbol = getNativeSymbol(item.chainId);

  if (item.category === "fastest_finish" || item.category === "perfect_run") {
    const seconds = Number(item.meta?.duration_seconds ?? item.meta?.score ?? 0);
    if (Number.isFinite(seconds) && seconds > 0) return { label: "Time", value: formatDuration(seconds) };
  }

  if (item.category === "biggest_hit") {
    const raw = String(item.meta?.score ?? "0");
    return { label: "Hit", value: `${trimBnb(raw)} ${nativeSymbol}` };
  }

  if (item.category === "top_earner") {
    const raw = String(item.meta?.pnl_raw ?? item.meta?.score ?? "0");
    return { label: "PnL", value: `${trimBnb(raw)} ${nativeSymbol}` };
  }

  if (item.category === "crowd_favorite") {
    const votes = Number(item.meta?.votes_count ?? item.meta?.score ?? 0);
    if (Number.isFinite(votes) && votes >= 0) return { label: "Votes", value: votes.toLocaleString() };
  }

  return { label: "Result", value: "Verified win" };
}

export function trimBnb(raw: string) {
  try {
    const formatted = ethers.formatEther(BigInt(raw || "0"));
    const [whole, frac = ""] = formatted.split(".");
    const trimmed = frac.replace(/0+$/, "").slice(0, 4);
    return trimmed ? `${whole}.${trimmed}` : whole;
  } catch {
    return "0";
  }
}

export function formatDuration(totalSeconds: number) {
  const seconds = Math.max(0, Math.trunc(totalSeconds));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (!parts.length) parts.push(`${seconds}s`);
  return parts.slice(0, 2).join(" ");
}

export function buildShareText(args: {
  win: LeagueCabinetWin;
  displayName?: string | null;
  mastery?: LeagueCabinetMastery | null;
}) {
  const { win, displayName, mastery } = args;
  const name = (displayName ?? "").trim() || "A MemeWarzone player";
  const leagueTitle = getLeagueTitle(win.category);
  const metric = formatMetric(win);
  const placement = formatWinPlacement(win);
  const masteryText = mastery ? ` ${mastery.tier} tier now. ${mastery.wins} total ${mastery.wins === 1 ? "win" : "wins"} in ${leagueTitle}.` : "";

  return `${name} just secured ${placement} in ${leagueTitle} on MemeWarzone. ${metric.label}: ${metric.value}.${masteryText} Compete. Create. Conquer.`.trim();
}

export function buildVictoryPrompt(args: {
  win: LeagueCabinetWin;
  displayName?: string | null;
  mastery?: LeagueCabinetMastery | null;
}) {
  const { win, displayName, mastery } = args;
  const leagueTitle = getLeagueTitle(win.category);
  const metric = formatMetric(win);
  const placement = formatWinPlacement(win);
  const epoch = formatEpochLabel(win);
  const winner = (displayName ?? "").trim() || shortenAddress(win.recipientAddress);
  const tier = mastery?.tier ? ` Current mastery tier: ${mastery.tier}.` : "";

  return [
    `Create a square social share card for MemeWarzone using the ${leagueTitle} league badge as the hero image reference.`,
    `Style: premium game UI, dark worn metal, orange fire accents, black tactical frame, subtle sparks, high contrast, polished but aggressive, authentic warzone branding.`,
    `Main headline: \"${leagueTitle}\".`,
    `Secondary headline: \"${placement}\".`,
    `Show winner tag: \"${winner}\".`,
    `Show epoch label: \"${epoch}\".`,
    `Show stat line: \"${metric.label}: ${metric.value}\".${tier}`,
    `Add a smaller CTA footer: \"Compete. Create. Conquer.\" and \"memewar.zone\".`,
    `Do not redesign the badge. Keep it recognizable and centered with cinematic depth, flames, steel, and collectible trophy-card energy.`,
  ].join(" ");
}

export function buildMasteryPrompt(args: {
  mastery: LeagueCabinetMastery;
  displayName?: string | null;
  address?: string | null;
}) {
  const { mastery, displayName, address } = args;
  const leagueTitle = getLeagueTitle(mastery.category);
  const winner = (displayName ?? "").trim() || shortenAddress(address ?? "");
  const next = mastery.nextTier && mastery.nextThreshold ? ` Next tier at ${mastery.nextThreshold} wins.` : " Legend tier unlocked.";

  return [
    `Create a square mastery achievement card for MemeWarzone using the ${leagueTitle} league badge as the main emblem.`,
    `Theme: elite military game UI, dark steel plate, amber-orange glow, subtle embers, premium collectible badge presentation.`,
    `Headline: \"${leagueTitle} Mastery\".`,
    `Primary badge text: \"${mastery.tier} Tier\".`,
    `Show player tag: \"${winner}\".`,
    `Show progress stats: \"${mastery.wins} total wins\" and \"${mastery.titles} titles\".${next}`,
    `Add a small footer with \"MemeWarzone\" and \"Compete. Create. Conquer.\".`,
    `The design should feel like a rare in-game achievement card, not a plain flyer.`,
  ].join(" ");
}

export function buildCabinetPrompt(args: { displayName?: string | null; cabinet: LeagueCabinet }) {
  const { displayName, cabinet } = args;
  const winner = (displayName ?? "").trim() || "MemeWarzone player";
  const topLeagues = cabinet.mastery
    .slice(0, 3)
    .map((entry) => `${getLeagueTitle(entry.category)} (${entry.wins})`)
    .join(", ");

  return [
    `Create a square trophy-cabinet showcase card for MemeWarzone.`,
    `Theme: dark tactical metal display, fiery orange highlights, premium game UI, collectible wall of honors.`,
    `Headline: \"League Cabinet\".`,
    `Show player tag: \"${winner}\".`,
    `Show summary stats: \"${cabinet.summary.totalWins} total league wins\", \"${cabinet.summary.totalTitles} titles\", \"${cabinet.summary.uniqueLeagues} leagues conquered\".`,
    topLeagues ? `Feature the three most important league badges: ${topLeagues}.` : "Feature the main MemeWarzone league crest.",
    `Add a footer CTA: \"Compete. Create. Conquer.\" and \"memewar.zone\".`,
    `Make it feel like an elite profile achievement showcase ready for social media.`,
  ].join(" ");
}

export function shortenAddress(addr?: string | null) {
  const value = String(addr ?? "").trim();
  if (!value) return "";
  if (value.length <= 10) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}


function apiBaseUrl() {
  const rawBase = String(import.meta.env.VITE_API_BASE_URL ?? "").trim();
  if (rawBase && /^https?:\/\//i.test(rawBase)) return rawBase.replace(/\/$/, "");
  return window.location.origin.replace(/\/$/, "");
}

export type ShareCardKind = "win" | "mastery" | "cabinet";
export type ShareCardFormat = "png" | "svg";

export function buildShareCardUrl(args: {
  kind: ShareCardKind;
  chainId: number;
  address: string;
  win?: Pick<LeagueCabinetWin, "category" | "period" | "epochStart" | "rank"> | null;
  category?: LeagueKey | null;
  download?: boolean;
  format?: ShareCardFormat;
}) {
  const base = apiBaseUrl();
  const qs = new URLSearchParams({
    kind: args.kind,
    chainId: String(args.chainId),
    address: args.address.toLowerCase(),
    format: args.format ?? "png",
  });

  if (args.kind === "win") {
    if (!args.win) throw new Error("Win selector required for win share cards");
    qs.set("category", args.win.category);
    qs.set("period", args.win.period);
    qs.set("epochStart", args.win.epochStart);
    qs.set("rank", String(args.win.rank));
  }

  if (args.kind === "mastery") {
    const category = args.category ?? args.win?.category ?? null;
    if (!category) throw new Error("Category required for mastery share cards");
    qs.set("category", category);
  }

  if (args.download) qs.set("download", "1");

  return `${base}/api/shareCard?${qs.toString()}`;
}

export function buildMasteryShareText(args: {
  mastery: LeagueCabinetMastery;
  displayName?: string | null;
}) {
  const { mastery, displayName } = args;
  const name = (displayName ?? "").trim() || "A MemeWarzone player";
  const leagueTitle = getLeagueTitle(mastery.category);
  const next = mastery.nextTier && mastery.nextThreshold
    ? ` Next tier at ${mastery.nextThreshold} wins.`
    : " Legend tier unlocked.";

  return `${name} is now ${mastery.tier} tier in ${leagueTitle} on MemeWarzone with ${mastery.wins} total wins and ${mastery.titles} titles.${next} Compete. Create. Conquer.`;
}

export function buildCabinetShareText(args: {
  cabinet: LeagueCabinet;
  displayName?: string | null;
}) {
  const { cabinet, displayName } = args;
  const name = (displayName ?? "").trim() || "A MemeWarzone player";
  return `${name} has built a MemeWarzone League Cabinet with ${cabinet.summary.totalWins} league wins, ${cabinet.summary.totalTitles} titles, and ${cabinet.summary.uniqueLeagues} conquered leagues. Compete. Create. Conquer.`;
}
