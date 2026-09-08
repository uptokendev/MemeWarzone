import { ethers } from "ethers";
import { normalizeAddress } from "@/lib/address";

const EVM_LEAGUE_CHAINS = new Set([56, 97, 4663, 46630]);

export type RewardItem = {
  period: "weekly" | "monthly";
  epochStart: string;
  epochEnd: string;
  expiresAt?: string | null;
  category: string;
  rank: number;
  amountRaw: string;
  payload: any;
  computedAt?: string;
};

export type MonthlyClaimReward = {
  category: string;
  categoryHash: string;
  rank: number;
  recipient: string;
  amountRaw: string;
  leaf: string;
  proof: string[];
  claimed: boolean;
  claimable: boolean;
  transaction: {
    to: string;
    value: string;
    data: string;
    functionName: "claim";
  };
};

export type MonthlyClaimResponse = {
  ok: boolean;
  monthId: string;
  status: "sealed" | "pending";
  isSealed: boolean;
  reconciliation: {
    rootMatches: boolean;
    winnerTotalMatches: boolean;
    readyForClaims: boolean;
  };
  eligible: boolean;
  claimableCount: number;
  claimableAmountRaw: string;
  rewards: MonthlyClaimReward[];
};

export function monthIdFromEpochStart(epochStart: string): string {
  const date = new Date(epochStart);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid monthly epoch start");
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function buildLeagueClaimMessage(args: {
  chainId: number;
  recipient: string;
  period: "weekly" | "monthly";
  epochStart: string;
  category: string;
  rank: number;
  nonce: string;
}): string {
  const { chainId, recipient, period, epochStart, category, rank, nonce } = args;
  return [
    "MemeWarzone League",
    "Action: LEAGUE_CLAIM",
    `ChainId: ${chainId}`,
    `Recipient: ${normalizeAddress(recipient)}`,
    `Period: ${period}`,
    `EpochStart: ${epochStart}`,
    `Category: ${category}`,
    `Rank: ${rank}`,
    `Nonce: ${nonce}`,
  ].join("\n");
}

export async function reconcileEvmLeagueClaims(chainId: number, address: string): Promise<{
  reconciledCount: number;
  items?: Array<{ txHash?: string | null }>;
  unresolved?: Array<{ code?: string; reason?: string }>;
}> {
  if (!EVM_LEAGUE_CHAINS.has(Number(chainId))) return { reconciledCount: 0 };
  const { apiFetch } = await import("@/lib/apiBase");
  const r = await apiFetch(`/api/league`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "reconcile-evm-claims",
      chainId: Number(chainId),
      recipient: normalizeAddress(address),
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || "League claim reconciliation failed");
  return j;
}

export async function fetchClaimableRewards(chainId: number, address: string): Promise<RewardItem[]> {
  if (EVM_LEAGUE_CHAINS.has(Number(chainId))) {
    try {
      await reconcileEvmLeagueClaims(chainId, address);
    } catch (error) {
      console.warn("[rewardsApi] EVM League reconciliation deferred:", error);
    }
  }
  const qs = new URLSearchParams({ chainId: String(chainId), address: normalizeAddress(address) });
  const r = await fetch(`/api/rewards?${qs.toString()}`);
  const j = await r.json();
  return Array.isArray(j?.rewards) ? (j.rewards as RewardItem[]) : [];
}

export async function fetchMonthlyClaim(
  chainId: number,
  monthId: string,
  address: string
): Promise<MonthlyClaimResponse> {
  const qs = new URLSearchParams({
    chainId: String(chainId),
    monthId,
    wallet: normalizeAddress(address),
  });
  const { apiFetch } = await import("@/lib/apiBase");
  const r = await apiFetch(`/api/league?${qs.toString()}`);
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error || "Failed to load monthly claim");
  return j as MonthlyClaimResponse;
}

export async function submitLeagueClaim(params: {
  chainId: number;
  period: "weekly" | "monthly";
  epochStart: string;
  category: string;
  rank: number;
  recipient: string;
  nonce: string;
  signature: string;
}): Promise<
  | { ok: true; txHash: string; claimedAt?: string | null; amountRaw?: string }
  | {
      ok: true;
      mode: "merkle";
      vaultAddress: string;
      epochId: string;
      epochTotal: string;
      root: string;
      categoryHash: string;
      recipient: string;
      rank: number;
      amountRaw: string;
      proof: string[];
    }
  | {
      ok: true;
      mode: "solana_treasury";
      programId: string;
      vaultAddress: string;
      configAddress: string;
      epochAddress: string;
      claimReceiptAddress: string;
      periodCode: number;
      epochStartSec: number;
      epochTotal: string;
      root: string;
      categoryHash: string;
      recipient: string;
      rank: number;
      amountRaw: string;
      proof: string[];
    }
> {
  const { apiFetch } = await import("@/lib/apiBase");
  const r = await apiFetch(`/api/league`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "claim", ...params }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error || "Claim failed");
  return j;
}

export async function recordLeagueClaimTx(params: {
  chainId: number;
  period: "weekly" | "monthly";
  epochStart: string;
  category: string;
  rank: number;
  recipient: string;
  nonce: string;
  signature: string;
  txHash: string;
}): Promise<{ ok: boolean; txHash?: string | null }> {
  const { apiFetch } = await import("@/lib/apiBase");
  const r = await apiFetch(`/api/league`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "record", ...params }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error || "Record failed");
  return j;
}

export function formatWeiToBnb(weiLike: string | number | bigint, decimals = 18): string {
  try {
    const v = typeof weiLike === "bigint" ? weiLike : BigInt(String(weiLike));
    return ethers.formatUnits(v, decimals);
  } catch {
    return "0";
  }
}
