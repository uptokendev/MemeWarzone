import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Swords } from "lucide-react";
import { toast } from "sonner";

import { ChallengeCoinModal } from "@/components/arena/ChallengeCoinModal";
import { CreatorChallengeCarousel } from "@/components/arena/CreatorChallengeCarousel";
import { CommandCenterCard } from "@/components/command-center/CommandCenterCard";
import { useCommandCenterData } from "@/components/command-center/CommandCenterContext";
import { FindMatchPanel } from "@/components/command-center/FindMatchPanel";
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
import { requestArenaBuyIn, shouldOpenBuyInAfterAccept } from "@/lib/arena/challengePopupPresentation.mjs";
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
        if (shouldOpenBuyInAfterAccept(result, result?.battle) && result?.battle) {
          requestArenaBuyIn(result.battle);
          toast.success("Accepted. Pay your buy-in.");
        } else {
          toast.success("Challenge accepted. Fight is live.");
        }
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

  const chip = "inline-flex h-[22px] items-center rounded-full border px-2 text-xs font-semibold";
  const chipOrange = "border-[#7A3A0C] bg-[#2A1609] text-mw-accent-soft";
  const fieldLabel = "flex flex-col gap-1.5 font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted";
  const fieldInput = "mw-focus h-11 w-full rounded-[10px] border border-[#2E353D] bg-mw-input px-3 font-mw-body text-[15px] normal-case tracking-normal text-mw-text";
  const smallButton = "mw-focus inline-flex min-h-9 items-center justify-center gap-2 rounded-[10px] border border-mw-edge bg-mw-raised px-3 font-mw-body text-sm font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text disabled:opacity-50";
  const primaryButton = "mw-focus inline-flex min-h-10 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 font-mw-body text-sm font-bold text-[#140A02] hover:bg-[#FF8A3D] hover:text-[#140A02] disabled:opacity-50";

  return (
    <div className="flex flex-col gap-3.5 font-mw-body text-mw-text">
      <h2 className="sr-only">Battles</h2>

      {incoming.length ? (
        <CommandCenterCard className="border-[#5A3416]" title="Incoming offers" description="Accept, decline, or counter-offer a different stake. Add an email in Settings to get challenge and counter-offer mail.">
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

      <CommandCenterCard title="Your match status" description="Live, waiting, and finished fights for coins you own.">
        {qualified.length ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2 lg:grid-cols-[repeat(auto-fill,minmax(200px,1fr))]">
            {qualified.map((item) => (
              <div key={tokenKey(item)} className="flex flex-col gap-1.5 rounded-[14px] border border-mw-border bg-mw-input p-3">
                <div>
                  <b>{item.symbol || item.tokenName}</b>
                  <div className="text-[13px] text-mw-muted">{item.unavailableReason || item.currentState}</div>
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
                    <Link to={`/battle/${encodeURIComponent(item.battleId)}`} className={smallButton}>Open battle</Link>
                  </div>
                ) : (
                  <span className={`${chip} w-max ${item.eligibility ? "border-[#1F5133] text-[#6EE7A0]" : "border-mw-edge text-mw-muted"}`}>{item.eligibility ? "Ready" : "Unavailable"}</span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="m-0 text-sm text-mw-muted">{feed.loading ? "Loading..." : "No battle activity yet."}</p>
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
          <Button className={`${primaryButton} w-max`} onClick={() => setChallengeOpen(true)}>
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


      <CommandCenterCard
        title="Auto deploy"
        description="Opt this coin into automatic matchmaking. Compatible AUTO DEPLOY opponents can be paired without ACCEPT. If escrow is required, each owner still funds on-chain. The backend never signs wallet transactions. Stake and duration stay under your control."
      >
        {!qualified.length ? (
          <p className="m-0 text-sm text-mw-muted">
            {feed.loading
              ? "Loading your graduated and imported coins..."
              : "No eligible coins yet. Graduate a MemeWarzone coin or import a passed token first."}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <label className={fieldLabel}>
              Coin
              <select
                className={fieldInput}
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
                <span className={`${chip} w-max ${chipOrange}`}>AUTO DEPLOY: SEARCHING</span>
                <p className="m-0 text-sm text-mw-muted">
                  Stake {selectedBattle?.stakeNative ?? "—"} {nativeLabel(chainId, selectedBattle?.nativeSymbol)} ·{" "}
                  {battleDurationLabel((selectedBattle as { durationHours?: number } | null)?.durationHours || durationHours)}
                </p>
                <p className="m-0 text-sm text-mw-muted">
                  Looking for a ranked compatible opponent. No ACCEPT step after an automatic pair.
                </p>
                <Button className={smallButton} disabled={busy === "cancel-open"} onClick={() => void handleDisableAutoDeploy()}>
                  {busy === "cancel-open" ? "Disabling..." : "DISABLE AUTO DEPLOY"}
                </Button>
              </>
            ) : autoDeployMode === "funding" ? (
              <>
                <span className={`${chip} w-max ${chipOrange}`}>Opponent found · funding required</span>
                <p className="m-0 text-sm text-mw-muted">AUTO DEPLOY cannot be disabled after a pair. Both owners fund the on-chain stake.</p>
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
                <span className={`${chip} w-max ${chipOrange}`}>Live</span>
                <p className="m-0 text-sm text-mw-muted">This coin is already in a live fight.</p>
              </>
            ) : (
              <>
                <label className={fieldLabel}>
                  Battle type
                  <select
                    data-battle-mode-select="true"
                    className={fieldInput}
                    value={battleMode}
                    onChange={(event) => {
                      const nextMode = parseBattleMode(event.target.value);
                      setBattleMode(nextMode);
                      setDurationHours(parseBattleDurationHoursForMode(nextMode, durationHours, 24));
                    }}
                  >
                    <option value="normal">Metrics battle (market cap, holders, volume, boosts)</option>
                    <option value="vote">Vote Battle (free votes + boosts, 6 to 48 hours)</option>
                  </select>
                </label>
                <label className={fieldLabel}>
                  Fight length
                  <select
                    className={fieldInput}
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
                <label className={fieldLabel}>
                  Stake ({nativeLabel(chainId)})
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={stake}
                    onChange={(event) => setStake(event.target.value)}
                    className={fieldInput}
                    placeholder={`Amount in ${nativeLabel(chainId)}`}
                  />
                </label>
                <Button className={primaryButton} disabled={!canAct} onClick={() => void handleOpen()}>
                  {busy === "open" ? "Enabling..." : "ENABLE AUTO DEPLOY"}
                </Button>
              </>
            )}
          </div>
        )}
      </CommandCenterCard>
    </div>
  );
}
