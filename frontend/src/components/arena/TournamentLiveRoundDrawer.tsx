import { TournamentLiveRoundBattles } from "@/components/arena/TournamentLiveRoundBattles";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

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
        <TournamentLiveRoundBattles rounds={rounds} liveBattleIds={liveBattleIds} />
      </DialogContent>
    </Dialog>
  );
}
