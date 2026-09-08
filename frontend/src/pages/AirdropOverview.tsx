import { useEffect, useMemo, useState } from "react";
import { formatEther } from "ethers";
import { Link } from "react-router-dom";
import { ArrowRight, Gift, Sparkles, Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConnectWalletButton } from "@/components/ConnectWalletButton";
import { useWallet } from "@/contexts/WalletContext";
import { useActiveFeedWallet } from "@/hooks/useActiveFeedWallet";
import { isSolanaAddress } from "@/lib/address";
import { BNB_CHAIN_ID, isSolanaChainId, ROBINHOOD_CHAIN_ID, ROBINHOOD_TESTNET_CHAIN_ID } from "@/lib/chainConfig";
import { fetchWalletRewardSummary, type WalletRewardSummary } from "@/lib/recruiterApi";
import { fetchAirdropWinners, fetchWalletRewardEligibility, type AirdropWinner, type WalletEligibilityItem } from "@/lib/rewardProgramsApi";

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

function formatEligibilityReason(reason: string): string {
  const normalized = String(reason || "").trim().toLowerCase();
  const known: Record<string, string> = {
    minimum_volume_not_met: "Minimum weekly trading volume not reached.",
    cooldown_active: "This wallet is still in a reward cooldown period.",
    battle_league_excluded: "Battle League activity is excluded from this reward draw.",
    creator_not_eligible: "Creator eligibility requirements were not met this week.",
    trader_not_eligible: "Trader eligibility requirements were not met this week.",
  };
  return known[normalized] || reason.replace(/_/g, " ");
}

function getLatestEligibility(items: WalletEligibilityItem[], program: string): WalletEligibilityItem | null {
  return items.find((item) => item.program === program) ?? null;
}

