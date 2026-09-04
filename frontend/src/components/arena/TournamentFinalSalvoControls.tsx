import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { FinalSalvoPanel } from "@/components/arena/FinalSalvoPanel";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { useWallet } from "@/contexts/WalletContext";
import { fetchFinalSalvoState, submitFinalSalvoVote, type FinalSalvoPayload } from "@/lib/arena/finalSalvoClient";
import { presentFinalSalvoState } from "@/lib/arena/finalSalvoPresentation.mjs";
import { signArenaWalletAction } from "@/lib/arena/signArenaWalletAction";
import { tournamentVoteMatchRef } from "@/lib/arena/tournamentVotePresentation.mjs";
import { isSolanaChainId } from "@/lib/chainConfig";

type Match = {
  id?: string | null;
  battleId?: string | null;
  tokenA?: string | null;
  tokenB?: string | null;
};

export function TournamentFinalSalvoControls({
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
  const walletAddress = String(isSolanaChainId(chainId) ? solanaAccount || "" : wallet.account || "").trim();
  const matchRef = tournamentVoteMatchRef(match);
  const [payload, setPayload] = useState<FinalSalvoPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busySide, setBusySide] = useState<"left" | "right" | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [clockTick, setClockTick] = useState(0);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!tournamentId || !matchRef) return null;
    try {
      const next = await fetchFinalSalvoState(tournamentId, matchRef, walletAddress, signal);
      setPayload(next);
      setUnavailable(false);
      return next;
    } catch {
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
    const refreshTimer = window.setInterval(() => void refresh(), 5_000);
    const clockTimer = window.setInterval(() => setClockTick((value) => value + 1), 1_000);
    return () => {
      controller.abort();
      window.clearInterval(refreshTimer);
      window.clearInterval(clockTimer);
    };
  }, [refresh]);

  const state = payload?.finalSalvo || null;
  const model = useMemo(() => presentFinalSalvoState(state || {}), [state, clockTick]);
  const active = Boolean(model && state?.active);
  const tokenA = String(match.tokenA || "").trim();
  const tokenB = String(match.tokenB || "").trim();

  async function vote(side: "left" | "right") {
    if (!state || !model || !active || !model.walletEligible) return;
    if (!walletAddress) {
      toast.error("Connect a wallet to vote in Final Salvo.");
      return;
    }
    const tokenAddress = side === "left" ? tokenA : tokenB;
    if (!tokenAddress || !payload?.roundNumber || !payload?.matchId) return;
    const apiPhase = String(state.phase || "").trim();
    const shotIndex = Number(state.shotIndex || 0);
    if (!apiPhase || !shotIndex) return;

    setBusySide(side);
    try {
      const auth = await signArenaWalletAction({
        action: "arena_final_salvo_vote",
        extraLines: [
          `Tournament: ${tournamentId}`,
          `Round: ${payload.roundNumber}`,
          `Match: ${payload.matchId}`,
          `Phase: ${apiPhase}`,
          `Shot: ${shotIndex}`,
          `Token: ${tokenAddress}`,
        ],
        walletAddress,
        chainId,
        evmWallet: wallet,
        solanaAccount,
      });
      const next = await submitFinalSalvoVote({
        tournamentId,
        matchRef,
        walletAddress,
        tokenAddress,
        auth,
      });
      setPayload(next);
      toast.success("Final Salvo vote confirmed.");
    } catch (error) {
      toast.error(String((error as Error)?.message || "Final Salvo vote failed."));
      await refresh();
    } finally {
      setBusySide(null);
    }
  }

  if (loading && !payload) {
    return <div role="status" className="text-[10px] uppercase tracking-[0.16em] text-white/45">Checking Final Salvo…</div>;
  }
  if (unavailable || !payload) {
    return (
      <div role="status" data-final-salvo-runtime="unavailable" className="text-[10px] uppercase tracking-[0.16em] text-white/45">
        Final Salvo runtime unavailable
      </div>
    );
  }
  if (!model || !active) return null;

  return (
    <FinalSalvoPanel
      state={state}
      leftLabel={tokenA || "LEFT"}
      rightLabel={tokenB || "RIGHT"}
      busy={Boolean(busySide)}
      onVote={(side) => void vote(side)}
    />
  );
}
