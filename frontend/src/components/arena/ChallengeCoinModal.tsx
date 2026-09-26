import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Search, Swords } from "lucide-react";
import { toast } from "sonner";

import { CreateSplitPane, CreateWizardShell } from "@/components/create/CreateWizardShell";
import { MatchQualityPreview } from "@/components/command-center/MatchQualityPreview";
import { SearchPopup } from "@/components/search/SearchPopup";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { challengePostGradBattle, fetchArenaBattleMatches, fetchArenaBattleOpponents, fetchPostGradCreatorBattleStatuses, type ArenaBattleOpponent } from "@/features/postgrad/apiClient";
import { fetchRecentArenaImports, type RecentArenaImport } from "@/lib/arenaImports";
import { projectImportsEnabled } from "@/features/projectImports/config";
import { useArenaWalletAction } from "@/hooks/useArenaWalletAction";
import type { CreatorBattleStatus } from "@/hooks/useArenaBattleFeed";
import {
  battleDurationOptions,
  parseBattleDurationHoursForMode,
  type BattleMode,
} from "@/lib/arena/battleDuration";
import { presentManualOpponentPreview, presentMatchCandidates } from "@/lib/arena/findMatchPresentation.mjs";
import { getAllowedChainIds, getChainLabel, getNativeSymbol, isSolanaChainId } from "@/lib/chainConfig";
import { isEvmAddress, isSolanaAddress } from "@/lib/address";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { cn } from "@/lib/utils";
import { resolveImageUri } from "@/lib/media";
import type { TokenSearchResult } from "@/types/search";

const STEPS = ["Battle type", "Pick opponent", "Terms", "Review"] as const;
const selectedClass = "border-orange-400/70 bg-orange-500/10 shadow-lg shadow-orange-500/10";
const idleClass = "border-border bg-background/40 hover:border-orange-400/40";

function CoinAvatar({ src, label, size = "h-9 w-9" }: { src?: string | null; label: string; size?: string }) {
  const url = resolveImageUri(src);
  const initial = (label.replace(/^\$/, "").trim()[0] || "?").toUpperCase();
  return url ? (
    <img src={url} alt="" loading="lazy" className={cn(size, "shrink-0 rounded-full border border-border/60 bg-black/40 object-cover")} onError={(event) => { (event.currentTarget as HTMLImageElement).style.visibility = "hidden"; }} />
  ) : (
    <div className={cn(size, "flex shrink-0 items-center justify-center rounded-full border border-border/60 bg-black/40 font-retro text-xs text-muted-foreground")}>{initial}</div>
  );
}

function tokenKey(status: CreatorBattleStatus) {
  return String(status.tokenAddress || status.tokenId || status.campaignAddress || "");
}

