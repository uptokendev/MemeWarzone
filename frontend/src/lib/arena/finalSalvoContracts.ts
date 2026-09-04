export type FinalSalvoPhase = "salvo" | "sudden_death" | "resolved" | "paused";
export type FinalSalvoSide = "left" | "right";

export type FinalSalvoState = {
  tournamentId: string;
  matchId: string;
  battleId?: string | null;
  phase: FinalSalvoPhase | string;
  salvoIndex?: number | null;
  suddenDeathRound?: number | null;
  shotStartedAt?: string | null;
  shotEndsAt?: string | null;
  secondsRemaining?: number | null;
  leftSeriesWins?: number | null;
  rightSeriesWins?: number | null;
  leftVotes?: number | null;
  rightVotes?: number | null;
  votingLive?: boolean;
  walletVote?: FinalSalvoSide | null;
  walletEligible?: boolean | null;
  shotWinner?: FinalSalvoSide | null;
  winner?: FinalSalvoSide | null;
  resolvedAt?: string | null;
};

/**
 * Agent 3 owns persistence, uniqueness, shot scheduling and winner resolution.
 * Agent 2 only consumes this authoritative transport.
 */
export type FinalSalvoTransport = {
  getState(input: {
    tournamentId: string;
    matchId: string;
    walletAddress?: string | null;
    signal?: AbortSignal;
  }): Promise<FinalSalvoState>;
  vote(input: {
    tournamentId: string;
    matchId: string;
    walletAddress: string;
    side: FinalSalvoSide;
    auth: unknown;
  }): Promise<FinalSalvoState>;
};
