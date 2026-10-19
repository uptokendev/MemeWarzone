import { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cp } from "@/components/token/coinPageStyles";
import { useWallet } from "@/contexts/WalletContext";
import { getNativeSymbol, isRobinhoodChainId, type SupportedChainId } from "@/lib/chainConfig";
import { getReadProvider } from "@/lib/readProvider";
import { evmBuyGasReserveWei } from "@/lib/tradeBalanceReserve";
import { GEN8_CREATOR_BUY_ESCROW_COPY } from "../../../shared/gen8EscrowSchedule.mjs";
import {
  GEN8_AUTO_SLIPPAGE,
  GEN8_DEFAULT_SLIPPAGE_BPS,
  assertGen8HookMatches,
  executeGen8EscrowBuy,
  executeGen8Trade,
  GEN8_FIRST_SELL_NOTE,
  GEN8_WAITING_CONFIRMATION,
  gen8AntiSniperCountdown,
  gen8AppConfig,
  gen8ErrorMessage,
  gen8FeeLine,
  gen8MaxSellable,
  gen8StepLabel,
  gen8TradingOpensLine,
  quoteGen8Trade,
  readGen8SellSetup,
} from "@/lib/evmGen8Client.mjs";
import { gen8FormatAmount, gen8FormatPriceImpact, gen8UsesSizedSlippage } from "../../../shared/evmGen8Swap.mjs";
import { gen8TradeGap } from "../../../shared/gen8LaunchReadiness.mjs";
import {
  BSC_PROTECTED_RPC_DEFAULT,
  addProtectedBscRpc,
  offersProtectedRpc,
  readProtectedRpcChoice,
  rememberProtectedRpcChoice,
} from "@/lib/bscProtectedRpc.mjs";
import { GEN8_COIN_POLL_MS, useNowSeconds, type Gen8CoinState } from "@/hooks/useGen8Coin";
import { notifyIndexerFills } from "@/lib/indexerTradeIngest";
import { setVisibleInterval } from "@/lib/visibleInterval.mjs";

