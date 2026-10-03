import { useEffect, useRef, useState } from "react";
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
  onBuyInStarted,
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
  onBuyInStarted?: (battleId: string) => void;
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
  const onBuyInStartedRef = useRef(onBuyInStarted);
  onBuyInStartedRef.current = onBuyInStarted;

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
    // Accepted + matched (or escrow still due) goes straight to the buy-in; live only needs telling.
    const needsBuyIn =
      eventName === CHALLENGE_POPUP_EVENTS.accepted && (battle.state === "matched" || escrowRequired === true);
    if (needsBuyIn) {
      setBuyInOpen(true);
      onBuyInStartedRef.current?.(battle.id);
    }
  }, [open, battle, eventName, escrowRequired]);

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
        onBuyInStarted?.(nextBattle.id);
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
      setWaitingCopy(`Waiting for ${view.offerFromTicker} to respond`);
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
        <DialogContent className="mwz-portal-shell w-[calc(100vw-2rem)] max-w-md rounded-[18px] border border-mw-edge bg-mw-surface p-0 font-mw-body text-mw-text [&>button]:right-2 [&>button]:top-2 [&>button]:flex [&>button]:h-11 [&>button]:w-11 [&>button]:items-center [&>button]:justify-center [&>button]:text-mw-muted [&>button]:opacity-100 [&>button:hover]:text-mw-text">
          <div className="space-y-4 p-5">
            <DialogTitle className="pr-10 font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">{view.kicker}</DialogTitle>
            <h2 className="break-words font-mw-cond text-2xl font-bold text-mw-text">{view.headline}</h2>
            <p className="text-sm text-mw-muted">
              {view.mode === "respond" && countdown ? `COMMUNITY VS COMMUNITY · ANSWER WITHIN ${countdown}` : view.communityLine}
            </p>
            {view.counterLine ? <p className="rounded-[10px] border border-[#5A3416] bg-mw-accent-fill px-3 py-2.5 text-sm text-mw-accent-soft">{view.counterLine}</p> : null}
            <p className="rounded-[14px] border border-mw-border bg-mw-input px-4 py-3 font-mw-mono text-[15px] font-bold text-mw-text">Buy-in {view.buyInLabel} · {view.durationLabel}</p>

            {view.mode === "declined" ? (
              <>
                <p className="text-sm text-mw-text">This challenge was declined.</p>
                {view.message ? <p className="text-sm text-mw-muted">Message: {view.message}</p> : null}
                <Button className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50 w-full" onClick={onClose}>Close</Button>
              </>
            ) : view.mode === "accepted" ? (
              battle.state === "live" ? (
                <>
                  <p className="text-sm text-mw-text">Your challenge was accepted. The battle is live on the Battle Wall.</p>
                  <Button className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50 w-full" onClick={onClose}>Close</Button>
                </>
              ) : (
                <p className="text-sm text-mw-muted">Accepted — pay your buy-in.</p>
              )
            ) : waitingCopy ? (
              <p className="text-sm text-mw-accent-soft">{waitingCopy}</p>
            ) : declineOpen ? (
              <div className="space-y-3">
                <p className="text-sm text-mw-text">Are you sure you want to decline?</p>
                <textarea
                  value={declineMessage}
                  maxLength={280}
                  onChange={(event) => setDeclineMessage(event.target.value)}
                  className="min-h-20 mw-focus w-full rounded-[10px] border border-mw-edge bg-mw-input px-3 py-2.5 text-base text-mw-text placeholder:text-[#4B535C] focus:outline-none focus:ring-2 focus:ring-mw-accent"
                  placeholder="Optional message to the other owner"
                />
                <div className="flex gap-2">
                  <Button variant="outline" className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-mw-edge bg-mw-raised px-4 text-[15px] font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text disabled:opacity-60 flex-1" disabled={Boolean(busy)} onClick={() => setDeclineOpen(false)}>Back</Button>
                  <Button className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50 flex-1" disabled={busy === "decline"} onClick={() => void decline()}>
                    {busy === "decline" ? "Declining..." : "Decline"}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <label className="block font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">
                  Counter buy-in ({view.nativeSymbol})
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={counterStake}
                    onChange={(event) => setCounterStake(event.target.value)}
                    className="mt-1.5 font-mw-mono normal-case tracking-normal mw-focus w-full rounded-[10px] border border-mw-edge bg-mw-input px-3 py-2.5 text-base text-mw-text placeholder:text-[#4B535C] focus:outline-none focus:ring-2 focus:ring-mw-accent"
                    placeholder={`Higher than ${offered}`}
                  />
                </label>
                <div className="grid grid-cols-1 gap-2 min-[400px]:grid-cols-3">
                  <Button className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50" disabled={Boolean(busy)} onClick={() => void accept()}>
                    {busy === "accept" ? "..." : "ACCEPT"}
                  </Button>
                  <Button variant="outline" className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-mw-edge bg-mw-raised px-4 text-[15px] font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text disabled:opacity-60" disabled={Boolean(busy)} onClick={() => void counter()}>
                    {busy === "counter" ? "..." : "COUNTER"}
                  </Button>
                  <Button variant="outline" className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-mw-edge bg-mw-raised px-4 text-[15px] font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text disabled:opacity-60" disabled={Boolean(busy)} onClick={() => setDeclineOpen(true)}>
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
