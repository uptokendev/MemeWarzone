import { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { getNativeSymbol, isRobinhoodChainId } from "@/lib/chainConfig";
import { getReadProvider } from "@/lib/readProvider";
import { readEvmCreateContext, readGen6CreateContext, type Gen6FactoryContext, type Gen7FactoryContext } from "@/lib/evmGen6Client";
import { LAUNCH_FEE_NOTE, campaignFromFactoryConfig, planFirstBuy, quoteFirstBuy } from "@/lib/evmGen6.mjs";
import {
  EVM_GEN7_FIRST_BUY_SLACK_BPS,
  GEN7_LAUNCH_FEE_NOTE,
  gen7CurveFromConfig,
  gen7FirstBuyOverBalance,
  gen7MaxFirstBuyBudget,
  isGen7TargetAllowed,
  planGen7FirstBuy,
  quoteGen7FirstBuy,
} from "@/lib/evmGen7.mjs";
import { evmLaunchBalanceMessage, evmLaunchGasReserveWei } from "@/lib/tradeBalanceReserve";
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
 * Generation 7: re-read the factory config and the oracle's market cap now and price the first buy on
 * the curve the factory would size for a create in this block (planGen7FirstBuy).
 */
export async function freshEvmGen7FirstBuyPlan(input: {
  chainId: number;
  factoryAddress: string;
  graduationTarget: bigint;
  budgetWei: bigint;
}): Promise<EvmFirstBuyPlan> {
  const ctx = await readEvmCreateContext(getReadProvider(input.chainId as any), input.factoryAddress, input.graduationTarget);
  if (ctx.generation !== 7) throw new Error("The factory is not generation 7.");
  return planGen7FirstBuy({
    budgetWei: input.budgetWei,
    config: ctx.config,
    protocolFeeBps: ctx.protocolFeeBps,
    marketCapNativeWei: ctx.marketCapNativeWei,
  });
}

/** The creator wallet's native balance on `chainId`, or null when it cannot be read. */
export async function readEvmNativeBalance(chainId: number, account: string): Promise<bigint | null> {
  if (!ethers.isAddress(account)) return null;
  try {
    return BigInt(await getReadProvider(chainId as any).getBalance(account));
  } catch {
    return null;
  }
}

/**
 * Before the wallet opens on a gen-7 launch: the first buy's value (quote + slack) plus the gas reserve
 * must fit in the balance. Throws the same sentence the page shows; a failed balance read does not block.
 */
export async function assertEvmGen7LaunchBalance(input: { chainId: number; account: string; valueWei: bigint }) {
  if (input.valueWei <= 0n) return;
  const balance = await readEvmNativeBalance(input.chainId, input.account);
  if (balance == null) return;
  const isRobinhood = isRobinhoodChainId(input.chainId);
  const reserve = evmLaunchGasReserveWei(isRobinhood);
  if (input.valueWei + reserve > balance) {
    throw new Error(
      evmLaunchBalanceMessage(gen7MaxFirstBuyBudget({ balanceWei: balance, gasReserveWei: reserve }), getNativeSymbol(input.chainId as any), isRobinhood),
    );
  }
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
  generation = 6,
  account = "",
  onBlockedChange,
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
  /** 7 for a generation-7 factory (EVM_GEN7_V2_PLAN.md); everything below is unchanged for 6. */
  generation?: 6 | 7;
  /** Gen-7 only: the creator wallet, for the balance line and MAX. */
  account?: string;
  /** Gen-7 only: true while the first buy is over the 70% cap or above what the wallet can pay. */
  onBlockedChange?: (blocked: boolean) => void;
}) {
  if (generation === 7) {
    return (
      <EvmGen7LaunchOptions
        chainId={chainId}
        factoryAddress={factoryAddress}
        graduationTarget={graduationTarget}
        feeChoice={feeChoice}
        onFeeChoiceChange={onFeeChoiceChange}
        sharePct={sharePct}
        onSharePctChange={onSharePctChange}
        firstBuyInput={firstBuyInput}
        onFirstBuyInputChange={onFirstBuyInputChange}
        onPlanChange={onPlanChange}
        initialFirstBuyTokens={initialFirstBuyTokens}
        account={account}
        onBlockedChange={onBlockedChange}
      />
    );
  }
  return (
    <EvmGen6LaunchOptionsBody
      chainId={chainId}
      factoryAddress={factoryAddress}
      graduationTarget={graduationTarget}
      feeChoice={feeChoice}
      onFeeChoiceChange={onFeeChoiceChange}
      sharePct={sharePct}
      onSharePctChange={onSharePctChange}
      firstBuyInput={firstBuyInput}
      onFirstBuyInputChange={onFirstBuyInputChange}
      onPlanChange={onPlanChange}
      initialFirstBuyTokens={initialFirstBuyTokens}
    />
  );
}

