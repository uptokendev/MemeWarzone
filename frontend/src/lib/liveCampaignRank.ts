import { liveCampaignKey } from "@/lib/liveMarketMerge";

export type LiveRankContext = "explore" | "wtr";

export type LiveRankRow = {
  chainId: number;
  campaignAddress: string;
  createdAt: number;
  lastActivityAt: number;
  vol24hBnb: number;
  votes24h: number;
  holderCount: number;
  marketcapBnb: number;
  progressPct: number;
  etaSec: number | null;
  isDexTrading: boolean;
  voteTrendingScore: number;
  graduatedAt: number;
};

export function homepageTrendingScore(input: {
  vol24hBnb: number;
  votes24h: number;
  holderCount: number;
}): number {
  return (finite(input.vol24hBnb) * 1000) + (finite(input.votes24h) * 10) + (finite(input.holderCount) * 2);
}

export function warRoomTrendingScore(input: {
  vol24hBnb: number;
  votes24h: number;
  holderCount: number;
  voteTrendingScore: number;
}): number {
  return homepageTrendingScore(input) + finite(input.voteTrendingScore);
}

export function maxVoteCount(live: unknown, rest: unknown): number {
  const a = Number(live);
  const b = Number(rest);
  const av = Number.isFinite(a) ? a : 0;
  const bv = Number.isFinite(b) ? b : 0;
  return Math.max(av, bv);
}

export function rankIdentity(chainId: number, campaignAddress: string): string {
  return `${Number(chainId) || 0}:${liveCampaignKey(Number(chainId) || 0, String(campaignAddress || ""))}`;
}

export function compareLiveCampaigns(
  a: LiveRankRow,
  b: LiveRankRow,
  input: { tab: string; sort: string; context: LiveRankContext },
): number {
  const sort = String(input.sort || "default");
  const tab = String(input.tab || "trending");
  const createdTie = () => tieCreatedThenIdentity(a, b);

  if (sort === "mcap_desc") return cmpDesc(a.marketcapBnb, b.marketcapBnb) || createdTie();
  if (sort === "mcap_asc") {
    const aUnknown = a.marketcapBnb <= 0 ? 1 : 0;
    const bUnknown = b.marketcapBnb <= 0 ? 1 : 0;
    if (aUnknown !== bUnknown) return aUnknown - bUnknown;
    return cmpAsc(a.marketcapBnb, b.marketcapBnb) || createdTie();
  }
  if (sort === "votes_desc") return cmpDesc(a.votes24h, b.votes24h) || createdTie();
  if (sort === "progress_desc") return cmpDesc(a.progressPct, b.progressPct) || createdTie();
  if (sort === "volume_desc") return cmpDesc(a.vol24hBnb, b.vol24hBnb) || createdTie();
  if (sort === "holders_desc") return cmpDesc(a.holderCount, b.holderCount) || createdTie();
  if (sort === "created_asc") return cmpAsc(a.createdAt, b.createdAt) || identityCmp(a, b);
  if (sort === "created_desc" || tab === "new") return cmpDesc(a.createdAt, b.createdAt) || identityCmp(a, b);

  if (tab === "ending") {
    return cmpEtaAscNullsLast(a.etaSec, b.etaSec) || cmpDesc(a.progressPct, b.progressPct) || createdTie();
  }
  if (tab === "dex" || tab === "graduated") {
    return cmpDesc(a.graduatedAt, b.graduatedAt) || createdTie();
  }

  if (input.context === "wtr" && (sort === "default" || tab === "trending")) {
    const sa = warRoomTrendingScore(a);
    const sb = warRoomTrendingScore(b);
    return cmpDesc(sa, sb) || cmpDesc(a.lastActivityAt, b.lastActivityAt) || createdTie();
  }

  const sa = homepageTrendingScore(a);
  const sb = homepageTrendingScore(b);
  return cmpDesc(sa, sb) || createdTie();
}

function finite(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function cmpDesc(a: number, b: number): number {
  if (a === b) return 0;
  return b - a;
}

function cmpAsc(a: number, b: number): number {
  if (a === b) return 0;
  return a - b;
}

function cmpEtaAscNullsLast(a: number | null, b: number | null): number {
  const aNull = a == null || !Number.isFinite(a);
  const bNull = b == null || !Number.isFinite(b);
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  return (a as number) - (b as number);
}

function identityCmp(a: LiveRankRow, b: LiveRankRow): number {
  return rankIdentity(a.chainId, a.campaignAddress).localeCompare(rankIdentity(b.chainId, b.campaignAddress));
}

function tieCreatedThenIdentity(a: LiveRankRow, b: LiveRankRow): number {
  return cmpDesc(a.createdAt, b.createdAt) || identityCmp(a, b);
}
