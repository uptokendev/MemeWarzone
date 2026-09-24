import { useEffect, useMemo, useState } from "react";
import { Search, Swords } from "lucide-react";
import { toast } from "sonner";

import { CreateFullPane, CreateWizardShell } from "@/components/create/CreateWizardShell";
import { MatchQualityPreview } from "@/components/command-center/MatchQualityPreview";
import { SearchPopup } from "@/components/search/SearchPopup";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { challengePostGradBattle, fetchArenaBattleMatches, fetchPostGradCreatorBattleStatuses } from "@/features/postgrad/apiClient";
import { useArenaWalletAction } from "@/hooks/useArenaWalletAction";
import type { CreatorBattleStatus } from "@/hooks/useArenaBattleFeed";
import {
  battleDurationOptions,
  parseBattleDurationHoursForMode,
  parseBattleMode,
  type BattleMode,
} from "@/lib/arena/battleDuration";
import { presentManualOpponentPreview, presentMatchCandidates } from "@/lib/arena/findMatchPresentation.mjs";
import { getNativeSymbol } from "@/lib/chainConfig";
import type { TokenSearchResult } from "@/types/search";

const STEPS = ["Pick opponent", "Terms", "Review"] as const;

function tokenKey(status: CreatorBattleStatus) {
  return String(status.tokenAddress || status.tokenId || status.campaignAddress || "");
}

export function ChallengeCoinModal({
  open,
  onOpenChange,
  walletAddress,
  chainId,
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

  const native = getNativeSymbol(Number(chainId || 0));
  const selected = eligible.find((item) => tokenKey(item) === selectedToken) || eligible[0] || null;
  const stakeAmount = Number(stake);
  const preview = useMemo(() => presentManualOpponentPreview(targetTokenId, candidates), [candidates, targetTokenId]);
  const modeLines = battleMode === "vote" ? [`Mode: ${battleMode}`] : [];

  useEffect(() => {
    if (!open) return;
    setStep(1);
    setSelectedToken(initialTokenId);
    setTargetTokenId(initialTargetId);
    setTargetLabel("");
    setStake("");
    setDurationHours(24);
    setBattleMode("normal");
  }, [open, initialTargetId, initialTokenId]);

  useEffect(() => {
    if (!open || !walletAddress) return;
    const controller = new AbortController();
    void fetchPostGradCreatorBattleStatuses(walletAddress, chainId, controller.signal).then((json) => {
      const items = Array.isArray(json?.items) ? json.items.filter((item: CreatorBattleStatus) => item?.eligibility) : [];
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

  const canNext =
    step === 1
      ? Boolean(selected?.eligibility && targetTokenId.trim())
      : step === 2
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[920px] border-accent/30 bg-background/95 p-2 sm:p-3">
        <DialogTitle className="sr-only">Challenge a coin</DialogTitle>
        <CreateWizardShell
          step={step}
          totalSteps={3}
          canBack={step > 1}
          canNext={canNext}
          onBack={() => setStep((current) => Math.max(1, current - 1))}
          onNext={() => {
            if (step < 3) setStep((current) => current + 1);
            else void confirm();
          }}
          eyebrow="Warzone"
          stepLabels={STEPS}
          nextLabel={step === 3 ? (busy ? "Sending..." : "Confirm") : "Next"}
        >
          <CreateFullPane>
            <div className="flex h-full min-h-0 flex-col overflow-y-auto p-3 sm:p-4">
              {step === 1 ? (
                <div className="space-y-3">
                  {!eligible.length ? (
                    <p className="text-sm text-muted-foreground">No eligible coins yet. Graduate a MemeWarzone coin or import a passed token first.</p>
                  ) : (
                    <label className="block text-xs uppercase tracking-[0.14em] text-muted-foreground">
                      Your coin
                      <select
                        className="mt-1 w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-foreground"
                        value={tokenKey(selected || eligible[0])}
                        onChange={(event) => setSelectedToken(event.target.value)}
                      >
                        {eligible.map((item) => (
                          <option key={tokenKey(item)} value={tokenKey(item)}>
                            {item.symbol || item.tokenName} ({item.origin === "import" ? "imported" : "graduated"})
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label className="block text-xs uppercase tracking-[0.14em] text-muted-foreground">
                    Opponent
                    <div className="mt-1 flex gap-2">
                      <input
                        value={targetTokenId}
                        onChange={(event) => {
                          setTargetTokenId(event.target.value);
                          setTargetLabel("");
                        }}
                        className="w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-foreground"
                        placeholder="Token address"
                      />
                      <Button type="button" variant="outline" className="font-retro" onClick={() => setSearchOpen(true)}>
                        <Search className="h-4 w-4" />
                      </Button>
                    </div>
                    {targetLabel ? <p className="mt-1 text-xs text-accent">{targetLabel}</p> : null}
                  </label>
                  <MatchQualityPreview
                    preview={preview}
                    onChallengeAnyway={() => toast.message("Open War can still proceed. Set terms on the next step.")}
                    onContinueWithChallenge={() => toast.message("You can still send this challenge. Set terms on the next step.")}
                  />
                </div>
              ) : null}

              {step === 2 ? (
                <div className="space-y-3">
                  <label className="block text-xs uppercase tracking-[0.14em] text-muted-foreground">
                    Battle type
                    <select
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
                    Buy-in ({native})
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={stake}
                      onChange={(event) => setStake(event.target.value)}
                      className="mt-1 w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-foreground"
                      placeholder={`Amount in ${native}`}
                    />
                  </label>
                </div>
              ) : null}

              {step === 3 ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 text-accent">
                    <Swords className="h-4 w-4" />
                    <span className="font-retro text-sm uppercase tracking-[0.16em]">Review & confirm</span>
                  </div>
                  <div className="mwz-hud-frame space-y-2 p-4 text-sm">
                    <div className="flex justify-between gap-3"><span className="text-muted-foreground">Your coin</span><span className="font-retro">{selected?.symbol || selected?.tokenName || "—"}</span></div>
                    <div className="flex justify-between gap-3"><span className="text-muted-foreground">Opponent</span><span className="font-retro">{targetLabel || targetTokenId || "—"}</span></div>
                    <div className="flex justify-between gap-3"><span className="text-muted-foreground">Buy-in</span><span className="font-retro">{stakeAmount} {native}</span></div>
                    <div className="flex justify-between gap-3"><span className="text-muted-foreground">Duration</span><span className="font-retro">{battleDurationOptions(battleMode).find((item) => item.hours === durationHours)?.label || `${durationHours}h`}</span></div>
                    <div className="flex justify-between gap-3"><span className="text-muted-foreground">Mode</span><span className="font-retro">{battleMode === "vote" ? "Vote Battle" : "Metrics battle"}</span></div>
                  </div>
                  <p className="text-sm text-muted-foreground">They must accept before the fight goes live.</p>
                </div>
              ) : null}
            </div>
          </CreateFullPane>
        </CreateWizardShell>
        <SearchPopup open={searchOpen} onOpenChange={setSearchOpen} onSelectToken={pickSearch} />
      </DialogContent>
    </Dialog>
  );
}
