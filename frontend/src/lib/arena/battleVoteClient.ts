import { apiFetch } from "@/lib/apiBase";
import type { WalletActionAuthPayload } from "@/lib/walletActionAuth";
import type { TournamentVoteSummary } from "@/lib/arena/tournamentVoteClient";

export type BattleVotePayload = {
  ok: boolean;
  chainId: number;
  battleId: string;
  battleMode?: "vote";
  roundNumber: number;
  matchId: string;
  phase?: string;
  votingLive?: boolean;
  regulationEndsAt?: string | null;
  durationHours?: number | null;
  freeVotePoints?: number;
  boostPointsPerUsd?: number;
  summary: TournamentVoteSummary;
  score?: { leftPoints: number; rightPoints: number };
  walletVote?: string | null;
  selectedToken?: string | null;
  finalSalvo?: { state: string } | null;
  unavailableReason?: string | null;
  updatedAt?: string | null;
};

async function readJson(res: Response) {
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.ok === false) {
    const error = new Error(String(json?.error || `Battle vote request failed (${res.status})`));
    (error as Error & { code?: string }).code = json?.code ? String(json.code) : undefined;
    throw error;
  }
  return json;
}

function route(battleId: string) {
  return `/api/arena/battles/${encodeURIComponent(battleId)}/votes`;
}

export async function fetchBattleVoteState(
  battleId: string,
  walletAddress?: string | null,
  chainId?: number | null,
  signal?: AbortSignal,
): Promise<BattleVotePayload> {
  const qs = new URLSearchParams();
  if (walletAddress) qs.set("walletAddress", walletAddress);
  if (chainId) qs.set("chainId", String(chainId));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const res = await apiFetch(`${route(battleId)}${suffix}`, { cache: "no-store", signal });
  return readJson(res) as Promise<BattleVotePayload>;
}

export async function submitBattleFreeVote(input: {
  battleId: string;
  chainId: number;
  walletAddress: string;
  tokenAddress: string;
  auth: WalletActionAuthPayload;
}): Promise<BattleVotePayload> {
  const res = await apiFetch(route(input.battleId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chainId: input.chainId,
      walletAddress: input.walletAddress,
      tokenAddress: input.tokenAddress,
      auth: input.auth,
    }),
  });
  return readJson(res) as Promise<BattleVotePayload>;
}
