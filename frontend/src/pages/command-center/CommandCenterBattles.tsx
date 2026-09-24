import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Swords } from "lucide-react";
import { toast } from "sonner";

import { ChallengeCoinModal } from "@/components/arena/ChallengeCoinModal";
import { CreatorChallengeCarousel } from "@/components/arena/CreatorChallengeCarousel";
import { CommandCenterCard } from "@/components/command-center/CommandCenterCard";
import { useCommandCenterData } from "@/components/command-center/CommandCenterContext";
import { FindMatchPanel } from "@/components/command-center/FindMatchPanel";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { Button } from "@/components/ui/button";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import {
  acceptPostGradBattle,
  cancelPostGradBattleOpen,
  counterPostGradBattle,
  declinePostGradBattle,
  openPostGradBattle,
} from "@/features/postgrad/apiClient";
import { postGradFlags } from "@/features/postgrad/config";
import { useArenaBattleFeed, type CreatorBattleStatus } from "@/hooks/useArenaBattleFeed";
import { isSolanaAddress } from "@/lib/address";
import { getNativeSymbol, isSolanaChainId } from "@/lib/chainConfig";
import { signWalletAction } from "@/lib/walletActionAuth";
import { signSolanaMessage } from "@/lib/solanaWallet";
import { ArenaStakeButton } from "@/components/arena/ArenaStakeButton";
import {
  battleDurationLabel,
  battleDurationOptions,
  parseBattleDurationHours,
  parseBattleDurationHoursForMode,
  parseBattleMode,
  type BattleMode,
} from "@/lib/arena/battleDuration";
import { presentAutoDeployStatus } from "@/lib/arena/autoDeployPresentation.mjs";
import { collectIncomingCreatorChallenges } from "@/lib/arena/creatorChallengePresentation.mjs";
import { presentMatchCandidates } from "@/lib/arena/findMatchPresentation.mjs";

function nativeLabel(chainId?: number, fallback?: string) {
  if (fallback) return fallback;
  return getNativeSymbol(chainId);
}

function tokenKey(status: CreatorBattleStatus) {
  return status.tokenAddress || status.tokenId || status.campaignAddress;
}

