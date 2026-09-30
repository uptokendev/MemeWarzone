import { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { getNativeSymbol } from "@/lib/chainConfig";
import { getReadProvider } from "@/lib/readProvider";
import { readGen6CreateContext, type Gen6FactoryContext } from "@/lib/evmGen6Client";
import { LAUNCH_FEE_NOTE, campaignFromFactoryConfig, planFirstBuy, quoteFirstBuy } from "@/lib/evmGen6.mjs";
import { CreatorFeeChoicePicker, type CreatorFeeChoice } from "@/components/create/CreatorFeeChoicePicker";

export type EvmFirstBuyPlan = ReturnType<typeof planFirstBuy>;

function formatNative(wei: bigint, symbol: string) {
  const n = Number(ethers.formatEther(wei));
  if (!Number.isFinite(n)) return `${wei.toString()} wei`;
  const digits = n >= 1 ? 4 : 6;
  return `${n.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "")} ${symbol}`;
}

export function parseNativeInput(value: string): bigint {
  const text = String(value || "").trim();
  if (!text) return 0n;
  try {
    const wei = ethers.parseEther(text);
    return wei > 0n ? wei : 0n;
  } catch {
    return 0n;
  }
}

/** Re-read the factory and oracle and price the first buy exactly as the factory will. */
export async function freshEvmFirstBuyPlan(input: {
  chainId: number;
  factoryAddress: string;
  graduationTarget: bigint;
  budgetWei: bigint;
}): Promise<EvmFirstBuyPlan> {
  const ctx = await readGen6CreateContext(getReadProvider(input.chainId as any), input.factoryAddress, input.graduationTarget);
  return planFirstBuy({ budgetWei: input.budgetWei, config: ctx.config, protocolFeeBps: ctx.protocolFeeBps, nativeTargetWei: ctx.nativeTargetWei });
}

/**
 * Create-page options for a generation-6 EVM factory: the creator fee choice and the
 * creator's first buy. Same controls and words as the Solana DBC create page.
 */
export function EvmGen6LaunchOptions({
  chainId,
  factoryAddress,
  graduationTarget,
  feeChoice,
  onFeeChoiceChange,
  sharePct,
  onSharePctChange,
  firstBuyInput,
  onFirstBuyInputChange,
  onPlanChange,
  initialFirstBuyTokens = 0n,
}: {
  chainId: number;
  factoryAddress: string;
  graduationTarget: bigint;
  feeChoice: CreatorFeeChoice;
  onFeeChoiceChange: (choice: CreatorFeeChoice) => void;
  sharePct: string;
  onSharePctChange: (pct: string) => void;
  firstBuyInput: string;
  onFirstBuyInputChange: (value: string) => void;
  onPlanChange?: (plan: EvmFirstBuyPlan | null) => void;
  /** A draft's saved first buy (tokens); shown as its native cost once the curve is known. */
  initialFirstBuyTokens?: bigint;
}) {
  const symbol = getNativeSymbol(chainId);
  const [ctx, setCtx] = useState<Gen6FactoryContext | null>(null);
  const [ctxError, setCtxError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCtx(null);
    setCtxError(null);
    if (!factoryAddress || graduationTarget <= 0n) return;
    void readGen6CreateContext(getReadProvider(chainId as any), factoryAddress, graduationTarget)
      .then((next) => {
        if (!cancelled) setCtx(next);
      })
      .catch((error) => {
        if (!cancelled) setCtxError(String(error?.shortMessage || error?.message || "The price feed did not answer."));
      });
    return () => {
      cancelled = true;
    };
  }, [chainId, factoryAddress, graduationTarget]);

  useEffect(() => {
    if (!ctx || initialFirstBuyTokens <= 0n || firstBuyInput) return;
    const c = campaignFromFactoryConfig(ctx.config);
    const { total } = quoteFirstBuy({ tokens: initialFirstBuyTokens, basePrice: c.basePrice, priceSlope: c.priceSlope, protocolFeeBps: ctx.protocolFeeBps });
    if (total > 0n) onFirstBuyInputChange(ethers.formatEther(total));
    // Only when the saved amount or the curve arrives; typing afterwards is the creator's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, initialFirstBuyTokens]);

  const budgetWei = parseNativeInput(firstBuyInput);
  const plan = useMemo(
    () =>
      ctx
        ? planFirstBuy({ budgetWei, config: ctx.config, protocolFeeBps: ctx.protocolFeeBps, nativeTargetWei: ctx.nativeTargetWei })
        : null,
    [ctx, budgetWei],
  );

  useEffect(() => {
    onPlanChange?.(plan);
  }, [plan, onPlanChange]);

  const feePct = ctx ? (Number(ctx.protocolFeeBps) / 100).toFixed(0) : "2";

  return (
    <div className="space-y-3 rounded-xl border border-border/50 bg-background/25 p-3">
      <CreatorFeeChoicePicker value={feeChoice} onChange={onFeeChoiceChange} sharePct={sharePct} onSharePctChange={onSharePctChange} />
      <div>
        <div className="font-retro text-sm text-foreground">Your first buy (optional)</div>
        <p className="mt-0.5 text-xs text-muted-foreground">Buys in the same transaction as the launch, at the normal {feePct}% fee. The tokens go to your wallet unlocked.</p>
        <Input
          type="number"
          min={0}
          step="0.001"
          value={firstBuyInput}
          onChange={(e) => onFirstBuyInputChange(e.target.value)}
          placeholder={`${symbol} amount`}
          className="mt-2 max-w-[12rem]"
          data-testid="evm-first-buy-input"
        />
        {plan && budgetWei > 0n ? (
          <p className={cn("mt-1 text-xs", plan.exceedsCap ? "text-orange-300" : "text-muted-foreground")}>
            About {(plan.supplyBps / 100).toFixed(2)}% of supply for {formatNative(plan.total, symbol)}, including the {feePct}% fee
            {plan.exceedsCap ? ". That is over the cap: lower the amount." : "."}
          </p>
        ) : null}
        {plan ? (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Most you can buy now: {formatNative(plan.maxTotalWei, symbol)}
            {plan.limitedBy === "target"
              ? ", half of the graduation target at today's price."
              : ", which is 10% of the supply."}
          </p>
        ) : null}
        {ctxError ? <p className="mt-1 text-[11px] text-orange-300">First-buy pricing is unavailable: {ctxError}</p> : null}
      </div>
      <p className="text-xs text-muted-foreground">{LAUNCH_FEE_NOTE}</p>
    </div>
  );
}
