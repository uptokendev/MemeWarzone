import {
  LEAGUES,
  MONTHLY_PLAYER_PRIZE_CAP_USD,
  getLimit,
  type LeagueChain,
  type LeagueDef,
  type LeagueKey,
  type LeaguePeriod,
} from "@/lib/leagues";
import { fetchOnChainLeagueSummary } from "@/lib/onChainLeagueSummary";
import { type SupportedChainId } from "@/lib/chainConfig";
import { apiFetch } from "@/lib/apiBase";

/**
 * Map UI league keys → frontend-api /api/league?category=…
 * (frontend/api/league.js — locked category names, not indexer aliases)
 */
const API_CATEGORY_BY_LEAGUE: Partial<Record<LeagueKey, string>> = {
  perfect_run: "perfect_run",
  fastest_finish: "fastest_finish",
  biggest_hit: "biggest_hit",
  top_earner: "top_earner",
  crowd_favorite: "crowd_favorite",
  recruiter_league: "recruiter_league",
};

const ONCHAIN_FALLBACK_TIMEOUT_MS = 2500;

export type LeagueStatus = "loading" | "ready" | "empty" | "pending" | "error" | "claimable" | "finalized" | "expired" | "rolled_over";

export interface LeagueEpoch {
  period: LeaguePeriod;
  epochOffset: number;
  epochStart: string | null;
  epochEnd: string | null;
  rangeEnd: string | null;
  status: "live" | "finalized" | "pending";
}

export interface LeagueSeasonMeta {
  seasonId: string;
  epochId: string;
  chain: LeagueChain;
  chainId?: number;
  period: LeaguePeriod;
  epochOffset: number;
  status?: string;
}

export interface LeaguePrizeMeta {
  basis?: string;
  period?: LeaguePeriod;
  computedAt?: string;
  totalLeagueFeeRaw?: string;
  /** Sum of every league's pot this epoch: the prize money settlement pays (not the raw fee total). */
  totalPotRaw?: string;
  leagueCount?: number;
  winners?: number;
  splitBps?: number[];
  potRaw?: string;
  payoutsRaw?: string[];
  rolloverRaw?: string;
  paidRaw?: string;
  availablePotRaw?: string;
  availablePayoutsRaw?: string[];
  generatedUsd?: number;
  playerPrizePoolUsd?: number;
  charityReserveUsd?: number;
  monthlyPlayerPrizeCapUsd?: number;
  capApplies?: boolean;
  capReached?: boolean;
  bnbUsdPrice?: number | null;
  solUsdPrice?: number | null;
  nativeUsdPrice?: number | null;
  nativeUsdPriceSource?: string;
  nativeSymbol?: string;
  nativeDecimals?: number;
  claimsOpen?: boolean;
  byLeague?: Record<string, unknown>;
  warning?: string;
}

export interface LeaguePayoutPolicy {
  minWinners: number;
  paidFieldPct: number;
  alpha: number;
  monthlyPlayerPrizeCapUsd: number;
}

export interface CurrentLeagueLeader {
  leagueKey: LeagueKey;
  leagueTitle: string;
  label: string;
  metric: string;
}

export interface LeagueWinnerHistoryItem {
  id: string;
  label: string;
  leagueKey?: LeagueKey;
  completedAt?: string;
  winnerLabel?: string;
}

export interface LeagueSummaryCard {
  key: LeagueKey;
  title: string;
  status: LeagueStatus;
  entrants: number;
  rows: unknown[];
  prize?: LeaguePrizeMeta;
  warning?: string;
}

export interface LeagueDetail {
  key: LeagueKey;
  status: LeagueStatus;
  rows: unknown[];
  prize?: LeaguePrizeMeta;
  warning?: string;
}

export interface LeagueTrendMetrics {
  basis?: string;
  changeVsPreviousEpoch?: { entrants?: number; playerPrizePoolUsd?: number } | null;
  entrantsGrowthPct?: number | null;
  prizePoolGrowthPct?: number | null;
}

export interface LeagueHallOfFame {
  basis?: string;
  allTimeWinners: unknown[];
  biggestPrizePools: unknown[];
  mostWins: unknown[];
}