export default function CommandCenterBattles() {
  const { walletAddress, chainId } = useCommandCenterData();
  const location = useLocation();
  const wallet = useWallet();
  const { solanaAccount } = useSolanaWallet();
  const feed = useArenaBattleFeed(walletAddress, chainId);
  const [selectedToken, setSelectedToken] = useState("");
  const [stake, setStake] = useState("");
  const [challengeTarget, setChallengeTarget] = useState("");
  const [durationHours, setDurationHours] = useState(24);
  const [battleMode, setBattleMode] = useState<BattleMode>("normal");
  // The API signs "Mode: vote" only for Vote Battles; a metrics battle keeps
  // the historical message so nothing changes for existing flows.
  const modeSignatureLines = battleMode === "vote" ? [`Mode: ${battleMode}`] : [];
  const [busy, setBusy] = useState<string | null>(null);
  const [challengeOpen, setChallengeOpen] = useState(false);
  const [, setMatchCandidates] = useState<ReturnType<typeof presentMatchCandidates>>([]);

  const qualified = useMemo(
    () => feed.creatorStatuses.filter((item) => item.eligibility || Boolean(item.battleId)),
    [feed.creatorStatuses],
  );
  const eligible = qualified.filter((item) => item.eligibility);
  const incoming = useMemo(
    () => collectIncomingCreatorChallenges(feed.openForBattleQueue, feed.creatorStatuses, walletAddress),
    [feed.creatorStatuses, feed.openForBattleQueue, walletAddress],
  );

  const selected = qualified.find((item) => tokenKey(item) === selectedToken) || qualified[0] || eligible[0];
  const selectedBattle =
    [...feed.openForBattleQueue, ...feed.liveBattles].find((battle) => battle.id && battle.id === selected?.battleId) || null;
  const autoDeployMode = presentAutoDeployStatus(selected, selectedBattle);
  const stakeAmount = Number(stake);
  const canAct = Boolean(selected?.eligibility && Number.isFinite(stakeAmount) && stakeAmount > 0 && !busy);

  useEffect(() => {
    if (location.hash !== "#command-center-challenge") return;
    setChallengeOpen(true);
    const timer = window.setTimeout(() => {
      document.getElementById("command-center-challenge")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
    return () => window.clearTimeout(timer);
  }, [location.hash]);

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
      const auth = await signAuth("arena_open_battle", [`Token: ${tokenId}`, `Stake: ${stakeAmount}`, `Duration: ${durationHours}`, ...modeSignatureLines]);
      await openPostGradBattle({ tokenId, chainId: Number(chainId), stakeNative: stakeAmount, durationHours, battleMode, auth });
      await feed.refreshFeed();
      toast.success(
        battleMode === "vote"
          ? "AUTO DEPLOY is on for a Vote Battle. A compatible Vote Battle opponent can be paired automatically. If escrow is required, both owners still fund on-chain."
          : "AUTO DEPLOY is on. Compatible opponents can be paired automatically. If escrow is required, both owners still fund on-chain.",
      );
    } catch (error) {
      toast.error(String((error as Error)?.message || "Could not enable AUTO DEPLOY."));
    } finally {
      setBusy(null);
    }
  }

  async function handleDisableAutoDeploy() {
    if (!selected?.battleId || autoDeployMode !== "searching") return;
    setBusy("cancel-open");
    try {
      const auth = await signAuth("arena_cancel_open_battle", [`Battle: ${selected.battleId}`, `Token: ${tokenKey(selected)}`]);
      await cancelPostGradBattleOpen(selected.battleId, auth);
      await feed.refreshFeed();
      toast.success("AUTO DEPLOY disabled. This coin left the matchmaking queue.");
    } catch (error) {
      toast.error(String((error as Error)?.message || "Could not disable AUTO DEPLOY."));
    } finally {
      setBusy(null);
    }
  }

  async function handleCounterOffer(battleId: string, counterStake: string, counterDurationHours: number) {
    const amount = Number(counterStake);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter a counter-offer stake greater than zero.");
      throw new Error("Enter a counter-offer stake greater than zero.");
    }
    setBusy(battleId);
    try {
      const hours = parseBattleDurationHours(counterDurationHours, 24);
      const auth = await signAuth("arena_counter_battle", [`Battle: ${battleId}`, `Stake: ${amount}`, `Duration: ${hours}`]);
      await counterPostGradBattle(battleId, amount, auth, hours);
      await feed.refreshFeed();
      toast.success("Counter-offer sent. They get a popup and email if verified.");
    } catch (error) {
      toast.error(String((error as Error)?.message || "Could not send counter-offer."));
      throw error;
    } finally {
      setBusy(null);
    }
  }

  async function handleIncoming(battleId: string, accept: boolean) {
    setBusy(battleId);
    try {
      const action = accept ? "arena_accept_battle" : "arena_decline_battle";
      const auth = await signAuth(action, [`Battle: ${battleId}`]);
      if (accept) {
        const result = await acceptPostGradBattle(battleId, auth);
        await feed.refreshFeed();
        toast.success(
          result?.battle?.state === "matched" || result?.escrowRequired
            ? "Accepted. Pay your on-chain stake to start the 12-hour fight."
            : "Challenge accepted. Fight is live.",
        );
      } else {
        await declinePostGradBattle(battleId, auth);
        await feed.refreshFeed();
        toast.success("Challenge declined.");
      }
    } catch (error) {
      toast.error(String((error as Error)?.message || "Could not update challenge."));
      throw error;
    } finally {
      setBusy(null);
    }
  }

  if (!postGradFlags.arena) {
    return (
      <CommandCenterCard title="Battles" description="Warzone fights stay gated until the Warzone flags are on.">
        <p className="text-sm text-muted-foreground">This page is reserved for graduated coins and approved imports.</p>
      </CommandCenterCard>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Swords className="h-4 w-4 text-accent" />
        <span className="font-retro text-[10px] uppercase tracking-[0.16em]">Warzone battles</span>
      </div>

      {incoming.length ? (
        <CommandCenterCard title="Incoming offers" description="Accept, decline, or counter-offer a different stake. Add an email in Settings to get challenge and counter-offer mail.">
          <CreatorChallengeCarousel
            challenges={incoming}
            chainId={chainId}
            busyId={busy}
            onAccept={(battleId) => handleIncoming(battleId, true)}
            onDecline={(battleId) => handleIncoming(battleId, false)}
            onCounter={handleCounterOffer}
          />
        </CommandCenterCard>
      ) : null}

      <CommandCenterCard
        title="AUTO DEPLOY"
        description="Opt this coin into automatic matchmaking. Compatible AUTO DEPLOY opponents can be paired without ACCEPT. If escrow is required, each owner still funds on-chain. The backend never signs wallet transactions. Stake and duration stay under your control."
      >
        {!qualified.length ? (
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
                onChange={(event) => {
                  setSelectedToken(event.target.value);
                  setChallengeTarget("");
                  setMatchCandidates([]);
                }}
              >
                {qualified.map((item) => (
                  <option key={tokenKey(item)} value={tokenKey(item)}>
                    {item.symbol || item.tokenName} ({item.origin === "import" ? "imported" : "graduated"})
                  </option>
                ))}
              </select>
            </label>
            {autoDeployMode === "searching" ? (
              <>
                <TacticalTag label="AUTO DEPLOY: SEARCHING" tone="sponsored" />
                <p className="text-sm text-muted-foreground">
                  Stake {selectedBattle?.stakeNative ?? "—"} {nativeLabel(chainId, selectedBattle?.nativeSymbol)} ·{" "}
                  {battleDurationLabel((selectedBattle as { durationHours?: number } | null)?.durationHours || durationHours)}
                </p>
                <p className="text-sm text-muted-foreground">
                  Looking for a ranked compatible opponent. No ACCEPT step after an automatic pair.
                </p>
                <Button className="font-retro" variant="outline" disabled={busy === "cancel-open"} onClick={() => void handleDisableAutoDeploy()}>
                  {busy === "cancel-open" ? "Disabling..." : "DISABLE AUTO DEPLOY"}
                </Button>
              </>
            ) : autoDeployMode === "funding" ? (
              <>
                <TacticalTag label="OPPONENT FOUND / FUNDING REQUIRED" tone="hot" />
                <p className="text-sm text-muted-foreground">AUTO DEPLOY cannot be disabled after a pair. Both owners fund the on-chain stake.</p>
                {selected?.battleId ? (
                  <ArenaStakeButton
                    battleId={selected.battleId}
                    chainId={chainId}
                    walletAddress={walletAddress}
                    battleState={selected.currentState}
                  />
                ) : null}
              </>
            ) : autoDeployMode === "live" ? (
              <>
                <TacticalTag label="LIVE" tone="hot" />
                <p className="text-sm text-muted-foreground">This coin is already in a live fight.</p>
              </>
            ) : (
              <>
                <label className="block text-xs uppercase tracking-[0.14em] text-muted-foreground">
                  Battle type
                  <select
                    data-battle-mode-select="true"
                    className="mt-1 w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-foreground"
                    value={battleMode}
                    onChange={(event) => {
                      const nextMode = parseBattleMode(event.target.value);
                      setBattleMode(nextMode);
                      setDurationHours(parseBattleDurationHoursForMode(nextMode, durationHours, 24));
                    }}
                  >
                    <option value="normal">Metrics battle (market cap, holders, volume, boosts)</option>
                    <option value="vote">Vote Battle (free votes + boosts, 1 to 24 hours)</option>
                  </select>
                </label>
                <label className="block text-xs uppercase tracking-[0.14em] text-muted-foreground">
                  Fight length
                  <select
                    className="mt-1 w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-foreground"
                    value={durationHours}
                    onChange={(event) => setDurationHours(parseBattleDurationHoursForMode(battleMode, event.target.value, 24))}
                  >
                    {battleDurationOptions(battleMode).map((item) => (
                      <option key={item.hours} value={item.hours}>
                        {item.label}
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
                  {busy === "open" ? "Enabling..." : "ENABLE AUTO DEPLOY"}
                </Button>
              </>
            )}
          </div>
        )}
      </CommandCenterCard>

      {selected?.eligibility ? (
        <FindMatchPanel
          tokenId={tokenKey(selected)}
          chainId={Number(chainId) || undefined}
          selectedTargetId={challengeTarget}
          onCandidatesChange={setMatchCandidates}
          onSelectTarget={(tokenId) => {
            setChallengeTarget(tokenId);
            setChallengeOpen(true);
            document.getElementById("command-center-challenge")?.scrollIntoView({ behavior: "smooth", block: "start" });
            toast.message("Rival selected. Set stake and duration, then send the challenge.");
          }}
        />
      ) : null}

      <div id="command-center-challenge">
        <CommandCenterCard title="Challenge a coin" description="Pick a waiting rival or paste a token address. They must accept before the fight goes live.">
          <Button className="font-retro" onClick={() => setChallengeOpen(true)}>
            <Swords className="h-4 w-4" />
            Challenge a coin
          </Button>
        </CommandCenterCard>
      </div>
      <ChallengeCoinModal
        open={challengeOpen}
        onOpenChange={setChallengeOpen}
        walletAddress={walletAddress}
        chainId={chainId}
        initialTokenId={selected ? tokenKey(selected) : ""}
        initialTargetId={challengeTarget}
        onSent={() => void feed.refreshFeed()}
      />

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
                  <div className="flex flex-wrap gap-2">
                    {item.currentState === "matched" ? (
                      <ArenaStakeButton
                        battleId={item.battleId}
                        chainId={chainId}
                        walletAddress={walletAddress}
                        battleState={item.currentState}
                      />
                    ) : null}
                    <Button asChild size="sm" variant="outline" className="font-retro">
                      <Link to={`/battle/${encodeURIComponent(item.battleId)}`}>Open battle</Link>
                    </Button>
                  </div>
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
