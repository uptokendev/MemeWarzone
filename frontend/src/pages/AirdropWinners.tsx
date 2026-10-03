import { useEffect, useState } from "react";
import { formatEther } from "ethers";
import { Link } from "react-router-dom";
import { ArrowRight, Trophy } from "lucide-react";
import { cp } from "@/components/token/coinPageStyles";
import { useSelectedFeedChainId } from "@/components/common/ChainFeedSwitch";
import { BNB_CHAIN_ID, isSolanaChainId, ROBINHOOD_CHAIN_ID, ROBINHOOD_TESTNET_CHAIN_ID } from "@/lib/chainConfig";
import { fetchAirdropWinners, type AirdropWinner } from "@/lib/rewardProgramsApi";
import { airdropProgramLabel, airdropRankNoun } from "@/lib/airdropProgramLabel.mjs";

const LAMPORTS_PER_SOL = 1_000_000_000;

function formatNative(raw: string, solana: boolean): string {
  try {
    const value = solana
      ? Number(BigInt(raw || "0")) / LAMPORTS_PER_SOL
      : Number(formatEther(BigInt(raw || "0")));
    return value.toLocaleString(undefined, { maximumFractionDigits: value >= 100 ? 2 : 6 });
  } catch {
    return "0";
  }
}

function nativeSymbol(chainId: number): string {
  if (isSolanaChainId(chainId)) return "SOL";
  if (chainId === ROBINHOOD_CHAIN_ID || chainId === ROBINHOOD_TESTNET_CHAIN_ID) return "ETH";
  return "BNB";
}

export default function AirdropWinners() {
  const [selectedChainId] = useSelectedFeedChainId();
  const effectiveChainId = Number(selectedChainId || BNB_CHAIN_ID);
  const solana = isSolanaChainId(effectiveChainId);
  const symbol = nativeSymbol(effectiveChainId);
  const [winners, setWinners] = useState<AirdropWinner[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const items = await fetchAirdropWinners({ chainId: effectiveChainId, limit: 100 });
        if (!cancelled) setWinners(items);
      } catch {
        if (!cancelled) setError("Winner history is temporarily unavailable. Please try again later.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [effectiveChainId]);

  return (
    <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-4 px-1 py-8 font-mw-body text-mw-text md:px-2">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="max-w-3xl">
          <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">Published winners</div>
          <h1 className="m-0 mt-1 font-mw-cond text-[32px] font-bold leading-none lg:text-[40px]">
            See the latest MemeWarzone Airdrop winners.
          </h1>
          <p className="mt-2 text-[15px] text-mw-muted">
            Browse recent trader and creator winners, their rewards and the epoch they won.
          </p>
        </div>

        <Link to="/airdrops" className={cp.btn}>
          Back to airdrops
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </div>

      <section className={`${cp.card} p-4`}>
        <div className="flex items-center gap-3">
          <Trophy className="h-5 w-5 shrink-0 text-mw-accent-soft" aria-hidden="true" />
          <div>
            <p className={cp.label}>Winner history</p>
            <h2 className={`mt-1 ${cp.title}`}>Recent published draws</h2>
          </div>
        </div>

        <div className="mt-4 space-y-2">
          {loading ? (
            <div className={`${cp.inset} p-3 text-[15px] text-mw-muted`}>
              Loading winners...
            </div>
          ) : error ? (
            <div className="rounded-[10px] border border-[#5C1F2B] bg-[#2A1016] p-3 text-[15px] text-mw-sell">
              {error}
            </div>
          ) : winners.length === 0 ? (
            <div className={`${cp.inset} p-3 text-[15px] text-mw-muted`}>
              No published airdrop winners yet.
            </div>
          ) : (
            winners.map((winner) => (
              <div key={`${winner.drawId}-${winner.walletAddress}-${winner.program}`} className={`${cp.inset} p-3`}>
                <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div className="min-w-0">
                    <p className="break-all font-mw-mono text-sm font-bold text-mw-text">{winner.walletAddress}</p>
                    <p className="mt-1 text-[13px] text-mw-muted">
                      {airdropProgramLabel(winner.program)} · epoch #{winner.epochId} · {airdropRankNoun(winner.program)} #{winner.winnerRank}
                    </p>
                  </div>
                  <div className="md:text-right">
                    <p className="font-mw-mono text-sm font-bold text-mw-text">{formatNative(winner.payoutAmount, solana)} {symbol}</p>
                    <p className="mt-1 text-[13px] text-mw-muted">
                      Weight tier {winner.weightTier} · score {winner.activityScore}
                    </p>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
