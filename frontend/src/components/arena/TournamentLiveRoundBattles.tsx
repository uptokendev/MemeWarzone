import { BattleWallModule } from "@/components/arena/BattleWallModule";
import { TournamentBoostControls } from "@/components/arena/TournamentBoostControls";
import { TournamentFinalSalvoControls } from "@/components/arena/TournamentFinalSalvoControls";
import { TournamentVoteControls } from "@/components/arena/TournamentVoteControls";
import { postGradFlags } from "@/features/postgrad/config";
import { getMockBattleById } from "@/features/postgrad/mockRegistry";
import { getMockTournamentBattleMetrics } from "@/features/postgrad/mockTournamentFixtures.mjs";
import type { Battle } from "@/features/postgrad/contracts";
import { useArenaBattleFeed } from "@/hooks/useArenaBattleFeed";
import { useTournamentCommandState } from "@/hooks/useTournamentCommandState";
import { presentCurrentRoundMatches } from "@/lib/arena/tournamentFightPresentation.mjs";
import { shouldShowTournamentVoteControls } from "@/lib/arena/tournamentVotePresentation.mjs";

type Match = {
  id?: string | null;
  battleId?: string | null;
  tokenA?: string | null;
  tokenB?: string | null;
  winner?: string | null;
  bye?: boolean;
};

type Round = {
  round: number;
  matches?: Match[];
};

function voteMode(mode?: { key?: string | null } | string | null) {
  return String(typeof mode === "string" ? mode : mode?.key || "").trim().toLowerCase() === "vote";
}

export function TournamentLiveRoundBattles({
  rounds,
  liveBattleIds,
  tournamentId,
  tournamentMode,
  tournamentChainId,
}: {
  rounds: Round[];
  liveBattleIds: string[];
  tournamentId?: string | null;
  tournamentMode?: { key?: string | null } | string | null;
  tournamentChainId?: number | null;
}) {
  const feed = useArenaBattleFeed();
  const current = presentCurrentRoundMatches(rounds) as Match[];
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
    <div className="space-y-6" data-tournament-live-round-count={battles.length}>
      {battles.length ? (
        battles.map((battle, index) => {
          const mockMetrics = postGradFlags.mocks ? getMockTournamentBattleMetrics(battle.id) : null;
          const match = current.find((candidate) => String(candidate.battleId || "") === String(battle.id));
          const showVote = Boolean(
            tournamentId &&
            tournamentChainId &&
            match &&
            shouldShowTournamentVoteControls({ mode: tournamentMode, match }),
          );
          const showVoteModeActions = Boolean(tournamentId && tournamentChainId && match && voteMode(tournamentMode));
          return (
            <div key={battle.id} className="space-y-3">
              <BattleWallModule
                battle={battle}
                metrics={mockMetrics}
                metricsRequested={Boolean(mockMetrics)}
                metricsLoaded={Boolean(mockMetrics)}
                realtimeActive={false}
                viewportIndex={index}
              />
              {showVote && match ? (
                <TournamentVoteControls
                  tournamentId={String(tournamentId)}
                  chainId={Number(tournamentChainId)}
                  match={match}
                />
              ) : null}
              {showVoteModeActions && match ? (
                <TournamentBoostControls
                  tournamentId={String(tournamentId)}
                  chainId={Number(tournamentChainId)}
                  match={match}
                />
              ) : null}
              {showVoteModeActions && match ? (
                <TournamentFinalSalvoControls
                  tournamentId={String(tournamentId)}
                  chainId={Number(tournamentChainId)}
                  match={match}
                />
              ) : null}
            </div>
          );
        })
      ) : (
        <p className="py-6 text-sm text-muted-foreground">No confirmed live battles in this round.</p>
      )}
    </div>
  );
}

export function TournamentLiveRoundPanel({
  tournamentId,
  statusLabel,
  stageLabel,
}: {
  tournamentId: string;
  statusLabel?: string | null;
  stageLabel?: string | null;
}) {
  const state = useTournamentCommandState(tournamentId, { loadMetrics: true });
  const liveBattleIds = state.liveMatches.map((match) => String(match.battleId || "")).filter(Boolean);
  const stage = stageLabel || (state.card?.bracketStage ? String(state.card.bracketStage).replaceAll("_", " ") : null);

  return (
    <section
      data-tournament-live-round-panel="true"
      className="mt-4 border-t pt-4"
      style={{ borderColor: "var(--mwz-flat-card-border)" }}
    >
      <div className="mb-3 text-[11px] uppercase tracking-[0.16em] text-white/50">
        {["WATCH LIVE ROUND", statusLabel || state.card?.status.label, stage].filter(Boolean).join(" · ")}
      </div>
      {!state.detail && !liveBattleIds.length ? (
        <p className="py-6 text-sm text-muted-foreground">Loading live round.</p>
      ) : (
        <TournamentLiveRoundBattles
          rounds={state.bracketRounds}
          liveBattleIds={liveBattleIds}
          tournamentId={tournamentId}
          tournamentMode={state.mode}
          tournamentChainId={state.tournamentChainId}
        />
      )}
    </section>
  );
}
