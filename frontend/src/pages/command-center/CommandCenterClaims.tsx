import { useEffect, useMemo, useState } from "react";
import { Contract, formatEther } from "ethers";
import { Gift, Trophy, Users, Swords, type LucideIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { CommandCenterCard } from "@/components/command-center/CommandCenterCard";
import { useCommandCenterData } from "@/components/command-center/CommandCenterContext";
import { RecruiterNativePayoutsPanel } from "@/components/command-center/RecruiterNativePayoutsPanel";
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
import { submitSolanaLeagueClaim } from "@/lib/solanaLeagueClaim";
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
  period: "weekly" | "monthly";
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
  period: "weekly" | "monthly";
  epochStart: string;
  epochEnd?: string | null;
  expiresAt?: string | null;
  category: string;
  rank: number;
  amountRaw: string;
  payload?: Record<string, unknown>;
  computedAt?: string | null;
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

function formatNativeAmount(raw: string, chainId?: number | null, symbol?: string | null) {
  try {
    if (isSolana(chainId)) {
      const value = Number(BigInt(raw || "0")) / LAMPORTS_PER_SOL;
      return `${value.toLocaleString(undefined, { maximumFractionDigits: value >= 100 ? 2 : 9 })} ${symbol || "SOL"}`;
    }
    const value = Number(formatEther(BigInt(raw || "0")));
    return `${value.toLocaleString(undefined, { maximumFractionDigits: value >= 100 ? 2 : 6 })} ${symbol || "BNB"}`;
  } catch {
    return `0 ${symbol || (isSolana(chainId) ? "SOL" : "BNB")}`;
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

    const solana = isSolanaRewardChainId(Number(chainId));
    return {
      id: buildLeagueRewardId(Number(chainId), reward),
      rewardType: "league",
      sourceId: null,
      sourceLabel: `${metadata.period}:${metadata.category}:${metadata.rank}`,
      walletAddress,
      userId: null,
      chain: solana ? "solana" : "bnb",
      chainId: Number(chainId),
      tokenSymbol: solana ? "SOL" : "BNB",
      amount: String(reward.amountRaw || "0"),
      amountUsd: null,
      status: "claimable",
      claimBatchId: null,
      claimTxHash: null,
      claimError: null,
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
  period: "weekly" | "monthly";
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

async function prepareLeagueRewardClaim(
  metadata: LeagueRewardMetadata,
  walletAddress: string,
  chainId: number,
): Promise<PreparedSolanaLeagueClaim> {
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
  return { ...json, chainId } as PreparedSolanaLeagueClaim;
}

async function recordLeagueRewardClaim(
  metadata: LeagueRewardMetadata,
  walletAddress: string,
  chainId: number,
  txHash: string,
) {
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

export default function CommandCenterClaims() {
  const { attribution, chainId, walletAddress } = useCommandCenterData();
  const wallet = useWallet();
  const { solanaAccount } = useSolanaWallet();
  const [items, setItems] = useState<RewardLedgerItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [claimingType, setClaimingType] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isRecruiterFlag, setIsRecruiterFlag] = useState(false);
  const rewardChainId = isSolana(chainId) ? getConfiguredSolanaRewardChainId() : chainId;

  const loadClaims = () => {
    setLoading(true);
    setMessage(null);
    void (async () => {
      const ledgerItems = await fetchRewardClaims({ walletAddress, chainId: rewardChainId, limit: 100 });
      const leagueItems = await fetchLeagueRewardItems(walletAddress, rewardChainId).catch(() => []);
      setItems([...(Array.isArray(ledgerItems) ? ledgerItems : []), ...leagueItems]);
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
        setMessage("Connect the BNB wallet that owns these league rewards before claiming.");
        try { window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal")); } catch {}
        return;
      }

      setClaimingType(card.rewardType);
      setMessage(null);
      const completed: string[] = [];

      try {
        for (const item of leagueClaimable) {
          const metadata = readLeagueRewardMetadata(item);
          if (!metadata) throw new Error("League reward claim metadata is missing.");
          const claimChainId = Number(item.chainId || rewardChainId || 0);
          const toastId = toast.loading(`Confirm ${formatNativeAmount(item.amount, claimChainId, item.tokenSymbol)} claim in your wallet...`);
          try {
            if (isSolanaRewardChainId(claimChainId)) {
              const prepared = await prepareLeagueRewardClaim(metadata, walletAddress, claimChainId);
              const txHash = await submitSolanaLeagueClaim(prepared);
              toast.dismiss(toastId);
              const recordToast = toast.loading("Finalizing league claim...");
              try {
                await recordLeagueRewardClaim(metadata, walletAddress, claimChainId, txHash);
              } finally {
                toast.dismiss(recordToast);
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
        setMessage(String(err?.shortMessage || err?.message || err || "League claim request failed"));
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
            if (!signer) throw new Error("BNB signer is unavailable for this reward claim.");
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

  return (
    <div className="space-y-4">
      <CommandCenterCard title={isSolana(rewardChainId) ? "Your Solana Rewards" : "Your BNB Rewards"}>
        {message ? <div className="mb-3 rounded-xl border border-border/60 bg-background/30 p-3 text-sm text-muted-foreground">{message}</div> : null}
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {rewardCards.map((card) => {
            const Icon = card.icon;
            const stateCopy = getRewardStateCopy(card.state);
            return (
              <div key={card.rewardType} className="rounded-2xl border border-border/50 bg-background/25 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 font-retro text-sm text-foreground">
                      <Icon className="h-4 w-4 text-accent" />
                      {card.title}
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">{card.description}</p>
                  </div>
                  <span className="rounded-full border border-border/40 bg-card/25 px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                    {stateCopy.label}
                  </span>
                </div>

                <div className="mt-5 flex items-end justify-between gap-3">
                  <div>
                    <div className="font-retro text-2xl text-foreground">{loading ? "..." : card.amountLabel}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{stateCopy.amountCaption}</div>
                  </div>
                  <Button
                    disabled={stateCopy.disabled || claimingType === card.rewardType}
                    className="font-retro"
                    onClick={() => void claimRewards(card)}
                  >
                    {claimingType === card.rewardType ? "Claiming..." : card.buttonLabel}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </CommandCenterCard>

      {showRecruiterRewards ? <RecruiterNativePayoutsPanel /> : null}
    </div>
  );
}
