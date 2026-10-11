import { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cp } from "@/components/token/coinPageStyles";
import { useWallet } from "@/contexts/WalletContext";
import { getNativeSymbol, isRobinhoodChainId, type SupportedChainId } from "@/lib/chainConfig";
import { getReadProvider } from "@/lib/readProvider";
import { evmBuyGasReserveWei } from "@/lib/tradeBalanceReserve";
import { DBC_CREATOR_LOCK_COPY } from "../../../shared/dbcEconomics.mjs";
import {
  GEN8_DEFAULT_SLIPPAGE_BPS,
  assertGen8HookMatches,
  executeGen8EscrowBuy,
  executeGen8Trade,
  gen8AntiSniperCountdown,
  gen8AppConfig,
  gen8ErrorMessage,
  gen8FeeLine,
  quoteGen8Trade,
} from "@/lib/evmGen8Client.mjs";
import { useNowSeconds, type Gen8CoinState } from "@/hooks/useGen8Coin";

type Quote = {
  side: "buy" | "sell";
  amountIn: bigint;
  amountOut: bigint;
  minOut: bigint;
  feeBps: number;
  feeWei: bigint;
  curveWei: bigint;
  creatorShareWei: bigint;
  graduated: boolean;
};

const ERC20_BALANCE = ["function balanceOf(address) view returns (uint256)"];

function parseUnitsSafe(text: string, decimals: number): bigint | null {
  const v = String(text || "").trim().replace(",", ".");
  if (!v || !(Number(v) > 0)) return null;
  try {
    const raw = ethers.parseUnits(v, decimals);
    return raw > 0n ? raw : null;
  } catch {
    return null;
  }
}

const fmt = (raw: bigint | string, digits: number) => Number(ethers.formatUnits(raw, 18)).toLocaleString(undefined, { maximumFractionDigits: digits });

/**
 * The trade box for an EVM generation 8 coin, before and after graduation (design 6.2): one Uniswap V4 pool, quoted
 * with Uniswap's V4Quoter and executed through the chain's UniversalRouter. No trade signature from our API. The fee
 * line and the 60 s launch-fee countdown come from the API's tradeFee; the creator's own buys go through the escrow
 * (D5) and are held on the gen-7 schedule.
 */
