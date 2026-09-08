import { useState } from "react";
import { TournamentBracketModal } from "@/components/arena/TournamentBracketModal";
import { TournamentLiveRoundDrawer } from "@/components/arena/TournamentLiveRoundDrawer";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useTournamentCommandState } from "@/hooks/useTournamentCommandState";

export function TournamentLiveOverviewModal({
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
  const [roundOpen, setRoundOpen] = useState(false);
  const state = useTournamentCommandState(open ? tournamentId : "", { loadMetrics: true });
  const card = state.card;
  const liveBattles = state.liveMatches;
  const liveBattleIds = liveBattles.map((match) => String(match.battleId || "")).filter(Boolean);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-tournament-live-modal="true"
        data-tournament-details-modal="true"
        className="max-h-[90vh] w-[95vw] max-w-lg overflow-y-auto border bg-[#050505] p-4 md:p-6"
        style={{ borderColor: "var(--mwz-flat-card-border)" }}
      >
        <DialogHeader className="pr-8 text-left">
          <DialogTitle className="font-black text-xl text-foreground">{card?.title || "Tournament"}</DialogTitle>
          <DialogDescription className="text-[11px] uppercase tracking-[0.16em] text-white/50">
            {[card?.status.label, card?.bracketStage ? String(card.bracketStage).replaceAll("_", " ") : null].filter(Boolean).join(" · ")}
          </DialogDescription>
        </DialogHeader>
        {!state.tournament ? (
          <p className="text-sm text-muted-foreground">This tournament could not be loaded.</p>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <TacticalTag label="LIVE" tone="success" />
              {card?.chain ? <TacticalTag label={card.chain.label} tone="default" /> : null}
              {state.mode ? <TacticalTag label={state.mode.label} tone="sponsored" /> : null}
            </div>
            <div className="space-y-1 text-[11px] uppercase tracking-[0.14em] text-white/60">
              {card?.participantCount != null ? <div>{card.participantCount} started</div> : null}
              {state.remaining != null ? <div>{state.remaining} remaining</div> : null}
              {card?.bracketStage ? <div>{String(card.bracketStage).replaceAll("_", " ")}</div> : null}
              {liveBattles.length ? (
                <div data-tournament-live-battle-count={liveBattles.length}>{liveBattles.length} battles live</div>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => {
                  if (onViewBracket) onViewBracket();
                  else setBracketOpen(true);
                }}
                className="mwz-button inline-flex min-h-11 items-center px-4 text-xs uppercase tracking-[0.16em]"
              >
                View bracket
              </button>
              {liveBattleIds.length ? (
                <button
                  type="button"
                  data-tournament-watch-live-round="true"
                  onClick={() => setRoundOpen(true)}
                  className="inline-flex min-h-11 items-center px-4 text-xs uppercase tracking-[0.16em] text-accent hover:underline"
                >
                  Watch live round
                </button>
              ) : null}
            </div>
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
            <TournamentLiveRoundDrawer
              open={roundOpen}
              onOpenChange={setRoundOpen}
              title={card?.title || "Tournament"}
              statusLabel={card?.status.label}
              stageLabel={card?.bracketStage}
              rounds={state.bracketRounds}
              liveBattleIds={liveBattleIds}
              tournamentId={tournamentId}
              tournamentMode={state.mode}
              tournamentChainId={state.tournamentChainId}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
