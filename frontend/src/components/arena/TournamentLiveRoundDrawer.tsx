import { TournamentLiveRoundBattles } from "@/components/arena/TournamentLiveRoundBattles";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Match = {
  id?: string | null;
  battleId?: string | null;
  tokenA?: string | null;
  tokenB?: string | null;
  winner?: string | null;
  bye?: boolean;
};

export function TournamentLiveRoundDrawer({
  open,
  onOpenChange,
  title,
  statusLabel,
  stageLabel,
  rounds,
  liveBattleIds,
  tournamentId,
  tournamentMode,
  tournamentChainId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  statusLabel?: string | null;
  stageLabel?: string | null;
  rounds: Array<{ round: number; matches?: Match[] }>;
  liveBattleIds: string[];
  tournamentId?: string | null;
  tournamentMode?: { key?: string | null } | string | null;
  tournamentChainId?: number | null;
}) {
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
        <TournamentLiveRoundBattles
          rounds={rounds}
          liveBattleIds={liveBattleIds}
          tournamentId={tournamentId}
          tournamentMode={tournamentMode}
          tournamentChainId={tournamentChainId}
        />
      </DialogContent>
    </Dialog>
  );
}
