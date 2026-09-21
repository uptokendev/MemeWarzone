import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { useWallet } from "@/contexts/WalletContext";
import { signArenaWalletAction } from "@/lib/arena/signArenaWalletAction";
import { isSolanaChainId } from "@/lib/chainConfig";
import { fetchBattleVoteState, submitBattleFreeVote, type BattleVotePayload } from "@/lib/arena/battleVoteClient";
import { battleDurationLabel } from "@/lib/arena/battleDuration";

function shortToken(value?: string | null) {
  const token = String(value || "").trim();
  if (!token) return "TOKEN";
  if (token.length <= 12) return token;
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

function tokenIdentityEqual(left?: string | null, right?: string | null) {
  const a = String(left || "").trim();
  const b = String(right || "").trim();
  if (!a || !b) return false;
  if (a.startsWith("0x") && b.startsWith("0x")) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

/**
 * Free Vote controls for a standalone Vote Battle. Same rules as the Vote
 * Tournament round controls: one free vote per wallet, boosts count 2 pts per
 * unit, ties go to Final Salvo.
 */
export function BattleVoteControls({
  battleId,
  chainId,
  tokenA,
  tokenB,
  labelA,
  labelB,
}: {
  battleId: string;
  chainId: number;
  tokenA: string;
  tokenB: string;
  labelA?: string | null;
  labelB?: string | null;
}) {
  const wallet = useWallet();
  const { solanaAccount } = useSolanaWallet();
  const walletAddress = String(isSolanaChainId(chainId) ? solanaAccount || "" : wallet.account || "").trim();
  const [payload, setPayload] = useState<BattleVotePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyToken, setBusyToken] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!battleId) return null;
    try {
      const next = await fetchBattleVoteState(battleId, walletAddress, chainId, signal);
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
  }, [battleId, chainId, walletAddress]);

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

  const model = useMemo(() => {
    const summary = payload?.summary;
    const score = payload?.score;
    const walletVote = String(payload?.walletVote || "").trim() || null;
    return {
      votingLive: payload?.votingLive === true,
      leftVotes: Number(summary?.leftVotes || 0),
      rightVotes: Number(summary?.rightVotes || 0),
      leftPoints: Number(score?.leftPoints ?? summary?.leftVotes ?? 0),
      rightPoints: Number(score?.rightPoints ?? summary?.rightVotes ?? 0),
      walletVote,
      walletEligible: payload?.votingLive === true && !walletVote,
      durationLabel: payload?.durationHours ? battleDurationLabel(payload.durationHours) : null,
      finalSalvo: payload?.finalSalvo?.state || null,
      unavailableReason: payload?.unavailableReason || null,
    };
  }, [payload]);

  async function vote(tokenAddress: string) {
    if (!walletAddress) {
      toast.error("Connect a wallet to use your Free Vote.");
      return;
    }
    if (!payload || !model.walletEligible) return;
    setBusyToken(tokenAddress);
    try {
      const auth = await signArenaWalletAction({
        action: "arena_battle_vote",
        extraLines: [`Battle: ${battleId}`, "Phase: regulation", `Token: ${tokenAddress}`],
        walletAddress,
        chainId,
        evmWallet: wallet,
        solanaAccount,
      });
      const next = await submitBattleFreeVote({ battleId, chainId, walletAddress, tokenAddress, auth });
      setPayload(next);
      toast.success("Free Vote confirmed.");
    } catch (error) {
      toast.error(String((error as Error)?.message || "Free Vote failed."));
      await refresh();
    } finally {
      setBusyToken(null);
    }
  }

  if (loading && !payload) {
    return <div role="status" aria-live="polite" className="text-[10px] uppercase tracking-[0.16em] text-white/45">Loading Vote Battle score…</div>;
  }
  if (unavailable || !payload) {
    return (
      <div role="status" aria-live="polite" data-vote-battle-runtime="unavailable" className="text-[10px] uppercase tracking-[0.16em] text-white/45">
        Vote Battle runtime unavailable
      </div>
    );
  }

  const sides = [
    { token: tokenA, label: labelA, votes: model.leftVotes, points: model.leftPoints },
    { token: tokenB, label: labelB, votes: model.rightVotes, points: model.rightPoints },
  ];

  return (
    <section aria-label="Vote Battle regulation" data-vote-battle-controls="true" className="space-y-3 border-t border-white/10 pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] uppercase tracking-[0.16em] text-white/50">
        <span>{model.durationLabel ? `${model.durationLabel.toUpperCase()} VOTE BATTLE` : "VOTE BATTLE"}</span>
        <span>FREE VOTE = 1 PT · BOOST = 2 PTS</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {sides.map((side) => {
          const selected = tokenIdentityEqual(model.walletVote, side.token);
          return (
            <div key={side.token} className="border border-white/10 bg-black/20 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[9px] uppercase tracking-[0.18em] text-white/42">REGULATION SCORE</div>
                  <div className="mt-1 font-retro text-lg text-white/90">{side.points} PT{side.points === 1 ? "" : "S"}</div>
                  <div className="text-[10px] uppercase tracking-[0.14em] text-white/45">{side.votes} free vote{side.votes === 1 ? "" : "s"}</div>
                </div>
                <div className="text-right text-xs text-white/65">{side.label || shortToken(side.token)}</div>
              </div>
              <Button
                type="button"
                size="sm"
                className="mt-3 w-full font-retro"
                variant={selected ? "secondary" : "outline"}
                disabled={!walletAddress || !model.walletEligible || Boolean(busyToken)}
                onClick={() => void vote(side.token)}
              >
                {busyToken === side.token ? "Confirming…" : selected ? "Vote confirmed" : "Free Vote"}
              </Button>
            </div>
          );
        })}
      </div>
      {model.finalSalvo ? (
        <p className="text-xs text-white/48">Regulation ended in a tie. Final Salvo ({model.finalSalvo}) decides this battle.</p>
      ) : !model.votingLive ? (
        <p className="text-xs text-white/48">Voting is closed for this battle.</p>
      ) : !walletAddress ? (
        <p className="text-xs text-white/48">Connect a wallet on this battle's chain to use one Free Vote.</p>
      ) : model.walletVote ? (
        <p className="text-xs text-white/48">This wallet already used its Free Vote for this battle.</p>
      ) : (
        <p className="text-xs text-white/48">One Free Vote per wallet and battle. Boosts add 2 pts per unit to the same score.</p>
      )}
    </section>
  );
}
