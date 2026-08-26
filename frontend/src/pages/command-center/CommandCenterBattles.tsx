import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Swords } from "lucide-react";
import { toast } from "sonner";

import { CommandCenterCard } from "@/components/command-center/CommandCenterCard";
import { useCommandCenterData } from "@/components/command-center/CommandCenterContext";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { Button } from "@/components/ui/button";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import {
  acceptPostGradBattle,
  challengePostGradBattle,
  declinePostGradBattle,
  openPostGradBattle,
} from "@/features/postgrad/apiClient";
import { postGradFlags } from "@/features/postgrad/config";
import { useArenaBattleFeed, type CreatorBattleStatus } from "@/hooks/useArenaBattleFeed";
import { isSolanaAddress } from "@/lib/address";
import { isSolanaChainId } from "@/lib/chainConfig";
import { signWalletAction } from "@/lib/walletActionAuth";
import { signSolanaMessage } from "@/lib/solanaWallet";
import { publicBattleLabel, publicBattleLane } from "@/lib/arena/publicBattleState";

function nativeLabel(chainId?: number) {
  return isSolanaChainId(Number(chainId)) ? "SOL" : "BNB";
}

function tokenKey(status: CreatorBattleStatus) {
  return status.tokenAddress || status.tokenId || status.campaignAddress;
}

