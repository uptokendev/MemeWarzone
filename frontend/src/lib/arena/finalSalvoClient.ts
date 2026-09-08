import { apiFetch } from "@/lib/apiBase";

export type FinalSalvoPayload = {
  ok?: boolean;
  tournamentId?: string;
  roundNumber?: number;
  matchId?: string;
  battleId?: string;
  selectedToken?: string;
  pointsAdded?: number;
  finalSalvo?: {
    state?: string | null;
    active?: boolean;
    phase?: string | null;
    shotIndex?: number | null;
    shotStartedAt?: string | null;
    shotEndsAt?: string | null;
    regulation?: { leftPoints?: number; rightPoints?: number };
    series?: { leftWins?: number; rightWins?: number; maxShots?: number };
    currentShot?: {
      leftUniqueVotes?: number;
      rightUniqueVotes?: number;
      walletVote?: string | null;
      walletEligible?: boolean;
    };
    suddenDeathRound?: number;
    winnerSide?: string | null;
    winnerToken?: string | null;
    shotHistory?: unknown[];
    resolvedAt?: string | null;
    boostAllowed?: boolean;
  };
  updatedAt?: string;
};

function route(tournamentId: string, matchRef: string) {
  return `/api/arena/tournaments/${encodeURIComponent(tournamentId)}/matches/${encodeURIComponent(matchRef)}/final-salvo`;
}

async function parseResponse(response: Response): Promise<FinalSalvoPayload> {
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = String(json?.error || json?.message || `Final Salvo request failed (${response.status})`);
    const error = new Error(message) as Error & { code?: string };
    if (json?.code) error.code = String(json.code);
    throw error;
  }
  return json as FinalSalvoPayload;
}

export async function fetchFinalSalvoState(
  tournamentId: string,
  matchRef: string,
  walletAddress?: string | null,
  signal?: AbortSignal,
) {
  const qs = new URLSearchParams();
  if (walletAddress) qs.set("walletAddress", walletAddress);
  const suffix = qs.size ? `?${qs.toString()}` : "";
  const response = await apiFetch(`${route(tournamentId, matchRef)}${suffix}`, { cache: "no-store", signal });
  return parseResponse(response);
}

export async function submitFinalSalvoVote(input: {
  tournamentId: string;
  matchRef: string;
  walletAddress: string;
  tokenAddress: string;
  auth: unknown;
}) {
  const response = await apiFetch(route(input.tournamentId, input.matchRef), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      walletAddress: input.walletAddress,
      tokenAddress: input.tokenAddress,
      auth: input.auth,
    }),
  });
  return parseResponse(response);
}