export interface LeagueWinnerSource {
  source?: string;
  finalized?: boolean;
  plannedSource?: string;
  note?: string;
}

export interface LeagueSummaryResponse {
  chain: LeagueChain;
  period: LeaguePeriod;
  epoch?: LeagueEpoch;
  season?: LeagueSeasonMeta;
  seasonId?: string;
  epochId?: string;
  winnerSource?: LeagueWinnerSource;
  prize?: LeaguePrizeMeta;
  payoutPolicy?: LeaguePayoutPolicy;
  leagues: LeagueSummaryCard[];
  selectedLeague?: LeagueDetail;
  currentLeaders: CurrentLeagueLeader[];
  history: LeagueWinnerHistoryItem[];
  trendMetrics?: LeagueTrendMetrics;
  hallOfFame?: LeagueHallOfFame;
}

type LegacyLeagueResponse = {
  items?: unknown[];
  warning?: string;
  prize?: LeaguePrizeMeta;
  epoch?: LeagueEpoch;
  stats?: { campaignsCreated?: number; recruitersRanked?: number };
};

export interface LoadLeagueSummaryOptions {
  chain: LeagueChain;
  chainId: number;
  period: LeaguePeriod;
  epochOffset: number;
}

function toNumber(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toStatus(value: unknown, fallback: LeagueStatus = "empty"): LeagueStatus {
  const status = String(value || "").toLowerCase();
  if (["loading", "ready", "empty", "pending", "error", "claimable", "finalized", "expired", "rolled_over"].includes(status)) return status as LeagueStatus;
  return fallback;
}

function isLeagueKey(value: unknown): value is LeagueKey {
  return LEAGUES.some((league) => league.key === value);
}

function leagueTitle(key: LeagueKey) {
  return LEAGUES.find((league) => league.key === key)?.title || key;
}

function emptyHallOfFame(): LeagueHallOfFame {
  return { basis: "building_history", allTimeWinners: [], biggestPrizePools: [], mostWins: [] };
}

function emptyTrendMetrics(): LeagueTrendMetrics {
  // Always provide numeric baselines so the UI never shows "frontend_empty" / blank deltas.
  return {
    basis: "live_epoch",
    changeVsPreviousEpoch: { entrants: 0, playerPrizePoolUsd: 0 },
    entrantsGrowthPct: 0,
    prizePoolGrowthPct: 0,
  };
}

function buildSeasonIds(chain: LeagueChain, chainId: number, period: LeaguePeriod, epochOffset: number, epoch?: LeagueEpoch) {
  const start = epoch?.epochStart || "live";
  const end = epoch?.epochEnd || epoch?.rangeEnd || "open";
  const seasonId = `${chain}-${chainId}-${period}-${start}_${end}`;
  return { seasonId, epochId: seasonId, season: { seasonId, epochId: seasonId, chain, chainId, period, epochOffset, status: epoch?.status || "live" } as LeagueSeasonMeta };
}

function normalizeRecruiterRow(row: any, index: number) {
  return {
    ...row,
    rank: toNumber(row?.rank, index + 1),
    displayName: row?.displayName || row?.display_name || row?.name || undefined,
    recruiterCode: row?.recruiterCode || row?.code || row?.recruiter_code || undefined,
    wallet: row?.wallet || row?.walletAddress || row?.wallet_address || undefined,
    linkedWallets: toNumber(row?.linkedWallets ?? row?.linkedWalletCount ?? row?.linked_wallet_count),
    linkedCreators: toNumber(row?.linkedCreators ?? row?.linkedCreatorsCount ?? row?.linked_creators_count),
    linkedTraders: toNumber(row?.linkedTraders ?? row?.linkedTradersCount ?? row?.linked_traders_count),
    activeSquadMembers: toNumber(row?.activeSquadMembers ?? row?.activeSquadMemberCount ?? row?.active_squad_member_count),
    referredVolumeUsd: toNumber(row?.referredVolumeUsd ?? row?.referred_volume_usd),
    weightedScore: toNumber(row?.weightedScore ?? row?.weighted_score),
    estimatedPayoutUsd: toNumber(row?.estimatedPayoutUsd ?? row?.estimated_payout_usd),
    claimStatus: row?.claimStatus || row?.claim_status || "Pending",
  };
}

function isEvmAddress(value: unknown) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || "").trim());
}