export default function CommandCenterBattles() {
  const { walletAddress, chainId } = useCommandCenterData();
  const wallet = useWallet();
  const { solanaAccount } = useSolanaWallet();
  const feed = useArenaBattleFeed(walletAddress, chainId);
  const [selectedToken, setSelectedToken] = useState("");
  const [stake, setStake] = useState("");
  const [challengeTarget, setChallengeTarget] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const qualified = useMemo(
    () => feed.creatorStatuses.filter((item) => item.eligibility || Boolean(item.battleId)),
    [feed.creatorStatuses],
  );
  const eligible = qualified.filter((item) => item.eligibility);
  const incoming = useMemo(() => {
    return feed.openForBattleQueue.filter((battle) => {
      if (String(battle.state) !== "challenged") return false;
      const defender = battle.participants?.[1];
      const keys = new Set(qualified.map(tokenKey).map((value) => value.toLowerCase()));
      const defenderId = String(defender?.tokenAddress || defender?.tokenId || "").toLowerCase();
      return Boolean(defenderId && keys.has(defenderId));
    });
  }, [feed.openForBattleQueue, qualified]);
  const waitingRivals = useMemo(
    () =>
      feed.openForBattleQueue.filter((battle) => {
        if (publicBattleLane(battle.state) !== "waiting") return false;
        const opener = battle.participants?.[0];
        const mine = qualified.some((item) => {
          const key = tokenKey(item).toLowerCase();
          return key && [opener?.tokenId, opener?.tokenAddress, opener?.campaignAddress].some((value) => String(value || "").toLowerCase() === key);
        });
        return !mine;
      }),
    [feed.openForBattleQueue, qualified],
  );

  const selected = eligible.find((item) => tokenKey(item) === selectedToken) || eligible[0];
  const stakeAmount = Number(stake);
  const canAct = Boolean(selected && Number.isFinite(stakeAmount) && stakeAmount > 0 && !busy);

  async function signAuth(action: string, extraLines: string[]) {
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

  async function handleOpen() {
    if (!selected || !canAct) return;
    const tokenId = tokenKey(selected);
    setBusy("open");
    try {
      const auth = await signAuth("arena_open_battle", [`Token: ${tokenId}`, `Stake: ${stakeAmount}`]);
      await openPostGradBattle({ tokenId, chainId: Number(chainId), stakeNative: stakeAmount, auth });
      await feed.refreshFeed();
      toast.success("Coin is waiting for a similar rival.");
    } catch (error) {
      toast.error(String((error as Error)?.message || "Could not open for battle."));
    } finally {
      setBusy(null);
    }
  }

  async function handleChallenge() {
    if (!selected || !canAct || !challengeTarget.trim()) return;
    const tokenId = tokenKey(selected);
    const targetTokenId = challengeTarget.trim();
    setBusy("challenge");
    try {
      const auth = await signAuth("arena_challenge_battle", [
        `Challenger: ${tokenId}`,
        `Defender: ${targetTokenId}`,
        `Stake: ${stakeAmount}`,
      ]);
      await challengePostGradBattle({ tokenId, targetTokenId, chainId: Number(chainId), stakeNative: stakeAmount, auth });
      await feed.refreshFeed();
      toast.success("Challenge sent.");
    } catch (error) {
      toast.error(String((error as Error)?.message || "Could not send challenge."));
    } finally {
      setBusy(null);
    }
  }

  async function handleIncoming(battleId: string, accept: boolean) {
    setBusy(battleId);
    try {
      const action = accept ? "arena_accept_battle" : "arena_decline_battle";
      const auth = await signAuth(action, [`Battle: ${battleId}`]);
      if (accept) await acceptPostGradBattle(battleId, auth);
      else await declinePostGradBattle(battleId, auth);
      await feed.refreshFeed();
      toast.success(accept ? "Challenge accepted. Fight is live." : "Challenge declined.");
    } catch (error) {
      toast.error(String((error as Error)?.message || "Could not update challenge."));
    } finally {
      setBusy(null);
    }
  }

  if (!postGradFlags.arena) {
    return (
      <CommandCenterCard title="Battles" description="Arena fights stay gated until the Arena flags are on.">
        <p className="text-sm text-muted-foreground">This page is reserved for graduated coins and approved imports.</p>
      </CommandCenterCard>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Swords className="h-4 w-4 text-accent" />
        <span className="font-retro text-[10px] uppercase tracking-[0.16em]">Arena battles</span>
      </div>

      {incoming.length ? (
        <CommandCenterCard title="Incoming challenges" description="Accept to start a live 12-hour fight, or decline.">
          <div className="space-y-3">
            {incoming.map((battle) => {
              const challenger = battle.participants?.[0];
              const defender = battle.participants?.[1];
              return (
                <div key={battle.id} className="mwz-hud-frame flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
                  <div>
                    <TacticalTag label="Challenged" tone="hot" />
                    <div className="mt-2 font-retro text-sm text-foreground">
                      {challenger?.symbol || "Rival"} challenged {defender?.symbol || "your coin"}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">Stake {(battle as { stakeNative?: number }).stakeNative || "—"} {nativeLabel(chainId)}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" className="font-retro" disabled={busy === battle.id} onClick={() => void handleIncoming(battle.id, true)}>
                      Accept
                    </Button>
                    <Button size="sm" variant="outline" className="font-retro" disabled={busy === battle.id} onClick={() => void handleIncoming(battle.id, false)}>
                      Decline
                    </Button>
                    <Button asChild size="sm" variant="outline" className="font-retro">
                      <Link to={`/battle/${encodeURIComponent(battle.id)}`}>View</Link>
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </CommandCenterCard>
      ) : null}

      <CommandCenterCard title="Open for battle" description="Set a chain-native stake. We auto-match a similar waiting coin within 20% of that stake.">
        {!eligible.length ? (
          <p className="text-sm text-muted-foreground">
            {feed.loading
              ? "Loading your graduated and imported coins..."
              : "No eligible coins yet. Graduate a MemeWarzone coin or import a passed token first."}
          </p>
        ) : (
          <div className="space-y-3">
            <label className="block text-xs uppercase tracking-[0.14em] text-muted-foreground">
              Coin
              <select
                className="mt-1 w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-foreground"
                value={tokenKey(selected)}
                onChange={(event) => setSelectedToken(event.target.value)}
              >
                {eligible.map((item) => (
                  <option key={tokenKey(item)} value={tokenKey(item)}>
                    {item.symbol || item.tokenName} ({item.origin === "import" ? "imported" : "graduated"})
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs uppercase tracking-[0.14em] text-muted-foreground">
              Stake ({nativeLabel(chainId)})
              <input
                type="number"
                min="0"
                step="any"
                value={stake}
                onChange={(event) => setStake(event.target.value)}
                className="mt-1 w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-foreground"
                placeholder={`Amount in ${nativeLabel(chainId)}`}
              />
            </label>
            <Button className="font-retro" disabled={!canAct} onClick={() => void handleOpen()}>
              {busy === "open" ? "Opening..." : "Open for battle"}
            </Button>
          </div>
        )}
      </CommandCenterCard>

      <CommandCenterCard title="Challenge a coin" description="Pick a waiting rival or paste a token address. They must accept before the fight goes live.">
        <div className="space-y-3">
          <label className="block text-xs uppercase tracking-[0.14em] text-muted-foreground">
            Target token
            <input
              value={challengeTarget}
              onChange={(event) => setChallengeTarget(event.target.value)}
              className="mt-1 w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-foreground"
              placeholder="Token address"
            />
          </label>
          {waitingRivals.length ? (
            <div className="space-y-2">
              <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Waiting now</div>
              {waitingRivals.slice(0, 8).map((battle) => {
                const opener = battle.participants?.[0];
                const target = String(opener?.tokenAddress || opener?.tokenId || "");
                return (
                  <button
                    key={battle.id}
                    type="button"
                    className="mwz-hud-frame flex w-full items-center justify-between p-3 text-left text-sm"
                    onClick={() => setChallengeTarget(target)}
                  >
                    <span className="font-retro text-foreground">{opener?.symbol || opener?.tokenName || "Unknown"}</span>
                    <span className="text-xs text-muted-foreground">{publicBattleLabel("waiting")}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
          <Button className="font-retro" disabled={!canAct || !challengeTarget.trim()} onClick={() => void handleChallenge()}>
            {busy === "challenge" ? "Sending..." : "Send challenge"}
          </Button>
        </div>
      </CommandCenterCard>

      <CommandCenterCard title="Your match status" description="Live, waiting, and finished fights for coins you own.">
        {qualified.length ? (
          <div className="space-y-2">
            {qualified.map((item) => (
              <div key={tokenKey(item)} className="mwz-hud-frame flex flex-wrap items-center justify-between gap-2 p-3">
                <div>
                  <div className="font-retro text-sm text-foreground">{item.symbol || item.tokenName}</div>
                  <div className="text-xs text-muted-foreground">{item.unavailableReason || item.currentState}</div>
                </div>
                {item.battleId ? (
                  <Button asChild size="sm" variant="outline" className="font-retro">
                    <Link to={`/battle/${encodeURIComponent(item.battleId)}`}>Open battle</Link>
                  </Button>
                ) : (
                  <TacticalTag label={item.eligibility ? "Ready" : "Unavailable"} tone={item.eligibility ? "success" : "default"} />
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{feed.loading ? "Loading..." : "No battle activity yet."}</p>
        )}
      </CommandCenterCard>
    </div>
  );
}
