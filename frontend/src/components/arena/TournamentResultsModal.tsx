import { useState } from "react";
import { ArenaWarPoolClaimButton } from "@/components/arena/ArenaWarPoolClaimButton";
import { TournamentBracketModal } from "@/components/arena/TournamentBracketModal";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { WarzoneTokenMark } from "@/components/warzone/WarzoneTokenMark";
import { useTournamentCommandState } from "@/hooks/useTournamentCommandState";

export function TournamentResultsModal({
  tournamentId,
  open,
  onOpenChange,
  onViewBracket,
}: {
  tournamentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onViewBracket?: () => void;
}) {
  const [bracketOpen, setBracketOpen] = useState(false);
  const state = useTournamentCommandState(open ? tournamentId : "", { loadMetrics: false });
  const card = state.card;
  const champion = state.champion;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-tournament-results-modal="true"
        data-tournament-details-modal="true"
        className="max-h-[90vh] w-[95vw] max-w-lg overflow-y-auto border bg-[#050505] p-4 md:p-6"
        style={{ borderColor: "var(--mwz-flat-card-border)" }}
      >
        <DialogHeader className="pr-8 text-left">
          <DialogTitle className="font-black text-xl text-foreground">{card?.title || "Tournament"}</DialogTitle>
          <DialogDescription className="text-[11px] uppercase tracking-[0.16em] text-white/50">Results</DialogDescription>
        </DialogHeader>
        {!state.tournament ? (
          <p className="text-sm text-muted-foreground">This tournament could not be loaded.</p>
        ) : (
          <div data-tournament-claims="true" className="space-y-4">
            <TacticalTag label="FINISHED" tone="default" />
            {champion ? (
              <div data-tournament-champion="true" className="flex items-center gap-3">
                <WarzoneTokenMark imageUrl={champion.imageUrl} symbol={champion.symbol} name={champion.tokenName} />
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-[0.18em] text-orange-200">Champion</div>
                  <div className="font-black text-foreground">{champion.symbol ? `$${champion.symbol}` : "TOKEN"}</div>
                  {champion.tokenName ? <div className="text-[11px] uppercase tracking-[0.12em] text-white/50">{champion.tokenName}</div> : null}
                </div>
              </div>
            ) : null}
            <ArenaWarPoolClaimButton
              battleId={state.id}
              chainId={state.tournamentChainId}
              label="CLAIM TOURNAMENT REWARDS"
            />
            <button
              type="button"
              onClick={() => {
                if (onViewBracket) onViewBracket();
                else setBracketOpen(true);
              }}
              className="inline-flex min-h-11 items-center text-xs uppercase tracking-[0.16em] text-accent hover:underline"
            >
              Final bracket
            </button>
            <TournamentBracketModal
              open={bracketOpen}
              onOpenChange={setBracketOpen}
              title={card?.title || "Tournament"}
              statusLabel={card?.status.label}
              stageLabel={card?.bracketStage}
              rounds={state.bracketRounds}
              entries={state.entries}
              chainId={state.tournamentChainId}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
