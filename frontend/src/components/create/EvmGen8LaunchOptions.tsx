import { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { getNativeSymbol, isDogeosChainId, isRobinhoodChainId } from "@/lib/chainConfig";
import { getReadProvider } from "@/lib/readProvider";
import { GEN7_LAUNCH_FEE_NOTE } from "../../../shared/evmGen7Curve.mjs";
import { gen8FirstBuyPlan, gen8MaxFirstBuyByBalance, gen8MaxFirstBuyValue, readGen8LaunchPlan } from "@/lib/evmGen8Client.mjs";
import { DOGE_BUY_GAS_RESERVE_WEI, evmLaunchBalanceMessage, evmLaunchGasReserveWei } from "@/lib/tradeBalanceReserve";
import { CreatorFeeChoicePicker, type CreatorFeeChoice } from "@/components/create/CreatorFeeChoicePicker";
import { parseNativeInput, readEvmNativeBalance } from "@/components/create/EvmGen6LaunchOptions";

/** launcher.plan(target). A Barkswap plan (DogeOS) also carries liqA / liqB and venue "barkswap" (its first-buy estimate needs liqA). */
export type Gen8LaunchPlan = { marketCapNative: bigint; virtualNative: bigint; virtualToken: bigint; tickStart: number; tickGrad: number; venue?: string; liqA?: bigint; liqB?: bigint };

function formatNative(wei: bigint, symbol: string) {
  const n = Number(ethers.formatEther(wei));
  if (!Number.isFinite(n)) return `${wei.toString()} wei`;
  const digits = n >= 1 ? 4 : 6;
  return `${n.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "")} ${symbol}`;
}

/**
 * The launch's gas reserve. DogeOS: ten times the foundation's DOGE buy reserve (the BNB and Robinhood launch reserves are
 * ten times their buy reserves too); a Bark launch is ~6.3M gas plus an L1 data fee in DOGE. Other chains unchanged.
 */
export function gen8LaunchGasReserveWei(chainId: number): bigint {
  if (isDogeosChainId(chainId)) return DOGE_BUY_GAS_RESERVE_WEI * 10n;
  return evmLaunchGasReserveWei(isRobinhoodChainId(chainId));
}

function formatReserve(wei: bigint) {
  const n = Math.floor((Number(wei) / 1e18) * 10_000) / 10_000;
  return n.toFixed(4).replace(/\.?0+$/, "") || "0";
}

/** evmLaunchBalanceMessage with the chain's own reserve (DogeOS names its DOGE reserve; other chains unchanged). */
export function gen8LaunchBalanceMessage(maxFirstBuyWei: bigint, chainId: number): string {
  const symbol = getNativeSymbol(chainId as any);
  if (!isDogeosChainId(chainId)) return evmLaunchBalanceMessage(maxFirstBuyWei, symbol, isRobinhoodChainId(chainId));
  const reserve = formatReserve(gen8LaunchGasReserveWei(chainId));
  if (maxFirstBuyWei <= 0n) return `Not enough ${symbol}. A launch needs about ${reserve} ${symbol} for gas.`;
  return `Not enough ${symbol}. A launch keeps about ${reserve} ${symbol} for gas. Your first buy can be up to ${formatReserve(maxFirstBuyWei)} ${symbol}.`;
}

/** Before the wallet opens on a gen-8 launch: the first buy plus the gas reserve must fit in the balance. */
export async function assertEvmGen8LaunchBalance(input: { chainId: number; account: string; valueWei: bigint }) {
  if (input.valueWei <= 0n) return;
  const balance = await readEvmNativeBalance(input.chainId, input.account);
  if (balance == null) return;
  const reserve = gen8LaunchGasReserveWei(input.chainId);
  if (input.valueWei + reserve > balance) {
    throw new Error(gen8LaunchBalanceMessage(gen8MaxFirstBuyByBalance({ balanceWei: balance, gasReserveWei: reserve }), input.chainId));
  }
}

/** Before the wallet opens: the first buy priced again on the launcher's plan for this block; throws over the cap. */
export async function freshEvmGen8FirstBuyCheck(input: { chainId: number; launcher: string; targetUsd: bigint; valueWei: bigint }) {
  if (input.valueWei <= 0n) return null;
  const plan = await readGen8LaunchPlan({ provider: getReadProvider(input.chainId as any), launcher: input.launcher, targetUsd: input.targetUsd, chainId: input.chainId });
  const firstBuy = gen8FirstBuyPlan({ valueWei: input.valueWei, plan });
  if (firstBuy.exceedsCap) throw new Error("Your first buy is over the cap. Lower the amount or press MAX.");
  return firstBuy;
}

/**
 * Create-page options for an EVM generation 8 launcher: the same controls and words as generation 7 (fee choice,
 * first buy up to 70% of the supply with MAX, balance line with the gas reserve, the 90% launch fee note). The first
 * buy is a native amount sent with the launch; the coins it buys are the launch's own V4 swap, replayed exactly. On
 * DogeOS (Barkswap) it is the launch's own Algebra swap on the Bark launcher's plan, priced in DOGE with the DOGE gas
 * reserve.
 */
export function EvmGen8LaunchOptions({
  chainId,
  launcher,
  graduationTarget,
  feeChoice,
  onFeeChoiceChange,
  sharePct,
  onSharePctChange,
  firstBuyInput,
  onFirstBuyInputChange,
  account = "",
  onBlockedChange,
}: {
  chainId: number;
  launcher: string;
  graduationTarget: bigint;
  feeChoice: CreatorFeeChoice;
  onFeeChoiceChange: (choice: CreatorFeeChoice) => void;
  sharePct: string;
  onSharePctChange: (pct: string) => void;
  firstBuyInput: string;
  onFirstBuyInputChange: (value: string) => void;
  account?: string;
  onBlockedChange?: (blocked: boolean) => void;
}) {
  const symbol = getNativeSymbol(chainId as any);
  const gasReserveWei = gen8LaunchGasReserveWei(chainId);
  const [plan, setPlan] = useState<Gen8LaunchPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [balanceWei, setBalanceWei] = useState<bigint | null>(null);
  const [maxPending, setMaxPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPlan(null);
    setPlanError(null);
    if (!launcher || graduationTarget <= 0n) return;
    void readGen8LaunchPlan({ provider: getReadProvider(chainId as any), launcher, targetUsd: graduationTarget, chainId })
      .then((next: Gen8LaunchPlan) => {
        if (!cancelled) setPlan(next);
      })
      .catch((error: any) => {
        if (!cancelled) setPlanError(String(error?.shortMessage || error?.message || "The price feed did not answer."));
      });
    return () => {
      cancelled = true;
    };
  }, [chainId, launcher, graduationTarget]);

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

  const valueWei = parseNativeInput(firstBuyInput);
  const firstBuy = useMemo(() => (plan && valueWei > 0n ? gen8FirstBuyPlan({ valueWei, plan }) : null), [plan, valueWei]);
  const maxByCap = useMemo(() => (plan ? (gen8MaxFirstBuyValue({ plan }) as bigint) : null), [plan]);
  const overBalance = Boolean(valueWei > 0n && balanceWei != null && valueWei + gasReserveWei > balanceWei);
  const blocked = Boolean(firstBuy?.exceedsCap) || overBalance;
  useEffect(() => {
    onBlockedChange?.(blocked);
  }, [blocked, onBlockedChange]);
  useEffect(() => () => onBlockedChange?.(false), [onBlockedChange]);

  const maxByBalance = balanceWei != null ? (gen8MaxFirstBuyByBalance({ balanceWei, gasReserveWei }) as bigint) : null;

  // MAX: the smaller of what buys 70% of the supply (a hair under, so a small price move cannot revert the launch)
  // and what the wallet can pay after the gas reserve.
  const fillMax = async () => {
    if (maxByCap == null) return;
    setMaxPending(true);
    try {
      const balance = account ? await readEvmNativeBalance(chainId, account) : null;
      if (balance != null) setBalanceWei(balance);
      let max = maxByCap;
      if (balance != null) {
        const fits = gen8MaxFirstBuyByBalance({ balanceWei: balance, gasReserveWei }) as bigint;
        if (fits < max) max = fits;
      }
      if (max <= 0n) {
        toast.error(gen8LaunchBalanceMessage(0n, chainId));
        return;
      }
      const step = 10n ** 12n;
      const shown = max > step ? max - (max % step) : max;
      onFirstBuyInputChange(ethers.formatEther(shown));
    } catch {
      toast.error("Could not read your balance. Try again.");
    } finally {
      setMaxPending(false);
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-border/50 bg-background/25 p-3" data-testid="evm-gen8-launch-options">
      <CreatorFeeChoicePicker value={feeChoice} onChange={onFeeChoiceChange} sharePct={sharePct} onSharePctChange={onSharePctChange} />
      <div>
        <div className="font-retro text-sm text-foreground">Your first buy (optional)</div>
        <p className="mt-0.5 text-xs text-muted-foreground">Buys in the same transaction as the launch, at the normal 2% fee. The tokens go to your wallet unlocked.</p>
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
          <Button type="button" variant="outline" size="sm" disabled={maxPending || maxByCap == null} onClick={() => void fillMax()}>
            {maxPending ? "…" : "MAX"}
          </Button>
        </div>
        {overBalance && maxByBalance != null ? (
          <p className="mt-1 text-xs text-orange-300">{gen8LaunchBalanceMessage(maxByBalance, chainId)}</p>
        ) : balanceWei != null ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Balance {formatNative(balanceWei, symbol)}. About {formatNative(gasReserveWei, symbol)} stays in your wallet for gas.
          </p>
        ) : null}
        {firstBuy ? (
          <p className={cn("mt-1 text-xs", firstBuy.exceedsCap ? "text-orange-300" : "text-muted-foreground")}>
            About {(firstBuy.supplyBps / 100).toFixed(2)}% of supply for {formatNative(firstBuy.valueWei, symbol)}, including the 2% fee
            {firstBuy.exceedsCap ? ". That is over the cap: lower the amount." : "."}
          </p>
        ) : null}
        {maxByCap != null ? (
          <p className="mt-1 text-[11px] text-muted-foreground">Most you can buy now: {formatNative(maxByCap, symbol)}, which is about 70% of the supply.</p>
        ) : null}
        {planError ? <p className="mt-1 text-[11px] text-orange-300">First-buy pricing is unavailable: {planError}</p> : null}
      </div>
      <p className="text-xs text-muted-foreground">{GEN7_LAUNCH_FEE_NOTE}</p>
    </div>
  );
}
