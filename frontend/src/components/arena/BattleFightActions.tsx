import { presentTournamentFightActions } from "@/lib/arena/tournamentFightPresentation.mjs";
import { cn } from "@/lib/utils";

export function BattleFightActions({
  mode,
  mocksEnabled = false,
  boostRuntime = false,
  voteRuntime = false,
}: {
  mode?: string | null;
  mocksEnabled?: boolean;
  boostRuntime?: boolean;
  voteRuntime?: boolean;
}) {
  const presented = presentTournamentFightActions({
    mode,
    mocksEnabled,
    boostRuntime,
    voteRuntime,
  });
  if (!presented.showBoost && !presented.showVote) return null;

  return (
    <div
      data-battle-fight-actions={mode || "none"}
      data-mock-battle-actions={presented.mockOnly ? "true" : undefined}
      className="flex min-h-11 flex-wrap items-center gap-2 py-1.5"
    >
      {presented.showVote ? (
        <button
          type="button"
          data-mock-battle-action="vote"
          disabled={presented.mockOnly}
          className={cn(
            "mwz-button h-8 min-w-[4.5rem] px-3 text-[10px] uppercase tracking-[0.16em]",
            presented.mockOnly && "cursor-default opacity-90",
          )}
        >
          Vote
        </button>
      ) : null}
      {presented.showBoost ? (
        <button
          type="button"
          data-mock-battle-action="boost"
          disabled={presented.mockOnly}
          className={cn(
            "mwz-button mwz-button-active h-8 min-w-[4.5rem] px-3 text-[10px] uppercase tracking-[0.16em]",
            presented.mockOnly && "cursor-default opacity-90",
          )}
        >
          Boost
        </button>
      ) : null}
    </div>
  );
}
