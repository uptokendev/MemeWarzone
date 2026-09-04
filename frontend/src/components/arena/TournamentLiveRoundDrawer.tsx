import { BattleWallModule } from "@/components/arena/BattleWallModule";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { postGradFlags } from "@/features/postgrad/config";
import { getMockBattleById } from "@/features/postgrad/mockRegistry";
import { getMockTournamentBattleMetrics } from "@/features/postgrad/mockTournamentFixtures.mjs";
import type { Battle } from "@/features/postgrad/contracts";
import { useArenaBattleFeed } from "@/hooks/useArenaBattleFeed";
import { presentCurrentRoundMatches } from "@/lib/arena/tournamentFightPresentation.mjs";

export function TournamentLiveRoundDrawer({
  open,
  onOpenChange,
  title,
  statusLabel,
  stageLabel,
  rounds,
  liveBattleIds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  statusLabel?: string | null;
  stageLabel?: string | null;
  rounds: Array<{ round: number; matches?: Array<{ battleId?: string | null; winner?: string | null; bye?: boolean }> }>;
  liveBattleIds: string[];
}) {
  const feed = useArenaBattleFeed();
  const current = presentCurrentRoundMatches(rounds);
  const allowed = new Set(liveBattleIds.map((id) => String(id)));
  const ids = current
    .map((match) => String(match.battleId || "").trim())
    .filter((id) => id && allowed.has(id));

  const battles = ids
    .map((id) => {
      const fromFeed = [...(feed.liveBattles || [])].find((battle) => String(battle.id) === id) as Battle | undefined;
      if (fromFeed) return fromFeed;
      return postGradFlags.mocks ? (getMockBattleById(id) as Battle | null) : null;
    })
    .filter(Boolean) as Battle[];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-tournament-live-round-drawer="true"
        className="max-h-[90vh] w-[95vw] max-w-[95vw] overflow-y-auto border bg-[#050505] p-4 md:p-6"
        style={{ borderColor: "var(--mwz-flat-card-border)" }}
      >
        <DialogHeader className="pr-8 text-left">
          <DialogTitle className="font-black text-xl text-foreground">{title}</DialogTitle>
          <DialogDescription className="text-[11px] uppercase tracking-[0.16em] text-white/50">
            {["WATCH LIVE ROUND", statusLabel, stageLabel].filter(Boolean).join(" · ")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-6" data-tournament-live-round-count={battles.length}>
          {battles.length ? (
            battles.map((battle, index) => {
              const mockMetrics = postGradFlags.mocks ? getMockTournamentBattleMetrics(battle.id) : null;
              return (
                <BattleWallModule
                  key={battle.id}
                  battle={battle}
                  metrics={mockMetrics}
                  metricsRequested={Boolean(mockMetrics)}
                  metricsLoaded={Boolean(mockMetrics)}
                  realtimeActive={false}
                  viewportIndex={index}
                />
              );
            })
          ) : (
            <p className="py-8 text-sm text-muted-foreground">No confirmed live battles in this round.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