type LaunchOptionsProps = {
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
  initialFirstBuyTokens?: bigint;
};

/** The generation-6 body, exactly as it was before gen-7 existed. */
function EvmGen6LaunchOptionsBody({
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
}: LaunchOptionsProps) {
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

/**
 * Generation 7: the same controls and words as the Solana DBC create page. The first buy may be up to
 * 70% of the supply with no cost cap; MAX takes the smaller of that and what the wallet can pay after
 * the gas reserve; the launch fee starts at 90%.
 */
function EvmGen7LaunchOptions({
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
  account = "",
  onBlockedChange,
}: LaunchOptionsProps & { account?: string; onBlockedChange?: (blocked: boolean) => void }) {
  const symbol = getNativeSymbol(chainId);
  const isRobinhood = isRobinhoodChainId(chainId);
  const gasReserveWei = evmLaunchGasReserveWei(isRobinhood);
  const [ctx, setCtx] = useState<Gen7FactoryContext | null>(null);
  const [ctxError, setCtxError] = useState<string | null>(null);
  const [balanceWei, setBalanceWei] = useState<bigint | null>(null);
  const [maxPending, setMaxPending] = useState(false);
  const targetAllowed = Boolean(isGen7TargetAllowed(chainId, graduationTarget));

  useEffect(() => {
    let cancelled = false;
    setCtx(null);
    setCtxError(null);
    // The page switches to a gen-7 tier once it knows the factory; until then there is nothing to price.
    if (!factoryAddress || graduationTarget <= 0n || !targetAllowed) return;
    void readEvmCreateContext(getReadProvider(chainId as any), factoryAddress, graduationTarget)
      .then((next) => {
        if (cancelled) return;
        if (next.generation === 7) setCtx(next);
        else setCtxError("The factory is not generation 7.");
      })
      .catch((error) => {
        if (!cancelled) setCtxError(String(error?.shortMessage || error?.message || "The price feed did not answer."));
      });
    return () => {
      cancelled = true;
    };
  }, [chainId, factoryAddress, graduationTarget, targetAllowed]);

  useEffect(() => {
    let cancelled = false;
    setBalanceWei(null);
    if (!account) return;
    void readEvmNativeBalance(chainId, account).then((next) => {
      if (!cancelled) setBalanceWei(next);
    });
    return () => {
      cancelled = true;
    };
  }, [chainId, account]);

  useEffect(() => {
    if (!ctx || initialFirstBuyTokens <= 0n || firstBuyInput) return;
    try {
      const curve = gen7CurveFromConfig({ ...ctx.config, marketCapNativeWei: ctx.marketCapNativeWei });
      const { total } = quoteGen7FirstBuy({
        tokens: initialFirstBuyTokens,
        virtualNative: curve.virtualNative,
        virtualToken: curve.virtualToken,
        protocolFeeBps: ctx.protocolFeeBps,
      });
      if (total > 0n) onFirstBuyInputChange(ethers.formatEther(total));
    } catch {
      // a saved amount beyond the curve stays empty; the creator types a new one
    }
    // Only when the saved amount or the curve arrives; typing afterwards is the creator's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, initialFirstBuyTokens]);

  const budgetWei = parseNativeInput(firstBuyInput);
  const plan = useMemo(() => {
    if (!ctx) return null;
    try {
      return planGen7FirstBuy({ budgetWei, config: ctx.config, protocolFeeBps: ctx.protocolFeeBps, marketCapNativeWei: ctx.marketCapNativeWei });
    } catch {
      return null;
    }
  }, [ctx, budgetWei]);

  useEffect(() => {
    onPlanChange?.(plan);
  }, [plan, onPlanChange]);

  const overBalance = Boolean(
    plan && plan.tokens > 0n && gen7FirstBuyOverBalance({ totalWei: plan.total, balanceWei, gasReserveWei }),
  );
  const blocked = Boolean(plan?.exceedsCap) || overBalance;
  useEffect(() => {
    onBlockedChange?.(blocked);
  }, [blocked, onBlockedChange]);
  useEffect(() => () => onBlockedChange?.(false), [onBlockedChange]);

  const maxByBalance = balanceWei != null ? gen7MaxFirstBuyBudget({ balanceWei, gasReserveWei }) : null;

  // MAX: the smaller of the 70% cap's cost and what the wallet can pay after the gas reserve and slack.
  const fillMax = async () => {
    if (!plan) return;
    setMaxPending(true);
    try {
      const balance = account ? await readEvmNativeBalance(chainId, account) : null;
      if (balance != null) setBalanceWei(balance);
      let max: bigint = plan.maxTotalWei;
      if (balance != null) {
        const fits = gen7MaxFirstBuyBudget({ balanceWei: balance, gasReserveWei });
        if (fits < max) max = fits;
      }
      if (max <= 0n) {
        toast.error(evmLaunchBalanceMessage(0n, symbol, isRobinhood));
        return;
      }
      // Rounded down to 6 decimals so the field stays readable and never above what fits.
      const step = 10n ** 12n;
      const shown = max > step ? max - (max % step) : max;
      onFirstBuyInputChange(ethers.formatEther(shown));
    } catch {
      toast.error("Could not read your balance. Try again.");
    } finally {
      setMaxPending(false);
    }
  };

  const feePct = ctx ? (Number(ctx.protocolFeeBps) / 100).toFixed(0) : "2";
  const slackPct = Number(EVM_GEN7_FIRST_BUY_SLACK_BPS) / 100;

  return (
    <div className="space-y-3 rounded-xl border border-border/50 bg-background/25 p-3" data-testid="evm-gen7-launch-options">
      <CreatorFeeChoicePicker value={feeChoice} onChange={onFeeChoiceChange} sharePct={sharePct} onSharePctChange={onSharePctChange} />
      <div>
        <div className="font-retro text-sm text-foreground">Your first buy (optional)</div>
        <p className="mt-0.5 text-xs text-muted-foreground">Buys in the same transaction as the launch, at the normal {feePct}% fee. The tokens go to your wallet unlocked.</p>
        <div className="mt-2 flex items-center gap-2">
          <Input
            type="number"
            min={0}
            step="0.001"
            value={firstBuyInput}
            onChange={(e) => onFirstBuyInputChange(e.target.value)}
            placeholder={`${symbol} amount`}
            className="max-w-[12rem]"
            data-testid="evm-first-buy-input"
          />
          <Button type="button" variant="outline" size="sm" disabled={maxPending || !plan} onClick={() => void fillMax()}>
            {maxPending ? "…" : "MAX"}
          </Button>
        </div>
        {overBalance && maxByBalance != null ? (
          <p className="mt-1 text-xs text-orange-300">{evmLaunchBalanceMessage(maxByBalance, symbol, isRobinhood)}</p>
        ) : balanceWei != null ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Balance {formatNative(balanceWei, symbol)}. About {formatNative(gasReserveWei, symbol)} stays in your wallet for gas.
          </p>
        ) : null}
        {plan && budgetWei > 0n ? (
          <p className={cn("mt-1 text-xs", plan.exceedsCap ? "text-orange-300" : "text-muted-foreground")}>
            About {(plan.supplyBps / 100).toFixed(2)}% of supply for {formatNative(plan.total, symbol)}, including the {feePct}% fee
            {plan.exceedsCap ? ". That is over the cap: lower the amount." : "."}
          </p>
        ) : null}
        {plan && plan.tokens > 0n ? (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Your wallet sends up to {slackPct}% more in case the price moves before the launch. The unused part comes back in the same transaction.
          </p>
        ) : null}
        {plan ? (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Most you can buy now: {formatNative(plan.maxTotalWei, symbol)}, which is 70% of the supply.
          </p>
        ) : null}
        {ctxError ? <p className="mt-1 text-[11px] text-orange-300">First-buy pricing is unavailable: {ctxError}</p> : null}
      </div>
      <p className="text-xs text-muted-foreground">{GEN7_LAUNCH_FEE_NOTE}</p>
    </div>
  );
}
