import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  engineAmountFromDisplay,
  mobileDockCta,
  mobileTradeCta,
  mobileTradeUnitLabel,
  nativeToUsdAmount,
  nextMobileTradeUnit,
  parseTradeNumber,
  percentOf,
  tokenToUsdAmount,
} from "@/lib/mobileTradePresentation.mjs";

export function useXlUp() {
  const [xl, setXl] = useState(() => (typeof window !== "undefined" ? window.matchMedia("(min-width: 1280px)").matches : true));
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1280px)");
    const onChange = () => setXl(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return xl;
}

export type MobileTradeUnit = "USD" | "NATIVE" | "TOKEN";

type Props = {
  connected: boolean;
  connectLabel: string;
  onConnect: () => void;
  nativeUnit: string;
  ticker: string;
  nativeUsd: number | null;
  priceNative: number | null;
  nativeBalance: number;
  tokenBalance: number;
  nativeBalanceLabel: string;
  tokenBalanceLabel: string;
  side: "buy" | "sell";
  onSideChange: (side: "buy" | "sell") => void;
  onEngineChange: (next: { denom: "BNB" | "TOKEN"; amount: string }) => void;
  onSubmit: () => void;
  pending?: boolean;
  quoteLine?: string | null;
  error?: string | null;
  disabled?: boolean;
};

const USD_PRESETS = [25, 100, 250];
const PCT_PRESETS = [25, 50, 100];

export function MobileTradeDock({
  connected,
  connectLabel,
  onConnect,
  onOpenBuy,
}: {
  connected: boolean;
  connectLabel: string;
  onConnect: () => void;
  onOpenBuy: () => void;
}) {
  const cta = mobileDockCta({ connected, connectLabel });
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border/60 bg-background/95 px-3 pt-2 backdrop-blur xl:hidden"
      style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
      data-mobile-trade-dock="true"
    >
      <Button
        type="button"
        className="mwz-button mwz-button-orange h-12 w-full font-retro text-base"
        onClick={cta.kind === "connect" ? onConnect : onOpenBuy}
      >
        {cta.label}
      </Button>
    </div>
  );
}