function isSolanaAddress(value: unknown) {
  const raw = String(value || "").trim();
  return raw.length >= 32 && raw.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(raw);
}

function isLeagueAddress(value: unknown) {
  return isEvmAddress(value) || isSolanaAddress(value);
}

function preserveAddress(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (isSolanaAddress(raw)) return raw;
  return raw.toLowerCase();
}

function campaignKey(row: any) {
  return preserveAddress(row?.campaign_address || row?.campaignAddress);
}

/** Enforce row shape per league so wallet/recruiter boards never show memecoins. */
function normalizeRows(def: LeagueDef, rows: unknown[]) {
  const list = Array.isArray(rows) ? rows : [];

  if (def.rowType === "recruiter") {
    return list
      .map((row, index) => normalizeRecruiterRow(row, index))
      .filter((row) => Boolean(row.wallet || row.recruiterCode || row.displayName))
      .map((row, index) => ({ ...row, rank: index + 1 }));
  }

  if (def.rowType === "wallet") {
    return list
      .map((row: any) => {
        const wallet = preserveAddress(row?.wallet || row?.walletAddress || row?.buyer_address);
        return {
          ...row,
          wallet,
          profit_raw: row?.profit_raw ?? row?.profitRaw ?? null,
          sells_raw: row?.sells_raw ?? row?.sellsRaw ?? null,
          buys_raw: row?.buys_raw ?? row?.buysRaw ?? null,
          trades_count: row?.trades_count != null ? Number(row.trades_count) : row?.tradesCount != null ? Number(row.tradesCount) : null,
          campaigns_traded: row?.campaigns_traded != null ? Number(row.campaigns_traded) : null,
          // Strip token fields so UI never renders this as a memecoin card.
          name: undefined,
          symbol: undefined,
          campaign_address: undefined,
          campaignAddress: undefined,
        };
      })
      .filter((row) => isLeagueAddress(row.wallet))
      .map((row, index) => ({ ...row, rank: index + 1 }));
  }

  // Token leagues: keep campaign rows only; dedupe graduation boards by campaign.
  const tokenRows = list
    .map((row: any) => ({
      ...row,
      campaign_address: campaignKey(row) || null,
      campaignAddress: campaignKey(row) || null,
      token_address: preserveAddress(row?.token_address || row?.tokenAddress) || null,
      tokenAddress: preserveAddress(row?.token_address || row?.tokenAddress) || null,
      name: row?.name ?? null,
      symbol: row?.symbol ?? null,
      logo_uri: row?.logo_uri || row?.logoUri || null,
      duration_seconds: row?.duration_seconds != null ? Number(row.duration_seconds) : null,
      sells_count: row?.sells_count != null ? Number(row.sells_count) : null,
      unique_buyers: row?.unique_buyers != null ? Number(row.unique_buyers) : null,
      bnb_amount_raw: row?.bnb_amount_raw ?? row?.bnbAmountRaw ?? null,
      buyer_address: preserveAddress(row?.buyer_address || row?.wallet) || null,
      votes_count: row?.votes_count != null ? Number(row.votes_count) : null,
    }))
    .filter((row) => isLeagueAddress(row.campaign_address));

  if (def.key === "perfect_run" || def.key === "fastest_finish" || def.key === "crowd_favorite") {
    const byCampaign = new Map<string, any>();
    for (const row of tokenRows) {
      const key = String(row.campaign_address);
      if (!byCampaign.has(key)) byCampaign.set(key, row);
    }
    return Array.from(byCampaign.values()).map((row, index) => ({ ...row, rank: index + 1 }));
  }

  // biggest_hit: one campaign once (largest buy already chosen by API; FE hard-dedupes).
  if (def.key === "biggest_hit") {
    const byCampaign = new Map<string, any>();
    for (const row of tokenRows) {
      const key = String(row.campaign_address);
      const prev = byCampaign.get(key);
      if (!prev) {
        byCampaign.set(key, row);
        continue;
      }
      try {
        const nextAmt = BigInt(String(row.bnb_amount_raw ?? "0"));
        const prevAmt = BigInt(String(prev.bnb_amount_raw ?? "0"));
        if (nextAmt > prevAmt) byCampaign.set(key, row);
      } catch {
        // keep first
      }
    }
    return Array.from(byCampaign.values())
      .sort((a, b) => {
        try {
          const av = BigInt(String(a.bnb_amount_raw ?? "0"));
          const bv = BigInt(String(b.bnb_amount_raw ?? "0"));
          if (av === bv) return 0;
          return bv > av ? 1 : -1;
        } catch {
          return 0;
        }
      })
      .map((row, index) => ({ ...row, rank: index + 1 }));
  }

  return tokenRows.map((row, index) => ({ ...row, rank: index + 1 }));
}

