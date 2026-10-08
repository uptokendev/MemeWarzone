import { useMemo, useState } from "react";
import { CreatorStreakRewardLine, streakRewardToastLine } from "@/components/social/CreatorStreakRewards";
import { toast } from "sonner";

import { useCommandCenterData } from "@/components/command-center/CommandCenterContext";
import { Button } from "@/components/ui/button";
import { postGradFlags } from "@/features/postgrad/config";
import { useArenaCheckin } from "@/hooks/useArenaCheckin";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { isSolanaAddress } from "@/lib/address";
import { getFrontendApiOrigin } from "@/lib/apiBase";
import { isSolanaChainId } from "@/lib/chainConfig";
import { sharePrepareToX } from "@/lib/sharePrepareToX";
import { signSolanaMessage } from "@/lib/solanaWallet";
import { signWalletAction } from "@/lib/walletActionAuth";

function tokenKey(coin: { tokenId?: string; tokenAddress?: string }) {
  return String(coin.tokenAddress || coin.tokenId || "");
}

function shareOrigin() {
  const configured = getFrontendApiOrigin();
  if (configured) return configured;
  if (typeof window !== "undefined") return window.location.origin;
  return "";
}

function appOrigin() {
  if (typeof window === "undefined") return "https://app.memewar.zone";
  const host = window.location.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1") return "https://app.memewar.zone";
  return window.location.origin;
}

export function ArenaDailyBriefing() {
  const { walletAddress, chainId } = useCommandCenterData();
  const wallet = useWallet();
  const { solanaAccount } = useSolanaWallet();
  const { status, loading, refresh, checkIn, dispatch } = useArenaCheckin(walletAddress, chainId);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const coins = status.coins;
  const current = useMemo(
    () => coins.find((coin) => tokenKey(coin) === selected) || coins[0],
    [coins, selected],
  );

  if (!postGradFlags.league || !walletAddress) return null;
  // A closed league month only stops league points; creators still check in for the streak (2026-10-08).
  if (!loading && !coins.length) return null;
  if (loading && !coins.length) return null;

  async function signAuth(action: "arena_league_checkin" | "arena_war_dispatch", extraLines: string[]) {
    const solana = isSolanaChainId(Number(chainId)) || isSolanaAddress(walletAddress);
    if (solana) {
      if (!solanaAccount) throw new Error("Connect the Solana wallet that owns this coin.");
      return signWalletAction({
        action,
        walletAddress,
        chainId: Number(chainId || 101),
        extraLines,
        walletType: "solana",
        signMessage: async (message) => (await signSolanaMessage(message, walletAddress)).signature,
      });
    }
    if (!wallet.signer) throw new Error("Connect the wallet that owns this coin.");
    return signWalletAction({
      action,
      walletAddress,
      chainId: Number(chainId || 56),
      extraLines,
      signer: wallet.signer,
    });
  }

  async function handleCheckin() {
    if (!current) {
      toast.error("Launch or verify a coin to check in.");
      return;
    }
    const token = tokenKey(current);
    setBusy("checkin");
    try {
      const auth = await signAuth("arena_league_checkin", [`Token: ${token}`, `Day: ${status.utcDay}`]);
      const result = await checkIn({ chainId, tokenAddress: token, auth });
      const days = Number(result.streakDays ?? result.streak ?? 0);
      const points = Number(result.points || 0);
      const parts = [`Checked in. Streak ${days} day${days === 1 ? "" : "s"}.`];
      if (points > 0) parts.push(Number(result.bonus) ? `+${points} league pts with the 7-day bonus.` : `+${points} league pts.`);
      const rewardLine = streakRewardToastLine(result.streakRewardEarned);
      if (rewardLine) parts.push(rewardLine);
      toast.success(parts.join(" "));
      await refresh();
    } catch (error) {
      toast.error(String((error as Error)?.message || "Could not check in."));
    } finally {
      setBusy(null);
    }
  }

  async function handleDispatch() {
    if (!current) {
      toast.error("Finish a battle this quarter before War Dispatch points land.");
      return;
    }
    const token = tokenKey(current);
    const cardId = `dispatch-${status.utcDay}-${token}`;
    const pageUrl = `${appOrigin()}/warzone/major-war-league`;
    const rankHint = current.points ? `${current.symbol} holds ${current.points} MWL pts` : `${current.symbol} is in the Major War League`;
    const params = new URLSearchParams({
      name: current.tokenName || current.symbol,
      ticker: current.symbol || "MWZ",
      status: "MAJOR WAR LEAGUE",
      description: `${rankHint}. Open for Battle.`,
      link: pageUrl.replace(/^https?:\/\//, ""),
      _v: cardId,
    });
    const imageUrl = `${shareOrigin()}/api/prepare-share-card?${params.toString()}`;
    setBusy("dispatch");
    try {
      await sharePrepareToX({
        imageUrl,
        pageUrl,
        tweetText: `${current.symbol} is on the MemeWarzone Major War League board. Open for Battle.`,
        fileName: `memewarzone-${current.symbol || "mwl"}-dispatch.png`,
        mode: "guided",
      });
      const auth = await signAuth("arena_war_dispatch", [`Token: ${token}`, `Card: ${cardId}`, `Day: ${status.utcDay}`]);
      const result = await dispatch({ chainId, tokenAddress: token, cardId, auth });
      toast.success(`War Dispatch sent. +${result.points} pts.`);
      await refresh();
    } catch (error) {
      toast.error(String((error as Error)?.message || "Could not send War Dispatch."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-[14px] border border-mw-border bg-mw-input p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-accent-soft">Daily briefing</div>
          <h2 className="mt-1 font-semibold text-sm text-mw-text">{current?.league ? "Check in and dispatch" : "Daily check-in"}</h2>
          <CreatorStreakRewardLine
            streak={status.streak}
            currentStreak={status.currentStreak}
            alreadyCheckedIn={status.alreadyCheckedIn}
            daysToReward={status.daysToStreakReward}
            rewardsReady={status.streakRewards}
          />
          <p className="mt-1 max-w-2xl text-xs text-mw-muted">
            {current?.league
              ? `$${String(current.symbol).replace(/^\$/, "")} is in this month's Major War League: check-in +0.1 pts, 7 days in a row +0.5, War Dispatch +0.25.`
              : `$${String(current?.symbol || "").replace(/^\$/, "")} is not in this month's Major War League, so it earns no league points. A battle puts it in.`}
          </p>
        </div>
        {coins.length > 1 ? (
          <select
            className="rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-mw-text"
            value={tokenKey(current)}
            onChange={(event) => setSelected(event.target.value)}
          >
            {coins.map((coin) => (
              <option key={tokenKey(coin)} value={tokenKey(coin)}>
                {coin.symbol}{coin.league ? ` · ${coin.points} pts` : ""}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          className={`font-semibold ${status.alreadyCheckedIn ? "" : "border border-mw-accent bg-mw-accent text-[#140A02] hover:bg-[#FF8F3D]"}`}
          disabled={Boolean(busy) || status.alreadyCheckedIn}
          onClick={() => void handleCheckin()}
        >
          {busy === "checkin" ? "Checking in..." : status.alreadyCheckedIn ? "Checked in" : "Daily check-in"}
        </Button>
        {current?.league ? (
          <Button
            size="sm"
            variant="outline"
            className="font-semibold"
            disabled={Boolean(busy) || status.alreadyDispatched}
            onClick={() => void handleDispatch()}
          >
            {busy === "dispatch" ? "Opening X..." : status.alreadyDispatched ? "Dispatched" : "War Dispatch"}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