function EligibilityCard(props: {
  title: string;
  item: WalletEligibilityItem | null;
  claimableAmount: string;
  solana: boolean;
  symbol: string;
}) {
  const { title, item, claimableAmount, solana, symbol } = props;
  return (
    <Card className="border-border/60 bg-card/65 p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-retro text-xs uppercase tracking-[0.2em] text-muted-foreground">{title}</p>
          <h2 className="mt-1 font-retro text-xl text-foreground">
            {item ? (item.isEligible ? "Eligible this week" : "Not eligible this week") : "No weekly result yet"}
          </h2>
        </div>
        <Gift className="h-4 w-4 text-amber-200" />
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-border/60 bg-background/35 p-4">
          <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Claimable</p>
          <p className="mt-2 font-retro text-lg text-foreground">{formatNative(claimableAmount, solana)} {symbol}</p>
        </div>
        <div className="rounded-2xl border border-border/60 bg-background/35 p-4">
          <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Last computed</p>
          <p className="mt-2 font-retro text-sm text-foreground">{formatDate(item?.computedAt)}</p>
        </div>
      </div>

      <div className="mt-4 rounded-2xl border border-border/60 bg-background/20 p-4">
        <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Why this result?</p>
        {item?.reasonCodes?.length ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {item.reasonCodes.map((reason) => (
              <span key={reason} className="rounded-full border border-border/60 bg-background/40 px-2.5 py-1 text-[10px] tracking-[0.06em] text-foreground">
                {formatEligibilityReason(reason)}
              </span>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">No eligibility issues were found for this result.</p>
        )}
      </div>
    </Card>
  );
}

export default function AirdropOverview() {
  const wallet = useWallet();
  const feedWallet = useActiveFeedWallet();
  const account = feedWallet.address || wallet.account || "";
  const solana = feedWallet.isSolana || isSolanaAddress(account) || isSolanaChainId(Number(feedWallet.chainId));
  const chainId = solana ? 101 : Number(feedWallet.chainId || wallet.chainId || BNB_CHAIN_ID);
  const robinhood = chainId === ROBINHOOD_CHAIN_ID || chainId === ROBINHOOD_TESTNET_CHAIN_ID;
  const symbol = solana ? "SOL" : robinhood ? "ETH" : "BNB";

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
          fetchAirdropWinners({ chainId, limit: 12 }).catch(() => []),
          account ? fetchWalletRewardSummary(account).catch(() => null) : Promise.resolve(null),
          account ? fetchWalletRewardEligibility(account, 20).catch(() => []) : Promise.resolve([]),
        ]);
        if (cancelled) return;
        setWinners(Array.isArray(winnerItems) ? winnerItems : []);
        setSummary(rewardSummary);
        setEligibility(Array.isArray(eligibilityItems) ? eligibilityItems : []);
      } catch {
        if (!cancelled) setError("Airdrop information is temporarily unavailable. Please try again later.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [account, chainId]);

  const traderEligibility = getLatestEligibility(eligibility, "airdrop_trader");
  const creatorEligibility = getLatestEligibility(eligibility, "airdrop_creator");
  const totals = useMemo(() => ({
    traderClaimable: summary?.claimableByProgram?.airdrop_trader ?? "0",
    creatorClaimable: summary?.claimableByProgram?.airdrop_creator ?? "0",
    totalClaimable: summary?.totalClaimableAmount ?? "0",
  }), [summary]);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 py-8">
      <Card className="overflow-hidden border-border/60 bg-[radial-gradient(circle_at_top_left,rgba(253,224,71,0.18),transparent_40%),linear-gradient(180deg,rgba(18,22,28,0.94),rgba(9,12,16,0.98))] p-6 md:p-8">
        <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div className="max-w-3xl space-y-3">
            <p className="font-retro text-xs uppercase tracking-[0.24em] text-amber-100/70">Warzone {symbol} Airdrops</p>
            <h1 className="font-retro text-3xl text-foreground md:text-5xl">Weekly rewards for active traders and creators.</h1>
            <p className="text-sm text-muted-foreground md:text-base">See your weekly eligibility, why you qualify or don’t qualify, available rewards and recent winners in one place.</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button asChild variant="outline" className="font-retro"><Link to="/airdrops/winners">Public winners<Trophy className="ml-2 h-4 w-4" /></Link></Button>
            {account ? <Button asChild className="font-retro"><Link to="/profile?tab=airdrops">Review claimable rewards<ArrowRight className="ml-2 h-4 w-4" /></Link></Button> : <ConnectWalletButton />}
          </div>
        </div>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="border-border/60 bg-card/70 p-5"><p className="font-retro text-xs uppercase tracking-[0.18em] text-muted-foreground">Trader claimable</p><p className="mt-4 font-retro text-3xl text-foreground">{formatNative(totals.traderClaimable, solana)} {symbol}</p></Card>
        <Card className="border-border/60 bg-card/70 p-5"><p className="font-retro text-xs uppercase tracking-[0.18em] text-muted-foreground">Creator claimable</p><p className="mt-4 font-retro text-3xl text-foreground">{formatNative(totals.creatorClaimable, solana)} {symbol}</p></Card>
        <Card className="border-border/60 bg-card/70 p-5"><p className="font-retro text-xs uppercase tracking-[0.18em] text-muted-foreground">Total wallet rewards</p><p className="mt-4 font-retro text-3xl text-foreground">{formatNative(totals.totalClaimable, solana)} {symbol}</p></Card>
      </div>

      {!account ? (
        <Card className="border-border/60 bg-card/65 p-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between"><div><p className="font-retro text-xs uppercase tracking-[0.18em] text-muted-foreground">Wallet required</p><h2 className="mt-1 font-retro text-2xl text-foreground">Connect to inspect your airdrop eligibility.</h2><p className="mt-2 text-sm text-muted-foreground">Once connected, we’ll show your latest trader and creator eligibility state, why you qualify or don’t qualify, and any claimable airdrop rewards.</p></div><ConnectWalletButton /></div>
        </Card>
      ) : loading ? (
        <Card className="border-border/60 bg-card/65 px-6 py-12 text-center text-sm text-muted-foreground">Loading airdrop information...</Card>
      ) : error ? (
        <Card className="border-rose-400/30 bg-rose-400/10 px-6 py-12 text-center text-sm text-rose-100">{error}</Card>
      ) : (
        <div className="grid gap-6 xl:grid-cols-2">
          <EligibilityCard title="Trader bucket" item={traderEligibility} claimableAmount={totals.traderClaimable} solana={solana} symbol={symbol} />
          <EligibilityCard title="Creator bucket" item={creatorEligibility} claimableAmount={totals.creatorClaimable} solana={solana} symbol={symbol} />
        </div>
      )}

      <Card className="border-border/60 bg-card/65 p-6">
        <div className="flex items-center gap-3"><Sparkles className="h-4 w-4 text-amber-200" /><div><p className="font-retro text-xs uppercase tracking-[0.2em] text-muted-foreground">Recent winners</p><h2 className="mt-1 font-retro text-xl text-foreground">Published draw results</h2></div></div>
        <div className="mt-5 space-y-3">
          {winners.length === 0 ? <div className="rounded-2xl border border-border/60 bg-background/30 p-4 text-sm text-muted-foreground">No published airdrop winners yet.</div> : winners.map((winner) => (
            <div key={`${winner.drawId}-${winner.walletAddress}-${winner.program}`} className="rounded-2xl border border-border/60 bg-background/35 p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div><p className="font-retro text-sm text-foreground">{winner.walletAddress} · {winner.program === "airdrop_trader" ? "Trader" : "Creator"} draw</p><p className="mt-1 text-xs uppercase tracking-[0.16em] text-muted-foreground">Epoch #{winner.epochId} · winner #{winner.winnerRank}</p></div>
                <div className="text-right"><p className="font-retro text-sm text-foreground">{formatNative(winner.payoutAmount, solana)} {symbol}</p><p className="mt-1 text-xs text-muted-foreground">Weight tier {winner.weightTier}</p></div>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