function getStatus(rows: unknown[], warning?: string): LeagueStatus {
  if (rows.length) return "ready";
  // Keep "empty" (not error) so pending leagues show clean empty copy, not broken-feed chrome.
  if (warning) return "empty";
  return "empty";
}

function leaderLabel(row: any) {
  if (typeof row?.label === "string") return row.label;
  if (typeof row?.displayName === "string") return row.displayName;
  if (typeof row?.recruiterCode === "string") return row.recruiterCode;
  if (typeof row?.name === "string") return row.symbol ? `${row.name} (${row.symbol})` : row.name;
  if (typeof row?.wallet === "string") return row.wallet;
  if (typeof row?.campaignAddress === "string") return row.campaignAddress;
  if (typeof row?.campaign_address === "string") return row.campaign_address;
  return "Awaiting leader";
}

function metricFor(def: LeagueDef, row: any) {
  if (typeof row?.metric === "string") return row.metric;
  if (typeof row?.estimatedPayoutUsd === "number" && row.estimatedPayoutUsd > 0) return `$${row.estimatedPayoutUsd.toLocaleString()} est. payout`;
  if (def.key === "fastest_finish") return row?.duration_seconds ? `${row.duration_seconds}s` : def.metricLabel;
  if (def.key === "biggest_hit") return row?.bnb_amount_raw ? "Largest buy" : def.metricLabel;
  if (def.key === "top_earner") return row?.profit_raw ? "Trader PnL" : def.metricLabel;
  if (def.key === "crowd_favorite") return row?.votes_count ? `${row.votes_count} votes` : def.metricLabel;
  if (def.key === "recruiter_league") return row?.weightedScore ? `${Number(row.weightedScore).toLocaleString()} score` : def.metricLabel;
  return def.metricLabel;
}

function normalizeLeader(raw: any, fallbackIndex: number): CurrentLeagueLeader | undefined {
  const key = raw?.leagueKey || raw?.league || raw?.key;
  if (!isLeagueKey(key)) return undefined;
  const def = LEAGUES.find((league) => league.key === key)!;
  return {
    leagueKey: key,
    leagueTitle: raw?.leagueTitle || raw?.title || def.title,
    label: leaderLabel(raw) || `Winner ${fallbackIndex + 1}`,
    metric: metricFor(def, raw),
  };
}

function normalizeHistoryItems(history: any): LeagueWinnerHistoryItem[] {
  if (Array.isArray(history)) return history;

  const groups = [
    ["weekly", history?.weekly],
    ["monthly", history?.monthly],
  ] as const;
  const items: LeagueWinnerHistoryItem[] = [];

  for (const [periodName, records] of groups) {
    if (!Array.isArray(records)) continue;
    for (const record of records) {
      const epochLabel = record?.epoch?.label || record?.epoch?.rangeLabel || record?.seasonId || `${periodName} epoch ${record?.epochOffset ?? "previous"}`;
      const winners = Array.isArray(record?.winners) ? record.winners : [];
      if (!winners.length) {
        items.push({
          id: `${periodName}-${record?.epochOffset ?? items.length}-empty`,
          label: `${periodName === "weekly" ? "Weekly" : "Monthly"} history`,
          completedAt: epochLabel,
          winnerLabel: record?.prize?.playerPrizePoolUsd ? `$${Number(record.prize.playerPrizePoolUsd).toLocaleString()} player pool` : "No finalized winners yet",
        });
        continue;
      }

      winners.slice(0, 6).forEach((winner: any, index: number) => {
        const key = winner?.leagueKey || winner?.league || winner?.key;
        items.push({
          id: `${periodName}-${record?.epochOffset ?? 0}-${key || "winner"}-${index}`,
          label: `${periodName === "weekly" ? "Weekly" : "Monthly"} #${winner?.rank ?? index + 1}`,
          leagueKey: isLeagueKey(key) ? key : undefined,
          completedAt: epochLabel,
          winnerLabel: leaderLabel(winner),
        });
      });
    }
  }

  return items;
}