export function MobileTradeSheet({
  connected,
  connectLabel,
  onConnect,
  nativeUnit,
  ticker,
  nativeUsd,
  priceNative,
  nativeBalance,
  tokenBalance,
  nativeBalanceLabel,
  tokenBalanceLabel,
  side,
  onSideChange,
  onEngineChange,
  onSubmit,
  pending = false,
  quoteLine,
  error,
  disabled = false,
  open,
  onClose,
}: Props & { open: boolean; onClose: () => void }) {
  const [unit, setUnit] = useState<MobileTradeUnit>("USD");
  const [displayAmount, setDisplayAmount] = useState("");
  const symbol = String(ticker || "TOKEN").replace(/^\$/, "");
  const unitLabel = mobileTradeUnitLabel(unit, nativeUnit, symbol);
  const cta = mobileTradeCta({ connected, displayAmount, side, pending });

  const usdBalance =
    side === "sell"
      ? tokenToUsdAmount(tokenBalance, priceNative, nativeUsd)
      : nativeToUsdAmount(nativeBalance, nativeUsd);

  useEffect(() => {
    if (!open) return;
    const next = engineAmountFromDisplay({
      unit,
      displayAmount,
      side,
      nativeUsd,
      priceNative,
    });
    onEngineChange(next);
  }, [open, unit, displayAmount, side, nativeUsd, priceNative, onEngineChange]);

  const prefix = unit === "USD";

  function cycleUnit() {
    setUnit((current) => nextMobileTradeUnit(current) as MobileTradeUnit);
    setDisplayAmount("");
  }

  function setUsdPreset(usd: number) {
    setUnit("USD");
    setDisplayAmount(String(usd));
  }

  // Percentages are of what the wallet holds, in that asset's own unit: a round trip through USD
  // rounds, and a 100% sell that rounds up asks for more tokens than the wallet has.
  function setPercent(pct: number) {
    if (side === "sell") {
      setUnit("TOKEN");
      setDisplayAmount(percentOf(tokenBalance, pct));
      return;
    }
    setUnit("NATIVE");
    setDisplayAmount(percentOf(nativeBalance, pct));
  }

  function setMax() {
    setPercent(100);
  }

  const walletLine = useMemo(() => {
    const nativeApprox = nativeToUsdAmount(nativeBalance, nativeUsd);
    return nativeApprox
      ? `${nativeBalanceLabel} ≈ $${nativeApprox}`
      : nativeBalanceLabel;
  }, [nativeBalance, nativeBalanceLabel, nativeUsd]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 xl:hidden" data-mobile-trade-sheet="true">
      <button type="button" className="absolute inset-0 bg-black/70" aria-label="Close trade sheet" onClick={onClose} />
      <div
        className="absolute inset-x-0 bottom-0 max-h-[92dvh] overflow-y-auto rounded-t-2xl border border-border/70 bg-background px-4 pt-3 shadow-2xl"
        style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="grid flex-1 grid-cols-2 gap-2 pr-2">
            <button
              type="button"
              className={cn(
                "h-10 rounded-lg font-retro text-sm",
                side === "buy" ? "bg-orange-500 text-white" : "border border-border text-muted-foreground",
              )}
              onClick={() => onSideChange("buy")}
            >
              Buy
            </button>
            <button
              type="button"
              className={cn(
                "h-10 rounded-lg font-retro text-sm",
                side === "sell" ? "bg-orange-500 text-white" : "border border-border text-muted-foreground",
              )}
              onClick={() => onSideChange("sell")}
            >
              Sell
            </button>
          </div>
          <button type="button" className="mwz-button h-9 w-9 shrink-0" onClick={onClose} aria-label="Close">
            <X className="mx-auto h-4 w-4" />
          </button>
        </div>

        <div className="flex items-end justify-center gap-2 py-4">
          {prefix ? <span className="pb-1 font-retro text-5xl leading-none text-foreground">$</span> : null}
          <input
            value={displayAmount}
            onChange={(event) => setDisplayAmount(event.target.value.replace(/[^0-9.]/g, ""))}
            inputMode="decimal"
            placeholder="0"
            className="min-w-0 max-w-[55%] bg-transparent text-center font-retro text-5xl leading-none text-foreground outline-none"
            aria-label="Trade amount"
            data-mobile-trade-amount="true"
          />
          <button
            type="button"
            onClick={cycleUnit}
            className="mb-1 rounded-full border border-border/70 px-2 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground"
            data-mobile-trade-unit={unit}
          >
            {unitLabel}
          </button>
        </div>

        <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {walletLine}
          </span>
          <button type="button" className="font-semibold uppercase tracking-[0.14em] text-orange-300" onClick={setMax}>
            MAX
          </button>
        </div>
        <div className="mb-3 text-[11px] text-muted-foreground">
          Token bag: {tokenBalanceLabel}
        </div>

        <div className="mb-2 grid grid-cols-3 gap-2">
          {USD_PRESETS.map((usd) => (
            <button
              key={usd}
              type="button"
              className="h-10 rounded-lg border border-border text-sm font-semibold text-foreground"
              onClick={() => setUsdPreset(usd)}
            >
              ${usd}
            </button>
          ))}
        </div>
        <div className="mb-4 grid grid-cols-3 gap-2">
          {PCT_PRESETS.map((pct) => (
            <button
              key={pct}
              type="button"
              className="h-10 rounded-lg border border-border text-sm text-muted-foreground"
              onClick={() => setPercent(pct)}
            >
              {pct}%
            </button>
          ))}
        </div>

        {quoteLine ? <p className="mb-2 text-center text-xs text-muted-foreground">{quoteLine}</p> : null}
        {error ? <p className="mb-2 text-center text-xs text-destructive">{error}</p> : null}

        <Button
          type="button"
          className="mwz-button mwz-button-orange h-12 w-full font-retro text-base"
          disabled={cta.kind === "empty" || cta.kind === "pending" || (cta.kind === "submit" && disabled)}
          onClick={() => {
            if (cta.kind === "connect") onConnect();
            else if (cta.kind === "submit") onSubmit();
          }}
          data-mobile-trade-submit={cta.kind}
        >
          {cta.label}
        </Button>
      </div>
    </div>
  );
}

export { parseTradeNumber };
