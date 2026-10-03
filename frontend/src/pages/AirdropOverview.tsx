import { useEffect, useMemo, useState } from "react";
import { formatEther } from "ethers";
import { Link } from "react-router-dom";
import { ArrowRight, Gift, Sparkles, Trophy } from "lucide-react";
import { cp } from "@/components/token/coinPageStyles";
import { ConnectWalletButton } from "@/components/ConnectWalletButton";
import { useWallet } from "@/contexts/WalletContext";
import { useActiveFeedWallet } from "@/hooks/useActiveFeedWallet";
import { isSolanaAddress } from "@/lib/address";
import { BNB_CHAIN_ID, isSolanaChainId, ROBINHOOD_CHAIN_ID, ROBINHOOD_TESTNET_CHAIN_ID } from "@/lib/chainConfig";
import { fetchWalletRewardSummary, type WalletRewardSummary } from "@/lib/recruiterApi";
import { fetchAirdropWinners, fetchWalletRewardEligibility, type AirdropWinner, type WalletEligibilityItem } from "@/lib/rewardProgramsApi";
import { airdropProgramLabel, airdropRankNoun } from "@/lib/airdropProgramLabel.mjs";

const LAMPORTS_PER_SOL = 1_000_000_000;

const PRIMARY_BTN =
  "mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50";

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
    <section className={`${cp.card} p-4`}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className={cp.label}>{title}</p>
          <h2 className={`mt-1 ${cp.title}`}>
            {item ? (item.isEligible ? "Eligible this week" : "Not eligible this week") : "No weekly result yet"}
          </h2>
        </div>
        <Gift className="h-5 w-5 shrink-0 text-mw-accent-soft" aria-hidden="true" />
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className={cp.tile}>
          <p className={cp.tileLabel}>Claimable</p>
          <p className={cp.tileValue}>{formatNative(claimableAmount, solana)} {symbol}</p>
        </div>
        <div className={cp.tile}>
          <p className={cp.tileLabel}>Last computed</p>
          <p className={cp.tileValue}>{formatDate(item?.computedAt)}</p>
        </div>
      </div>

      <div className={`mt-3 ${cp.inset} p-3`}>
        <p className={cp.label}>Why this result?</p>
        {item?.reasonCodes?.length ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {item.reasonCodes.map((reason) => (
              <span key={reason} className="inline-flex min-h-[26px] items-center rounded-full border border-mw-edge bg-[#171B20] px-2.5 py-1 text-[13px] font-semibold text-[#C9CED4]">
                {formatEligibilityReason(reason)}
              </span>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-[15px] text-mw-muted">No eligibility issues were found for this result.</p>
        )}
      </div>
    </section>
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
    <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-4 px-1 py-8 font-mw-body text-mw-text md:px-2">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="max-w-3xl">
          <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">Warzone {symbol} Airdrops</div>
          <h1 className="m-0 mt-1 font-mw-cond text-[32px] font-bold leading-none lg:text-[40px]">Weekly rewards for active traders and creators.</h1>
          <p className="mt-2 text-[15px] text-mw-muted">See your weekly eligibility, why you qualify or don’t qualify, available rewards and recent winners in one place.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/airdrops/winners" className={cp.btn}>Public winners<Trophy className="h-4 w-4" aria-hidden="true" /></Link>
          {account ? <Link to="/profile?tab=airdrops" className={PRIMARY_BTN}>Review claimable rewards<ArrowRight className="h-4 w-4" aria-hidden="true" /></Link> : <ConnectWalletButton />}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className={`${cp.card} p-4`}><p className={cp.label}>Trader claimable</p><p className={cp.metricValue}>{formatNative(totals.traderClaimable, solana)} {symbol}</p></div>
        <div className={`${cp.card} p-4`}><p className={cp.label}>Creator claimable</p><p className={cp.metricValue}>{formatNative(totals.creatorClaimable, solana)} {symbol}</p></div>
        <div className={`${cp.card} p-4`}><p className={cp.label}>Total wallet rewards</p><p className={cp.metricValue}>{formatNative(totals.totalClaimable, solana)} {symbol}</p></div>
      </div>

      {!account ? (
        <section className={`${cp.card} p-4`}>
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between"><div><p className={cp.label}>Wallet required</p><h2 className={`mt-1 ${cp.title}`}>Connect to inspect your airdrop eligibility.</h2><p className="mt-1 text-[15px] text-mw-muted">Once connected, we’ll show your latest trader and creator eligibility state, why you qualify or don’t qualify, and any claimable airdrop rewards.</p></div><ConnectWalletButton /></div>
        </section>
      ) : loading ? (
        <div className={`${cp.card} px-4 py-10 text-center text-[15px] text-mw-muted`}>Loading airdrop information...</div>
      ) : error ? (
        <div className="rounded-[14px] border border-[#5C1F2B] bg-[#2A1016] px-4 py-10 text-center text-[15px] text-mw-sell">{error}</div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <EligibilityCard title="Trader bucket" item={traderEligibility} claimableAmount={totals.traderClaimable} solana={solana} symbol={symbol} />
          <EligibilityCard title="Creator bucket" item={creatorEligibility} claimableAmount={totals.creatorClaimable} solana={solana} symbol={symbol} />
        </div>
      )}

      <section className={`${cp.card} p-4`}>
        <div className="flex items-center gap-3"><Sparkles className="h-5 w-5 shrink-0 text-mw-accent-soft" aria-hidden="true" /><div><p className={cp.label}>Recent winners</p><h2 className={`mt-1 ${cp.title}`}>Published draw results</h2></div></div>
        <div className="mt-4 space-y-2">
          {winners.length === 0 ? <div className={`${cp.inset} p-3 text-[15px] text-mw-muted`}>No published airdrop winners yet.</div> : winners.map((winner) => (
            <div key={`${winner.drawId}-${winner.walletAddress}-${winner.program}`} className={`${cp.inset} p-3`}>
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <div className="min-w-0"><p className="break-all font-mw-mono text-sm font-bold text-mw-text">{winner.walletAddress} · {airdropProgramLabel(winner.program)}</p><p className="mt-1 text-[13px] text-mw-muted">Epoch #{winner.epochId} · {airdropRankNoun(winner.program)} #{winner.winnerRank}</p></div>
                <div className="md:text-right"><p className="font-mw-mono text-sm font-bold text-mw-text">{formatNative(winner.payoutAmount, solana)} {symbol}</p><p className="mt-1 text-[13px] text-mw-muted">Weight tier {winner.weightTier}</p></div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