export function ChallengeCoinModal({
  open,
  onOpenChange,
  walletAddress: walletAddressProp,
  chainId: chainIdProp,
  initialTokenId = "",
  initialTargetId = "",
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  walletAddress?: string | null;
  chainId?: number | null;
  initialTokenId?: string;
  initialTargetId?: string;
  onSent?: () => void;
}) {
  const { signAuth } = useArenaWalletAction();
  const evm = useWallet();
  const { solanaAccount, isSolanaConnected } = useSolanaWallet();
  // A challenge is same-chain, so the chain is part of the choice. Opened from a token page
  // (target given) it is that token's chain and fixed. Opened from the Battle Wall it starts
  // on the active wallet's chain and can be switched: with MetaMask active that was always
  // BNB, which has no imports, so the recent-imports row stayed empty (2026-09-25).
  const chainLocked = Boolean(initialTargetId);
  const [chainChoice, setChainChoice] = useState<number>(Number(chainIdProp || 0));
  const chainId = chainLocked ? Number(chainIdProp || 0) : chainChoice;
  const chainOptions = useMemo(
    () => getAllowedChainIds().filter((id) => id === 56 || id === 101 || id === 4663 || id === 97 || id === 46630),
    [],
  );
  const walletAddress = isSolanaChainId(chainId)
    ? isSolanaConnected && isSolanaAddress(solanaAccount)
      ? String(solanaAccount)
      : isSolanaAddress(walletAddressProp) ? String(walletAddressProp) : null
    : evm.isConnected && isEvmAddress(evm.account)
      ? String(evm.account)
      : isEvmAddress(walletAddressProp) ? String(walletAddressProp) : null;
  const [step, setStep] = useState(1);
  const [eligible, setEligible] = useState<CreatorBattleStatus[]>([]);
  const [selectedToken, setSelectedToken] = useState(initialTokenId);
  const [targetTokenId, setTargetTokenId] = useState(initialTargetId);
  const [targetLabel, setTargetLabel] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [stake, setStake] = useState("");
  const [durationHours, setDurationHours] = useState(24);
  const [battleMode, setBattleMode] = useState<BattleMode>("normal");
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState<ReturnType<typeof presentMatchCandidates>>([]);
  const [recentImports, setRecentImports] = useState<RecentArenaImport[]>([]);
  const [opponents, setOpponents] = useState<ArenaBattleOpponent[]>([]);

  const native = getNativeSymbol(Number(chainId || 0));
  const selected = eligible.find((item) => tokenKey(item) === selectedToken) || eligible[0] || null;
  const stakeAmount = Number(stake);
  const preview = useMemo(() => presentManualOpponentPreview(targetTokenId, candidates), [candidates, targetTokenId]);
  const modeLines = battleMode === "vote" ? [`Mode: ${battleMode}`] : [];

  useEffect(() => {
    if (!open) return;
    setStep(1);
    setChainChoice(Number(chainIdProp || 0));
    setSelectedToken(initialTokenId);
    setTargetTokenId(initialTargetId);
    setTargetLabel("");
    setStake("");
    setDurationHours(24);
    setBattleMode("normal");
    setRecentImports([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialTargetId, initialTokenId]);

  function switchChain(next: number) {
    if (chainLocked || next === chainChoice) return;
    setChainChoice(next);
    setEligible([]);
    setSelectedToken("");
    setCandidates([]);
    setTargetTokenId("");
    setTargetLabel("");
  }

  useEffect(() => {
    if (!open || !chainId) return;
    const controller = new AbortController();
    void fetchRecentArenaImports(Number(chainId), 12).then((items) => {
      if (!controller.signal.aborted) setRecentImports(items);
    });
    return () => controller.abort();
  }, [open, chainId]);

  useEffect(() => {
    if (!open) return;
    if (!walletAddress) {
      setEligible([]);
      return;
    }
    const controller = new AbortController();
    void fetchPostGradCreatorBattleStatuses(walletAddress, chainId, controller.signal).then((json) => {
      // A coin already in a battle can still challenge others (canChallenge); only the same pair twice is refused.
      const items = Array.isArray(json?.items) ? json.items.filter((item: CreatorBattleStatus & { canChallenge?: boolean }) => item?.canChallenge ?? item?.eligibility) : [];
      setEligible(items);
      if (!selectedToken && items[0]) setSelectedToken(tokenKey(items[0]));
    });
    return () => controller.abort();
  }, [open, walletAddress, chainId, selectedToken]);

  useEffect(() => {
    const tokenId = tokenKey(selected || ({} as CreatorBattleStatus));
    if (!open || !tokenId) {
      setCandidates([]);
      return;
    }
    const controller = new AbortController();
    void fetchArenaBattleMatches(tokenId, chainId, 5, controller.signal).then((payload) => {
      if (!controller.signal.aborted) setCandidates(presentMatchCandidates(payload));
    });
    return () => controller.abort();
  }, [open, selected, chainId]);

  useEffect(() => {
    if (!open || !chainId) return;
    const controller = new AbortController();
    const tokenId = tokenKey(selected || ({} as CreatorBattleStatus));
    void fetchArenaBattleOpponents(tokenId, Number(chainId), battleMode, controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) setOpponents(items);
      })
      .catch(() => {
        if (!controller.signal.aborted) setOpponents([]);
      });
    return () => controller.abort();
  }, [open, selected, chainId, battleMode]);

  const opponentKey = (row: ArenaBattleOpponent) => String(row.token?.tokenAddress || row.token?.tokenId || row.token?.campaignAddress || "");
  const targetOpponent = opponents.find((row) => opponentKey(row).toLowerCase() === targetTokenId.trim().toLowerCase()) || null;
  // A metrics Battle is scored from both coins' market data; the server refuses one without it.
  const targetBlockedForMetrics = battleMode !== "vote" && targetOpponent !== null && targetOpponent.metricsAllowed === false;
  // Only the owner can answer; the server refuses a challenge to a coin nobody owns.
  const targetHasNoOwner = targetOpponent !== null && targetOpponent.hasOwner === false;

  const canNext =
    step === 1
      ? true
      : step === 2
        ? Boolean(((selected as (CreatorBattleStatus & { canChallenge?: boolean }) | undefined)?.canChallenge ?? selected?.eligibility) && targetTokenId.trim() && !targetBlockedForMetrics && !targetHasNoOwner)
        : step === 3
          ? Boolean(Number.isFinite(stakeAmount) && stakeAmount > 0)
          : !busy;

  function pickSearch(row: TokenSearchResult) {
    if (Number(row.chainId) && Number(chainId) && Number(row.chainId) !== Number(chainId)) {
      toast.error("Pick a coin on the same chain as yours.");
      return;
    }
    const id = String(row.tokenAddress || row.campaignAddress || "").trim();
    if (!id) {
      toast.error("That search result has no token address.");
      return;
    }
    setTargetTokenId(id);
    setTargetLabel(row.symbol ? `$${row.symbol}` : row.name);
  }

  async function confirm() {
    if (!selected || !canNext) return;
    const tokenId = tokenKey(selected);
    const target = targetTokenId.trim();
    setBusy(true);
    try {
      const auth = await signAuth(
        "arena_challenge_battle",
        [`Challenger: ${tokenId}`, `Defender: ${target}`, `Stake: ${stakeAmount}`, `Duration: ${durationHours}`, ...modeLines],
        { walletAddress, chainId },
      );
      await challengePostGradBattle({
        tokenId,
        targetTokenId: target,
        chainId: Number(chainId),
        stakeNative: stakeAmount,
        durationHours,
        battleMode,
        auth,
      });
      toast.success("Challenge sent. They must accept before the fight goes live.");
      onOpenChange(false);
      onSent?.();
    } catch (error) {
      toast.error(String((error as Error)?.message || "Could not send challenge."));
    } finally {
      setBusy(false);
    }
  }

  function goNext() {
    if (step < 4) setStep((current) => current + 1);
    else void confirm();
  }

  function pickMode(mode: BattleMode) {
    setBattleMode(mode);
    setDurationHours(parseBattleDurationHoursForMode(mode, durationHours, 24));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="mwz-portal-shell max-w-[920px] w-[min(920px,calc(100vw-1rem))] border-0 bg-transparent p-0 shadow-none gap-0 overflow-visible [&>button]:hidden">
        <DialogTitle className="sr-only">Challenge a coin</DialogTitle>
        <CreateWizardShell
          step={step}
          totalSteps={4}
          canBack={step > 1}
          canNext={canNext}
          onBack={() => setStep((current) => Math.max(1, current - 1))}
          onNext={goNext}
          eyebrow="Warzone"
          stepLabels={STEPS}
          nextLabel={step === 4 ? (busy ? "Sending..." : "Confirm") : "Next"}
        >
          {step === 1 ? (
            <CreateSplitPane
              left={
                <div className="max-w-md space-y-3 text-sm leading-relaxed text-muted-foreground">
                  <p className="font-retro text-xs uppercase tracking-[0.2em] text-orange-300">// Battle type</p>
                  <h2 className="font-retro text-xl text-foreground sm:text-2xl">How do you want to fight?</h2>
                  <p><span className="font-semibold text-orange-200">Battle</span> is scored from market data, so both coins need live market data and fair matchups are ranked.</p>
                  <p><span className="font-semibold text-orange-200">Vote Battle</span> is decided by the community. Any coin can challenge any coin.</p>
                </div>
              }
              right={
                <div className="flex h-full min-h-0 flex-col gap-3" data-challenge-step="battle-type">
                  <button type="button" data-battle-mode="normal" onClick={() => pickMode("normal")} className={cn("rounded-xl border p-4 text-left transition", battleMode === "normal" ? selectedClass : idleClass)}>
                    <div className="font-retro text-lg text-foreground">Battle</div>
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Metrics fight: market cap, holders, volume, boosts. Both coins need live market data.</p>
                  </button>
                  <button type="button" data-battle-mode="vote" onClick={() => pickMode("vote")} className={cn("rounded-xl border p-4 text-left transition", battleMode === "vote" ? selectedClass : idleClass)}>
                    <div className="font-retro text-lg text-foreground">Vote Battle</div>
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Free votes + boosts, 1 to 24 hours. Any coin can challenge any coin.</p>
                  </button>
                  <Button type="button" className="mwz-button mwz-button-orange mt-auto h-11 font-retro" onClick={goNext}>Next</Button>
                </div>
              }
            />
          ) : null}

          {step === 2 ? (
            <CreateSplitPane
              left={
                <div className="max-w-md space-y-3 text-sm leading-relaxed text-muted-foreground">
                  <p className="font-retro text-xs uppercase tracking-[0.2em] text-orange-300">// Pick opponent</p>
                  <h2 className="font-retro text-xl text-foreground sm:text-2xl">Choose who you fight</h2>
                  <p><span className="font-semibold text-orange-200">Your coin</span> is the one you send into battle. The opponent is the coin you challenge. Same chain only.</p>
                  <p>
                    No eligible coin yet?{" "}
                    <Link to="/create" onClick={() => onOpenChange(false)} className="font-semibold text-orange-200 underline underline-offset-2 hover:text-orange-100">Launch your token</Link>
                    {projectImportsEnabled ? (
                      <>
                        {" "}or{" "}
                        <Link to="/import" onClick={() => onOpenChange(false)} className="font-semibold text-orange-200 underline underline-offset-2 hover:text-orange-100">import your token</Link>
                      </>
                    ) : null}
                    . A launched coin can battle once it graduates; an imported token once it has passed review.
                  </p>
                </div>
              }
              right={
                <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto pr-1" data-challenge-step="opponent">
                  {chainLocked ? (
                    <p className="text-xs text-muted-foreground" data-challenge-chain="locked">Chain: <span className="text-foreground">{getChainLabel(chainId)}</span></p>
                  ) : chainOptions.length > 1 ? (
                    <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${chainOptions.length}, minmax(0, 1fr))` }} data-challenge-chain-switch="true">
                      {chainOptions.map((id) => (
                        <button
                          key={id}
                          type="button"
                          onClick={() => switchChain(id)}
                          className={cn("rounded-xl border px-3 py-2 font-retro text-xs uppercase tracking-[0.12em] transition", id === chainId ? selectedClass : idleClass)}
                        >
                          {getChainLabel(id)}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {!walletAddress ? (
                    <p className="text-sm text-muted-foreground">Connect your {isSolanaChainId(chainId) ? "Solana" : "EVM"} wallet to challenge on {getChainLabel(chainId)}.</p>
                  ) : !eligible.length ? (
                    <p className="text-sm text-muted-foreground">
                      No eligible coins on {getChainLabel(chainId)} yet.{" "}
                      <Link to="/create" onClick={() => onOpenChange(false)} className="font-semibold text-orange-200 underline underline-offset-2 hover:text-orange-100">Launch your token</Link>
                      {projectImportsEnabled ? (
                        <>
                          {" "}or{" "}
                          <Link to="/import" onClick={() => onOpenChange(false)} className="font-semibold text-orange-200 underline underline-offset-2 hover:text-orange-100">import your token</Link>
                        </>
                      ) : null}
                      .
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {eligible.map((item) => {
                        const id = tokenKey(item);
                        const active = id === tokenKey(selected || eligible[0]);
                        return (
                          <button
                            key={id}
                            type="button"
                            onClick={() => setSelectedToken(id)}
                            className={cn("w-full rounded-xl border p-4 text-left transition", active ? selectedClass : idleClass)}
                          >
                            <div className="flex items-center gap-3">
                              <CoinAvatar src={(item as { imageUrl?: string | null }).imageUrl} label={item.symbol || item.tokenName || "?"} size="h-10 w-10" />
                              <div className="min-w-0">
                                <div className="font-retro text-lg text-foreground">{item.symbol ? `$${item.symbol}` : item.tokenName}</div>
                                <p className="mt-1 truncate text-xs text-muted-foreground">{item.origin === "import" ? "imported" : "graduated"}{item.tokenName && item.symbol ? ` · ${item.tokenName}` : ""}</p>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <div>
                    <label className="mb-1 block font-retro text-sm text-foreground">Opponent</label>
                    <div className="flex gap-2">
                      <Input
                        value={targetTokenId}
                        onChange={(event) => {
                          setTargetTokenId(event.target.value);
                          setTargetLabel("");
                        }}
                        placeholder="Token address"
                        className="font-sans normal-case tracking-normal"
                      />
                      <Button type="button" variant="outline" className="h-10 shrink-0 font-retro" onClick={() => setSearchOpen(true)}>
                        <Search className="h-4 w-4" />
                      </Button>
                    </div>
                    {targetLabel ? <p className="mt-1 text-xs text-orange-200">{targetLabel}</p> : null}
                  </div>
                  <div data-recent-imports="true">
                    <div className="mb-1 font-retro text-sm text-foreground">Recent imports</div>
                    {recentImports.length ? (
                      <div className="grid grid-cols-2 gap-1.5">
                        {recentImports
                          .filter((row) => row.tokenAddress !== tokenKey(selected || ({} as CreatorBattleStatus)))
                          .map((row) => {
                            const active = row.tokenAddress === targetTokenId;
                            return (
                              <button
                                key={row.id}
                                type="button"
                                onClick={() => {
                                  setTargetTokenId(row.tokenAddress);
                                  setTargetLabel(row.symbol ? `$${row.symbol}` : row.name || row.tokenAddress);
                                }}
                                className={cn("rounded-xl border p-3 text-left transition", active ? selectedClass : idleClass)}
                              >
                                <div className="flex items-center gap-2">
                                  <CoinAvatar src={row.imageUrl} label={row.symbol || row.name || "?"} />
                                  <div className="min-w-0">
                                    <div className="truncate font-retro text-sm text-foreground">{row.symbol ? `$${row.symbol}` : row.name || "Import"}</div>
                                    <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{row.name || row.tokenAddress}</p>
                                  </div>
                                </div>
                              </button>
                            );
                          })}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">No imported coins on this chain yet</p>
                    )}
                  </div>
                  <div data-challenge-opponents="true">
                    <div className="mb-1 font-retro text-sm text-foreground">{battleMode === "vote" ? "All coins" : "Opponents"}</div>
                    {opponents.length ? (
                      <div className="grid grid-cols-2 gap-1.5">
                        {opponents.map((row) => {
                          const key = opponentKey(row);
                          const active = key.toLowerCase() === targetTokenId.trim().toLowerCase();
                          const tag = row.hasOwner === false ? "no owner yet" : battleMode === "vote" ? (row.origin === "import" ? "imported" : "graduated") : row.ranked ? "ranked" : row.metricsAllowed ? "open war" : "no market data";
                          return (
                            <button
                              key={key}
                              type="button"
                              onClick={() => {
                                setTargetTokenId(key);
                                setTargetLabel(row.token?.symbol ? `$${row.token.symbol}` : row.token?.tokenName || key);
                              }}
                              className={cn("rounded-xl border p-3 text-left transition", active ? selectedClass : idleClass, battleMode !== "vote" && !row.metricsAllowed && "opacity-60")}
                            >
                              <div className="flex items-center gap-2">
                                <CoinAvatar src={row.imageUrl} label={row.token?.symbol || row.token?.tokenName || "?"} />
                                <div className="min-w-0">
                                  <div className="truncate font-retro text-sm text-foreground">{row.token?.symbol ? `$${row.token.symbol}` : row.token?.tokenName || "Coin"}</div>
                                  <p className="mt-0.5 truncate text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{tag}</p>
                                </div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">No other coins on this chain yet</p>
                    )}
                  </div>
                  {targetHasNoOwner ? (
                    <p className="text-sm text-orange-200" data-challenge-no-owner="true">This coin has no verified owner yet, so nobody can answer a challenge. Choose another opponent.</p>
                  ) : null}
                  {targetBlockedForMetrics ? (
                    <p className="text-sm text-orange-200" data-challenge-metrics-blocked="true">This coin has no live market data yet, so a metrics Battle cannot be scored. Go back and pick Vote Battle, or choose another opponent.</p>
                  ) : null}
                  {battleMode !== "vote" ? (
                    <MatchQualityPreview
                      preview={preview}
                      onChallengeAnyway={() => {
                        if (canNext) goNext();
                      }}
                      onContinueWithChallenge={() => {
                        if (canNext) goNext();
                      }}
                    />
                  ) : null}
                  <Button type="button" className="mwz-button mwz-button-orange mt-auto h-11 shrink-0 font-retro" disabled={!canNext} onClick={goNext}>Next</Button>
                </div>
              }
            />
          ) : null}

          {step === 3 ? (
            <CreateSplitPane
              left={
                <div className="max-w-md space-y-3 text-sm leading-relaxed text-muted-foreground">
                  <p className="font-retro text-xs uppercase tracking-[0.2em] text-orange-300">// Set terms</p>
                  <h2 className="font-retro text-xl text-foreground sm:text-2xl">Buy-in and fight length</h2>
                  <p>They see these terms before they accept. The buy-in is paid after both sides agree.</p>
                </div>
              }
              right={
                <div className="flex h-full min-h-0 flex-col gap-3">
                  <div>
                    <div className="mb-1 font-retro text-sm text-foreground">Fight length</div>
                    <div className="grid grid-cols-2 gap-1.5">
                      {battleDurationOptions(battleMode).map((item) => (
                        <button
                          key={item.hours}
                          type="button"
                          onClick={() => setDurationHours(item.hours)}
                          className={cn("rounded-lg border px-2.5 py-2 text-left transition", durationHours === item.hours ? "border-accent bg-accent/15 text-foreground" : "border-border bg-muted/30 text-muted-foreground hover:border-accent/60")}
                        >
                          <span className="font-retro text-sm">{item.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="mb-1 block font-retro text-sm text-foreground">Buy-in ({native})</label>
                    <Input
                      type="number"
                      min="0"
                      step="any"
                      value={stake}
                      onChange={(event) => setStake(event.target.value)}
                      placeholder={`Amount in ${native}`}
                      className="font-sans normal-case tracking-normal"
                    />
                  </div>
                  <Button type="button" className="mwz-button mwz-button-orange mt-auto h-11 font-retro" disabled={!canNext} onClick={goNext}>Next</Button>
                </div>
              }
            />
          ) : null}

          {step === 4 ? (
            <CreateSplitPane
              left={
                <div className="max-w-md space-y-3 text-sm leading-relaxed text-muted-foreground">
                  <p className="font-retro text-xs uppercase tracking-[0.2em] text-orange-300">// Review</p>
                  <h2 className="font-retro text-xl text-foreground sm:text-2xl">Send the challenge</h2>
                  <p>They must accept before the fight goes live.</p>
                </div>
              }
              right={
                <div className="flex h-full min-h-0 flex-col gap-3">
                  <div className="space-y-2 rounded-xl border border-border/50 bg-background/30 p-3 text-sm">
                    <div className="flex items-center gap-2 text-orange-200">
                      <Swords className="h-4 w-4" />
                      <span className="font-retro text-sm">Review & confirm</span>
                    </div>
                    <div className="flex justify-between gap-3"><span className="text-muted-foreground">Your coin</span><span className="font-retro text-foreground">{selected?.symbol || selected?.tokenName || "—"}</span></div>
                    <div className="flex justify-between gap-3"><span className="text-muted-foreground">Opponent</span><span className="truncate font-medium text-foreground">{targetLabel || targetTokenId || "—"}</span></div>
                    <div className="flex justify-between gap-3"><span className="text-muted-foreground">Buy-in</span><span className="text-foreground">{stakeAmount} {native}</span></div>
                    <div className="flex justify-between gap-3"><span className="text-muted-foreground">Duration</span><span className="text-foreground">{battleDurationOptions(battleMode).find((item) => item.hours === durationHours)?.label || `${durationHours}h`}</span></div>
                    <div className="flex justify-between gap-3"><span className="text-muted-foreground">Mode</span><span className="text-foreground">{battleMode === "vote" ? "Vote Battle" : "Battle"}</span></div>
                  </div>
                  <Button type="button" className="mwz-button mwz-button-orange mt-auto h-12 w-full font-retro text-base" disabled={!canNext || busy} onClick={() => void confirm()}>
                    {busy ? "Sending…" : "Confirm"}
                  </Button>
                </div>
              }
            />
          ) : null}
        </CreateWizardShell>
        <SearchPopup open={searchOpen} onOpenChange={setSearchOpen} onSelectToken={pickSearch} />
      </DialogContent>
    </Dialog>
  );
}
