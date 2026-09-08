import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Swords } from "lucide-react";
import { toast } from "sonner";

import { CreatorChallengeCarousel } from "@/components/arena/CreatorChallengeCarousel";
import { CommandCenterCard } from "@/components/command-center/CommandCenterCard";
import { useCommandCenterData } from "@/components/command-center/CommandCenterContext";
import { FindMatchPanel } from "@/components/command-center/FindMatchPanel";
import { MatchQualityPreview } from "@/components/command-center/MatchQualityPreview";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { Button } from "@/components/ui/button";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import {
  acceptPostGradBattle,
  cancelPostGradBattleOpen,
  challengePostGradBattle,
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
import { BATTLE_DURATIONS, battleDurationLabel, parseBattleDurationHours } from "@/lib/arena/battleDuration";
import { presentAutoDeployStatus } from "@/lib/arena/autoDeployPresentation.mjs";
import { collectIncomingCreatorChallenges } from "@/lib/arena/creatorChallengePresentation.mjs";
import { presentManualOpponentPreview, presentMatchCandidates } from "@/lib/arena/findMatchPresentation.mjs";
import { publicBattleLabel, publicBattleLane } from "@/lib/arena/publicBattleState";

function nativeLabel(chainId?: number, fallback?: string) {
  if (fallback) return fallback;
  return getNativeSymbol(chainId);
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
  const [durationHours, setDurationHours] = useState(24);
  const [busy, setBusy] = useState<string | null>(null);
  const [matchCandidates, setMatchCandidates] = useState<ReturnType<typeof presentMatchCandidates>>([]);

  const qualified = useMemo(
    () => feed.creatorStatuses.filter((item) => item.eligibility || Boolean(item.battleId)),
    [feed.creatorStatuses],
  );
  const eligible = qualified.filter((item) => item.eligibility);
  const incoming = useMemo(
    () => collectIncomingCreatorChallenges(feed.openForBattleQueue, feed.creatorStatuses, walletAddress),
    [feed.creatorStatuses, feed.openForBattleQueue, walletAddress],
  );
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

  const selected = qualified.find((item) => tokenKey(item) === selectedToken) || qualified[0] || eligible[0];
  const selectedBattle =
    [...feed.openForBattleQueue, ...feed.liveBattles].find((battle) => battle.id && battle.id === selected?.battleId) || null;
  const autoDeployMode = presentAutoDeployStatus(selected, selectedBattle);
  const stakeAmount = Number(stake);
  const canAct = Boolean(selected?.eligibility && Number.isFinite(stakeAmount) && stakeAmount > 0 && !busy);
  const matchPreview = presentManualOpponentPreview(challengeTarget, matchCandidates);

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
      const auth = await signAuth("arena_open_battle", [`Token: ${tokenId}`, `Stake: ${stakeAmount}`, `Duration: ${durationHours}`]);
      await openPostGradBattle({ tokenId, chainId: Number(chainId), stakeNative: stakeAmount, durationHours, auth });
      await feed.refreshFeed();
      toast.success("AUTO DEPLOY is on. Compatible opponents can be paired automatically. If escrow is required, both owners still fund on-chain.");
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
        `Duration: ${durationHours}`,
      ]);
      await challengePostGradBattle({ tokenId, targetTokenId, chainId: Number(chainId), stakeNative: stakeAmount, durationHours, auth });
      await feed.refreshFeed();
      toast.success("Challenge sent. Email goes out if they verified an address and Resend is configured.");
    } catch (error) {
      toast.error(String((error as Error)?.message || "Could not send challenge."));
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
                  Fight length
                  <select
                    className="mt-1 w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-foreground"
                    value={durationHours}
                    onChange={(event) => setDurationHours(parseBattleDurationHours(event.target.value, 24))}
                  >
                    {BATTLE_DURATIONS.map((item) => (
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
            document.getElementById("command-center-challenge")?.scrollIntoView({ behavior: "smooth", block: "start" });
            toast.message("Rival selected. Set stake and duration, then send the challenge.");
          }}
        />
      ) : null}

      <CommandCenterCard title="Challenge a coin" description="Pick a waiting rival or paste a token address. They must accept before the fight goes live.">
        <div className="space-y-3" id="command-center-challenge">
          <label className="block text-xs uppercase tracking-[0.14em] text-muted-foreground">
            Target token
            <input
              value={challengeTarget}
              onChange={(event) => setChallengeTarget(event.target.value)}
              className="mt-1 w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-foreground"
              placeholder="Token address"
            />
          </label>
          <MatchQualityPreview
            preview={matchPreview}
            onChallengeAnyway={() => {
              toast.message("Open War can still proceed. Set stake and duration, then send the challenge.");
            }}
            onContinueWithChallenge={() => {
              toast.message("You can still send this challenge. Set stake and duration, then send it.");
            }}
          />
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
