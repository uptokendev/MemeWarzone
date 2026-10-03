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

/**
 * Sits right above the app's bottom tab bar (`--mwz-footer-offset`, 0 where there is none).
 * Connected + `onOpenSell`: green Buy and red Sell, both opening the same trade sheet.
 */
export function MobileTradeDock({
  connected,
  connectLabel,
  onConnect,
  onOpenBuy,
  onOpenSell,
}: {
  connected: boolean;
  connectLabel: string;
  onConnect: () => void;
  onOpenBuy: () => void;
  onOpenSell?: () => void;
}) {
  const cta = mobileDockCta({ connected, connectLabel });
  const split = cta.kind !== "connect" && Boolean(onOpenSell);
  return (
    <div
      className="fixed inset-x-0 bottom-[var(--mwz-footer-offset,0px)] z-40 border-t border-mw-border bg-mw-ground px-4 py-2.5 font-mw-body xl:hidden"
      data-mobile-trade-dock="true"
    >
      {split ? (
        <div className="grid grid-cols-2 gap-2.5">
          <button
            type="button"
            className="mw-focus inline-flex min-h-[50px] items-center justify-center rounded-[10px] bg-mw-buy text-[17px] font-semibold text-[#04140A]"
            onClick={onOpenBuy}
          >
            {cta.label}
          </button>
          <button
            type="button"
            className="mw-focus inline-flex min-h-[50px] items-center justify-center rounded-[10px] bg-mw-sell text-[17px] font-semibold text-[#FFF1F3]"
            onClick={onOpenSell}
          >
            Sell
          </button>
        </div>
      ) : (
        <Button
          type="button"
          className="mw-focus h-[50px] w-full rounded-[10px] border border-mw-accent bg-mw-accent text-[17px] font-semibold text-[#140A02] hover:bg-[#FF8F3D]"
          onClick={cta.kind === "connect" ? onConnect : onOpenBuy}
        >
          {cta.label}
        </Button>
      )}
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
      <button type="button" className="absolute inset-0 bg-[rgba(5,6,8,0.75)]" aria-label="Close trade sheet" onClick={onClose} />
      <div
        className="absolute inset-x-0 bottom-0 max-h-[92dvh] overflow-y-auto rounded-t-[20px] border border-mw-edge bg-mw-surface px-4 pt-3 font-mw-body text-mw-text shadow-2xl"
        style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="grid flex-1 grid-cols-2 gap-1 rounded-[10px] border border-mw-border bg-mw-input p-1 mr-2">
            <button
              type="button"
              className={cn(
                "mw-focus min-h-11 rounded-lg text-[15px] font-bold",
                side === "buy" ? "bg-mw-buy text-[#04140A]" : "text-mw-muted hover:text-mw-text",
              )}
              onClick={() => onSideChange("buy")}
            >
              Buy
            </button>
            <button
              type="button"
              className={cn(
                "mw-focus min-h-11 rounded-lg text-[15px] font-bold",
                side === "sell" ? "bg-mw-sell text-[#FFF1F3]" : "text-mw-muted hover:text-mw-text",
              )}
              onClick={() => onSideChange("sell")}
            >
              Sell
            </button>
          </div>
          <button type="button" className="mw-focus inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] text-mw-muted hover:bg-mw-raised hover:text-mw-text" onClick={onClose} aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex items-end justify-center gap-2 py-4">
          {prefix ? <span className="pb-1 font-mw-mono text-5xl font-bold leading-none text-mw-text">$</span> : null}
          <input
            value={displayAmount}
            onChange={(event) => setDisplayAmount(event.target.value.replace(/[^0-9.]/g, ""))}
            inputMode="decimal"
            placeholder="0"
            className="min-w-0 max-w-[55%] bg-transparent text-center font-mw-mono text-5xl font-bold leading-none text-mw-text placeholder:text-[#4B535C] outline-none"
            aria-label="Trade amount"
            data-mobile-trade-amount="true"
          />
          <button
            type="button"
            onClick={cycleUnit}
            className="mw-focus mb-1 inline-flex min-h-11 items-center rounded-full border border-mw-edge bg-[#171B20] px-3 text-[13px] font-semibold text-[#C9CED4] hover:text-mw-text"
            data-mobile-trade-unit={unit}
          >
            {unitLabel}
          </button>
        </div>

        <div className="mb-3 flex items-center justify-between gap-2 text-xs text-mw-muted">
          <span>
            {walletLine}
          </span>
          <button type="button" className="mw-focus inline-flex min-h-11 items-center rounded-lg px-2 font-mw-cond text-sm font-bold uppercase tracking-[0.08em] text-mw-accent-soft hover:text-[#FFD0A8]" onClick={setMax}>
            MAX
          </button>
        </div>
        <div className="mb-3 text-xs text-mw-muted">
          Token bag: {tokenBalanceLabel}
        </div>

        <div className="mb-2 grid grid-cols-3 gap-2">
          {USD_PRESETS.map((usd) => (
            <button
              key={usd}
              type="button"
              className="mw-focus min-h-11 rounded-[10px] border border-mw-edge bg-[#171B20] font-mw-mono text-sm font-semibold text-mw-text hover:bg-[#1F252C]"
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
              className="mw-focus min-h-11 rounded-[10px] border border-mw-edge bg-[#171B20] font-mw-mono text-sm text-[#C9CED4] hover:bg-[#1F252C] hover:text-mw-text"
              onClick={() => setPercent(pct)}
            >
              {pct}%
            </button>
          ))}
        </div>

        {quoteLine ? <p className="mb-2 text-center text-xs text-mw-muted">{quoteLine}</p> : null}
        {error ? <p className="mb-2 text-center text-xs text-mw-sell">{error}</p> : null}

        <Button
          type="button"
          className={side === "sell" ? "mw-focus min-h-[54px] w-full rounded-[10px] border border-mw-sell bg-mw-sell text-[17px] font-semibold text-[#FFF1F3] hover:bg-[#BE123C] disabled:opacity-60" : "mw-focus min-h-[54px] w-full rounded-[10px] border border-mw-buy bg-mw-buy text-[17px] font-semibold text-[#04140A] hover:bg-[#15803D] disabled:opacity-60"}
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
