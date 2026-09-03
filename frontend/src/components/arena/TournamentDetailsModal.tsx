import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TournamentCommand } from "@/components/arena/TournamentCommand";

export function TournamentDetailsModal({
  tournamentId,
  open,
  onOpenChange,
}: {
  tournamentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const id = String(tournamentId || "").trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-tournament-details-modal="true"
        className="max-h-[90vh] w-[95vw] max-w-xl overflow-y-auto border bg-[#050505] p-4 md:p-6"
        style={{ borderColor: "var(--mwz-flat-card-border)" }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Tournament details</DialogTitle>
          <DialogDescription>Register, pay the buy-in, or view the bracket.</DialogDescription>
        </DialogHeader>
        {id ? <TournamentCommand tournamentId={id} embedded /> : null}
      </DialogContent>
    </Dialog>
  );
}