function rawToBigInt(value: unknown): bigint {
  try {
    return BigInt(String(value ?? "0"));
  } catch {
    return 0n;
  }
}

function prizeHasValue(prize?: LeaguePrizeMeta) {
  return rawToBigInt(prize?.availablePotRaw ?? prize?.potRaw ?? prize?.totalLeagueFeeRaw) > 0n;
}

function shouldUseOnChainCard(card?: LeagueSummaryCard) {
  if (!card) return false;
  return !Array.isArray(card.rows) || card.rows.length === 0 || card.status === "empty" || card.status === "error";
}

function mergeOnChainLeagueFallback(summary: LeagueSummaryResponse, onChain: Awaited<ReturnType<typeof fetchOnChainLeagueSummary>>): LeagueSummaryResponse {
  if (!onChain) return summary;

  const nextLeagues = summary.leagues.map((card) => {
    const fallback = onChain.cards[card.key as keyof typeof onChain.cards];
    if (!fallback) {
      return prizeHasValue(card.prize) ? card : { ...card, prize: onChain.prize };
    }
    if (!shouldUseOnChainCard(card)) {
      return prizeHasValue(card.prize) ? card : { ...card, prize: onChain.prize };
    }
    return {
      ...card,
      ...fallback,
      title: card.title || fallback.title,
      warning: card.warning || fallback.warning,
    };
  });

  const currentLeaders = nextLeagues
    .map((card) => {
      const def = LEAGUES.find((league) => league.key === card.key);
      const top = card.rows?.[0] as any;
      if (!def || !top) return undefined;
      return { leagueKey: def.key, leagueTitle: def.title, label: leaderLabel(top), metric: metricFor(def, top) } satisfies CurrentLeagueLeader;
    })
    .filter(Boolean) as CurrentLeagueLeader[];

  return {
    ...summary,
    prize: prizeHasValue(summary.prize) ? summary.prize : onChain.prize,
    leagues: nextLeagues,
    currentLeaders: summary.currentLeaders.length ? summary.currentLeaders : currentLeaders,
    trendMetrics: summary.trendMetrics?.basis === "frontend_empty" && prizeHasValue(onChain.prize)
      ? {
          basis: "onchain_live_campaign_counters",
          changeVsPreviousEpoch: { entrants: onChain.prize.leagueCount ?? 0, playerPrizePoolUsd: 0 },
          entrantsGrowthPct: null,
          prizePoolGrowthPct: null,
        }
      : summary.trendMetrics,
  };
}

function solanaPendingSummary(chain: LeagueChain, period: LeaguePeriod, epochOffset: number): LeagueSummaryResponse {
  const seasonId = `${chain}-pending-${period}-${epochOffset}`;
  return {
    chain,
    period,
    epoch: { period, epochOffset, epochStart: null, epochEnd: null, rangeEnd: null, status: "pending" },
    season: { seasonId, epochId: seasonId, chain, period, epochOffset, status: "pending" },
    seasonId,
    epochId: seasonId,
    winnerSource: { source: "pending", finalized: false },
    payoutPolicy: { minWinners: period === "weekly" ? 3 : 5, paidFieldPct: 0.15, alpha: 0.72, monthlyPlayerPrizeCapUsd: MONTHLY_PLAYER_PRIZE_CAP_USD },
    prize: { capReached: false, charityReserveUsd: 0, monthlyPlayerPrizeCapUsd: MONTHLY_PLAYER_PRIZE_CAP_USD, warning: "Solana prize feed pending." },
    leagues: LEAGUES.map((league) => ({
      key: league.key,
      title: league.title,
      status: "pending",
      entrants: 0,
      rows: [],
      warning: "Solana league feed pending. BNB standings and prize pools are not reused for Solana.",
    })),
    currentLeaders: [],
    history: [],
    trendMetrics: emptyTrendMetrics(),
    hallOfFame: emptyHallOfFame(),
  };
}

