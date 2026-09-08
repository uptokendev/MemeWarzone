import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { useWallet } from "@/contexts/WalletContext";
import { getNativeSymbol, isSolanaChainId } from "@/lib/chainConfig";
import { fetchFinalSalvoState } from "@/lib/arena/finalSalvoClient";
import {
  createSolanaTournamentBoostQuote,
  createTournamentBoostQuote,
  fetchTournamentBoostState,
  formatSolanaBoostLamports,
  formatTournamentBoostNative,
  submitSolanaTournamentBoost,
  submitTournamentBoost,
  type TournamentBoostState,
} from "@/lib/arena/tournamentBoostClient";
import { fetchTournamentVoteState, type TournamentVotePayload } from "@/lib/arena/tournamentVoteClient";
import { presentTournamentVoteSummary, tournamentVoteMatchRef } from "@/lib/arena/tournamentVotePresentation.mjs";

type Match = {
  id?: string | null;
  battleId?: string | null;
  tokenA?: string | null;
  tokenB?: string | null;
};

function bigintNumber(value?: string | null) {
  try {
    const number = Number(BigInt(String(value || "0")));
    return Number.isSafeInteger(number) && number >= 0 ? number : 0;
  } catch { return 0; }
}

function shortToken(value?: string | null) {
  const token = String(value || "").trim();
  if (!token) return "TOKEN";
  if (token.length <= 12) return token;
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

export function TournamentBoostControls({ tournamentId, chainId, match }: {
  tournamentId: string;
  chainId: number;
  match: Match;
}) {
  const wallet = useWallet();
  const solanaWallet = useSolanaWallet();
  const matchRef = tournamentVoteMatchRef(match);
  const [boostState, setBoostState] = useState<TournamentBoostState | null>(null);
  const [voteState, setVoteState] = useState<TournamentVotePayload | null>(null);
  const [salvoActive, setSalvoActive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [quantity, setQuantity] = useState(1);
  const [busySide, setBusySide] = useState<"left" | "right" | null>(null);
  const nativeSymbol = getNativeSymbol(chainId);
  const solana = isSolanaChainId(chainId);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!tournamentId || !matchRef) {
      setLoading(false);
      return null;
    }
    try {
      const [boost, votes, salvo] = await Promise.all([
        fetchTournamentBoostState(tournamentId, matchRef, signal),
        fetchTournamentVoteState(tournamentId, matchRef, null, signal),
        fetchFinalSalvoState(tournamentId, matchRef, null, signal).catch(() => null),
      ]);
      setBoostState(boost);
      setVoteState(votes);
      setSalvoActive(Boolean(salvo?.finalSalvo?.active || salvo?.finalSalvo?.state === "resolved"));
      setUnavailable(false);
      return boost;
    } catch {
      if (signal?.aborted) return null;
      setUnavailable(true);
      return null;
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [matchRef, tournamentId]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void refresh(controller.signal);
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [refresh]);

  const voteModel = useMemo(() => presentTournamentVoteSummary(voteState || {}), [voteState]);
  const leftBoostPoints = bigintNumber(boostState?.summary?.left?.boostPoints);
  const rightBoostPoints = bigintNumber(boostState?.summary?.right?.boostPoints);
  const leftBoostUnits = bigintNumber(boostState?.summary?.left?.boostUnits);
  const rightBoostUnits = bigintNumber(boostState?.summary?.right?.boostUnits);
  const leftCombined = voteModel.leftPoints + leftBoostPoints;
  const rightCombined = voteModel.rightPoints + rightBoostPoints;
  const tokenA = String(match.tokenA || "").trim();
  const tokenB = String(match.tokenB || "").trim();

  async function boost(side: "left" | "right") {
    if (!boostState || salvoActive) return;
    const targetToken = side === "left" ? tokenA : tokenB;
    setBusySide(side);
    try {
      if (solana) {
        const account = String(solanaWallet.solanaAccount || "").trim();
        if (!account) throw new Error("Connect a Solana wallet to Boost this Vote Tournament.");
        if (!targetToken) throw new Error("Tournament combatant address is unavailable for the Solana Boost path.");
        const quoted = await createSolanaTournamentBoostQuote({
          tournamentId, matchRef, chainId, wallet: account, targetToken, boostUnits: quantity,
          roundNumber: Number(boostState.roundNumber), matchId: boostState.matchId,
        });
        const confirmed = window.confirm(
          `Boost ${shortToken(targetToken)} with ${quantity} Boost${quantity === 1 ? "" : "s"}?\n\nCost: ${formatSolanaBoostLamports(quoted.grossLamports)}\nEach backend-confirmed Boost adds 2 regulation points.`,
        );
        if (!confirmed) return;
        const payment = await submitSolanaTournamentBoost({ tournamentId, matchRef, wallet: account, quote: quoted });
        toast.success(`Tournament Boost confirmed${payment.signature ? `: ${payment.signature.slice(0, 10)}…` : "."}`);
      } else {
        if (!wallet.account || !wallet.signer) throw new Error("Connect an EVM wallet to Boost this Vote Tournament.");
        if (Number(wallet.chainId) !== Number(chainId)) throw new Error("Switch your wallet to the tournament chain before Boosting.");
        if (!/^0x[a-fA-F0-9]{40}$/.test(targetToken)) throw new Error("Tournament combatant address is unavailable for the EVM Boost path.");
        const quoted = await createTournamentBoostQuote({
          tournamentId, matchRef, chainId, wallet: wallet.account, targetToken, boostUnits: quantity,
          roundNumber: Number(boostState.roundNumber), matchId: boostState.matchId, signer: wallet.signer,
        });
        const confirmed = window.confirm(
          `Boost ${shortToken(targetToken)} with ${quantity} Boost${quantity === 1 ? "" : "s"}?\n\nCost: ${formatTournamentBoostNative(quoted.quote.value.grossNativeRaw, nativeSymbol)}\nEach confirmed Boost adds 2 regulation points.`,
        );
        if (!confirmed) return;
        const submitted = await submitTournamentBoost({ signer: wallet.signer, quote: quoted.quote });
        toast.success(`Tournament Boost submitted${submitted.txHash ? `: ${submitted.txHash.slice(0, 10)}…` : "."}`);
      }

      for (let attempt = 0; attempt < 4; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, attempt === 0 ? 1_000 : 1_500));
        const fresh = await refresh();
        const sidePoints = side === "left" ? bigintNumber(fresh?.summary?.left?.boostPoints) : bigintNumber(fresh?.summary?.right?.boostPoints);
        const previousPoints = side === "left" ? leftBoostPoints : rightBoostPoints;
        if (sidePoints > previousPoints) break;
      }
    } catch (error) {
      toast.error(String((error as Error)?.message || "Tournament Boost failed."));
      await refresh();
    } finally { setBusySide(null); }
  }

  if (loading && !boostState) {
    return <div role="status" aria-live="polite" className="text-[10px] uppercase tracking-[0.14em] text-white/38">Loading Tournament Boost score…</div>;
  }
  if (unavailable || !boostState || !voteState) {
    return <div role="status" aria-live="polite" data-tournament-boost-runtime="unavailable" className="text-[10px] uppercase tracking-[0.14em] text-white/38">Tournament Boost runtime unavailable</div>;
  }
  if (salvoActive) return null;

  return (
    <section aria-label="Vote Tournament Boost" data-tournament-boost-controls="true" data-tournament-boost-chain={solana ? "solana" : "evm"} className="space-y-3 border-t border-white/10 pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] uppercase tracking-[0.14em] text-white/48">
        <span>TOURNAMENT BOOST · $1 = 2 PTS</span><span>90% PRIZE · 10% PROTOCOL</span>
      </div>
      <div className="flex flex-wrap gap-2" aria-label="Tournament Boost quantity">
        {[1, 5, 10].map((value) => (
          <Button key={value} type="button" size="sm" variant={quantity === value ? "default" : "outline"} className="font-retro" onClick={() => setQuantity(value)}>{value}x</Button>
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <RegulationSide token={tokenA} freePoints={voteModel.leftPoints} boostPoints={leftBoostPoints} boostUnits={leftBoostUnits} combined={leftCombined} busy={busySide === "left"} disabled={Boolean(busySide)} onBoost={() => void boost("left")} />
        <RegulationSide token={tokenB} freePoints={voteModel.rightPoints} boostPoints={rightBoostPoints} boostUnits={rightBoostUnits} combined={rightCombined} busy={busySide === "right"} disabled={Boolean(busySide)} onBoost={() => void boost("right")} />
      </div>
      <p className="text-[10px] uppercase tracking-[0.13em] text-white/35">Combined regulation score = authoritative Free Vote points + backend-confirmed Boost points. Winner and bracket advancement remain server-authoritative.</p>
    </section>
  );
}

function RegulationSide({ token, freePoints, boostPoints, boostUnits, combined, busy, disabled, onBoost }: {
  token: string; freePoints: number; boostPoints: number; boostUnits: number; combined: number;
  busy: boolean; disabled: boolean; onBoost: () => void;
}) {
  return (
    <div className="border border-white/10 bg-black/20 p-3">
      <div className="flex items-start justify-between gap-3">
        <div><div className="text-[9px] uppercase tracking-[0.16em] text-white/38">{shortToken(token)}</div><div className="mt-1 font-retro text-xl text-white/90">{combined} PTS</div></div>
        <div className="text-right text-[9px] uppercase tracking-[0.12em] text-white/42"><div>{freePoints} vote</div><div>{boostPoints} boost</div><div>{boostUnits} units</div></div>
      </div>
      <Button type="button" size="sm" variant="outline" className="mt-3 w-full font-retro" disabled={disabled || !token} onClick={onBoost}>{busy ? "Confirming…" : "Boost"}</Button>
    </div>
  );
}
