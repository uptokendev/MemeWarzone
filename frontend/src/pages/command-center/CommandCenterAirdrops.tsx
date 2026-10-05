import { useEffect, useMemo, useState } from "react";
import { formatEther } from "ethers";

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
  const { chainId, walletAddress } = useCommandCenterData();
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

  // "You this epoch" reads the existing preview: is this wallet in today's qualifying list?
  const myPreviewRow = previewRows.find((row) => String(row.walletAddress || "").toLowerCase() === String(walletAddress || "").toLowerCase()) ||
    [...(preview?.traders || []), ...(preview?.creators || [])].find((row) => String(row.walletAddress || "").toLowerCase() === String(walletAddress || "").toLowerCase()) ||
    null;
  const lbl = "font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted";
  const big = "font-mw-mono text-[30px] font-bold leading-tight text-mw-text";
  const rowClass = "flex min-h-[34px] items-center justify-between gap-2.5 border-b border-[#1E2329] py-1 text-sm last:border-b-0";

  return (
    <div className="flex flex-col gap-3.5 font-mw-body text-mw-text">
      <CommandCenterPageHeader title={pageTitle(chainId)} />

      <section className="grid gap-3.5 rounded-[14px] border border-[#5A3416] bg-[#1A130D] p-3.5 lg:grid-cols-3 lg:p-[22px]">
        <div>
          <div className={lbl}>Current prize pool</div>
          <div className={big}>{loading ? "..." : formatNativeAmount(currentPrizePoolRaw, chainId)} {symbol}</div>
          <div className="text-[13px] text-mw-muted">{poolStatus}</div>
        </div>
        <div>
          <div className={lbl}>Next drop in</div>
          <div className={big}>{countdown}</div>
          <div className="text-[13px] text-mw-muted">
            {current?.currentEpochId ? `Epoch ${current.currentEpochId}` : "Mondays, UTC"}
          </div>
        </div>
        <div>
          <div className={lbl}>You this epoch</div>
          <div className="mt-1.5">
            {preview ? (
              <span className={`inline-flex h-[22px] items-center rounded-full border px-2 text-xs font-semibold ${myPreviewRow ? "border-[#1F5133] text-[#6EE7A0]" : "border-mw-edge text-[#FFB27A]"}`}>
                {myPreviewRow ? "Eligible" : "Not in the preview yet"}
              </span>
            ) : (
              <span className="text-sm text-mw-muted">Preview unavailable</span>
            )}
          </div>
          <div className="mt-1.5 text-[13px] text-mw-muted">
            {preview ? `${preview.traderCount} traders / ${preview.creatorCount} creators qualify this epoch. Preview, final at the drop.` : "Final at the drop."}
          </div>
        </div>
      </section>

      <CommandCenterCard title="Previous winners">
        {loading ? (
          <div className="text-sm text-mw-muted">Loading previous winners...</div>
        ) : error ? (
          <div className="rounded-[10px] border border-[#5A1A26] bg-[#2A0E14] p-3 text-sm text-[#FFB4C0]">{error}</div>
        ) : winners.length === 0 ? (
          <div className="text-sm text-mw-muted">
            {isSolanaAirdrop(chainId)
              ? "No published Solana winners yet. Once a week is drawn, winners claim in Rewards and claims."
              : isRobinhoodAirdrop(chainId)
                ? "No published Robinhood winners yet. Once a week is drawn, winners claim in Rewards and claims."
                : "No previous winners yet."}
          </div>
        ) : (
          <div className="flex flex-col">
            {winners.map((winner) => (
              <div key={`${winner.drawId}-${winner.walletAddress}-${winner.program}`} className={rowClass}>
                <span className="min-w-0 truncate text-mw-muted">
                  {isHolderPayoutProgram(winner.program) ? "Holder payout" : `${winnerType(winner.program)} winner`} #{winner.winnerRank} ·{" "}
                  <span className="font-mw-mono text-mw-text">{shortenAddress(winner.walletAddress)}</span>
                </span>
                <span className="shrink-0 font-mw-mono font-semibold">{formatNativeAmount(winner.payoutAmount, chainId)} {symbol}</span>
              </div>
            ))}
          </div>
        )}
      </CommandCenterCard>

      {previewRows.length ? (
        <CommandCenterCard title="Eligible this epoch (preview)">
          {preview?.note ? <p className="m-0 text-[13px] text-mw-muted">{preview.note}</p> : null}
          <div className="flex flex-col">
            {previewRows.map((row) => (
              <div key={`${row.program}-${row.walletAddress}`} className={rowClass}>
                <span className="min-w-0 truncate text-mw-muted">
                  <span className="font-mw-mono text-mw-text">{shortenAddress(row.walletAddress)}</span> · {row.kind}
                  {row.tradeCount ? ` · ${row.tradeCount} trades` : ""}
                  {row.uniqueBuyers ? ` · ${row.uniqueBuyers} buyers` : ""}
                </span>
                <span className="shrink-0 font-mw-mono font-semibold">{formatNativeAmount(row.estimatedShareRaw || ZERO_RAW, chainId)} {symbol}</span>
              </div>
            ))}
          </div>
        </CommandCenterCard>
      ) : null}

      <p className="m-0 text-[13px] text-mw-muted">Unclaimed drops roll back into the pot after 60 days. Claim in Rewards and claims.</p>
    </div>
  );
}