function normalizeSummaryPayload(payload: any, chain: LeagueChain, period: LeaguePeriod, epochOffset: number): LeagueSummaryResponse | undefined {
  if (!payload || !Array.isArray(payload.leagues)) return undefined;

  const cards: LeagueSummaryCard[] = [];
  const leaders: CurrentLeagueLeader[] = [];

  for (const def of LEAGUES) {
    const incoming = payload.leagues.find((item: any) => item?.key === def.key);
    const rawRows = Array.isArray(incoming?.rows) ? incoming.rows : Array.isArray(incoming?.items) ? incoming.items : [];
    const rows = normalizeRows(def, rawRows);
    const status = toStatus(incoming?.status, getStatus(rows, incoming?.warning));

    cards.push({
      key: def.key,
      title: incoming?.title || def.title,
      status,
      entrants: toNumber(incoming?.entrants, rows.length),
      rows,
      prize: incoming?.prize,
      warning: incoming?.warning,
    });

    const top = rows[0] as any;
    if (top) leaders.push({ leagueKey: def.key, leagueTitle: def.title, label: leaderLabel(top), metric: metricFor(def, top) });
  }

  const incomingLeaders = Array.isArray(payload.currentLeaders) && payload.currentLeaders.length
    ? payload.currentLeaders
    : Array.isArray(payload.current?.winners)
      ? payload.current.winners
      : [];
  const normalizedLeaders = incomingLeaders
    .map((leader: any, index: number) => normalizeLeader(leader, index))
    .filter(Boolean) as CurrentLeagueLeader[];

  return {
    chain: payload.chain === "solana" || payload.chain === "bnb" ? payload.chain : chain,
    period: payload.period === "weekly" || payload.period === "monthly" ? payload.period : period,
    epoch: payload.epoch || payload.current?.epoch || { period, epochOffset, epochStart: null, epochEnd: null, rangeEnd: null, status: chain === "solana" ? "pending" : "live" },
    season: payload.season,
    seasonId: payload.seasonId || payload.season?.seasonId,
    epochId: payload.epochId || payload.season?.epochId,
    winnerSource: payload.winnerSource,
    prize: payload.prize || payload.current?.prize,
    payoutPolicy: payload.payoutPolicy,
    leagues: cards,
    selectedLeague: payload.selectedLeague && isLeagueKey(payload.selectedLeague.key)
      ? {
          key: payload.selectedLeague.key,
          status: toStatus(payload.selectedLeague.status),
          rows: normalizeRows(LEAGUES.find((league) => league.key === payload.selectedLeague.key)!, Array.isArray(payload.selectedLeague.rows) ? payload.selectedLeague.rows : []),
          prize: payload.selectedLeague.prize,
          warning: payload.selectedLeague.warning,
        }
      : undefined,
    currentLeaders: normalizedLeaders.length ? normalizedLeaders : leaders,
    history: normalizeHistoryItems(payload.history),
    trendMetrics: (() => {
      const base = emptyTrendMetrics();
      const incoming = payload.trendMetrics || {};
      return {
        basis: String(incoming.basis || base.basis || "live_epoch").replace(/frontend_empty/gi, "live_epoch"),
        changeVsPreviousEpoch: {
          entrants: Number(incoming.changeVsPreviousEpoch?.entrants ?? 0),
          playerPrizePoolUsd: Number(incoming.changeVsPreviousEpoch?.playerPrizePoolUsd ?? 0),
        },
        entrantsGrowthPct: Number.isFinite(Number(incoming.entrantsGrowthPct)) ? Number(incoming.entrantsGrowthPct) : 0,
        prizePoolGrowthPct: Number.isFinite(Number(incoming.prizePoolGrowthPct)) ? Number(incoming.prizePoolGrowthPct) : 0,
      };
    })(),
    hallOfFame: payload.hallOfFame || emptyHallOfFame(),
  };
}

