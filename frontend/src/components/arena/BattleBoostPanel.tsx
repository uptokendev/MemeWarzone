import { useEffect, useMemo, useState } from "react";
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
    return Number(BigInt(String(raw || "0")));
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
  const [busySide, setBusySide] = useState<"left" | "right" | null>(null);
  const [quantity, setQuantity] = useState(1);
  const nativeSymbol = getNativeSymbol(chainId);

  useEffect(() => {
    const controller = new AbortController();
    void fetchBattleBoostState(battleId, controller.signal)
      .then((json) => setSummary(json?.summary || null))
      .catch(() => setSummary(null));
    return () => controller.abort();
  }, [battleId]);

  const totals = useMemo(
    () => ({ left: unitsFor(summary, "left"), right: unitsFor(summary, "right") }),
    [summary],
  );

  async function boost(side: "left" | "right", tokenId?: string | null) {
    if (!tokenId) return toast.error("Battle combatant address is unavailable.");
    if (!wallet.signer || !wallet.account) return toast.error("Connect an EVM wallet to Boost this battle.");
    if (Number(wallet.chainId) !== Number(chainId)) {
      return toast.error(`Switch your wallet to the battle chain before Boosting.`);
    }

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

      const refreshed = await fetchBattleBoostState(battleId).catch(() => null);
      if (refreshed?.summary) setSummary(refreshed.summary);
    } catch (error) {
      toast.error(String((error as Error)?.message || "Battle Boost failed."));
    } finally {
      setBusySide(null);
    }
  }

  return (
    <section data-battle-boost-panel="true" className="space-y-3">
      <div>
        <div className="text-[10px] uppercase tracking-[0.24em] text-white/45">Battle Boost</div>
        <p className="mt-1 text-xs text-white/55">
          $1 paid Boosts add to the competition prize pool. 90% goes to the prize pool and 10% to protocol. The V3 Boost scoring curve is not active yet.
        </p>
      </div>

      <div className="flex flex-wrap gap-2" aria-label="Battle Boost quantity">
        {[1, 5, 10].map((value) => (
          <Button
            key={value}
            type="button"
            size="sm"
            variant={quantity === value ? "default" : "outline"}
            className="font-retro"
            onClick={() => setQuantity(value)}
          >
            {value}x
          </Button>
        ))}
      </div>

      <div className="grid gap-2 md:grid-cols-2">
        <Button
          type="button"
          variant="outline"
          className="justify-between font-retro"
          disabled={Boolean(busySide) || !left.tokenId}
          onClick={() => void boost("left", left.tokenId)}
        >
          <span>Boost {left.ticker || left.name || "left"}</span>
          <span className="text-xs opacity-70">{totals.left}</span>
        </Button>
        <Button
          type="button"
          variant="outline"
          className="justify-between font-retro"
          disabled={Boolean(busySide) || !right.tokenId}
          onClick={() => void boost("right", right.tokenId)}
        >
          <span>Boost {right.ticker || right.name || "right"}</span>
          <span className="text-xs opacity-70">{totals.right}</span>
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
