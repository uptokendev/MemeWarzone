import { useEffect, useState } from "react";
import { formatEther } from "ethers";
import { Link } from "react-router-dom";
import { ArrowRight, Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useSelectedFeedChainId } from "@/components/common/ChainFeedSwitch";
import { BNB_CHAIN_ID, isSolanaChainId, ROBINHOOD_CHAIN_ID, ROBINHOOD_TESTNET_CHAIN_ID } from "@/lib/chainConfig";
import { fetchAirdropWinners, type AirdropWinner } from "@/lib/rewardProgramsApi";

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
    <div className="mx-auto flex max-w-5xl flex-col gap-6 py-8">
      <Card className="overflow-hidden border-border/60 bg-[radial-gradient(circle_at_top_left,rgba(251,191,36,0.2),transparent_42%),linear-gradient(180deg,rgba(18,22,28,0.94),rgba(9,12,16,0.98))] p-6 md:p-8">
        <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div className="max-w-3xl space-y-3">
            <p className="font-retro text-xs uppercase tracking-[0.24em] text-amber-100/70">Published winners</p>
            <h1 className="font-retro text-3xl text-foreground md:text-5xl">
              See the latest MemeWarzone Airdrop winners.
            </h1>
            <p className="text-sm text-muted-foreground md:text-base">
              Browse recent trader and creator winners, their rewards and the epoch they won.
            </p>
          </div>

          <Button asChild variant="outline" className="font-retro">
            <Link to="/airdrops">
              Back to airdrops
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </Card>

      <Card className="border-border/60 bg-card/65 p-6">
        <div className="flex items-center gap-3">
          <Trophy className="h-4 w-4 text-amber-200" />
          <div>
            <p className="font-retro text-xs uppercase tracking-[0.2em] text-muted-foreground">Winner history</p>
            <h2 className="mt-1 font-retro text-xl text-foreground">Recent published draws</h2>
          </div>
        </div>

        <div className="mt-5 space-y-3">
          {loading ? (
            <div className="rounded-2xl border border-border/60 bg-background/30 p-4 text-sm text-muted-foreground">
              Loading winners...
            </div>
          ) : error ? (
            <div className="rounded-2xl border border-rose-400/30 bg-rose-400/10 p-4 text-sm text-rose-100">
              {error}
            </div>
          ) : winners.length === 0 ? (
            <div className="rounded-2xl border border-border/60 bg-background/30 p-4 text-sm text-muted-foreground">
              No published airdrop winners yet.
            </div>
          ) : (
            winners.map((winner) => (
              <div key={`${winner.drawId}-${winner.walletAddress}-${winner.program}`} className="rounded-2xl border border-border/60 bg-background/35 p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="font-retro text-sm text-foreground">{winner.walletAddress}</p>
                    <p className="mt-1 text-xs uppercase tracking-[0.16em] text-muted-foreground">
                      {winner.program === "airdrop_trader" ? "Trader draw" : "Creator draw"} · epoch #{winner.epochId} · winner #{winner.winnerRank}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-retro text-sm text-foreground">{formatNative(winner.payoutAmount, solana)} {symbol}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Weight tier {winner.weightTier} · score {winner.activityScore}
                    </p>
                  </div>
                </div>
              </div>
            )))
          )}
        </div>
      </Card>
    </div>
  );
}
