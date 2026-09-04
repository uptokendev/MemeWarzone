import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useWallet } from "@/contexts/WalletContext";
import { getNativeSymbol } from "@/lib/chainConfig";
import {
  createBattleBoostQuote,
  fetchBattleBoostState,
  formatBoostNative,
  submitBattleBoost,
  type BattleBoostSummary,
} from "@/lib/arena/battleBoostClient";

type Side = {
  tokenId?: string | null;
  ticker?: string | null;
  name?: string | null;
};

function unitsFor(summary: BattleBoostSummary | null, side: "left" | "right") {
  const raw = summary?.[side]?.boostUnits;
  try {
    const number = Number(BigInt(String(raw || "0")));
    return Number.isSafeInteger(number) && number >= 0 ? number : 0;
  } catch {
    return 0;
  }
}

export function BattleBoostPanel({
  battleId,
  chainId,
  left,
  right,
}: {
  battleId: string;
  chainId: number;
  left: Side;
  right: Side;
}) {
  const wallet = useWallet();
  const [summary, setSummary] = useState<BattleBoostSummary | null>(null);
  const [runtimeReady, setRuntimeReady] = useState<boolean | null>(null);
  const [busySide, setBusySide] = useState<"left" | "right" | null>(null);
  const [quantity, setQuantity] = useState(1);
  const nativeSymbol = getNativeSymbol(chainId);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const json = await fetchBattleBoostState(battleId, signal);
      setSummary(json?.summary || null);
      setRuntimeReady(true);
      return json;
    } catch {
      if (!signal?.aborted) {
        setSummary(null);
        setRuntimeReady(false);
      }
      return null;
    }
  }, [battleId]);

  useEffect(() => {
    const controller = new AbortController();
    setRuntimeReady(null);
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const totals = useMemo(
    () => ({ left: unitsFor(summary, "left"), right: unitsFor(summary, "right") }),
    [summary],
  );

  async function boost(side: "left" | "right", tokenId?: string | null) {
    if (runtimeReady !== true) return toast.error("Battle Boost runtime is unavailable.");
    if (!tokenId) return toast.error("Battle combatant address is unavailable.");
    if (!wallet.signer || !wallet.account) return toast.error("Connect an EVM wallet to Boost this battle.");
    if (Number(wallet.chainId) !== Number(chainId)) {
      return toast.error("Switch your wallet to the battle chain before Boosting.");
    }

    const previousUnits = side === "left" ? totals.left : totals.right;
    setBusySide(side);
    try {
      const quoted = await createBattleBoostQuote({
        battleId,
        chainId,
        wallet: wallet.account,
        targetToken: tokenId,
        boostUnits: quantity,
        signer: wallet.signer,
      });
      const gross = quoted.quote.value.grossNativeRaw;
      const label = side === "left" ? left.ticker || left.name || "left side" : right.ticker || right.name || "right side";
      const confirmed = window.confirm(
        `Boost ${label} with ${quantity} Boost${quantity === 1 ? "" : "s"}?\n\nCost: ${formatBoostNative(gross, nativeSymbol)}\nBoosts are paid support. Battle Points V3 scoring from Boost remains founder-pending.`,
      );
      if (!confirmed) return;

      const submitted = await submitBattleBoost({ signer: wallet.signer, quote: quoted.quote });
      toast.success(`Battle Boost submitted${submitted.txHash ? `: ${submitted.txHash.slice(0, 10)}…` : "."}`);

      for (let attempt = 0; attempt < 4; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, attempt === 0 ? 1_000 : 1_500));
        const fresh = await refresh();
        const nextUnits = unitsFor(fresh?.summary || null, side);
        if (nextUnits > previousUnits) break;
      }
    } catch (error) {
      toast.error(String((error as Error)?.message || "Battle Boost failed."));
      await refresh();
    } finally {
      setBusySide(null);
    }
  }

  const disabled = Boolean(busySide) || runtimeReady !== true;

  return (
    <section data-battle-boost-panel="true" className="space-y-3">
      <div>
        <div className="text-[10px] uppercase tracking-[0.24em] text-white/45">Battle Boost</div>
        <p className="mt-1 text-xs text-white/55">
          $1 paid Boosts add to the competition prize pool. 90% goes to the prize pool and 10% to protocol. The V3 Boost scoring curve is not active yet.
        </p>
      </div>

      {runtimeReady === null ? (
        <div role="status" aria-live="polite" className="text-[10px] uppercase tracking-[0.14em] text-white/38">Checking Battle Boost runtime…</div>
      ) : runtimeReady === false ? (
        <div role="status" aria-live="polite" data-battle-boost-runtime="unavailable" className="text-[10px] uppercase tracking-[0.14em] text-white/38">
          Battle Boost unavailable
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2" aria-label="Battle Boost quantity">
        {[1, 5, 10].map((value) => (
          <Button
            key={value}
            type="button"
            size="sm"
            variant={quantity === value ? "default" : "outline"}
            className="font-retro"
            disabled={runtimeReady !== true}
            onClick={() => setQuantity(value)}
          >
            {value}x
          </Button>
        ))}
      </div>

      <div className="grid min-w-0 gap-2 md:grid-cols-2">
        <Button
          type="button"
          variant="outline"
          className="min-w-0 justify-between gap-2 font-retro"
          disabled={disabled || !left.tokenId}
          onClick={() => void boost("left", left.tokenId)}
        >
          <span className="truncate">Boost {left.ticker || left.name || "left"}</span>
          <span className="shrink-0 text-xs opacity-70">{totals.left}</span>
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-w-0 justify-between gap-2 font-retro"
          disabled={disabled || !right.tokenId}
          onClick={() => void boost("right", right.tokenId)}
        >
          <span className="truncate">Boost {right.ticker || right.name || "right"}</span>
          <span className="shrink-0 text-xs opacity-70">{totals.right}</span>
        </Button>
      </div>

      {summary?.total?.grossNativeRaw ? (
        <div className="text-[10px] uppercase tracking-[0.16em] text-white/42">
          Confirmed Boost support: {formatBoostNative(summary.total.grossNativeRaw, nativeSymbol)}
        </div>
      ) : null}
    </section>
  );
}