type Quote = {
  side: "buy" | "sell";
  amountIn: bigint;
  amountOut: bigint;
  minOut: bigint;
  slippageBps: number;
  slippageAuto: boolean;
  priceImpactBps: number | null;
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

/** Slippage choices on BNB Chain (the sized default first); Robinhood keeps its flat 1% (F13). */
const BNB_SLIPPAGE_CHOICES: Array<typeof GEN8_AUTO_SLIPPAGE | number> = [GEN8_AUTO_SLIPPAGE, 50, 100, 300];
/** Price impact from which the panel shows it in red. */
const HIGH_IMPACT_BPS = 1000;

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
    const gap = () => gen8TradeGap(chainId, import.meta.env, { vite: true });
    if (!cfg?.hook) return gap().message || "Trading for this coin is not set up in this app yet.";
    try {
      assertGen8HookMatches(cfg, state.gen8?.hook);
      if (!cfg.router || !cfg.quoter) return gap().message || "Trading for this coin is not set up on this chain yet.";
      return null;
    } catch (error) {
      return String((error as Error)?.message || "Trading for this coin is not set up in this app yet.");
    }
  }, [cfg, chainId, state.gen8?.hook]);
  const token = state.token;
  const account = wallet.account ? String(wallet.account) : null;
  const viewerIsCreator = Boolean(account && state.creator && account.toLowerCase() === String(state.creator).toLowerCase());
  const escrowBuy = viewerIsCreator && Boolean(cfg?.escrow);
  const [side, setSide] = useState<"buy" | "sell">(initialSide);
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<{ index: number; total: number; kind: string; phase: "sign" | "pending" } | null>(null);
  const [twoApprovals, setTwoApprovals] = useState(false);
  const sizedSlippage = gen8UsesSizedSlippage(chainId);
  const [slippageChoice, setSlippageChoice] = useState<typeof GEN8_AUTO_SLIPPAGE | number>(sizedSlippage ? GEN8_AUTO_SLIPPAGE : GEN8_DEFAULT_SLIPPAGE_BPS);
  const slippageArg = sizedSlippage ? slippageChoice : GEN8_DEFAULT_SLIPPAGE_BPS;
  const showRpcOffer = offersProtectedRpc(chainId);
  const [rpcChoice, setRpcChoice] = useState(() => (showRpcOffer ? readProtectedRpcChoice() : null));
  const [rpcBusy, setRpcBusy] = useState(false);
  const [balances, setBalances] = useState<{ nativeRaw: bigint; tokenRaw: bigint } | null>(null);
  const [balanceTick, setBalanceTick] = useState(0);
  const spotKey = state.market?.sqrtPriceX96 ?? "";
  const [maxSellable, setMaxSellable] = useState<bigint | null>(null);
  const graduated = (state.platformStatus || state.graduation?.phase) === "graduated";
  const openAt = Number(state.openAt ?? state.tradeFee?.openAt ?? state.tradeFee?.launchAt ?? 0);
  const clockNeeded = !graduated || openAt > Math.floor(Date.now() / 1000);
  const now = useNowSeconds(clockNeeded);
  const tradingOpen = state.tradingOpen ?? now >= openAt;
  const opensLine = tradingOpen ? null : gen8TradingOpensLine(openAt, now);
  const countdown = graduated || !tradingOpen ? null : gen8AntiSniperCountdown(state.tradeFee, now);

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
  }, [account, readProvider, token, balanceTick, spotKey]);

  useEffect(() => {
    if (!readProvider || !cfg || !state.gen8?.poolId || state.gen8.tickStart == null) {
      setMaxSellable(null);
      return;
    }
    let cancelled = false;
    void gen8MaxSellable({ provider: readProvider, cfg, poolId: state.gen8.poolId, tickStart: state.gen8.tickStart })
      .then((n) => {
        if (!cancelled) setMaxSellable(n);
      })
      .catch(() => {
        if (!cancelled) setMaxSellable(null);
      });
    return () => {
      cancelled = true;
    };
  }, [readProvider, cfg, state.gen8?.poolId, state.gen8?.tickStart, state.graduation?.phase, balanceTick, spotKey]);

  const amountRaw = parseUnitsSafe(amount, 18);
  const overSellCap = Boolean(side === "sell" && amountRaw && maxSellable != null && amountRaw > maxSellable);

  // Before the first prompt: a first sell of this coin still needs both one-time approvals.
  // Read once per quoted amount. The sell itself does not read the allowance again between transactions.
  useEffect(() => {
    if (side !== "sell" || !account || !readProvider || !cfg?.router || !amountRaw || !tradingOpen) {
      setTwoApprovals(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      readGen8SellSetup({ provider: readProvider, owner: account, token, amountIn: amountRaw, router: cfg.router.address })
        .then((setup) => {
          if (!cancelled) setTwoApprovals(Boolean(setup?.approval && setup?.permit2Approval));
        })
        .catch(() => {
          if (!cancelled) setTwoApprovals(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [side, account, readProvider, cfg, amountRaw, token, tradingOpen, spotKey]);

  // Live quote (exact input): what you receive, the price impact, the minimum at the slippage (sized from the impact on
  // BNB Chain, 1% on Robinhood), the fee and the creator's part.
  useEffect(() => {
    setQuoteError(null);
    if (setupError || !amountRaw || !readProvider || !cfg || !tradingOpen || overSellCap) {
      setQuote(null);
      if (!tradingOpen) setQuoteError(null);
      else if (overSellCap) setQuoteError("This sell is larger than the bonding range can take back. Sell a smaller amount.");
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      quoteGen8Trade({ provider: readProvider, cfg, token, side, amountIn: amountRaw, slippageBps: slippageArg, sender: side === "buy" && escrowBuy ? cfg.escrow : null })
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
  }, [setupError, amount, side, token, readProvider, cfg, escrowBuy, state.graduation?.phase, slippageArg, tradingOpen, overSellCap, spotKey]);

  // Safety read of the wallet balance and the sell cap. A new pool price refreshes them through spotKey.
  useEffect(() => setVisibleInterval(() => setBalanceTick((n) => n + 1), GEN8_COIN_POLL_MS), []);

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
    if (!tradingOpen) {
      toast.error(opensLine?.line || "Trading on this coin has not opened yet.");
      return;
    }
    if (overSellCap) {
      toast.error("This sell is larger than the bonding range can take back. Sell a smaller amount.");
      return;
    }
    if (overBalance) {
      toast.error(side === "buy" ? `Not enough ${native}. Keep about ${ethers.formatEther(gasReserve)} ${native} for gas.` : "Amount is above your balance.");
      return;
    }
    setBusy(true);
    setStep(null);
    try {
      if (!wallet.signer || !wallet.account) throw new Error(`Connect the ${native} wallet first.`);
      let signer = wallet.signer as any;
      if (Number(wallet.chainId) !== Number(chainId)) {
        const switched = await wallet.switchToChain(chainId as SupportedChainId);
        if (Number(switched?.chainId) !== Number(chainId) || !switched?.signer) throw new Error("The wallet did not switch chains.");
        signer = switched.signer;
      }
      const onStep = (next: { index: number; total: number; kind: string; phase: "sign" | "pending" }) => setStep(next);
      // Runs inside the trade, the moment the swap receipt is in, before the toast.
      const onReceipt = (receipt: { hash?: string } | null) => {
        const txHash = receipt?.hash ?? null;
        // The token is the gen-8 campaign. This post wakes the indexer; the approval transactions are not this hash.
        if (txHash) notifyIndexerFills({ chainId, campaignAddress: token, txHashes: [txHash] });
        if (!txHash || typeof window === "undefined") return;
        window.dispatchEvent(new CustomEvent("memewarzone:txConfirmed", {
          detail: { kind: side, campaignAddress: token, chainId, txHash },
        }));
      };
      const result =
        side === "buy" && escrowBuy
          ? await executeGen8EscrowBuy({ signer, chainId, cfg, token, amountIn: amountRaw, slippageBps: slippageArg, readProvider, onReceipt })
          : await executeGen8Trade({ signer, chainId, cfg, token, side, amountIn: amountRaw, slippageBps: slippageArg, readProvider, onStep, onReceipt });
      const txHash = result.receipt?.hash ?? null;
      toast.success(`${side === "buy" ? "Buy" : "Sell"} confirmed: ${String(result.receipt?.hash || "").slice(0, 10)}…`);
      setAmount("");
      setQuote(null);
      setBalanceTick((n) => n + 1);
      onTraded?.({ side, txHash });
    } catch (error) {
      toast.error(gen8ErrorMessage(error) || String((error as Error)?.message || "Trade failed."));
    } finally {
      setBusy(false);
      setStep(null);
    }
  }

  async function addProtectedRpc() {
    const eip1193 = (wallet.provider as any) || (typeof window !== "undefined" ? (window as any).ethereum : null);
    if (!eip1193) {
      toast.error("Connect the BNB wallet first.");
      return;
    }
    setRpcBusy(true);
    try {
      await addProtectedBscRpc(eip1193, { rpc: BSC_PROTECTED_RPC_DEFAULT });
      setRpcChoice(readProtectedRpcChoice() || { state: "added" });
      toast.success("Your wallet accepted the request. Check that BNB Chain now uses the private RPC in your wallet's network settings.");
    } catch (error) {
      const text = String((error as Error)?.message || "");
      toast.error(/user rejected|denied/i.test(text) ? "You rejected the request in your wallet." : "Your wallet did not add the RPC. You can add it by hand in its network settings.");
    } finally {
      setRpcBusy(false);
    }
  }

  function dismissRpcOffer() {
    rememberProtectedRpcChoice("dismissed");
    setRpcChoice(readProtectedRpcChoice() || { state: "dismissed" });
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
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={cp.smallButton}
                onClick={() => {
                  const cap = maxSellable != null && maxSellable < balances.tokenRaw ? maxSellable : balances.tokenRaw;
                  setAmount(ethers.formatUnits(cap, 18));
                }}
              >
                MAX
              </Button>
            ) : null}
            {sizedSlippage ? (
              <label className="flex items-center gap-1 whitespace-nowrap text-xs text-mw-muted">
                Slippage
                <select
                  aria-label="Slippage"
                  data-gen8-slippage="true"
                  className="rounded-md border border-mw-border bg-transparent px-1 py-0.5 text-xs text-mw-text"
                  value={String(slippageChoice)}
                  onChange={(event) => setSlippageChoice(event.target.value === GEN8_AUTO_SLIPPAGE ? GEN8_AUTO_SLIPPAGE : Number(event.target.value))}
                >
                  {BNB_SLIPPAGE_CHOICES.map((choice) => (
                    <option key={String(choice)} value={String(choice)}>
                      {choice === GEN8_AUTO_SLIPPAGE ? `Auto${quote?.slippageAuto ? ` (${quote.slippageBps / 100}%)` : ""}` : `${choice / 100}%`}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <span className="whitespace-nowrap text-xs text-mw-muted">Slippage: {GEN8_DEFAULT_SLIPPAGE_BPS / 100}%</span>
            )}
          </div>
        </div>
        <div className="relative">
          <input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" aria-label={`Amount (${unit})`} className={cp.amountInput} placeholder="0" />
          <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 font-mw-mono text-sm text-mw-muted">{unit}</span>
        </div>
        <div className={`${cp.inset} mt-3 flex flex-col gap-1.5 p-3 text-sm`} data-gen8-quote={quote ? "true" : undefined}>
          <div className={row}>
            <span className="text-mw-muted">Balance</span>
            <span className="font-mw-mono text-mw-text">{balances ? (side === "buy" ? `${gen8FormatAmount(balances.nativeRaw)} ${native}` : `${gen8FormatAmount(balances.tokenRaw)} ${symbol || "tokens"}`) : "—"}</span>
          </div>
          <div className={row}>
            <span className="text-mw-muted">Receive</span>
            <span className="font-mw-mono font-bold text-mw-text">{quote ? (side === "buy" ? `${gen8FormatAmount(quote.amountOut)} ${symbol || "tokens"}` : `${gen8FormatAmount(quote.amountOut)} ${native}`) : "—"}</span>
          </div>
          <div className={row} data-gen8-price-impact={quote?.priceImpactBps ?? undefined}>
            <span className="text-mw-muted">Price impact</span>
            <span className={`font-mw-mono ${quote?.priceImpactBps != null && quote.priceImpactBps >= HIGH_IMPACT_BPS ? "text-mw-down" : "text-mw-muted"}`}>{quote ? gen8FormatPriceImpact(quote.priceImpactBps) : "—"}</span>
          </div>
          <div className={row}>
            <span className="text-mw-muted">At least{quote ? ` (${quote.slippageBps / 100}% slippage)` : ""}</span>
            <span className="font-mw-mono text-mw-muted">{quote ? (side === "buy" ? `${gen8FormatAmount(quote.minOut)} ${symbol || "tokens"}` : `${gen8FormatAmount(quote.minOut)} ${native}`) : "—"}</span>
          </div>
          <div className={row}>
            <span className="text-mw-muted">Fee {(feeBps / 100).toFixed(feeBps % 100 ? 2 : 0)}%</span>
            <span className="font-mw-mono text-mw-muted">{quote ? `${gen8FormatAmount(quote.feeWei)} ${native}` : "—"}</span>
          </div>
          {quote && quote.creatorShareWei > 0n ? (
            <div className={row}>
              <span className="text-mw-muted">Of which to the coin&apos;s creator</span>
              <span className="font-mw-mono text-mw-muted">{gen8FormatAmount(quote.creatorShareWei)} {native}</span>
            </div>
          ) : null}
        </div>
        {opensLine ? (
          <p className="mt-2 text-center text-xs text-[#FF9A4D]" data-gen8-trading-opens="true">
            {opensLine.line}
          </p>
        ) : null}
        {countdown ? (
          <p className="mt-2 text-center text-xs text-[#FF9A4D]" data-gen8-launch-fee="true">
            {countdown.line}
          </p>
        ) : null}
        {side === "sell" && maxSellable != null ? (
          <p className="mt-2 text-center text-[11px] text-mw-muted" data-gen8-max-sellable="true">
            Max sellable {gen8FormatAmount(maxSellable)} {symbol || "tokens"}
          </p>
        ) : null}
        <p className="mt-2 text-center text-[11px] text-mw-muted">{gen8FeeLine({ graduated, feeBps: graduated ? state.tradeFee?.postGraduationBps ?? 100 : state.tradeFee?.bondingBps ?? 200 })}</p>
        {side === "buy" && escrowBuy ? <p className="mt-1 text-center text-xs text-orange-200">{GEN8_CREATOR_BUY_ESCROW_COPY}</p> : null}
        {showRpcOffer && rpcChoice?.state !== "dismissed" ? (
          <div className="mt-2 rounded-md border border-mw-border p-2 text-xs text-mw-muted" data-gen8-rpc-offer={rpcChoice?.state || "open"}>
            {rpcChoice?.state === "added" ? (
              <p>You added the {BSC_PROTECTED_RPC_DEFAULT.label} to your wallet in this browser. Your wallet decides which RPC it sends with; check that BNB Chain uses it.</p>
            ) : (
              <>
                <p>
                  Your wallet sends this trade to its own BNB Chain RPC. Through a public RPC, bots see the trade before it lands and can buy just before you and sell just after (a sandwich), up to your slippage. A private RPC sends it to block builders without the public mempool.
                </p>
                <div className="mt-1.5 flex items-center gap-2">
                  <Button type="button" variant="ghost" size="sm" className={cp.smallButton} disabled={rpcBusy || !account} onClick={() => void addProtectedRpc()}>
                    Add protected BSC RPC
                  </Button>
                  <button type="button" className="text-xs underline" onClick={dismissRpcOffer}>
                    Not now
                  </button>
                </div>
              </>
            )}
          </div>
        ) : null}
        {quoteError && !quote ? <p className="mt-2 text-center text-xs text-mw-down">{quoteError}</p> : null}
        {overSellCap ? <p className="mt-2 text-center text-xs text-mw-down">This sell is larger than the bonding range can take back. Sell a smaller amount.</p> : null}
        {overBalance ? <p className="mt-2 text-center text-xs text-mw-down">{side === "buy" ? `Not enough ${native} (about ${ethers.formatEther(gasReserve)} ${native} stays for gas).` : "Amount is above your balance."}</p> : null}
        {twoApprovals ? (
          <p className="mt-2 text-center text-xs text-mw-muted" data-gen8-first-sell="true">{GEN8_FIRST_SELL_NOTE}</p>
        ) : null}
        {busy && step ? (
          <p className="mt-2 text-center text-xs text-mw-text" data-gen8-step={step.phase}>{gen8StepLabel(step)}</p>
        ) : null}
      </div>
      <Button
        className={`min-h-12 w-full rounded-[10px] font-mw-body text-base font-bold disabled:opacity-50 ${side === "buy" ? "border border-mw-buy bg-mw-buy text-[#04140A] hover:bg-[#15913F]" : "border border-mw-sell bg-mw-sell text-[#FFF1F3] hover:bg-[#C81A40]"}`}
        disabled={account ? busy || !tradingOpen || !amountRaw || !quote || overBalance || overSellCap : false}
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
        {!account ? `Connect ${robinhood ? "Robinhood" : "BNB"} wallet` : !tradingOpen ? "Trading not open yet" : busy ? (step?.phase === "pending" ? GEN8_WAITING_CONFIRMATION : step ? gen8StepLabel(step) : "Preparing the trade...") : `${side === "buy" ? "Buy" : "Sell"} ${symbol ? `$${symbol}` : ""}`.trim()}
      </Button>
    </div>
  );
}
