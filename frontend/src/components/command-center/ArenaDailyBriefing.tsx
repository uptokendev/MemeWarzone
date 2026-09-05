import { useMemo, useState } from "react";
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
  if (status.frozen) return null;
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
      toast.error("Finish a battle this quarter before check-in points land.");
      return;
    }
    const token = tokenKey(current);
    setBusy("checkin");
    try {
      const auth = await signAuth("arena_league_checkin", [`Token: ${token}`, `Day: ${status.utcDay}`]);
      const result = await checkIn({ chainId, tokenAddress: token, auth });
      toast.success(
        Number(result.bonus)
          ? `Checked in. ${result.points} pts including a 7-day streak bonus.`
          : `Checked in. +${result.points} pts. Streak ${result.streak}.`,
      );
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
    <section className="mwz-hud-frame p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.22em] text-accent/80">Daily briefing</div>
          <h2 className="mt-1 font-retro text-sm text-foreground">Check in and dispatch</h2>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            Streak {status.streak} day{status.streak === 1 ? "" : "s"}. Check-in 0.1 pts, 7-day streak +0.5, War Dispatch 0.25. One of each per UTC day.
          </p>
        </div>
        {coins.length > 1 ? (
          <select
            className="rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-foreground"
            value={tokenKey(current)}
            onChange={(event) => setSelected(event.target.value)}
          >
            {coins.map((coin) => (
              <option key={tokenKey(coin)} value={tokenKey(coin)}>
                {coin.symbol} · {coin.points} pts
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          className="font-retro"
          disabled={Boolean(busy) || status.alreadyCheckedIn}
          onClick={() => void handleCheckin()}
        >
          {busy === "checkin" ? "Checking in..." : status.alreadyCheckedIn ? "Checked in" : "Daily check-in"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="font-retro"
          disabled={Boolean(busy) || status.alreadyDispatched}
          onClick={() => void handleDispatch()}
        >
          {busy === "dispatch" ? "Opening X..." : status.alreadyDispatched ? "Dispatched" : "War Dispatch"}
        </Button>
      </div>
    </section>
  );
}
