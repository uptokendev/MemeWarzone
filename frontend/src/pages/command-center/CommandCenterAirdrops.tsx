import { useEffect, useMemo, useState } from "react";
import { formatEther } from "ethers";
import { Gift, Trophy } from "lucide-react";

import { CommandCenterCard } from "@/components/command-center/CommandCenterCard";
import { CommandCenterPageHeader } from "@/components/command-center/CommandCenterPageHeader";
import { useCommandCenterData } from "@/components/command-center/CommandCenterContext";
import { ROBINHOOD_CHAIN_ID, ROBINHOOD_TESTNET_CHAIN_ID, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import {
  fetchAirdropCurrent,
  fetchAirdropPreview,
  fetchAirdropWinners,
  type AirdropCurrent,
  type AirdropPreview,
  type AirdropWinner,
} from "@/lib/rewardProgramsApi";
import { airdropProgramKind, isHolderPayoutProgram } from "@/lib/airdropProgramLabel.mjs";

const ZERO_RAW = "0";
const LAMPORTS_PER_SOL = 1_000_000_000;

function isSolanaAirdrop(chainId?: number | null): boolean {
  return chainId === SOLANA_CHAIN_ID;
}

function isRobinhoodAirdrop(chainId?: number | null): boolean {
  return chainId === ROBINHOOD_CHAIN_ID || chainId === ROBINHOOD_TESTNET_CHAIN_ID;
}

function nativeSymbol(chainId?: number | null, tokenSymbol?: string | null): "BNB" | "SOL" | "ETH" | string {
  // Chain identity is authoritative for native rewards. Older/current reward rows may
  // still carry a legacy BNB tokenSymbol from the shared EVM reward pipeline; never
  // let that relabel a Robinhood prize pool after the API response arrives.
  if (isSolanaAirdrop(chainId)) return "SOL";
  if (isRobinhoodAirdrop(chainId)) return "ETH";
  if (tokenSymbol) return tokenSymbol;
  return "BNB";
}

function pageTitle(chainId?: number | null): string {
  if (isSolanaAirdrop(chainId)) return "SOL Airdrops";
  if (isRobinhoodAirdrop(chainId)) return "ETH Airdrops";
  return "BNB Airdrops";
}

function formatNativeAmount(raw: string, chainId?: number | null): string {
  try {
    if (isSolanaAirdrop(chainId)) {
      const value = Number(BigInt(raw || ZERO_RAW)) / LAMPORTS_PER_SOL;
      return value.toLocaleString(undefined, { maximumFractionDigits: value >= 100 ? 2 : 6 });
    }

    const value = Number(formatEther(BigInt(raw || ZERO_RAW)));
    return value.toLocaleString(undefined, { maximumFractionDigits: value >= 100 ? 2 : 6 });
  } catch {
    return "0";
  }
}

function shortenAddress(address: string): string {
  if (!address) return "Unknown wallet";
  if (address.length <= 14) return address;
  return address.slice(0, 6) + "..." + address.slice(-4);
}

function getNextMondayUtc(): Date {
  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  const daysUntilMonday = (8 - todayUtc.getUTCDay()) % 7 || 7;
  return new Date(todayUtc.getTime() + daysUntilMonday * 24 * 60 * 60 * 1000);
}

function formatCountdown(target: Date, nowMs: number): string {
  const diffMs = target.getTime() - nowMs;
  if (diffMs <= 0) return "Drop pending";

  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return days + "d " + hours + "h " + minutes + "m";
  if (hours > 0) return hours + "h " + minutes + "m";
  return minutes + "m";
}

function winnerType(program: string): string {
  return airdropProgramKind(program);
}

export default function CommandCenterAirdrops() {
  const { chainId } = useCommandCenterData();
  const [winners, setWinners] = useState<AirdropWinner[]>([]);
  const [current, setCurrent] = useState<AirdropCurrent | null>(null);
  const [preview, setPreview] = useState<AirdropPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void Promise.all([
      fetchAirdropCurrent(chainId),
      fetchAirdropWinners({ chainId, limit: 12 }),
      fetchAirdropPreview(chainId).catch(() => null),
    ])
      .then(([currentBatch, items, previewBatch]) => {
        if (cancelled) return;
        setCurrent(currentBatch || null);
        setWinners(Array.isArray(items) ? items : []);
        setPreview(previewBatch);
      })
      .catch((err: any) => {
        if (!cancelled) setError(String(err?.message || err || "Failed to load airdrop data"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [chainId]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);

  const nextDropAt = useMemo(() => {
    const raw = current?.current?.metadata?.dropDate || current?.current?.metadata?.dropAt || current?.current?.metadata?.claimableAt;
    const configured = raw ? new Date(String(raw)) : null;
    return configured && Number.isFinite(configured.getTime()) ? configured : getNextMondayUtc();
  }, [current]);
  const countdown = formatCountdown(nextDropAt, nowMs);
  const currentPrizePoolRaw =
    current?.prizePool?.amount || current?.current?.totalAmount || preview?.estimatedPoolRaw || ZERO_RAW;
  const symbol = nativeSymbol(chainId, current?.prizePool?.tokenSymbol || current?.current?.tokenSymbol || preview?.tokenSymbol);
  const poolStatus = current?.prizePool?.status || current?.current?.status || preview?.note || "pending";
  const previewRows = [
    ...(preview?.traders || []).map((row) => ({ ...row, kind: "Trader" })),
    ...(preview?.creators || []).map((row) => ({ ...row, kind: "Creator" })),
  ].slice(0, 12);

  return (
    <div className="space-y-4">
      <CommandCenterPageHeader title={pageTitle(chainId)} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="space-y-4">
          <CommandCenterCard className="min-h-[180px]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-semibold font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">Current Prize Pool</p>
                <div className="mt-5 font-semibold text-4xl text-mw-text md:text-5xl">
                  {loading ? "..." : formatNativeAmount(currentPrizePoolRaw, chainId)} {symbol}
                </div>
                <p className="mt-3 text-xs uppercase tracking-[0.16em] text-mw-muted">{poolStatus}</p>
              </div>
              <div className="rounded-2xl border border-[#7A3A0C] bg-[#2A1609] p-3 text-mw-accent-soft">
                <Gift className="h-5 w-5" />
              </div>
            </div>
          </CommandCenterCard>

          <CommandCenterCard>
            <p className="font-semibold font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">Next drop in</p>
            <div className="mt-4 font-semibold text-3xl text-mw-text md:text-4xl">{countdown}</div>
            {current?.currentEpochId ? <p className="mt-2 text-xs uppercase tracking-[0.16em] text-mw-muted">Epoch {current.currentEpochId}</p> : null}
            {preview ? (
              <p className="mt-2 text-xs text-mw-muted">
                {preview.traderCount} traders / {preview.creatorCount} creators qualify this epoch. Claims closed.
              </p>
            ) : null}
          </CommandCenterCard>
        </div>

        <CommandCenterCard className="min-h-[376px]" title="Previous winners">
          {loading ? (
            <div className="rounded-[14px] border border-mw-border bg-mw-input p-4 text-sm text-mw-muted">
              Loading previous winners...
            </div>
          ) : error ? (
            <div className="rounded-2xl border border-[#5A1A26] bg-[#2A0E14] p-4 text-sm text-[#FFB4C0]">
              {error}
            </div>
          ) : winners.length === 0 ? (
            <div className="rounded-[14px] border border-mw-border bg-mw-input p-4 text-sm text-mw-muted">
              {isSolanaAirdrop(chainId)
                ? "No published Solana winners yet. Estimates can appear from bonding volume; claims stay closed."
                : isRobinhoodAirdrop(chainId)
                  ? "No published Robinhood winners yet. Estimates can appear from Robinhood bonding volume; claims stay closed."
                  : "No previous winners yet."}
            </div>
          ) : (
            <div className="space-y-3">
              {winners.map((winner) => (
                <div
                  key={`${winner.drawId}-${winner.walletAddress}-${winner.program}`}
                  className="rounded-2xl border border-border/60 bg-background/35 p-4"
                >
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Trophy className="h-4 w-4 shrink-0 text-mw-accent-soft" />
                        <p className="truncate font-semibold text-sm text-mw-text">{shortenAddress(winner.walletAddress)}</p>
                      </div>
                      <p className="mt-1 text-xs uppercase tracking-[0.16em] text-mw-muted">
                        {isHolderPayoutProgram(winner.program) ? "Holder payout" : `${winnerType(winner.program)} winner`} #{winner.winnerRank}
                      </p>
                    </div>
                    <p className="shrink-0 font-semibold text-sm text-mw-text">
                      {formatNativeAmount(winner.payoutAmount, chainId)} {symbol}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CommandCenterCard>
      </div>

      {previewRows.length ? (
        <CommandCenterCard title="Eligible this epoch (preview)">
          <p className="mb-3 text-xs text-mw-muted">{preview?.note}</p>
          <div className="space-y-2">
            {previewRows.map((row) => (
              <div
                key={`${row.program}-${row.walletAddress}`}
                className="flex items-center justify-between gap-3 rounded-2xl border border-border/60 bg-background/35 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate font-semibold text-sm text-mw-text">{shortenAddress(row.walletAddress)}</p>
                  <p className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">
                    {row.kind}
                    {row.tradeCount ? ` · ${row.tradeCount} trades` : ""}
                    {row.uniqueBuyers ? ` · ${row.uniqueBuyers} buyers` : ""}
                  </p>
                </div>
                <p className="shrink-0 font-semibold text-sm text-mw-text">
                  {formatNativeAmount(row.estimatedShareRaw || ZERO_RAW, chainId)} {symbol}
                </p>
              </div>
            ))}
          </div>
        </CommandCenterCard>
      ) : null}
    </div>
  );
}
