import { apiFetch } from "@/lib/apiBase";
import type { WalletActionAuthPayload } from "@/lib/walletActionAuth";

export type TournamentVoteSummary = {
  tokenA: string;
  tokenB: string;
  leftVotes: number;
  rightVotes: number;
  totalVotes: number;
};

export type TournamentVotePayload = {
  ok: boolean;
  tournamentId: string;
  roundNumber: number;
  matchId: string;
  battleId?: string | null;
  votingLive?: boolean;
  summary: TournamentVoteSummary;
  walletVote?: string | null;
  selectedToken?: string | null;
  updatedAt?: string | null;
};

async function readJson(res: Response) {
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.ok === false) {
    const error = new Error(String(json?.error || `Tournament vote request failed (${res.status})`));
    (error as Error & { code?: string }).code = json?.code ? String(json.code) : undefined;
    throw error;
  }
  return json;
}

function route(tournamentId: string, matchRef: string) {
  return `/api/arena/tournaments/${encodeURIComponent(tournamentId)}/matches/${encodeURIComponent(matchRef)}/votes`;
}

export async function fetchTournamentVoteState(
  tournamentId: string,
  matchRef: string,
  walletAddress?: string | null,
  signal?: AbortSignal,
): Promise<TournamentVotePayload> {
  const qs = new URLSearchParams();
  if (walletAddress) qs.set("walletAddress", walletAddress);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const res = await apiFetch(`${route(tournamentId, matchRef)}${suffix}`, { cache: "no-store", signal });
  return readJson(res) as Promise<TournamentVotePayload>;
}

export async function submitTournamentFreeVote(input: {
  tournamentId: string;
  matchRef: string;
  walletAddress: string;
  tokenAddress: string;
  auth: WalletActionAuthPayload;
}): Promise<TournamentVotePayload> {
  const res = await apiFetch(route(input.tournamentId, input.matchRef), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      walletAddress: input.walletAddress,
      tokenAddress: input.tokenAddress,
      auth: input.auth,
    }),
  });
  return readJson(res) as Promise<TournamentVotePayload>;
}