export function Gen8TradePanel({
  chainId,
  state,
  symbol,
  initialSide = "buy",
  onTraded,
}: {
  chainId: number;
  state: Gen8CoinState;
  symbol: string;
  initialSide?: "buy" | "sell";
  onTraded?: (trade: { side: "buy" | "sell"; txHash: string | null }) => void;
}) {
  const wallet = useWallet();
  const native = getNativeSymbol(chainId as SupportedChainId);
  const robinhood = isRobinhoodChainId(chainId);
  const cfg = useMemo(() => gen8AppConfig(chainId), [chainId]);
  const setupError = useMemo(() => {
    try {
      assertGen8HookMatches(cfg, state.gen8?.hook);
      if (!cfg?.router || !cfg?.quoter) return "Trading for this coin is not set up on this chain yet.";
      return null;
    } catch (error) {
      return String((error as Error)?.message || "Trading for this coin is not set up in this app yet.");
    }
  }, [cfg, state.gen8?.hook]);
  const token = state.token;
  const account = wallet.account ? String(wallet.account) : null;
  const viewerIsCreator = Boolean(account && state.creator && account.toLowerCase() === String(state.creator).toLowerCase());
  const escrowBuy = viewerIsCreator && Boolean(cfg?.escrow);
  const [side, setSide] = useState<"buy" | "sell">(initialSide);
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [balances, setBalances] = useState<{ nativeRaw: bigint; tokenRaw: bigint } | null>(null);
  const [balanceTick, setBalanceTick] = useState(0);
  const graduated = state.graduation?.phase === "graduated";
  const now = useNowSeconds(!graduated && Math.floor(Date.now() / 1000) < Number(state.tradeFee?.antiSniperEndsAt || 0) + 1);
  const countdown = graduated ? null : gen8AntiSniperCountdown(state.tradeFee, now);

  const readProvider = useMemo(() => {
    try {
      return getReadProvider(chainId as SupportedChainId);
    } catch {
      return null;
    }
  }, [chainId]);

  useEffect(() => {
    if (!account || !readProvider) {
      setBalances(null);
      return;
    }
    let cancelled = false;
    void Promise.all([readProvider.getBalance(account), new ethers.Contract(token, ERC20_BALANCE, readProvider).balanceOf(account)])
      .then(([n, t]) => {
        if (!cancelled) setBalances({ nativeRaw: BigInt(n), tokenRaw: BigInt(t) });
      })
      .catch(() => {
        if (!cancelled) setBalances(null);
      });
    return () => {
      cancelled = true;
    };
  }, [account, readProvider, token, balanceTick]);

  const amountRaw = parseUnitsSafe(amount, 18);

  // Live quote (exact input): what you receive, the minimum at 1% slippage, the fee and the creator's part.
  useEffect(() => {
    setQuoteError(null);
    if (setupError || !amountRaw || !readProvider || !cfg) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      quoteGen8Trade({ provider: readProvider, cfg, token, side, amountIn: amountRaw, slippageBps: GEN8_DEFAULT_SLIPPAGE_BPS, sender: side === "buy" && escrowBuy ? cfg.escrow : null })
        .then((q: Quote) => {
          if (!cancelled) setQuote(q);
        })
        .catch((error: any) => {
          if (cancelled) return;
          setQuote(null);
          setQuoteError(gen8ErrorMessage(error) || "No quote for this amount.");
        });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupError, amount, side, token, readProvider, cfg, escrowBuy, state.graduation?.phase]);

  const gasReserve = evmBuyGasReserveWei(robinhood);
  const overBalance = Boolean(
    balances && amountRaw && (side === "buy" ? amountRaw + gasReserve > balances.nativeRaw : amountRaw > balances.tokenRaw),
  );

  async function trade() {
    if (!amountRaw) {
      toast.error("Enter an amount.");
      return;
    }
    if (!cfg || setupError) {
      toast.error(setupError || "Trading for this coin is not set up on this chain yet.");
      return;
    }
    if (overBalance) {
      toast.error(side === "buy" ? `Not enough ${native}. Keep about ${ethers.formatEther(gasReserve)} ${native} for gas.` : "Amount is above your balance.");
      return;
    }
    setBusy(true);
    try {
      if (!wallet.signer || !wallet.account) throw new Error(`Connect the ${native} wallet first.`);
      let signer = wallet.signer as any;
      if (Number(wallet.chainId) !== Number(chainId)) {
        const switched = await wallet.switchToChain(chainId as SupportedChainId);
        if (Number(switched?.chainId) !== Number(chainId) || !switched?.signer) throw new Error("The wallet did not switch chains.");
        signer = switched.signer;
      }
      const result =
        side === "buy" && escrowBuy
          ? await executeGen8EscrowBuy({ signer, chainId, cfg, token, amountIn: amountRaw, readProvider })
          : await executeGen8Trade({ signer, chainId, cfg, token, side, amountIn: amountRaw, readProvider });
      toast.success(`${side === "buy" ? "Buy" : "Sell"} confirmed: ${String(result.receipt?.hash || "").slice(0, 10)}…`);
      setAmount("");
      setQuote(null);
      setBalanceTick((n) => n + 1);
      onTraded?.({ side, txHash: result.receipt?.hash ?? null });
    } catch (error) {
      toast.error(gen8ErrorMessage(error) || String((error as Error)?.message || "Trade failed."));
    } finally {
      setBusy(false);
    }
  }

  if (setupError) {
    return (
      <p className="text-sm text-muted-foreground" data-gen8-trade-unavailable="true">
        {setupError}
      </p>
    );
  }

  const unit = side === "buy" ? native : symbol || "token";
  const row = "flex items-center justify-between gap-2";
  const feeBps = quote?.feeBps ?? countdown?.bps ?? state.tradeFee?.currentBps ?? (graduated ? 100 : 200);
  return (
    <div className="flex flex-col gap-3.5 font-mw-body text-mw-text" data-gen8-trade-panel={graduated ? "graduated" : "bonding"}>
      <div className={cp.segList} role="tablist" aria-label="Buy or sell">
        <button type="button" role="tab" aria-selected={side === "buy"} data-state={side === "buy" ? "active" : "inactive"} className={cp.segBuy} onClick={() => { setSide("buy"); setAmount(""); }}>
          Buy
        </button>
        <button type="button" role="tab" aria-selected={side === "sell"} data-state={side === "sell" ? "active" : "inactive"} className={cp.segSell} onClick={() => { setSide("sell"); setAmount(""); }}>
          Sell
        </button>
      </div>
      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-xs text-mw-muted">Uniswap pool{graduated ? ", graduated" : ""}</span>
          <div className="flex items-center gap-2">
            {side === "sell" && balances && balances.tokenRaw > 0n ? (
              <Button type="button" variant="ghost" size="sm" className={cp.smallButton} onClick={() => setAmount(ethers.formatUnits(balances.tokenRaw, 18))}>
                MAX
              </Button>
            ) : null}
            <span className="whitespace-nowrap text-xs text-mw-muted">Slippage: {GEN8_DEFAULT_SLIPPAGE_BPS / 100}%</span>
          </div>
        </div>
        <div className="relative">
          <input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" aria-label={`Amount (${unit})`} className={cp.amountInput} placeholder="0" />
          <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 font-mw-mono text-sm text-mw-muted">{unit}</span>
        </div>
        <div className={`${cp.inset} mt-3 flex flex-col gap-1.5 p-3 text-sm`} data-gen8-quote={quote ? "true" : undefined}>
          <div className={row}>
            <span className="text-mw-muted">Balance</span>
            <span className="font-mw-mono text-mw-text">{balances ? (side === "buy" ? `${fmt(balances.nativeRaw, 6)} ${native}` : `${fmt(balances.tokenRaw, 2)} ${symbol || "tokens"}`) : "—"}</span>
          </div>
          <div className={row}>
            <span className="text-mw-muted">Receive</span>
            <span className="font-mw-mono font-bold text-mw-text">{quote ? (side === "buy" ? `${fmt(quote.amountOut, 4)} ${symbol || "tokens"}` : `${fmt(quote.amountOut, 8)} ${native}`) : "—"}</span>
          </div>
          <div className={row}>
            <span className="text-mw-muted">At least</span>
            <span className="font-mw-mono text-mw-muted">{quote ? (side === "buy" ? `${fmt(quote.minOut, 4)} ${symbol || "tokens"}` : `${fmt(quote.minOut, 8)} ${native}`) : "—"}</span>
          </div>
          <div className={row}>
            <span className="text-mw-muted">Fee {(feeBps / 100).toFixed(feeBps % 100 ? 2 : 0)}%</span>
            <span className="font-mw-mono text-mw-muted">{quote ? `${fmt(quote.feeWei, 8)} ${native}` : "—"}</span>
          </div>
          {quote && quote.creatorShareWei > 0n ? (
            <div className={row}>
              <span className="text-mw-muted">Of which to the coin&apos;s creator</span>
              <span className="font-mw-mono text-mw-muted">{fmt(quote.creatorShareWei, 8)} {native}</span>
            </div>
          ) : null}
        </div>
        {countdown ? (
          <p className="mt-2 text-center text-xs text-[#FF9A4D]" data-gen8-launch-fee="true">
            {countdown.line}
          </p>
        ) : null}
        <p className="mt-2 text-center text-[11px] text-mw-muted">{gen8FeeLine({ graduated, feeBps: graduated ? state.tradeFee?.postGraduationBps ?? 100 : state.tradeFee?.bondingBps ?? 200 })}</p>
        {side === "buy" && escrowBuy ? <p className="mt-1 text-center text-xs text-orange-200">{DBC_CREATOR_LOCK_COPY}</p> : null}
        {quoteError && !quote ? <p className="mt-2 text-center text-xs text-mw-down">{quoteError}</p> : null}
        {overBalance ? <p className="mt-2 text-center text-xs text-mw-down">{side === "buy" ? `Not enough ${native} (about ${ethers.formatEther(gasReserve)} ${native} stays for gas).` : "Amount is above your balance."}</p> : null}
      </div>
      <Button
        className={`min-h-12 w-full rounded-[10px] font-mw-body text-base font-bold disabled:opacity-50 ${side === "buy" ? "border border-mw-buy bg-mw-buy text-[#04140A] hover:bg-[#15913F]" : "border border-mw-sell bg-mw-sell text-[#FFF1F3] hover:bg-[#C81A40]"}`}
        disabled={account ? busy || !amountRaw || !quote || overBalance : false}
        onClick={() => {
          if (!account) {
            try {
              window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal"));
            } catch {
              /* ignore */
            }
            return;
          }
          void trade();
        }}
      >
        {!account ? `Connect ${robinhood ? "Robinhood" : "BNB"} wallet` : busy ? (side === "sell" ? "Approve and sign in your wallet..." : "Confirm in your wallet...") : `${side === "buy" ? "Buy" : "Sell"} ${symbol ? `$${symbol}` : ""}`.trim()}
      </Button>
    </div>
  );
}
