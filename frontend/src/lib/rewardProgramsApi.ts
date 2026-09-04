import { buildRealtimeApiUrl } from "@/lib/realtimeApi";
import { apiFetch } from "@/lib/apiBase";

async function parseJson(res: Response) {
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(String((json as any)?.error || (json as any)?.message || `Request failed (${res.status})`));
  }
  return json as any;
}

function buildQuery(params: Record<string, string | number | null | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

function nativeSymbolForChain(chainId?: number | null, fallback?: string | null): string {
  const chain = Number(chainId || 0);
  if (chain === 101 || chain === 102) return "SOL";
  if (chain === 4663 || chain === 46630) return "ETH";
  if (chain === 56 || chain === 97) return "BNB";
  return String(fallback || "").trim() || "BNB";
}

export type RewardLedgerItem = {
  id: string;
  rewardType: string;
  sourceId: string | null;
  sourceLabel: string | null;
  walletAddress: string;
  userId: string | null;
  chain: string;
  chainId: number | null;
  tokenSymbol: string;
  amount: string;
  amountUsd: string | null;
  status: "pending" | "approved" | "claimable" | "claim_pending" | "claimed" | "failed" | "expired" | "cancelled";
  claimBatchId: string | null;
  claimTxHash: string | null;
  claimError: string | null;
  metadata: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
  claimableAt: string | null;
  claimedAt: string | null;
  expiresAt: string | null;
};

export type RewardsMeResponse = {
  address: string;
  chainId: number | null;
  claimable: RewardLedgerItem[];
  items: RewardLedgerItem[];
  totals: {
    claimableAmount: string;
    claimedAmount: string;
    expiredAmount: string;
  };
  materializedAt: string | null;
};

export type AirdropCurrent = {
  status: string;
  currentEpochId: number | null;
  current: {
    id: string;
    rewardType: string;
    chain: string;
    chainId: number | null;
    tokenSymbol: string;
    status: string;
    totalAmount: string;
    recipientCount: number;
    claimableCount: number;
    claimedCount: number;
    failedCount: number;
    source: string | null;
    metadata: Record<string, unknown>;
    createdAt: string | null;
    publishedAt: string | null;
    closedAt: string | null;
  } | null;
  prizePool: {
    chain: string;
    tokenSymbol: string;
    amount: string;
    status: string;
  } | null;
  materializedAt: string | null;
};

export type WalletEligibilityItem = {
  id: number;
  epochId: number;
  chainId: number;
  epochType: string;
  startAt: string;
  endAt: string;
  program: string;
  isEligible: boolean;
  reasonCodes: string[];
  computedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type AirdropWinner = {
  id: number;
  drawId: number;
  epochId: number;
  chainId: number;
  program: string;
  walletAddress: string;
  winnerRank: number;
  weightTier: number;
  weightValue: number;
  activityScore: string;
  payoutAmount: string;
  metadataJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type SquadLeaderboardItem = {
  recruiterId: number;
  recruiterCode: string | null;
  recruiterDisplayName: string | null;
  recruiterStatus: string | null;
  recruiterIsOg: boolean;
  rawScore: string;
  effectiveScore: string;
  estimatedAllocationAmount: string;
  globalCapAmount: string;
  globalCapApplied: boolean;
  activeMemberCount: number;
  eligibleMemberCount: number;
  currentEpochId: number;
  currentEpochStartAt: string;
  currentEpochEndAt: string;
};

export type SquadMemberItem = {
  walletAddress: string;
  recruiterId: number;
  recruiterCode: string | null;
  recruiterDisplayName: string | null;
  memberRole?: string | null;
  isEligible: boolean;
  reasonCodes: string[];
  rawScore: string;
  estimatedPayoutAmount: string;
  memberCapAmount: string;
  memberCapApplied: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

export type SolanaRewardReconciliationResult = {
  walletAddress: string;
  chainId: number;
  requestedCount: number;
  checkedCount: number;
  reconciledCount: number;
  items: Array<{
    rewardLedgerId: string;
    status: string;
    txHash?: string | null;
    claimReceiptAddress?: string | null;
    slot?: number | null;
  }>;
  unresolved: Array<{
    rewardLedgerId: string;
    reason: string;
    code: string;
  }>;
  reconciledAt: string;
};

function normalizeRewardItem(item: any, requestedChainId?: number | null): RewardLedgerItem {
  const chainId = Number(item?.chainId ?? item?.chain_id ?? requestedChainId ?? 0) || null;
  return {
    ...item,
    chainId,
    tokenSymbol: nativeSymbolForChain(chainId, item?.tokenSymbol ?? item?.token_symbol),
  } as RewardLedgerItem;
}

export async function fetchRewardsMe(params: {
  walletAddress: string;
  chainId?: number | null;
  rewardType?: string | null;
  limit?: number;
}): Promise<RewardsMeResponse> {
  const res = await fetch(buildRealtimeApiUrl(`/api/rewards/me${buildQuery({
    address: params.walletAddress,
    chainId: params.chainId,
    rewardType: params.rewardType,
    limit: params.limit ?? 100,
  })}`));
  const json = await parseJson(res);
  const responseChainId = Number(json?.chainId ?? params.chainId ?? 0) || null;
  return {
    address: String(json?.address || params.walletAddress),
    chainId: responseChainId,
    claimable: Array.isArray(json?.claimable) ? json.claimable.map((item: any) => normalizeRewardItem(item, responseChainId)) : [],
    items: Array.isArray(json?.items) ? json.items.map((item: any) => normalizeRewardItem(item, responseChainId)) : [],
    totals: json?.totals || { claimableAmount: "0", claimedAmount: "0", expiredAmount: "0" },
    materializedAt: json?.materializedAt || null,
  };
}

async function fetchRewardClaimsRaw(params: {
  walletAddress: string;
  chainId?: number | null;
  rewardType?: string | null;
  limit?: number;
}): Promise<RewardLedgerItem[]> {
  const res = await fetch(buildRealtimeApiUrl(`/api/rewards/me/claims${buildQuery({
    address: params.walletAddress,
    chainId: params.chainId,
    rewardType: params.rewardType,
    limit: params.limit ?? 100,
  })}`));
  const json = await parseJson(res);
  return Array.isArray(json?.items)
    ? json.items.map((item: any) => normalizeRewardItem(item, params.chainId))
    : [];
}

export async function reconcileSolanaRewardClaims(params: {
  walletAddress: string;
  chainId: number;
  rewardLedgerIds: string[];
}): Promise<SolanaRewardReconciliationResult> {
  const res = await fetch(buildRealtimeApiUrl("/api/rewards"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "reconcile-solana-claims",
      walletAddress: params.walletAddress,
      chainId: params.chainId,
      rewardLedgerIds: params.rewardLedgerIds,
    }),
  });
  return parseJson(res) as Promise<SolanaRewardReconciliationResult>;
}

export async function fetchRewardClaims(params: {
  walletAddress: string;
  chainId?: number | null;
  rewardType?: string | null;
  limit?: number;
}): Promise<RewardLedgerItem[]> {
  const initial = await fetchRewardClaimsRaw(params);
  const chainId = Number(params.chainId || 0);
  if (![101, 102].includes(chainId)) return initial;

  const stale = initial.filter((item) =>
    (item.status === "claim_pending" || item.status === "failed") &&
    (item.rewardType === "airdrop" || item.rewardType === "squad")
  );
  if (!stale.length) return initial;

  try {
    const reconciliation = await reconcileSolanaRewardClaims({
      walletAddress: params.walletAddress,
      chainId,
      rewardLedgerIds: stale.slice(0, 10).map((item) => item.id),
    });

    if (reconciliation.reconciledCount > 0) {
      return fetchRewardClaimsRaw(params);
    }

    const blocked = new Set(
      reconciliation.unresolved
        .filter((item) => item.code !== "SOLANA_CLAIM_RECEIPT_MISSING")
        .map((item) => item.rewardLedgerId),
    );
    if (blocked.size) {
      return initial.map((item) => blocked.has(item.id)
        ? { ...item, status: "claim_pending", claimError: "On-chain reconciliation is pending." }
        : item);
    }
  } catch (error) {
    console.warn("[rewardProgramsApi] Solana claim reconciliation deferred:", error);
  }

  return initial;
}

export async function requestRewardClaim(input: {
  walletAddress: string;
  chainId?: number | null;
  rewardLedgerIds: string[];
}): Promise<RewardLedgerItem[]> {
  const res = await fetch(buildRealtimeApiUrl("/api/rewards/me/claims"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const json = await parseJson(res);
  return Array.isArray(json?.items)
    ? json.items.map((item: any) => normalizeRewardItem(item, input.chainId))
    : [];
}

export type AirdropPreviewWallet = {
  walletAddress: string;
  program: string;
  volumeRaw?: string;
  estimatedShareRaw?: string;
  tradeCount?: number;
  activeDays?: number;
  uniqueBuyers?: number;
  eligibleCampaignCount?: number;
  finalWeight?: number;
};

export type AirdropPreview = {
  ok: boolean;
  claimsOpen: boolean;
  chainId: number;
  tokenSymbol: string;
  epoch: { id: string; start: string; end: string };
  estimatedPoolRaw: string;
  traders: AirdropPreviewWallet[];
  creators: AirdropPreviewWallet[];
  traderCount: number;
  creatorCount: number;
  tradeCount?: number;
  note?: string;
};

export async function fetchAirdropPreview(chainId?: number | null): Promise<AirdropPreview | null> {
  const res = await fetch(buildRealtimeApiUrl(`/api/airdrops/preview${buildQuery({ chainId })}`));
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  if (!json || json.ok === false) return null;
  const responseChainId = Number(json?.chainId ?? chainId ?? 0) || 0;
  return {
    ...json,
    chainId: responseChainId,
    tokenSymbol: nativeSymbolForChain(responseChainId, json?.tokenSymbol),
  } as AirdropPreview;
}

export async function fetchAirdropCurrent(chainId?: number | null): Promise<AirdropCurrent> {
  const res = await fetch(buildRealtimeApiUrl(`/api/airdrops/current${buildQuery({ chainId })}`));
  if (res.status === 404) {
    return { status: "empty", currentEpochId: null, current: null, prizePool: null, materializedAt: null };
  }
  const json = await parseJson(res);
  const responseChainId = Number(json?.current?.chainId ?? chainId ?? 0) || null;
  const symbol = nativeSymbolForChain(responseChainId, json?.current?.tokenSymbol ?? json?.prizePool?.tokenSymbol);
  return {
    status: String(json?.status || "empty"),
    currentEpochId: json?.currentEpochId ?? null,
    current: json?.current ? { ...json.current, chainId: responseChainId, tokenSymbol: symbol } : null,
    prizePool: json?.prizePool ? { ...json.prizePool, tokenSymbol: symbol } : null,
    materializedAt: json?.materializedAt || null,
  };
}

export async function fetchWalletRewardEligibility(walletAddress: string, limit = 20, program?: string | null): Promise<WalletEligibilityItem[]> {
  const res = await fetch(buildRealtimeApiUrl(`/api/rewards/me/eligibility${buildQuery({ address: walletAddress, limit, program })}`));
  const json = await parseJson(res);
  return Array.isArray(json?.items) ? json.items as WalletEligibilityItem[] : [];
}

export async function fetchAirdropWinners(params: {
  epochId?: number | null;
  chainId?: number | null;
  program?: string | null;
  walletAddress?: string | null;
  limit?: number;
} = {}): Promise<AirdropWinner[]> {
  const res = await fetch(buildRealtimeApiUrl(`/api/airdrops/winners${buildQuery(params)}`));
  if (res.status === 404) return [];
  const json = await parseJson(res);
  return Array.isArray(json?.items) ? json.items as AirdropWinner[] : [];
}

export async function fetchSquadLeaderboard(epochId?: number | null) {
  const res = await fetch(buildRealtimeApiUrl(`/api/squads${buildQuery({ epochId })}`));
  return parseJson(res);
}

export async function fetchSquadMembers(params: {
  epochId?: number | null;
  recruiterCode?: string | null;
  walletAddress?: string | null;
  limit?: number;
}) {
  const query = buildQuery(params);

  if (params.walletAddress) {
    const canonical = await apiFetch(`/api/squads/members${query}`, { cache: "no-store" as RequestCache })
      .then(parseJson)
      .catch(() => null);
    if (Array.isArray(canonical?.items) && canonical.items.length > 0) return canonical;
  }

  const realtime = await fetch(buildRealtimeApiUrl(`/api/squads/members${query}`))
    .then(parseJson)
    .catch(() => null);
  if (Array.isArray(realtime?.items) && realtime.items.length > 0) return realtime;

  const canonical = await apiFetch(`/api/squads/members${query}`, { cache: "no-store" as RequestCache });
  return parseJson(canonical);
}
