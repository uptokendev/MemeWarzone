import { useEffect, useMemo, useState } from "react";
import { Contract, formatEther } from "ethers";
import { Gift, Trophy, Users, Swords, type LucideIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { CommandCenterCard } from "@/components/command-center/CommandCenterCard";
import { useCommandCenterData } from "@/components/command-center/CommandCenterContext";
import { CreatorFeesPanel, EvmCreatorFeesPanel } from "@/components/command-center/CreatorFeesPanel";
import { RecruiterNativePayoutsPanel } from "@/components/command-center/RecruiterNativePayoutsPanel";
import { ArenaWarPoolClaimButton } from "@/components/arena/ArenaWarPoolClaimButton";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { addressesMatch } from "@/lib/address";
import { apiFetch } from "@/lib/apiBase";
import { fetchRewardClaims, type RewardLedgerItem } from "@/lib/rewardProgramsApi";
import {
  REWARD_DISTRIBUTOR_ABI,
  createRewardClaimIntent,
  recordRewardClaimFailure,
  recordRewardClaimTx,
} from "@/lib/rewardDistributor";
import { fetchRecruiterSignupStatus } from "@/lib/recruiterApi";
import { submitSolanaLeagueClaim, submitSolanaLeagueClaims } from "@/lib/solanaLeagueClaim";
import { useFeedSession } from "@/hooks/useFeedSession";
import { submitSolanaAirdropClaim } from "@/lib/solanaRewardClaim";
import { getConfiguredSolanaRewardChainId, isSolanaRewardChainId } from "@/lib/solanaRewardNetwork";
import { signSolanaMessage } from "@/lib/solanaWallet";

type RewardCardState = "claimable" | "pending" | "failed" | "expired" | "empty";

type RewardCardConfig = {
  rewardType: string;
  title: string;
  description: string;
  icon: LucideIcon;
  buttonLabel: string;
  amountLabel: string;
  state: RewardCardState;
  items: RewardLedgerItem[];
};

type LeagueRewardMetadata = {
  claimSource: "league_api";
  period: "weekly" | "monthly" | "mwl_monthly" | "quarterly";
  epochStart: string;
  epochEnd: string | null;
  expiresAt: string | null;
  category: string;
  rank: number;
  recipient: string;
  computedAt: string | null;
  payload: Record<string, unknown>;
};

type LeagueRewardRow = {
  // Quarterly finals claim through the same rail once the client supports
  // period code 2 (solanaRewardV0Claim.ts); the API only lists weekly/monthly today.
  period: "weekly" | "monthly" | "mwl_monthly" | "quarterly";
  epochStart: string;
  epochEnd?: string | null;
  expiresAt?: string | null;
  category: string;
  rank: number;
  amountRaw: string;
  payload?: Record<string, unknown>;
  computedAt?: string | null;
  /** Solana: false until the operator sealed the epoch root on-chain. */
  claimable?: boolean;
  rootPublishedAt?: string | null;
  rootTxHash?: string | null;
};

type PreparedSolanaLeagueClaim = {
  ok: boolean;
  mode: "solana_treasury";
  chainId: number;
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
};

const ACTIVE_SQUAD_STATES = new Set(["in_squad", "linked_squad", "active_squad", "squad_member", "member"]);
const LAMPORTS_PER_SOL = 1_000_000_000;

const REWARD_COPY: Record<string, { title: string; description: string; icon: LucideIcon }> = {
  league: {
    title: "League Rewards",
    description: "Rewards earned from weekly or monthly league placements.",
    icon: Trophy,
  },
  airdrop: {
    title: "Airdrop Rewards",
    description: "Airdrop rewards connected to this wallet.",
    icon: Gift,
  },
  recruiter: {
    title: "Recruiter Rewards",
    description: "Rewards earned through recruiter activity.",
    icon: Users,
  },
  squad: {
    title: "Squad Rewards",
    description: "Squad rewards earned through your recruiter squad.",
    icon: Users,
  },
  battle: {
    title: "Battle Rewards",
    description: "Rewards earned from battle participation.",
    icon: Swords,
  },
  tournament: {
    title: "Tournament Rewards",
    description: "Tournament rewards connected to this wallet.",
    icon: Trophy,
  },
  campaign: {
    title: "Campaign Rewards",
    description: "Campaign rewards connected to this wallet.",
    icon: Gift,
  },
  manual: {
    title: "Manual Rewards",
    description: "Manual rewards assigned by the MemeWarzone team.",
    icon: Gift,
  },
  future: {
    title: "Future Rewards",
    description: "Future reward programs will appear here.",
    icon: Gift,
  },
};

function hasActiveSquad(value?: string | null, recruiterLinkState?: string | null) {
  const recruiterState = String(recruiterLinkState || "").trim().toLowerCase();
  if (recruiterState.includes("self_recruiter") || recruiterState.includes("recruiter_wallet")) return false;
  const state = String(value || "").trim().toLowerCase();
  return ACTIVE_SQUAD_STATES.has(state);
}

function isSolana(chainId?: number | null) {
  return isSolanaRewardChainId(chainId);
}

function isRobinhood(chainId?: number | null) {
  const id = Number(chainId || 0);
  return id === 4663 || id === 46630;
}

function rewardNativeSymbol(chainId?: number | null) {
  if (isSolana(chainId)) return "SOL";
  if (isRobinhood(chainId)) return "ETH";
  return "BNB";
}

function rewardChainLabel(chainId?: number | null) {
  if (isSolana(chainId)) return "Solana";
  if (isRobinhood(chainId)) return "Robinhood";
  return "BNB";
}

function formatNativeAmount(raw: string, chainId?: number | null, symbol?: string | null) {
  const nativeSymbol = symbol || rewardNativeSymbol(chainId);
  try {
    if (isSolana(chainId)) {
      const value = Number(BigInt(raw || "0")) / LAMPORTS_PER_SOL;
      return `${value.toLocaleString(undefined, { maximumFractionDigits: value >= 100 ? 2 : 9 })} ${nativeSymbol}`;
    }
    const value = Number(formatEther(BigInt(raw || "0")));
    return `${value.toLocaleString(undefined, { maximumFractionDigits: value >= 100 ? 2 : 6 })} ${nativeSymbol}`;
  } catch {
    return `0 ${nativeSymbol}`;
  }
}

function amountSum(items: RewardLedgerItem[]) {
  return items.reduce((sum, item) => {
    try {
      return sum + BigInt(item.amount || "0");
    } catch {
      return sum;
    }
  }, 0n);
}

function rewardState(items: RewardLedgerItem[]): RewardCardState {
  if (items.some((item) => item.status === "claimable")) return "claimable";
  if (items.some((item) => item.status === "claim_pending")) return "pending";
  if (items.some((item) => item.status === "failed")) return "failed";
  if (items.some((item) => item.status === "expired")) return "expired";
  return "empty";
}

function getRewardStateCopy(state: RewardCardState) {
  switch (state) {
    case "claimable":
      return { label: "Ready", amountCaption: "Available to claim", disabled: false };
    case "pending":
      return { label: "Pending", amountCaption: "Claim in progress", disabled: true };
    case "failed":
      return { label: "Failed", amountCaption: "Retry available", disabled: false };
    case "expired":
      return { label: "Expired", amountCaption: "Claim window closed", disabled: true };
    case "empty":
    default:
      return { label: "No rewards yet", amountCaption: "Available to claim", disabled: true };
  }
}

function hasRecruiterAccess(recruiterLinkState?: string | null, isRecruiterFlag?: boolean) {
  if (isRecruiterFlag) return true;
  const state = String(recruiterLinkState || "").trim().toLowerCase();
  if (!state || state === "unlinked") return false;
  return (
    state.includes("self_recruiter") ||
    state.includes("recruiter_wallet") ||
    state.includes("recruiter_owner") ||
    state.includes("recruiter")
  );
}

function buildRewardCards(
  items: RewardLedgerItem[],
  squadState?: string | null,
  recruiterLinkState?: string | null,
  chainId?: number | null,
): RewardCardConfig[] {
  const squadOk = hasActiveSquad(squadState, recruiterLinkState);

  const grouped = new Map<string, RewardLedgerItem[]>();
  for (const item of items) {
    const type = String(item.rewardType || "future").toLowerCase();
    if (!grouped.has(type)) grouped.set(type, []);
    grouped.get(type)!.push(item);
  }

  const baseline = ["league", "airdrop"];
  if (squadOk || grouped.has("squad")) baseline.push("squad");

  const orderedTypes = Array.from(new Set([...baseline, ...grouped.keys()])).filter((type) => {
    if (type === "recruiter") return (grouped.get("recruiter")?.length ?? 0) > 0;
    if (type === "squad") return squadOk || (grouped.get("squad")?.length ?? 0) > 0;
    return true;
  });

  return orderedTypes.map((rewardType) => {
    const copy = REWARD_COPY[rewardType] || REWARD_COPY.future;
    const groupItems = grouped.get(rewardType) || [];
    const first = groupItems[0];
    const state = rewardState(groupItems);
    return {
      rewardType,
      title: copy.title,
      description: copy.description,
      icon: copy.icon,
      buttonLabel: state === "failed" ? "Retry Claim" : `Claim ${copy.title}`,
      amountLabel: formatNativeAmount(String(amountSum(groupItems)), first?.chainId ?? chainId, first?.tokenSymbol),
      state,
      items: groupItems,
    };
  });
}

async function parseApiJson(res: Response) {
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json as any)?.ok === false) {
    throw new Error(String((json as any)?.error || (json as any)?.message || `Request failed (${res.status})`));
  }
  return json as any;
}

