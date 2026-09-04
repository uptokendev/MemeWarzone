import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { useWallet } from "@/contexts/WalletContext";
import { useActiveFeedWallet } from "@/hooks/useActiveFeedWallet";
import { signArenaWalletAction } from "@/lib/arena/signArenaWalletAction";
import {
  fetchTournamentVoteState,
  submitTournamentFreeVote,
  type TournamentVotePayload,
} from "@/lib/arena/tournamentVoteClient";
import {
  presentTournamentVoteSummary,
  tournamentVoteMatchRef,
} from "@/lib/arena/tournamentVotePresentation.mjs";

type Match = {
  id?: string | null;
  battleId?: string | null;
  tokenA?: string | null;
  tokenB?: string | null;
  winner?: string | null;
  bye?: boolean;
};

function shortToken(value?: string | null) {
  const token = String(value || "").trim();
  if (!token) return "TOKEN";
  if (token.length <= 12) return token;
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

export function TournamentVoteControls({
  tournamentId,
  chainId,
  match,
}: {
  tournamentId: string;
  chainId: number;
  match: Match;
}) {
  const wallet = useWallet();
  const { solanaAccount } = useSolanaWallet();
  const feedWallet = useActiveFeedWallet();
  const walletAddress = String(feedWallet.address || "").trim();
  const matchRef = tournamentVoteMatchRef(match);
  const [payload, setPayload] = useState<TournamentVotePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyToken, setBusyToken] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!tournamentId || !matchRef) return null;
    try {
      const next = await fetchTournamentVoteState(tournamentId, matchRef, walletAddress, signal);
      setPayload(next);
      setUnavailable(false);
      return next;
    } catch (error) {
      if (signal?.aborted) return null;
      setUnavailable(true);
      return null;
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [matchRef, tournamentId, walletAddress]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void refresh(controller.signal);
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [refresh]);

  const model = useMemo(() => presentTournamentVoteSummary(payload || {}), [payload]);
  const tokens = [String(match.tokenA || "").trim(), String(match.tokenB || "").trim()];

  async function vote(tokenAddress: string) {
    if (!walletAddress) {
      toast.error("Connect a wallet to use your Free Vote.");
      return;
    }
    if (!payload || !model.walletEligible || !model.roundNumber || !model.matchId) return;
    setBusyToken(tokenAddress);
    try {
      const auth = await signArenaWalletAction({
        action: "arena_tournament_vote",
        extraLines: [
          `Tournament: ${tournamentId}`,
          `Round: ${model.roundNumber}`,
          `Match: ${model.matchId}`,
          `Token: ${tokenAddress}`,
        ],
        walletAddress,
        chainId,
        evmWallet: wallet,
        solanaAccount,
      });
      const next = await submitTournamentFreeVote({
        tournamentId,
        matchRef,
        walletAddress,
        tokenAddress,
        auth,
      });
      setPayload(next);
      toast.success("Free Vote confirmed.");
    } catch (error) {
      const message = String((error as Error)?.message || "Free Vote failed.");
      toast.error(message);
      await refresh();
    } finally {
      setBusyToken(null);
    }
  }

  if (loading && !payload) {
    return <div className="text-[10px] uppercase tracking-[0.16em] text-white/45">Loading Vote Tournament score…</div>;
  }
  if (unavailable || !payload) {
    return (
      <div data-vote-tournament-runtime="unavailable" className="text-[10px] uppercase tracking-[0.16em] text-white/45">
        Vote Tournament runtime unavailable
      </div>
    );
  }

  return (
    <section data-vote-tournament-controls="true" className="space-y-3 border-t border-white/10 pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] uppercase tracking-[0.16em] text-white/50">
        <span>{model.regulationLabel}</span>
        <span>{model.scoringLabel}</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {tokens.map((tokenAddress, index) => {
          const points = index === 0 ? model.leftPoints : model.rightPoints;
          const selected = model.walletVote && model.walletVote.toLowerCase() === tokenAddress.toLowerCase();
          return (
            <div key={tokenAddress} className="border border-white/10 bg-black/20 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[9px] uppercase tracking-[0.18em] text-white/42">{model.scoreScopeLabel}</div>
                  <div className="mt-1 font-retro text-lg text-white/90">{points} PT{points === 1 ? "" : "S"}</div>
                </div>
                <div className="text-right text-xs text-white/65">{shortToken(tokenAddress)}</div>
              </div>
              <Button
                type="button"
                size="sm"
                className="mt-3 w-full font-retro"
                variant={selected ? "secondary" : "outline"}
                disabled={!walletAddress || !model.walletEligible || Boolean(busyToken)}
                onClick={() => void vote(tokenAddress)}
              >
                {busyToken === tokenAddress ? "Confirming…" : selected ? "Vote confirmed" : "Free Vote"}
              </Button>
            </div>
          );
        })}
      </div>
      {!walletAddress ? (
        <p className="text-xs text-white/48">Connect a wallet to use one Free Vote for this matchup and round.</p>
      ) : model.walletVote ? (
        <p className="text-xs text-white/48">This wallet already used its Free Vote for this matchup.</p>
      ) : (
        <p className="text-xs text-white/48">One Free Vote per wallet, matchup and tournament round. Eligibility is server-authoritative.</p>
      )}
      <p className="text-[10px] uppercase tracking-[0.14em] text-white/38">
        Paid Boost and combined regulation score appear only when the authoritative Boost aggregate is available.
      </p>
    </section>
  );
}
