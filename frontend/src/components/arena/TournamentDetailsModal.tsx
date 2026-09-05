import { TournamentLiveOverviewModal } from "@/components/arena/TournamentLiveOverviewModal";
import { TournamentRegistrationModal } from "@/components/arena/TournamentRegistrationModal";
import { TournamentResultsModal } from "@/components/arena/TournamentResultsModal";

export function TournamentDetailsModal({
  tournamentId,
  open,
  onOpenChange,
  kind = "registration",
}: {
  tournamentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind?: "registration" | "live" | "results";
}) {
  const id = String(tournamentId || "").trim();
  if (kind === "live") {
    return <TournamentLiveOverviewModal tournamentId={id} open={open} onOpenChange={onOpenChange} />;
  }
  if (kind === "results") {
    return <TournamentResultsModal tournamentId={id} open={open} onOpenChange={onOpenChange} />;
  }
  return <TournamentRegistrationModal tournamentId={id} open={open} onOpenChange={onOpenChange} />;
}