function buildLeagueRewardId(chainId: number, reward: LeagueRewardRow) {
  return `league:${chainId}:${reward.period}:${reward.epochStart}:${reward.category}:${reward.rank}`;
}

function readLeagueRewardMetadata(item: RewardLedgerItem): LeagueRewardMetadata | null {
  const metadata = item.metadata as Partial<LeagueRewardMetadata> | undefined;
  return metadata?.claimSource === "league_api" ? (metadata as LeagueRewardMetadata) : null;
}

// Major War League prizes read as "Major War League September 2026 · #1"; pre-grad keep their key.
function leagueRewardLabel(metadata: LeagueRewardMetadata): string {
  const start = new Date(String(metadata.epochStart || ""));
  const valid = Number.isFinite(start.getTime());
  if (metadata.period === "mwl_monthly" && valid) {
    return `Major War League ${start.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })} · #${metadata.rank}`;
  }
  if (metadata.period === "quarterly" && valid) {
    return `Quarterly Championship Q${Math.floor(start.getUTCMonth() / 3) + 1} ${start.getUTCFullYear()} · #${metadata.rank}`;
  }
  return `${metadata.period}:${metadata.category}:${metadata.rank}`;
}

async function fetchLeagueRewardItems(walletAddress?: string | null, chainId?: number | null): Promise<RewardLedgerItem[]> {
  if (!walletAddress || chainId == null || !Number.isFinite(Number(chainId))) return [];

  const query = new URLSearchParams({ address: walletAddress, chainId: String(chainId) });
  const res = await apiFetch(`/api/rewards?${query.toString()}`, { cache: "no-store" });
  const json = await parseApiJson(res);
  const rewards = Array.isArray(json?.rewards) ? (json.rewards as LeagueRewardRow[]) : [];

  return rewards.map((reward) => {
    const metadata: LeagueRewardMetadata = {
      claimSource: "league_api",
      period: reward.period,
      epochStart: reward.epochStart,
      epochEnd: reward.epochEnd || null,
      expiresAt: reward.expiresAt || null,
      category: String(reward.category || "").toLowerCase(),
      rank: Number(reward.rank || 0),
      recipient: walletAddress,
      computedAt: reward.computedAt || null,
      payload: reward.payload && typeof reward.payload === "object" ? reward.payload : {},
    };

    const id = Number(chainId);
    const solana = isSolanaRewardChainId(id);
    const robinhood = isRobinhood(id);
    return {
      id: buildLeagueRewardId(id, reward),
      rewardType: "league",
      sourceId: null,
      sourceLabel: leagueRewardLabel(metadata),
      walletAddress,
      userId: null,
      chain: solana ? "solana" : robinhood ? "robinhood" : "bnb",
      chainId: id,
      tokenSymbol: rewardNativeSymbol(id),
      amount: String(reward.amountRaw || "0"),
      amountUsd: null,
      // The API says whether the epoch root is sealed on-chain; a prize whose
      // root is still pending shows as "Pending" and cannot be claimed yet.
      status: reward.claimable === false ? "claim_pending" : "claimable",
      claimBatchId: null,
      claimTxHash: null,
      claimError: reward.claimable === false ? "Epoch root not published on-chain yet." : null,
      metadata,
      createdAt: metadata.computedAt || metadata.epochEnd || metadata.epochStart,
      updatedAt: metadata.computedAt || metadata.epochEnd || metadata.epochStart,
      claimableAt: metadata.epochEnd || metadata.computedAt,
      claimedAt: null,
      expiresAt: metadata.expiresAt,
    } satisfies RewardLedgerItem;
  });
}

