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
  const monthlySponsors = useEventSponsors({
    eventType: "monthly_mwl",
    eventReferenceId: String(season?.id || ""),
    chainId: Number(wallet.chainId || 0) || null,
    enabled: Boolean(season?.id && season.id !== "arena-league-empty"),
  });
  const quarterlySponsors = useEventSponsors({
    eventType: "quarterly_championship",
    eventReferenceId: String(season?.quarterFinalsTournamentId || ""),
    chainId: Number(wallet.chainId || 0) || null,
    enabled: Boolean(season?.quarterFinalsTournamentId),
  });

  return (
    <>
      <EventSponsorAttribution sponsors={monthlySponsors} variant="premium" className="basis-full" />
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
              Monthly league → Quarterly Championship
            </DialogDescription>
            <EventSponsorAttribution sponsors={monthlySponsors} variant="premium" />
          </DialogHeader>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>MWL scoring stays Win 3 / loss 1 / draw 0.</p>
            <p>
              High MWL finishers earn an advantage toward the Quarterly Championship. The championship standings keep changing through the quarterly epoch until final placement is locked.
            </p>
            <p>There is no separate knockout-stage sponsorship between the Monthly MWL and the Quarterly Championship.</p>
          </div>
          <EventSponsorAttribution sponsors={quarterlySponsors} variant="premium" />
        </DialogContent>
      </Dialog>
    </>
  );
}
