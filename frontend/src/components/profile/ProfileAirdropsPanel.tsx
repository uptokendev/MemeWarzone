import { useEffect, useMemo, useState } from "react";
import { formatEther } from "ethers";
import { Link } from "react-router-dom";
import { ArrowRight, Gift, Sparkles, Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConnectWalletButton } from "@/components/ConnectWalletButton";
import { isSolanaAddress } from "@/lib/address";
import { fetchWalletRewardSummary, type WalletRewardSummary } from "@/lib/recruiterApi";
import {
  fetchAirdropWinners,
  fetchWalletRewardEligibility,
  type AirdropWinner,
  type WalletEligibilityItem,
} from "@/lib/rewardProgramsApi";
import { airdropProgramLabel, airdropRankNoun } from "@/lib/airdropProgramLabel.mjs";

type ProfileAirdropsPanelProps = {
  account: string | null;
  isConnected: boolean;
  isOwnProfile: boolean;
};

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

function formatDate(value: string | null | undefined): string {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not available" : date.toLocaleString();
}

function getLatestEligibility(items: WalletEligibilityItem[], program: string): WalletEligibilityItem | null {
  return items.find((item) => item.program === program) ?? null;
}

function EligibilityCard(props: {
  title: string;
  item: WalletEligibilityItem | null;
  claimableAmount: string;
  solana: boolean;
}) {
  const { title, item, claimableAmount, solana } = props;

  return (
    <Card className="border-border/60 bg-card/65 p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-retro text-xs uppercase tracking-[0.2em] text-muted-foreground">{title}</p>
          <h3 className="mt-1 font-retro text-xl text-foreground">
            {item ? (item.isEligible ? "Eligible this week" : "Not eligible this week") : "No weekly result yet"}
          </h3>
        </div>
        <Gift className="h-4 w-4 text-amber-200" />
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-border/60 bg-background/35 p-4">
          <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Claimable</p>
          <p className="mt-2 font-retro text-lg text-foreground">
            {formatNative(claimableAmount, solana)} {solana ? "SOL" : "BNB"}
          </p>
        </div>
        <div className="rounded-2xl border border-border/60 bg-background/35 p-4">
          <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Last computed</p>
          <p className="mt-2 font-retro text-sm text-foreground">{formatDate(item?.computedAt)}</p>
        </div>
      </div>

      <div className="mt-4 rounded-2xl border border-border/60 bg-background/20 p-4">
        <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Reason codes</p>
        {item?.reasonCodes?.length ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {item.reasonCodes.map((reason) => (
              <span
                key={reason}
                className="rounded-full border border-border/60 bg-background/40 px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] text-foreground"
              >
                {reason.replace(/_/g, " ")}
              </span>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">No public blockers on the latest eligibility result.</p>
        )}
      </div>
    </Card>
  );
}

export function ProfileAirdropsPanel({ account, isConnected, isOwnProfile }: ProfileAirdropsPanelProps) {
  const solana = isSolanaAddress(account);
  const chainId = solana ? 101 : 97;
  const symbol = solana ? "SOL" : "BNB";
  const [summary, setSummary] = useState<WalletRewardSummary | null>(null);
  const [eligibility, setEligibility] = useState<WalletEligibilityItem[]>([]);
  const [winners, setWinners] = useState<AirdropWinner[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const [winnerItems, rewardSummary, eligibilityItems] = await Promise.all([
          fetchAirdropWinners({ chainId, limit: 6 }).catch(() => []),
          account ? fetchWalletRewardSummary(account).catch(() => null) : Promise.resolve(null),
          account ? fetchWalletRewardEligibility(account, 20).catch(() => []) : Promise.resolve([]),
        ]);

        if (cancelled) return;
        setWinners(Array.isArray(winnerItems) ? winnerItems : []);
        setSummary(rewardSummary);
        setEligibility(Array.isArray(eligibilityItems) ? eligibilityItems : []);
      } catch (err: any) {
        if (!cancelled) setError(String(err?.message || err || "Failed to load airdrop state"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [account, chainId]);

  const traderEligibility = getLatestEligibility(eligibility, "airdrop_trader");
  const creatorEligibility = getLatestEligibility(eligibility, "airdrop_creator");

  const totals = useMemo(
    () => ({
      traderClaimable: summary?.claimableByProgram?.airdrop_trader ?? "0",
      creatorClaimable: summary?.claimableByProgram?.airdrop_creator ?? "0",
      totalClaimable: summary?.totalClaimableAmount ?? "0",
    }),
    [summary],
  );

  if (!isOwnProfile) {
    return (
      <Card className="border-border/60 bg-card/65 p-6">
        <p className="font-retro text-xs uppercase tracking-[0.2em] text-muted-foreground">Airdrops</p>
        <h3 className="mt-2 font-retro text-2xl text-foreground">Wallet-specific airdrop state is private to your profile.</h3>
        <p className="mt-3 text-sm text-muted-foreground">
          Public winner publication still lives on the standalone winners page, but eligibility and claimable balances only render on your own connected profile.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Button asChild variant="outline" className="font-retro">
            <Link to="/airdrops/winners">
              Public winners
              <Trophy className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </Card>
    );
  }

  if (!isConnected || !account) {
    return (
      <Card className="border-border/60 bg-card/65 p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="font-retro text-xs uppercase tracking-[0.2em] text-muted-foreground">Airdrops</p>
            <h3 className="mt-2 font-retro text-2xl text-foreground">Connect to inspect your trader and creator eligibility.</h3>
            <p className="mt-3 text-sm text-muted-foreground">
              Your claimable totals, reason codes, and recent published winners are all available here once your wallet is connected.
            </p>
          </div>
          <ConnectWalletButton />
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="border-border/60 bg-card/70 p-5">
          <p className="font-retro text-xs uppercase tracking-[0.18em] text-muted-foreground">Trader claimable</p>
          <p className="mt-4 font-retro text-3xl text-foreground">{formatNative(totals.traderClaimable, solana)} {symbol}</p>
        </Card>
        <Card className="border-border/60 bg-card/70 p-5">
          <p className="font-retro text-xs uppercase tracking-[0.18em] text-muted-foreground">Creator claimable</p>
          <p className="mt-4 font-retro text-3xl text-foreground">{formatNative(totals.creatorClaimable, solana)} {symbol}</p>
        </Card>
        <Card className="border-border/60 bg-card/70 p-5">
          <p className="font-retro text-xs uppercase tracking-[0.18em] text-muted-foreground">Total claimable</p>
          <p className="mt-4 font-retro text-3xl text-foreground">{formatNative(totals.totalClaimable, solana)} {symbol}</p>
        </Card>
      </div>

      {loading ? (
        <Card className="border-border/60 bg-card/65 px-6 py-12 text-center text-sm text-muted-foreground">
          Loading airdrop state...
        </Card>
      ) : error ? (
        <Card className="border-rose-400/30 bg-rose-400/10 px-6 py-12 text-center text-sm text-rose-100">
          {error}
        </Card>
      ) : (
        <div className="grid gap-6 xl:grid-cols-2">
          <EligibilityCard title="Trader bucket" item={traderEligibility} claimableAmount={totals.traderClaimable} solana={solana} />
          <EligibilityCard title="Creator bucket" item={creatorEligibility} claimableAmount={totals.creatorClaimable} solana={solana} />
        </div>
      )}

      <Card className="border-border/60 bg-card/65 p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <Sparkles className="h-4 w-4 text-amber-200" />
            <div>
              <p className="font-retro text-xs uppercase tracking-[0.2em] text-muted-foreground">Recent winners</p>
              <h3 className="mt-1 font-retro text-xl text-foreground">Published draw preview</h3>
            </div>
          </div>
          <Button asChild variant="outline" className="font-retro">
            <Link to="/airdrops/winners">
              All winners
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </div>

        <div className="mt-5 space-y-3">
          {winners.length === 0 ? (
            <div className="rounded-2xl border border-border/60 bg-background/30 p-4 text-sm text-muted-foreground">
              No published airdrop winners yet.
            </div>
          ) : (
            winners.map((winner) => (
              <div key={`${winner.drawId}-${winner.walletAddress}-${winner.program}`} className="rounded-2xl border border-border/60 bg-background/35 p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="font-retro text-sm text-foreground">
                      {airdropProgramLabel(winner.program)} · {winner.walletAddress}
                    </p>
                    <p className="mt-1 text-xs uppercase tracking-[0.16em] text-muted-foreground">
                      Epoch #{winner.epochId} · {airdropRankNoun(winner.program)} #{winner.winnerRank}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-retro text-sm text-foreground">{formatNative(winner.payoutAmount, solana)} {symbol}</p>
                    <p className="mt-1 text-xs text-muted-foreground">Weight tier {winner.weightTier}</p>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </Card>
    </div>
  );
}