async function fetchWalletNonce(chainId: number, walletAddress: string): Promise<string> {
  const query = new URLSearchParams({ chainId: String(chainId), address: walletAddress });
  const res = await apiFetch(`/api/auth/nonce?${query.toString()}`, { cache: "no-store" });
  const json = await parseApiJson(res);
  if (!json?.nonce) throw new Error("League claim nonce missing from response.");
  return String(json.nonce);
}

function buildLeagueClaimMessage(input: {
  chainId: number;
  recipient: string;
  period: "weekly" | "monthly" | "mwl_monthly" | "quarterly";
  epochStart: string;
  category: string;
  rank: number;
  nonce: string;
}) {
  return [
    "MemeWarzone League",
    "Action: LEAGUE_CLAIM",
    `ChainId: ${input.chainId}`,
    `Recipient: ${input.recipient}`,
    `Period: ${input.period}`,
    `EpochStart: ${input.epochStart}`,
    `Category: ${input.category}`,
    `Rank: ${input.rank}`,
    `Nonce: ${input.nonce}`,
  ].join("\n");
}

/** League claim/record body; with the 30-day sign-in no nonce or signature is sent (2026-10-08). */
function leagueClaimRequest(action: "claim" | "record", metadata: LeagueRewardMetadata, walletAddress: string, chainId: number, sessionToken: string, txHash?: string) {
  return apiFetch("/api/league", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({
      action,
      chainId,
      period: metadata.period,
      epochStart: metadata.epochStart,
      category: metadata.category,
      rank: metadata.rank,
      recipient: walletAddress,
      ...(txHash ? { txHash } : {}),
    }),
  });
}

async function prepareLeagueRewardClaim(
  metadata: LeagueRewardMetadata,
  walletAddress: string,
  chainId: number,
  sessionToken = "",
): Promise<PreparedSolanaLeagueClaim | { alreadyPaid: true; txHash: string }> {
  if (sessionToken) {
    const json = await parseApiJson(await leagueClaimRequest("claim", metadata, walletAddress, chainId, sessionToken));
    if (json?.mode !== "solana_treasury") {
      if (json?.txHash) return { alreadyPaid: true, txHash: String(json.txHash) };
      throw new Error("The server did not return claim data for this prize. Refresh and try again.");
    }
    return { ...json, chainId } as PreparedSolanaLeagueClaim;
  }
  const nonce = await fetchWalletNonce(chainId, walletAddress);
  const message = buildLeagueClaimMessage({
    chainId,
    recipient: walletAddress,
    period: metadata.period,
    epochStart: metadata.epochStart,
    category: metadata.category,
    rank: metadata.rank,
    nonce,
  });
  const { signature } = await signSolanaMessage(message, walletAddress);
  const res = await apiFetch("/api/league", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "claim",
      chainId,
      period: metadata.period,
      epochStart: metadata.epochStart,
      category: metadata.category,
      rank: metadata.rank,
      recipient: walletAddress,
      nonce,
      signature,
    }),
  });
  const json = await parseApiJson(res);
  // The server answers {ok, txHash, claimedAt} for a prize it already paid (idempotent claim). That
  // answer has no claim data: passing it on crashed as "Invalid category hash" (2026-10-03, $ASK).
  if (json?.mode !== "solana_treasury") {
    if (json?.txHash) return { alreadyPaid: true, txHash: String(json.txHash) };
    throw new Error("The server did not return claim data for this prize. Refresh and try again.");
  }
  return { ...json, chainId } as PreparedSolanaLeagueClaim;
}

