import { useTournamentCommandState } from "@/hooks/useTournamentCommandState";

export { useTournamentCommandState } from "@/hooks/useTournamentCommandState";

export function TournamentCommand({
  tournamentId,
  embedded = false,
}: {
  tournamentId: string;
  embedded?: boolean;
}) {
  useTournamentCommandState(tournamentId, { loadMetrics: false });
  return (
    <div data-tournament-command={tournamentId || "unavailable"} data-tournament-focused={embedded ? "true" : undefined} className="hidden">
      Tournament command state is presented through lobby modals.
    </div>
  );
}

export default TournamentCommand;
