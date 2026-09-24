import { useEffect, useState } from "react";
import { toast } from "sonner";

import { BuyInPopup } from "@/components/arena/BuyInPopup";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { acceptPostGradBattle, counterPostGradBattle, declinePostGradBattle } from "@/features/postgrad/apiClient";
import type { Battle } from "@/features/postgrad/contracts";
import { useArenaWalletAction } from "@/hooks/useArenaWalletAction";
import {
  CHALLENGE_POPUP_EVENTS,
  formatChallengeCountdown,
  isStrictlyHigherStake,
  presentChallengeResponsePopup,
  sanitizeDeclineMessage,
} from "@/lib/arena/challengePopupPresentation.mjs";

export function ChallengeResponsePopup({
  open,
  eventName,
  battle,
  message,
  escrowRequired,
  walletAddress,
  chainId,
  onClose,
  onChanged,
}: {
  open: boolean;
  eventName: string;
  battle: Battle | null;
  message?: string | null;
  escrowRequired?: boolean;
  walletAddress?: string | null;
  chainId?: number | null;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const { signAuth } = useArenaWalletAction();
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [counterStake, setCounterStake] = useState("");
  const [declineOpen, setDeclineOpen] = useState(false);
  const [declineMessage, setDeclineMessage] = useState("");
  const [buyInOpen, setBuyInOpen] = useState(false);
  const [fundedBattle, setFundedBattle] = useState<Battle | null>(null);
  const [waitingCopy, setWaitingCopy] = useState("");

  const view = battle ? presentChallengeResponsePopup(battle, eventName, { message, escrowRequired, endsAt: (battle as { endsAt?: string }).endsAt }) : null;
  const offered = Number((battle as { offeredStakeNative?: number; stakeNative?: number } | null)?.offeredStakeNative ?? battle?.stakeNative ?? 0);
  const durationHours = Number((battle as { offeredDurationHours?: number; durationHours?: number } | null)?.offeredDurationHours ?? (battle as { durationHours?: number } | null)?.durationHours ?? 24);
  const countdown = formatChallengeCountdown((battle as { endsAt?: string } | null)?.endsAt, now);

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (!open || !battle) return;
    setCounterStake("");
    setDeclineOpen(false);
    setDeclineMessage("");
    setWaitingCopy("");
    setFundedBattle(eventName === CHALLENGE_POPUP_EVENTS.accepted ? battle : null);
    if (eventName === CHALLENGE_POPUP_EVENTS.accepted) setBuyInOpen(true);
  }, [open, battle, eventName]);

  if (!battle || !view) return null;

  async function accept() {
    setBusy("accept");
    try {
      const auth = await signAuth("arena_accept_battle", [`Battle: ${battle.id}`], { walletAddress, chainId: chainId ?? battle.chainId });
      const result = await acceptPostGradBattle(battle.id, auth);
      onChanged?.();
      const nextBattle = (result?.battle as Battle | undefined) || { ...battle, state: "matched" as const };
      if (result?.escrowRequired || nextBattle.state === "matched") {
        setFundedBattle(nextBattle);
        setBuyInOpen(true);
        toast.success("Accepted. Pay your buy-in.");
      } else {
        toast.success("Challenge accepted.");
        onClose();
      }
    } catch (error) {
      toast.error(String((error as Error)?.message || "Could not accept."));
    } finally {
      setBusy(null);
    }
  }

  async function counter() {
    const amount = Number(counterStake);
    if (!isStrictlyHigherStake(amount, offered)) {
      toast.error(`Counter buy-in must be higher than ${offered} ${view.nativeSymbol}.`);
      return;
    }
    setBusy("counter");
    try {
      const auth = await signAuth(
        "arena_counter_battle",
        [`Battle: ${battle.id}`, `Stake: ${amount}`, `Duration: ${durationHours}`],
        { walletAddress, chainId: chainId ?? battle.chainId },
      );
      await counterPostGradBattle(battle.id, amount, auth, durationHours);
      setWaitingCopy(`Waiting for ${view.leftTicker} to respond`);
      onChanged?.();
      toast.success("Counter-offer sent.");
    } catch (error) {
      toast.error(String((error as Error)?.message || "Could not send counter-offer."));
    } finally {
      setBusy(null);
    }
  }

  async function decline() {
    const note = sanitizeDeclineMessage(declineMessage);
    setBusy("decline");
    try {
      const auth = await signAuth("arena_decline_battle", [`Battle: ${battle.id}`], { walletAddress, chainId: chainId ?? battle.chainId });
      await declinePostGradBattle(battle.id, auth, note || undefined);
      onChanged?.();
      toast.success("Challenge declined.");
      onClose();
    } catch (error) {
      toast.error(String((error as Error)?.message || "Could not decline."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Dialog open={open && !buyInOpen} onOpenChange={(next) => { if (!next) onClose(); }}>
        <DialogContent className="max-w-md border-accent/40 bg-background/95 p-0">
          <div className="mwz-hud-frame space-y-4 border-0 p-5">
            <DialogTitle className="font-retro text-[10px] uppercase tracking-[0.22em] text-accent">{view.kicker}</DialogTitle>
            <h2 className="font-retro text-xl text-foreground">{view.headline}</h2>
            <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
              {countdown ? `COMMUNITY VS COMMUNITY · BATTLE STARTS IN ${countdown}` : view.communityLine}
            </p>
            <p className="font-retro text-sm text-foreground">Buy-in {view.buyInLabel} · {view.durationLabel}</p>

            {view.mode === "declined" ? (
              <>
                <p className="text-sm text-foreground">This challenge was declined.</p>
                {view.message ? <p className="text-sm text-muted-foreground">Message: {view.message}</p> : null}
                <Button className="font-retro w-full" onClick={onClose}>Close</Button>
              </>
            ) : view.mode === "accepted" ? (
              <p className="text-sm text-muted-foreground">Accepted — pay your buy-in.</p>
            ) : waitingCopy ? (
              <p className="text-sm text-accent">{waitingCopy}</p>
            ) : declineOpen ? (
              <div className="space-y-3">
                <p className="text-sm text-foreground">Are you sure you want to decline?</p>
                <textarea
                  value={declineMessage}
                  maxLength={280}
                  onChange={(event) => setDeclineMessage(event.target.value)}
                  className="min-h-20 w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-foreground"
                  placeholder="Optional message to the other owner"
                />
                <div className="flex gap-2">
                  <Button variant="outline" className="font-retro flex-1" disabled={Boolean(busy)} onClick={() => setDeclineOpen(false)}>Back</Button>
                  <Button className="font-retro flex-1" disabled={busy === "decline"} onClick={() => void decline()}>
                    {busy === "decline" ? "Declining..." : "Decline"}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <label className="block text-xs uppercase tracking-[0.14em] text-muted-foreground">
                  Counter buy-in ({view.nativeSymbol})
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={counterStake}
                    onChange={(event) => setCounterStake(event.target.value)}
                    className="mt-1 w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-foreground"
                    placeholder={`Higher than ${offered}`}
                  />
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <Button className="font-retro" disabled={Boolean(busy)} onClick={() => void accept()}>
                    {busy === "accept" ? "..." : "ACCEPT"}
                  </Button>
                  <Button variant="outline" className="font-retro" disabled={Boolean(busy)} onClick={() => void counter()}>
                    {busy === "counter" ? "..." : "COUNTER"}
                  </Button>
                  <Button variant="outline" className="font-retro" disabled={Boolean(busy)} onClick={() => setDeclineOpen(true)}>
                    DECLINE
                  </Button>
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
      <BuyInPopup
        open={buyInOpen}
        battle={fundedBattle || battle}
        walletAddress={walletAddress}
        onOpenChange={(next) => {
          setBuyInOpen(next);
          if (!next) onClose();
        }}
      />
    </>
  );
}
