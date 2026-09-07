import { useState } from "react";
import { EventSponsorAttribution } from "@/components/arena/EventSponsorAttribution";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useActiveFeedWallet } from "@/hooks/useActiveFeedWallet";
import { useArenaLeagueFeed } from "@/hooks/useArenaLeagueFeed";
import { useEventSponsors } from "@/hooks/useEventSponsors";

export function WarzoneLeagueHowItWorks() {
  const [open, setOpen] = useState(false);
  const { season } = useArenaLeagueFeed();
  const wallet = useActiveFeedWallet();
  const sponsors = useEventSponsors({
    eventType: "monthly_mwl",
    eventReferenceId: String(season?.id || ""),
    chainId: Number(wallet.chainId || 0) || null,
    enabled: Boolean(season?.id && season.id !== "arena-league-empty"),
  });

  return (
    <>
      <EventSponsorAttribution sponsors={sponsors} variant="premium" className="basis-full" />
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-warzone-mwl-how-it-works="true"
        className="text-[10px] uppercase tracking-[0.16em] text-accent hover:underline"
      >
        How it works
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          data-warzone-mwl-how-it-works-modal="true"
          className="max-w-md border bg-[#050505]"
          style={{ borderColor: "var(--mwz-flat-card-border)" }}
        >
          <DialogHeader>
            <DialogTitle className="font-black text-foreground">Major War League</DialogTitle>
            <DialogDescription className="text-[11px] uppercase tracking-[0.16em] text-white/50">
              Scoring
            </DialogDescription>
            <EventSponsorAttribution sponsors={sponsors} variant="premium" />
          </DialogHeader>
          <p className="text-sm text-muted-foreground">Win 3 / loss 1 / draw 0</p>
        </DialogContent>
      </Dialog>
    </>
  );
}