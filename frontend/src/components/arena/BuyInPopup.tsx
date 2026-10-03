import { useEffect, useState } from "react";

import { ArenaStakeButton } from "@/components/arena/ArenaStakeButton";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { fetchArenaStakeStatus } from "@/features/postgrad/apiClient";
import { presentChallengeResponsePopup } from "@/lib/arena/challengePopupPresentation.mjs";
import type { Battle } from "@/features/postgrad/contracts";

export function BuyInPopup({
  open,
  onOpenChange,
  battle,
  walletAddress,
  onSettled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  battle: Battle | null;
  walletAddress?: string | null;
  onSettled?: (status: { bothPaid?: boolean; myPaid?: boolean; live?: boolean }) => void;
}) {
  const [status, setStatus] = useState<{ bothPaid?: boolean; paidA?: boolean; paidB?: boolean; myRole?: string | null; live?: boolean } | null>(null);
  const view = battle ? presentChallengeResponsePopup(battle, "challenge_accepted") : null;
  const depositEnds = String((battle as { endsAt?: string } | null)?.endsAt || "");

  useEffect(() => {
    if (!open || !battle?.id) return;
    let cancelled = false;
    async function tick() {
      try {
        const json = await fetchArenaStakeStatus(battle!.id, walletAddress || "");
        if (cancelled) return;
        setStatus(json);
        const live = String(battle?.state) === "live" || json?.bothPaid;
        if (json?.bothPaid || live) onSettled?.({ bothPaid: true, live: true });
        else if ((json?.myRole === "a" && json?.paidA) || (json?.myRole === "b" && json?.paidB)) {
          onSettled?.({ myPaid: true, bothPaid: Boolean(json?.bothPaid) });
        }
      } catch {
        if (!cancelled) setStatus(null);
      }
    }
    void tick();
    const timer = window.setInterval(() => void tick(), 8000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open, battle, walletAddress, onSettled]);

  if (!battle || !view) return null;
  const waitingOther = Boolean(status && !status.bothPaid && ((status.myRole === "a" && status.paidA) || (status.myRole === "b" && status.paidB)));
  const live = String(battle.state) === "live" || Boolean(status?.bothPaid);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="mwz-portal-shell w-[calc(100vw-2rem)] max-w-md rounded-[18px] border border-mw-edge bg-mw-surface p-0 font-mw-body text-mw-text [&>button]:right-2 [&>button]:top-2 [&>button]:flex [&>button]:h-11 [&>button]:w-11 [&>button]:items-center [&>button]:justify-center [&>button]:text-mw-muted [&>button]:opacity-100 [&>button:hover]:text-mw-text">
        <div className="space-y-4 p-5">
          <DialogTitle className="pr-10 font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">Scheduled battle</DialogTitle>
          <h2 className="font-mw-cond text-2xl font-bold text-mw-text">{live ? "Battle is live" : waitingOther ? "Waiting for the other side" : "Accepted — pay your buy-in"}</h2>
          <p className="break-words text-sm text-mw-muted">{view.headline}</p>
          <p className="rounded-[14px] border border-mw-border bg-mw-input px-4 py-3 font-mw-mono text-[15px] font-bold text-mw-text">Buy-in {view.buyInLabel}</p>
          {depositEnds ? <p className="text-xs text-mw-muted">Deposit window until {new Date(depositEnds).toLocaleString()}</p> : null}
          {live || waitingOther ? (
            <p className="text-sm text-mw-muted">{live ? "Both stakes are in. The fight is on the Battle Wall." : "Your stake is in. Waiting for the other owner."}</p>
          ) : (
            <ArenaStakeButton
              battleId={battle.id}
              chainId={Number(battle.chainId)}
              walletAddress={walletAddress || ""}
              battleState={battle.state}
            />
          )}
          <Button type="button" variant="outline" className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-mw-edge bg-mw-raised px-4 text-[15px] font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text disabled:opacity-60 w-full" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