async function tryLoadFutureSummary({ chain, chainId, period, epochOffset }: LoadLeagueSummaryOptions) {
  // Mounted on frontend-api as /api/league/summary (leagueSummary.js) — never the indexer.
  const params = new URLSearchParams({ chain, chainId: String(chainId), period, epochOffset: String(epochOffset) });
  try {
    const response = await apiFetch(`/api/league/summary?${params.toString()}`, { cache: "no-store" });
    if (!response.ok) {
      console.warn("[leagueApi] /api/league/summary failed", response.status, response.url);
      return undefined;
    }
    const payload = await response.json().catch(() => null);
    if (!payload || typeof payload !== "object") return undefined;
    return normalizeSummaryPayload(payload, chain, period, epochOffset);
  } catch (error) {
    console.warn("[leagueApi] /api/league/summary error", error);
    return undefined;
  }
}

async function loadLegacySummary({ chain, chainId, period, epochOffset }: LoadLeagueSummaryOptions): Promise<LeagueSummaryResponse> {
  const results = await Promise.all(
    LEAGUES.map(async (league) => {
      const effectivePeriod = league.supports.includes(period) ? period : league.supports[0];
      const apiCategory = API_CATEGORY_BY_LEAGUE[league.key];

      // Leagues without an indexer category stay empty until summary API exists —
      // do not hit /api/league with unknown keys (returns empty and used to force on-chain).
      if (!apiCategory) {
        return [
          league.key,
          {
            items: [],
            warning:
              league.key === "recruiter_league"
                ? "Recruiter league feed is not wired to this indexer category yet."
                : "Standings for this league are not available from the live indexer yet.",
          } satisfies LegacyLeagueResponse,
        ] as const;
      }

      const params = new URLSearchParams({
        chainId: String(chainId),
        period: effectivePeriod,
        epochOffset: String(effectivePeriod === period ? epochOffset : 0),
        limit: String(getLimit(league, effectivePeriod)),
        category: apiCategory,
      });

      try {
        const response = await apiFetch(`/api/league?${params.toString()}`, { cache: "no-store" });
        const json = (await response.json()) as LegacyLeagueResponse;
        if (!response.ok) {
          return [league.key, { items: [], warning: "League feed unavailable." } satisfies LegacyLeagueResponse] as const;
        }
        return [league.key, json] as const;
      } catch {
        return [league.key, { items: [], warning: "League feed unavailable." } satisfies LegacyLeagueResponse] as const;
      }
    }),
  );

  let epoch: LeagueEpoch | undefined;
  const leagues: LeagueSummaryCard[] = [];
  const currentLeaders: CurrentLeagueLeader[] = [];
  let prize: LeaguePrizeMeta | undefined;
  let totalFeeRaw = 0n;
  let totalPotRaw = 0n;

  for (const [key, payload] of results) {
    const def = LEAGUES.find((league) => league.key === key)!;
    const rawRows = Array.isArray(payload.items) ? payload.items : [];
    const rows = normalizeRows(def, rawRows);
    const status = getStatus(rows, payload.warning);

    if (!epoch && payload.epoch) epoch = payload.epoch as LeagueEpoch;
    if (payload.prize) {
      if (!prize) prize = payload.prize as LeaguePrizeMeta;
      try {
        const fee = BigInt(String((payload.prize as any)?.totalLeagueFeeRaw ?? "0"));
        if (fee > totalFeeRaw) totalFeeRaw = fee;
      } catch {
        /* ignore */
      }
      try {
        const pot = BigInt(String((payload.prize as any)?.availablePotRaw ?? (payload.prize as any)?.potRaw ?? "0"));
        // Perfect Run is monthly only; on the weekly tab it loads the monthly pot, which is not weekly money.
        if (def.supports.includes(period)) totalPotRaw += pot;
        // accumulate category pots when total fee is missing
        if (totalFeeRaw === 0n && pot > 0n) totalFeeRaw += pot;
      } catch {
        /* ignore */
      }
    }

    leagues.push({ key, title: def.title, status, entrants: rows.length, rows, prize: payload.prize, warning: payload.warning });

    const top = rows[0] as any;
    if (top) currentLeaders.push({ leagueKey: key, leagueTitle: leagueTitle(key), label: leaderLabel(top), metric: metricFor(def, top) });
  }

  if (!epoch) {
    epoch = { period, epochOffset, epochStart: null, epochEnd: null, rangeEnd: null, status: "live" };
  }

  const hubPrize: LeaguePrizeMeta = {
    ...(prize || {}),
    basis: prize?.basis || "league_fee_only",
    period,
    totalLeagueFeeRaw: totalFeeRaw > 0n ? totalFeeRaw.toString() : prize?.totalLeagueFeeRaw || "0",
    totalPotRaw: totalPotRaw.toString(),
    potRaw: prize?.potRaw || (totalFeeRaw > 0n ? totalFeeRaw.toString() : "0"),
    availablePotRaw: prize?.availablePotRaw || prize?.potRaw || (totalFeeRaw > 0n ? totalFeeRaw.toString() : "0"),
  };

  const seasonMeta = buildSeasonIds(chain, chainId, period, epochOffset, epoch);

  return {
    chain,
    period,
    epoch,
    season: seasonMeta.season,
    seasonId: seasonMeta.seasonId,
    epochId: seasonMeta.epochId,
    prize: hubPrize,
    payoutPolicy: { minWinners: period === "weekly" ? 3 : 5, paidFieldPct: 0.15, alpha: 0.72, monthlyPlayerPrizeCapUsd: MONTHLY_PLAYER_PRIZE_CAP_USD },
    leagues,
    currentLeaders,
    history: [],
    trendMetrics: emptyTrendMetrics(),
    hallOfFame: emptyHallOfFame(),
  };
}

