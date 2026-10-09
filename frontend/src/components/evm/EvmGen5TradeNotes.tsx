import { useEffect, useState } from "react";
import type { Gen5CampaignState } from "@/lib/evmGen6Client";
import {
  EVM_ANTI_SNIPER_WINDOW_SECONDS,
  EVM_CREATOR_BUY_LOCK_COPY,
  evmFeeChoiceLine,
  evmGraduationStatus,
} from "@/lib/evmGen6.mjs";
import { GEN7_ANTI_SNIPER_WINDOW_SECONDS } from "@/lib/evmGen7.mjs";

function useNowSeconds(active: boolean) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * Trade-panel lines for a generation-5 EVM coin: the creator's lock notice before they buy, the graduation state and where the
 * creator fees go. Quotes themselves come from the campaign's quote functions,
 * which already include the current fee.
 */
export function EvmGen5TradeNotes({
  state,
  viewerIsCreator,
  tradeTab,
  nativeSymbol,
  explorerBase,
}: {
  state: Gen5CampaignState;
  viewerIsCreator: boolean;
  tradeTab: "buy" | "sell" | string;
  nativeSymbol: string;
  explorerBase: string;
}) {
  const gen7 = state.factoryGeneration === 7;
  const windowSeconds = gen7 ? GEN7_ANTI_SNIPER_WINDOW_SECONDS : EVM_ANTI_SNIPER_WINDOW_SECONDS;
  const windowOpen = !state.launched && Math.floor(Date.now() / 1000) < state.launchAt + windowSeconds + 1;
  const now = useNowSeconds(windowOpen);
  const graduation = evmGraduationStatus({
    launched: state.launched,
    graduationPending: state.graduationPending,
    pendingSince: state.pendingSince,
    quoteToken: state.quoteToken,
    nativeFallback: state.nativeFallback,
    quoteSymbol: state.quoteSymbol || undefined,
    nativeSymbol,
    nowUnix: now,
  });
  const feeLine = evmFeeChoiceLine(state.feeChoice, state.feeCreatorPct);

  return (
    <div className="mt-2 space-y-1 text-center text-xs" data-testid="evm-gen5-trade-notes">
      {/* The launch-fee line is not shown on the coin page (founder, 2026-10-08); it is explained in the docs. */}
      {graduation.phase === "trading" && viewerIsCreator && tradeTab === "buy" ? (
        <p className="text-orange-200">{EVM_CREATOR_BUY_LOCK_COPY}</p>
      ) : null}
      {graduation.phase === "pending" ? (
        <>
          <p className="text-emerald-300">{graduation.line}</p>
          {graduation.note ? <p className="text-muted-foreground">{graduation.note}</p> : null}
        </>
      ) : null}
      {graduation.phase === "graduated" ? (
        <p className="text-emerald-300">
          Graduated.{" "}
          {state.pool ? (
            <a href={`${explorerBase}/address/${state.pool}`} target="_blank" rel="noreferrer" className="underline">
              Pool {state.pool.slice(0, 6)}…{state.pool.slice(-4)}
            </a>
          ) : (
            "The pool address is loading."
          )}
        </p>
      ) : null}
      {feeLine && state.feeChoice !== "keep" ? <p className="text-[11px] text-muted-foreground">{feeLine}</p> : null}
    </div>
  );
}