async function recordLeagueRewardClaim(
  metadata: LeagueRewardMetadata,
  walletAddress: string,
  chainId: number,
  txHash: string,
  sessionToken = "",
) {
  if (sessionToken) {
    // The server reads the payout on-chain before it records it; right after confirmation an RPC can
    // lag, so a "not confirmed yet" answer is retried a few times.
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await parseApiJson(await leagueClaimRequest("record", metadata, walletAddress, chainId, sessionToken, txHash));
      } catch (error) {
        lastError = error;
        if (!/not confirmed|missing or failed|not available yet|CONFIRMATIONS_PENDING/i.test(String((error as Error)?.message || ""))) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2500));
      }
    }
    throw lastError;
  }
  const nonce = await fetchWalletNonce(chainId, walletAddress);
  const message = buildLeagueClaimMessage({
    chainId,
    recipient: walletAddress,
    period: metadata.period,
    epochStart: metadata.epochStart,
    category: metadata.category,
    rank: metadata.rank,
    nonce,
  });
  const { signature } = await signSolanaMessage(message, walletAddress);
  const res = await apiFetch("/api/league", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "record",
      chainId,
      period: metadata.period,
      epochStart: metadata.epochStart,
      category: metadata.category,
      rank: metadata.rank,
      recipient: walletAddress,
      nonce,
      signature,
      txHash,
    }),
  });
  return parseApiJson(res);
}

type BattleClaimItem = {
  battleId: string;
  chainId: number;
  kind?: "battle" | "tournament";
  nativeSymbol?: string;
  title?: string | null;
  settledAt?: string | null;
};

type BattleClaimStatus =
  | { kind: "loading" }
  | { kind: "claimable"; amount: string | null }
  | { kind: "claimed" }
  | { kind: "waiting" }
  | { kind: "unknown" };

// Reads the same claim-intent the Claim button uses, only to show the amount and whether the prize
// was already collected. The claim itself is still the button's unchanged flow.
function readBattleClaimStatus(json: any, chainId: number): BattleClaimStatus {
  if (!json || json.ok === false) return { kind: "unknown" };
  if (json.chain === "solana" && json.resolved === false) return { kind: "waiting" };
  if (json.claimMethod === "claimPlace") return { kind: "claimable", amount: null };
  if (json.claimedWinner === true) return { kind: "claimed" };
  const raw = String(json.pendingWinner ?? "");
  if (!/^\d+$/.test(raw)) return { kind: "claimable", amount: null };
  if (BigInt(raw) === 0n) return { kind: "claimed" };
  const decimals = isSolana(chainId) ? 9 : 18;
  const whole = Number(BigInt(raw)) / 10 ** decimals;
  return { kind: "claimable", amount: whole.toLocaleString(undefined, { maximumFractionDigits: 4 }) };
}

function BattleClaimRow({ item }: { item: BattleClaimItem }) {
  const [status, setStatus] = useState<BattleClaimStatus>({ kind: "loading" });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setStatus({ kind: "loading" });
    apiFetch(`/api/arena/war-pools/${encodeURIComponent(item.battleId)}/claim-intent`, { cache: "no-store" })
      .then(async (res) => {
        const json = await res.json().catch(() => null);
        if (res.status === 409) return { kind: "waiting" } as BattleClaimStatus;
        return readBattleClaimStatus(json, item.chainId);
      })
      .catch(() => ({ kind: "unknown" }) as BattleClaimStatus)
      .then((next) => { if (!cancelled) setStatus(next); });
    return () => { cancelled = true; };
  }, [item.battleId, item.chainId, nonce]);

  const symbol = item.nativeSymbol || "";
  const when = item.settledAt ? new Date(item.settledAt).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-[14px] border border-mw-border bg-mw-surface p-3 font-mw-body text-mw-text" data-battle-claim={item.battleId}>
      <div className="min-w-0">
        <div className="truncate text-sm font-bold">
          {item.title || (item.kind === "tournament" ? "Tournament prize" : "Battle win")}
        </div>
        <div className="text-xs text-mw-muted">
          {[when, status.kind === "claimable" && status.amount ? `${status.amount} ${symbol}` : null].filter(Boolean).join(" · ") || item.battleId}
        </div>
      </div>
      {status.kind === "claimed" ? (
        <span className="inline-flex h-[22px] items-center rounded-full border border-[#1F5133] px-2 text-xs font-semibold text-[#6EE7A0]">Claimed</span>
      ) : status.kind === "waiting" ? (
        <span className="text-xs text-mw-muted">Waiting for on-chain result</span>
      ) : status.kind === "loading" ? (
        <span className="text-xs text-mw-muted">Checking</span>
      ) : (
        <ArenaWarPoolClaimButton battleId={item.battleId} chainId={item.chainId} onClaimed={() => setNonce((n) => n + 1)} />
      )}
    </div>
  );
}

