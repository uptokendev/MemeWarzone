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
      <DialogContent className="max-w-md border-accent/40 bg-background/95 p-0">
        <div className="mwz-hud-frame space-y-4 border-0 p-5">
          <DialogTitle className="font-retro text-[10px] uppercase tracking-[0.22em] text-accent">Scheduled battle</DialogTitle>
          <h2 className="font-retro text-lg text-foreground">{live ? "Battle is live" : waitingOther ? "Waiting for the other side" : "Accepted — pay your buy-in"}</h2>
          <p className="text-sm text-muted-foreground">{view.headline}</p>
          <p className="font-retro text-sm text-foreground">Buy-in {view.buyInLabel}</p>
          {depositEnds ? <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Deposit window until {new Date(depositEnds).toLocaleString()}</p> : null}
          {live || waitingOther ? (
            <p className="text-sm text-muted-foreground">{live ? "Both stakes are in. The fight is on the Battle Wall." : "Your stake is in. Waiting for the other owner."}</p>
          ) : (
            <ArenaStakeButton
              battleId={battle.id}
              chainId={Number(battle.chainId)}
              walletAddress={walletAddress || ""}
              battleState={battle.state}
            />
          )}
          <Button type="button" variant="outline" className="font-retro w-full" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