async function fetchOnChainLeagueSummaryBudgeted(chainId: SupportedChainId, period: LeaguePeriod) {
  try {
    return await Promise.race([
      fetchOnChainLeagueSummary(chainId, period),
      new Promise<null>((resolve) => {
        window.setTimeout(() => resolve(null), ONCHAIN_FALLBACK_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return null;
  }
}

function summaryNeedsOnChainFallback(summary: LeagueSummaryResponse) {
  const indexedLeagues = summary.leagues.filter((card) => API_CATEGORY_BY_LEAGUE[card.key]);
  const hasIndexedRows = indexedLeagues.some((card) => Array.isArray(card.rows) && card.rows.length > 0);
  // If any real indexer standings arrived, skip the multi-campaign log scan.
  if (hasIndexedRows) return false;
  // Only scan chain when prize is also missing (otherwise UI can show empty cards fast).
  return !prizeHasValue(summary.prize);
}

export async function loadLeagueSummary(options: LoadLeagueSummaryOptions): Promise<LeagueSummaryResponse> {
  const futureSummary = await tryLoadFutureSummary(options);
  if (futureSummary) {
    // Prefer indexer/summary payload. On-chain log scan is last-resort only (was always on = multi-second page).
    if (options.chain === "solana" || !summaryNeedsOnChainFallback(futureSummary)) return futureSummary;
    const onChain = await fetchOnChainLeagueSummaryBudgeted(options.chainId as SupportedChainId, options.period);
    return mergeOnChainLeagueFallback(futureSummary, onChain);
  }
  if (options.chain === "solana") {
    try {
      return await loadLegacySummary(options);
    } catch {
      const pending = solanaPendingSummary(options.chain, options.period, options.epochOffset);
      pending.prize = {
        ...pending.prize,
        warning: "Solana standings request failed. Retry — BNB boards are not reused.",
      };
      return pending;
    }
  }

  const legacySummary = await loadLegacySummary(options);
  if (!summaryNeedsOnChainFallback(legacySummary)) return legacySummary;

  const onChain = await fetchOnChainLeagueSummaryBudgeted(options.chainId as SupportedChainId, options.period);
  return mergeOnChainLeagueFallback(legacySummary, onChain);
}