export default function CommandCenterClaims() {
  const { attribution, chainId, walletAddress } = useCommandCenterData();
  const wallet = useWallet();
  const { solanaAccount } = useSolanaWallet();
  const feedSession = useFeedSession();
  const [items, setItems] = useState<RewardLedgerItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [claimingType, setClaimingType] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isRecruiterFlag, setIsRecruiterFlag] = useState(false);
  const [battleClaims, setBattleClaims] = useState<BattleClaimItem[]>([]);
  const rewardChainId = isSolana(chainId) ? getConfiguredSolanaRewardChainId() : chainId;

  const loadClaims = () => {
    setLoading(true);
    setMessage(null);
    void (async () => {
      const ledgerItems = await fetchRewardClaims({ walletAddress, chainId: rewardChainId, limit: 100 });
      const leagueItems = await fetchLeagueRewardItems(walletAddress, rewardChainId).catch(() => []);
      setItems([...(Array.isArray(ledgerItems) ? ledgerItems : []), ...leagueItems]);
      if (walletAddress) {
        const war = await apiFetch(`/api/arena/war-pools/claimable?wallet=${encodeURIComponent(walletAddress)}`, { cache: "no-store" })
          .then((res) => res.json())
          .catch(() => null);
        setBattleClaims(Array.isArray(war?.items) ? war.items : []);
      } else {
        setBattleClaims([]);
      }
    })()
      .catch((err: any) => setMessage(String(err?.message || err || "Failed to load rewards")))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadClaims();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress, rewardChainId]);

  useEffect(() => {
    let cancelled = false;
    if (!walletAddress) {
      setIsRecruiterFlag(false);
      return;
    }
    void fetchRecruiterSignupStatus(walletAddress)
      .then((status) => {
        if (!cancelled) setIsRecruiterFlag(Boolean(status?.isRecruiter));
      })
      .catch(() => {
        if (!cancelled) setIsRecruiterFlag(false);
      });
    return () => {
      cancelled = true;
    };
  }, [walletAddress]);

  const rewardCards = useMemo(
    () => buildRewardCards(items, attribution?.squadState, attribution?.recruiterLinkState, rewardChainId),
    [items, attribution?.recruiterLinkState, attribution?.squadState, rewardChainId],
  );
  const showRecruiterRewards = hasRecruiterAccess(attribution?.recruiterLinkState, isRecruiterFlag);

  async function claimRewards(card: RewardCardConfig) {
    const claimable = card.items.filter((item) => item.status === "claimable" || item.status === "failed");
    if (!claimable.length) return;

    const leagueClaimable = claimable.filter((item) => Boolean(readLeagueRewardMetadata(item)));
    if (leagueClaimable.length) {
      if (leagueClaimable.length !== claimable.length) {
        setMessage("League rewards must be claimed separately.");
        return;
      }
      if (!walletAddress) {
        setMessage("Connect the wallet that owns these league rewards before claiming.");
        return;
      }
      const firstChainId = Number(leagueClaimable[0]?.chainId || rewardChainId || 0);
      const solanaLeague = isSolanaRewardChainId(firstChainId);
      if (solanaLeague) {
        if (!solanaAccount || solanaAccount !== walletAddress) {
          setMessage("Connect the same Solana wallet that owns these league rewards before claiming.");
          try { window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal")); } catch {}
          return;
        }
      } else if (!wallet?.signer) {
        setMessage(`Connect the ${rewardChainLabel(firstChainId)} wallet that owns these league rewards before claiming.`);
        try { window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal")); } catch {}
        return;
      }

      setClaimingType(card.rewardType);
      setMessage(null);
      const completed: string[] = [];

      // With the 30-day sign-in the server steps need no signature, and Solana prizes go to the wallet
      // as one approval (signAllTransactions). Founder, 2026-10-08: three prizes took nine prompts with
      // no word on what each one was. Declining the sign-in keeps the old flow below.
      let sessionToken = "";
      if (addressesMatch(feedSession.account, walletAddress)) {
        sessionToken = await feedSession.ensureSession().catch(() => "");
      }
      if (sessionToken) {
        const total = leagueClaimable.length;
        const toastId = toast.loading(total === 1 ? "Getting your prize ready..." : `Getting ${total} prizes ready...`);
        const failed: string[] = [];
        const paidItems: RewardLedgerItem[] = [];
        try {
          const queue: Array<{ item: RewardLedgerItem; metadata: LeagueRewardMetadata; claimChainId: number; prepared?: PreparedSolanaLeagueClaim }> = [];
          for (const item of leagueClaimable) {
            const metadata = readLeagueRewardMetadata(item);
            if (!metadata) throw new Error("League reward claim metadata is missing.");
            const claimChainId = Number(item.chainId || rewardChainId || 0);
            if (isSolanaRewardChainId(claimChainId)) {
              const prepared = await prepareLeagueRewardClaim(metadata, walletAddress, claimChainId, sessionToken);
              if ("alreadyPaid" in prepared) {
                completed.push(item.id);
                paidItems.push(item);
              } else {
                queue.push({ item, metadata, claimChainId, prepared });
              }
            } else {
              queue.push({ item, metadata, claimChainId });
            }
          }

          const solanaQueue = queue.filter((entry) => entry.prepared);
          if (solanaQueue.length) {
            toast.loading(
              solanaQueue.length === 1
                ? `Approve the ${formatNativeAmount(solanaQueue[0].item.amount, solanaQueue[0].claimChainId, solanaQueue[0].item.tokenSymbol)} claim in your wallet...`
                : `Approve ${solanaQueue.length} prize claims in your wallet. One approval covers all of them.`,
              { id: toastId },
            );
            const results = await submitSolanaLeagueClaims(solanaQueue.map((entry) => entry.prepared!));
            for (let i = 0; i < solanaQueue.length; i += 1) {
              const entry = solanaQueue[i];
              const result = results[i];
              if ("error" in result) {
                failed.push(`${entry.item.sourceLabel || "Prize"}: ${result.error.message}`);
                continue;
              }
              toast.loading(solanaQueue.length === 1 ? "Saving your claim..." : `Saving claim ${i + 1} of ${solanaQueue.length}...`, { id: toastId });
              try {
                await recordLeagueRewardClaim(entry.metadata, walletAddress, entry.claimChainId, result.signature, sessionToken);
              } catch (error) {
                // Paid on-chain; the record catches up on the next load (the receipt is found again).
                console.warn("[claims] league record after payout failed", error);
              }
              completed.push(entry.item.id);
              paidItems.push(entry.item);
            }
          }

          const evmQueue = queue.filter((entry) => !entry.prepared);
          for (let i = 0; i < evmQueue.length; i += 1) {
            const { item, metadata, claimChainId } = evmQueue[i];
            const { recordLeagueClaimTx, submitLeagueClaim } = await import("@/lib/rewardsApi");
            const params = { chainId: claimChainId, period: metadata.period, epochStart: metadata.epochStart, category: metadata.category, rank: metadata.rank, recipient: walletAddress };
            try {
              const prepared = await submitLeagueClaim({ ...params, sessionToken });
              let txHash = "txHash" in prepared ? String(prepared.txHash || "") : "";
              if ("mode" in prepared && prepared.mode === "merkle") {
                toast.loading(
                  evmQueue.length === 1
                    ? `Confirm the ${formatNativeAmount(item.amount, claimChainId, item.tokenSymbol)} claim in your wallet...`
                    : `Prize ${i + 1} of ${evmQueue.length}: confirm ${formatNativeAmount(item.amount, claimChainId, item.tokenSymbol)} in your wallet...`,
                  { id: toastId },
                );
                const treasury = new Contract(
                  prepared.vaultAddress,
                  ["function claim(uint256 epochId, bytes32 categoryHash, uint8 rank, address recipient, uint256 amount, bytes32[] proof)"],
                  wallet.signer,
                );
                const tx = await treasury.claim(prepared.epochId, prepared.categoryHash, prepared.rank, prepared.recipient, prepared.amountRaw, prepared.proof);
                await tx.wait();
                txHash = tx.hash;
                await recordLeagueClaimTx({ ...params, txHash, sessionToken }).catch((error) => console.warn("[claims] league record after payout failed", error));
              }
              completed.push(item.id);
              paidItems.push(item);
            } catch (error: any) {
              if (/reject|denied|cancel/i.test(String(error?.shortMessage || error?.message || ""))) throw error;
              failed.push(`${item.sourceLabel || "Prize"}: ${String(error?.shortMessage || error?.message || error)}`);
            }
          }

          toast.dismiss(toastId);
          const count = completed.length;
          const first = paidItems[0];
          const totalLabel = first ? formatNativeAmount(String(amountSum(paidItems)), first.chainId, first.tokenSymbol) : "";
          if (count) toast.success(count === 1 ? `Prize claimed · ${totalLabel}` : `${count} prizes claimed · ${totalLabel} in total`);
          if (failed.length) toast.error(failed.length === 1 ? "One prize was not claimed. See the note on this page." : `${failed.length} prizes were not claimed. See the note on this page.`);
          setMessage(
            [
              count ? (count === 1 ? `Prize claimed: ${totalLabel}, sent to your wallet.` : `${count} prizes claimed: ${totalLabel} in total, sent to your wallet.`) : "",
              ...failed.map((line) => `Not claimed. ${line}`),
            ].filter(Boolean).join("\n") || null,
          );
          loadClaims();
        } catch (err: any) {
          toast.dismiss(toastId);
          const raw = String(err?.shortMessage || err?.message || err || "League claim request failed");
          const reason = /reject|denied|cancel/i.test(raw) ? "Approval cancelled in your wallet. Nothing was claimed." : raw;
          setMessage(reason);
          toast.error(reason);
          if (completed.length) loadClaims();
        } finally {
          setClaimingType(null);
        }
        return;
      }

      try {
        for (const item of leagueClaimable) {
          const metadata = readLeagueRewardMetadata(item);
          if (!metadata) throw new Error("League reward claim metadata is missing.");
          const claimChainId = Number(item.chainId || rewardChainId || 0);
          const toastId = toast.loading(`Confirm ${formatNativeAmount(item.amount, claimChainId, item.tokenSymbol)} claim in your wallet...`);
          try {
            if (isSolanaRewardChainId(claimChainId)) {
              const prepared = await prepareLeagueRewardClaim(metadata, walletAddress, claimChainId);
              if ("alreadyPaid" in prepared) {
                // Paid before (e.g. a second click or Claim all after a claim): nothing to sign.
                toast.dismiss(toastId);
              } else {
                const txHash = await submitSolanaLeagueClaim(prepared);
                toast.dismiss(toastId);
                const recordToast = toast.loading("Finalizing league claim...");
                try {
                  await recordLeagueRewardClaim(metadata, walletAddress, claimChainId, txHash);
                } finally {
                  toast.dismiss(recordToast);
                }
              }
            } else {
              const { requestNonce } = await import("@/lib/profileApi");
              const { buildLeagueClaimMessage, recordLeagueClaimTx, submitLeagueClaim } = await import("@/lib/rewardsApi");
              const nonce = await requestNonce(claimChainId, walletAddress);
              const message = buildLeagueClaimMessage({
                chainId: claimChainId,
                recipient: walletAddress,
                period: metadata.period,
                epochStart: metadata.epochStart,
                category: metadata.category,
                rank: metadata.rank,
                nonce,
              });
              const signature = await wallet.signer.signMessage(message);
              const prepared = await submitLeagueClaim({
                chainId: claimChainId,
                period: metadata.period,
                epochStart: metadata.epochStart,
                category: metadata.category,
                rank: metadata.rank,
                recipient: walletAddress,
                nonce,
                signature,
              });
              let txHash = "txHash" in prepared ? String(prepared.txHash || "") : "";
              if ("mode" in prepared && prepared.mode === "merkle") {
                const treasury = new Contract(
                  prepared.vaultAddress,
                  ["function claim(uint256 epochId, bytes32 categoryHash, uint8 rank, address recipient, uint256 amount, bytes32[] proof)"],
                  wallet.signer,
                );
                const tx = await treasury.claim(
                  prepared.epochId,
                  prepared.categoryHash,
                  prepared.rank,
                  prepared.recipient,
                  prepared.amountRaw,
                  prepared.proof,
                );
                await tx.wait();
                txHash = tx.hash;
                await recordLeagueClaimTx({
                  chainId: claimChainId,
                  period: metadata.period,
                  epochStart: metadata.epochStart,
                  category: metadata.category,
                  rank: metadata.rank,
                  recipient: walletAddress,
                  nonce,
                  signature,
                  txHash,
                });
              }
              toast.dismiss(toastId);
            }
            completed.push(item.id);
          } catch (err) {
            toast.dismiss(toastId);
            throw err;
          }
        }

        const count = completed.length;
        setMessage(count === 1 ? `${card.title} claimed on-chain.` : `${count} ${card.title} claims completed on-chain.`);
        toast.success(count === 1 ? "League reward claimed." : `${count} league rewards claimed.`);
        loadClaims();
      } catch (err: any) {
        const reason = String(err?.shortMessage || err?.message || err || "League claim request failed");
        setMessage(reason);
        // The page message is easy to miss; a claim that stops must say so where the user looks.
        toast.error(reason);
      } finally {
        setClaimingType(null);
      }
      return;
    }

    const hasSolana = claimable.some((item) => isSolanaRewardChainId(item.chainId));
    const hasEvm = claimable.some((item) => !isSolanaRewardChainId(item.chainId));
    if (hasSolana && hasEvm) {
      setMessage("Mixed-chain rewards must be claimed separately.");
      return;
    }

    const signer = hasSolana ? null : wallet?.signer;
    const solanaSignMessage = hasSolana
      ? async (text: string) => (await signSolanaMessage(text, walletAddress)).signature
      : undefined;

    if (hasSolana) {
      if (!solanaAccount || solanaAccount !== walletAddress) {
        setMessage("Connect the same Solana wallet that owns these rewards before claiming.");
        try { window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal")); } catch {}
        return;
      }
    } else if (!signer) {
      setMessage("Connect the wallet that owns these rewards before claiming.");
      try { window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal")); } catch {}
      return;
    }

    if (!addressesMatch(wallet.account, walletAddress) && solanaAccount !== walletAddress) {
      setMessage("Connect the same wallet that owns these rewards before claiming.");
      return;
    }

    setClaimingType(card.rewardType);
    setMessage(null);
    const rewardLedgerIds = claimable.map((item) => item.id);
    let claimIntentId: string | null = null;
    const completed: string[] = [];

    try {
      const intent = await createRewardClaimIntent({
        walletAddress,
        chainId: rewardChainId,
        rewardLedgerIds,
        signer: signer || undefined,
        signMessage: solanaSignMessage,
      });
      claimIntentId = intent.id;

      for (const call of intent.calls) {
        const toastId = toast.loading(`Confirm ${formatNativeAmount(call.amount, call.chainId, call.tokenSymbol)} claim in your wallet...`);
        try {
          let txHash = "";
          if (call.mode === "solana_airdrop") {
            txHash = await submitSolanaAirdropClaim(call);
          } else {
            if (!signer) throw new Error("EVM signer is unavailable for this reward claim.");
            const contract = new Contract(call.contractAddress, REWARD_DISTRIBUTOR_ABI, signer);
            const tx = await contract.claim(call.batchId, call.amount, call.proof);
            toast.dismiss(toastId);
            const waitToast = toast.loading("Waiting for claim confirmation...");
            try {
              await tx.wait();
            } finally {
              toast.dismiss(waitToast);
            }
            txHash = String(tx.hash || "");
          }
          toast.dismiss(toastId);

          await recordRewardClaimTx({
            walletAddress,
            chainId: rewardChainId,
            rewardLedgerIds: [call.rewardLedgerId],
            claimIntentId,
            txHash,
            signer: signer || undefined,
            signMessage: solanaSignMessage,
          });
          completed.push(call.rewardLedgerId);
        } catch (err: any) {
          toast.dismiss(toastId);
          const reason = String(err?.shortMessage || err?.message || "Wallet claim transaction failed");
          await recordRewardClaimFailure({
            walletAddress,
            chainId: rewardChainId,
            rewardLedgerIds: [call.rewardLedgerId],
            claimIntentId,
            error: reason,
            signer: signer || undefined,
            signMessage: solanaSignMessage,
          }).catch(() => {});
          throw err;
        }
      }

      const count = completed.length;
      setMessage(count === 1 ? `${card.title} claimed on-chain.` : `${count} ${card.title} claims completed on-chain.`);
      toast.success(count === 1 ? "Reward claimed." : `${count} rewards claimed.`);
      loadClaims();
    } catch (err: any) {
      setMessage(String(err?.shortMessage || err?.message || err || "Claim request failed"));
    } finally {
      setClaimingType(null);
    }
  }

  // CO-4 (founder, 2026-10-03): "Claim all ready" runs the same per-reward claim for each ready row in
  // turn (one wallet signature each). No batching, no contract change.
  const readyCards = rewardCards.filter((card) => !getRewardStateCopy(card.state).disabled && card.items.some((item) => item.status === "claimable" || item.status === "failed"));
  const [claimAll, setClaimAll] = useState<{ done: number; total: number } | null>(null);
  async function claimAllReady() {
    if (claimAll || claimingType) return;
    const queue = [...readyCards];
    setClaimAll({ done: 0, total: queue.length });
    try {
      for (let i = 0; i < queue.length; i += 1) {
        await claimRewards(queue[i]);
        setClaimAll({ done: i + 1, total: queue.length });
      }
    } finally {
      setClaimAll(null);
    }
  }

  // UI redesign (artboard Rewards and claims): one row per reward; same claim handler and button rules.
  const chip = "inline-flex h-[22px] shrink-0 items-center rounded-full border px-2 text-xs font-semibold";
  const chipTone = (label: string) =>
    /ready|claimable|available/i.test(label) ? "border-[#1F5133] text-[#6EE7A0]" : /fail|error/i.test(label) ? "border-mw-edge text-[#FB7185]" : /expired|closed|no reward/i.test(label) ? "border-mw-edge text-[#7C858F]" : "border-mw-edge text-[#FFB27A]";
  const rowClass = "flex flex-wrap items-center gap-2.5 rounded-[14px] border border-mw-border bg-mw-surface p-3";

  return (
    <div className="flex flex-col gap-3.5 font-mw-body text-mw-text">
      <h2 className="sr-only">{`Your ${rewardChainLabel(rewardChainId)} Rewards`}</h2>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex min-h-10 items-center rounded-lg border border-mw-accent bg-[#2A1609] px-3 font-mw-mono text-[13px] text-mw-accent-soft">{rewardChainLabel(rewardChainId)}</span>
        <span className="text-[13px] text-mw-muted">Rewards for the connected wallet on this chain.</span>
        {readyCards.length > 1 || claimAll ? (
          <Button
            disabled={Boolean(claimAll) || Boolean(claimingType)}
            className="ml-auto min-h-10 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-sm font-bold text-[#140A02] hover:bg-[#FF8A3D] disabled:opacity-60"
            onClick={() => void claimAllReady()}
            data-claim-all="true"
          >
            {claimAll ? `Claiming ${Math.min(claimAll.done + 1, claimAll.total)} of ${claimAll.total}...` : `Claim all ready (${readyCards.length})`}
          </Button>
        ) : null}
      </div>
      {message ? <div className="rounded-[10px] border border-mw-border bg-mw-input p-3 text-sm text-mw-muted">{message}</div> : null}

      <div className="flex flex-col gap-2">
        {rewardCards.map((card) => {
          const Icon = card.icon;
          const stateCopy = getRewardStateCopy(card.state);
          return (
            <div key={card.rewardType} className={rowClass} title={card.description}>
              <Icon className="h-4 w-4 shrink-0 text-mw-accent-soft" aria-hidden="true" />
              <span className="min-w-[160px] flex-1">
                <b className="block text-sm">{card.title}</b>
                <span className="text-xs text-mw-muted">{rewardChainLabel(rewardChainId)} · {stateCopy.amountCaption}</span>
              </span>
              <span className="font-mw-mono font-bold">{loading ? "..." : card.amountLabel}</span>
              <span className={`${chip} ${chipTone(stateCopy.label)}`}>{stateCopy.label}</span>
              {card.rewardType === "league" && card.items.some((item) => item.status === "claimable" || item.status === "failed") ? (
                <ul className="m-0 w-full list-none space-y-1 p-0 text-xs text-mw-muted" data-league-prize-list="true">
                  {card.items
                    .filter((item) => item.status === "claimable" || item.status === "failed")
                    .map((item) => (
                      <li key={item.id} className="flex justify-between gap-3">
                        <span className="truncate">{item.sourceLabel || "League prize"}</span>
                        <span className="shrink-0 font-mw-mono text-mw-text">{formatNativeAmount(item.amount, item.chainId, item.tokenSymbol)}</span>
                      </li>
                    ))}
                </ul>
              ) : null}
              <Button
                disabled={stateCopy.disabled || claimingType === card.rewardType}
                className="min-h-9 rounded-[10px] border border-mw-accent bg-mw-accent px-3 text-sm font-bold text-[#140A02] hover:bg-[#FF8A3D] disabled:border-mw-edge disabled:bg-mw-raised disabled:text-mw-muted"
                onClick={() => void claimRewards(card)}
              >
                {claimingType === card.rewardType ? "Claiming..." : card.buttonLabel}
              </Button>
            </div>
          );
        })}

        {battleClaims.map((item) => (
          <BattleClaimRow key={item.battleId} item={item} />
        ))}
      </div>
      {battleClaims.length ? (
        <p className="m-0 text-[13px] text-mw-muted">
          The winning coin's owner collects 75% of both stakes and 90% of the boosts. Connect the wallet that owns the winning coin.
        </p>
      ) : null}

      {showRecruiterRewards ? <RecruiterNativePayoutsPanel /> : null}
      <CreatorFeesPanel />
      <EvmCreatorFeesPanel />
    </div>
  );
}
