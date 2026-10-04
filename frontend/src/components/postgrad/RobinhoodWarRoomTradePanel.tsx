import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Contract, ethers } from "ethers";
import type { CampaignInfo } from "@/lib/launchpadClient";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RobinhoodBeatTheMarketCard } from "@/components/postgrad/RobinhoodBeatTheMarketCard";
import { useToast } from "@/hooks/use-toast";
import { useWallet } from "@/contexts/WalletContext";
import {
  ensureRobinhoodV3SellAllowance,
  executeRobinhoodV3Buy,
  executeRobinhoodV3Sell,
  quoteRobinhoodV3Buy,
  quoteRobinhoodV3Sell,
  resolveRobinhoodV3Route,
  type RobinhoodV3Quote,
  type RobinhoodV3ResolvedRoute,
} from "@/lib/robinhoodV3Trade";
import { ROBINHOOD_CHAIN_ID, ROBINHOOD_TESTNET_CHAIN_ID } from "@/lib/chainConfig";
import { getReadProvider } from "@/lib/readProvider";
import LaunchTokenArtifact from "@/abi/LaunchToken.json";
import { ETH_BUY_GAS_RESERVE_WEI } from "@/lib/tradeBalanceReserve";

const TOKEN_ABI = LaunchTokenArtifact.abi as ethers.InterfaceAbi;
const TOKEN_DECIMALS = 18;
const SLIPPAGE_BPS = 100;

function parseAmount(value: string, decimals = 18): bigint {
  const raw = String(value || "").trim().replace(/,/g, ".");
  if (!raw || raw === ".") return 0n;
  try {
    return ethers.parseUnits(raw, decimals);
  } catch {
    return 0n;
  }
}

function formatAmount(value: bigint | null, decimals = 18, symbol = "") {
  if (value == null) return "—";
  try {
    const n = Number(ethers.formatUnits(value, decimals));
    const text = Number.isFinite(n)
      ? n >= 1
        ? n.toFixed(4)
        : n >= 0.01
          ? n.toFixed(6)
          : n.toFixed(8)
      : ethers.formatUnits(value, decimals);
    return symbol ? `${text} ${symbol}` : text;
  } catch {
    return "—";
  }
}

function formatBps(value: bigint | null) {
  if (value == null) return "—";
  return `${(Number(value) / 100).toFixed(2)}%`;
}

function formatUsd(value: string | null | undefined) {
  if (!value) return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return `$${value}`;
  if (number >= 100) return `$${number.toFixed(2)}`;
  if (number >= 1) return `$${number.toFixed(3)}`;
  return `$${number.toFixed(4)}`;
}

function shortAddress(value: string | null | undefined) {
  const raw = String(value || "").trim();
  if (!raw) return "—";
  return raw.length > 12 ? `${raw.slice(0, 6)}…${raw.slice(-4)}` : raw;
}

function campaignChainId(campaign: CampaignInfo): number {
  const id = Number((campaign as { chainId?: number }).chainId);
  return id === ROBINHOOD_CHAIN_ID || id === ROBINHOOD_TESTNET_CHAIN_ID ? id : ROBINHOOD_TESTNET_CHAIN_ID;
}

export function RobinhoodWarRoomTradePanel({ campaign }: { campaign: CampaignInfo }) {
  const { toast } = useToast();
  const wallet = useWallet();
  const chainId = useMemo(() => campaignChainId(campaign), [campaign]);
  const [tab, setTab] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("0");
  const [tradeInputDenom, setTradeInputDenom] = useState<"ETH" | "TOKEN">("ETH");
  const [route, setRoute] = useState<RobinhoodV3ResolvedRoute | null>(null);
  const [quoteDetails, setQuoteDetails] = useState<RobinhoodV3Quote | null>(null);
  const [nativeBalance, setNativeBalance] = useState<bigint | null>(null);
  const [tokenBalance, setTokenBalance] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connectedOnCampaignChain = Boolean(
    wallet.isConnected &&
    wallet.account &&
    wallet.provider &&
    wallet.signer &&
    Number(wallet.chainId) === chainId,
  );

  const openWalletModal = () => {
    try { window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal")); } catch { /* ignore */ }
  };

  const loadRoute = useCallback(async () => {
    try {
      setError(null);
      const provider = getReadProvider(chainId);
      const next = await resolveRobinhoodV3Route({
        provider,
        campaignAddress: campaign.campaign,
        chainId,
        expectedTokenAddress: campaign.token,
      });
      setRoute(next);
    } catch (err) {
      setRoute(null);
      setQuoteDetails(null);
      setError(String((err as Error)?.message || err || "Robinhood V3 route unavailable."));
    }
  }, [campaign.campaign, campaign.token, chainId]);

  const loadBalances = useCallback(async () => {
    if (!connectedOnCampaignChain || !wallet.provider || !wallet.account) {
      setNativeBalance(null);
      setTokenBalance(null);
      return;
    }
    try {
      const [native, token] = await Promise.all([
        wallet.provider.getBalance(wallet.account),
        campaign.token
          ? new Contract(campaign.token, TOKEN_ABI, wallet.provider).balanceOf(wallet.account).catch(() => 0n)
          : Promise.resolve(0n),
      ]);
      setNativeBalance(BigInt(native));
      setTokenBalance(BigInt(token));
    } catch {
      setNativeBalance(null);
      setTokenBalance(null);
    }
  }, [campaign.token, connectedOnCampaignChain, wallet.account, wallet.provider]);

  useEffect(() => { void loadRoute(); }, [loadRoute]);
  useEffect(() => { void loadBalances(); }, [loadBalances]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setQuoteDetails(null);
      if (!route) return;
      const provider = getReadProvider(chainId);
      const amountIn = parseAmount(amount, TOKEN_DECIMALS);
      if (amountIn <= 0n) return;
      try {
        setLoading(true);
        setError(null);
        const quote = tab === "buy"
          ? await quoteRobinhoodV3Buy(provider, route, amountIn, SLIPPAGE_BPS)
          : await quoteRobinhoodV3Sell(provider, route, amountIn, SLIPPAGE_BPS);
        if (cancelled) return;
        setQuoteDetails(quote);
      } catch (err) {
        if (!cancelled) setError(String((err as Error)?.message || err || "Quote unavailable."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [amount, chainId, route, tab]);

  const executeTrade = async () => {
    if (!wallet.account || !wallet.signer || !wallet.provider) {
      openWalletModal();
      return;
    }

    let tradeProvider = wallet.provider;
    let tradeSigner = wallet.signer;

    if (Number(wallet.chainId) !== chainId) {
      try {
        const switched = await wallet.switchToChain(chainId);
        tradeProvider = switched.provider;
        tradeSigner = switched.signer;
      } catch (err) {
        const message = String((err as Error)?.message || err || `Switch MetaMask to Robinhood chain ${chainId} and try again.`);
        setError(message);
        toast({ title: "Robinhood network switch failed", description: message, variant: "destructive" });
        return;
      }
    }

    if (!route) {
      setError("Robinhood V3 route is not ready yet.");
      return;
    }
    const amountIn = parseAmount(amount, TOKEN_DECIMALS);
    if (amountIn <= 0n) return;

    try {
      setLoading(true);
      setError(null);
      if (tab === "buy") {
        const quote = await quoteRobinhoodV3Buy(tradeProvider, route, amountIn, SLIPPAGE_BPS);
        const tx = await executeRobinhoodV3Buy({ signer: tradeSigner, quote });
        await tx.wait();
        toast({
          title: "Robinhood buy confirmed",
          description: route.routeKind === "STOCK_TWO_HOP"
            ? `${formatAmount(amountIn, 18, "ETH")} routed atomically through ${route.market.stockToken?.symbol || "Stock Token"} into ${campaign.symbol || "the token"}.`
            : `${formatAmount(amountIn, 18, "ETH")} traded on the Robinhood V3 pool.`,
        });
      } else {
        const quote = await quoteRobinhoodV3Sell(tradeProvider, route, amountIn, SLIPPAGE_BPS);
        await ensureRobinhoodV3SellAllowance({ signer: tradeSigner, route, amountInRaw: amountIn });
        const tx = await executeRobinhoodV3Sell({ signer: tradeSigner, quote });
        await tx.wait();
        toast({
          title: "Robinhood sell confirmed",
          description: route.routeKind === "STOCK_TWO_HOP"
            ? `${formatAmount(amountIn, TOKEN_DECIMALS, campaign.symbol || "tokens")} routed atomically through ${route.market.stockToken?.symbol || "Stock Token"} back to ETH.`
            : `${formatAmount(amountIn, TOKEN_DECIMALS, campaign.symbol || "tokens")} sold for ETH.`,
        });
      }
      setAmount("0");
      setQuoteDetails(null);
      await Promise.all([loadBalances(), loadRoute()]);
    } catch (err) {
      const message = String((err as Error)?.message || err || "Robinhood V3 trade failed.");
      setError(message);
      toast({ title: "Robinhood trade failed", description: message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const amountIn = parseAmount(amount, TOKEN_DECIMALS);
  // Buys pay gas in ETH on top of the amount entered.
  const insufficient = tab === "buy"
    ? nativeBalance != null && amountIn + ETH_BUY_GAS_RESERVE_WEI > nativeBalance
    : tokenBalance != null && amountIn > tokenBalance;
  const quoteOut = quoteDetails?.amountOutRaw ?? null;
  const minimumOut = quoteDetails?.minimumOutRaw ?? null;
  const isStockRoute = route?.routeKind === "STOCK_TWO_HOP";
  const stockToken = isStockRoute ? route?.market.stockToken ?? null : null;
  const stockSymbol = stockToken?.symbol || stockToken?.underlyingSymbol || "STOCK";
  const stockDecimals = Number.isInteger(stockToken?.decimals) ? Number(stockToken?.decimals) : 18;
  const pairLabel = isStockRoute
    ? `${campaign.symbol || "MEME"} / ${stockSymbol}`
    : `${campaign.symbol || "MEME"} / WETH`;
  const routeSummary = isStockRoute
    ? tab === "buy"
      ? `ETH → ${stockSymbol} → ${campaign.symbol || "MEME"}`
      : `${campaign.symbol || "MEME"} → ${stockSymbol} → ETH`
    : tab === "buy"
      ? `ETH → ${campaign.symbol || "MEME"}`
      : `${campaign.symbol || "MEME"} → ETH`;
  const routeHealthLabel = isStockRoute
    ? route?.stockRoute ? "Healthy · both V3 hops verified" : "Unavailable"
    : route ? "Healthy · direct V3 route verified" : "Unavailable";

  // UI redesign: artboard trade panel (presentation only; handlers below are the panel's own).
  const lblClass = "font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted";
  const chipClass =
    "mw-focus inline-flex min-h-[30px] items-center justify-center rounded-lg border border-[#2E353D] bg-[#171B20] px-2.5 font-mw-mono text-[13px] text-[#C9CED4] hover:border-[#3A424C]";
  const chipOnClass = "border-mw-accent bg-[#2A1609] text-mw-accent-soft hover:border-mw-accent";
  const segTriggerClass =
    "min-h-10 rounded-lg border-0 bg-transparent font-mw-body text-[15px] font-bold text-mw-muted shadow-none hover:text-mw-text";
  const switchDenom = () => {
    setTradeInputDenom((value) => (value === "ETH" ? "TOKEN" : "ETH"));
    setAmount("0");
    setQuoteDetails(null);
  };
  const tokenSymbol = campaign.symbol || "TOKEN";
  const denomChips = (label: string) => (
    <div className="flex items-center justify-between gap-2 text-[13px]">
      <span className="text-mw-muted">{label}</span>
      <span className="flex gap-1">
        <button type="button" aria-pressed={tradeInputDenom === "ETH"} onClick={tradeInputDenom === "ETH" ? undefined : switchDenom} className={`${chipClass} ${tradeInputDenom === "ETH" ? chipOnClass : ""}`}>ETH</button>
        <button type="button" aria-pressed={tradeInputDenom === "TOKEN"} onClick={tradeInputDenom === "TOKEN" ? undefined : switchDenom} className={`${chipClass} ${tradeInputDenom === "TOKEN" ? chipOnClass : ""}`}>{tokenSymbol}</button>
      </span>
    </div>
  );
  const amountInput = (
    <div className="relative">
      <input
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        inputMode="decimal"
        aria-label={tradeInputDenom === "ETH" ? "ETH amount" : `${campaign.symbol || "Token"} amount`}
        className="mw-focus h-12 w-full rounded-[10px] border border-[#2E353D] bg-mw-input pl-3.5 pr-20 font-mw-mono text-lg text-mw-text focus:border-mw-accent focus:outline-none"
      />
      <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 font-mw-mono text-[13px] text-mw-muted">{tradeInputDenom === "ETH" ? "ETH" : tokenSymbol}</span>
    </div>
  );
  // 25% / 50% fill the field from the balance of the unit being entered (buy in ETH, sell in the token).
  const percentBalance = tab === "buy" ? (tradeInputDenom === "ETH" ? nativeBalance : null) : tradeInputDenom === "TOKEN" ? tokenBalance : null;
  const percentDecimals = tab === "buy" ? 18 : TOKEN_DECIMALS;
  const balanceRow = (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="min-w-0 flex-1 truncate font-mw-mono text-[13px] text-mw-muted">
        Bal {tradeInputDenom === "ETH" ? formatAmount(nativeBalance, 18, "ETH") : formatAmount(tokenBalance, TOKEN_DECIMALS, tokenSymbol)}
      </span>
      {percentBalance != null ? (
        <>
          <button type="button" className={chipClass} onClick={() => setAmount(ethers.formatUnits((percentBalance * 25n) / 100n, percentDecimals))}>25%</button>
          <button type="button" className={chipClass} onClick={() => setAmount(ethers.formatUnits((percentBalance * 50n) / 100n, percentDecimals))}>50%</button>
        </>
      ) : null}
      <span className={`${chipClass} cursor-default hover:border-[#2E353D]`}>Slip 1%</span>
    </div>
  );
  const infoCell = (label: string, value: ReactNode, tone = "text-mw-text") => (
    <div className="min-w-0">
      <div className={`${lblClass} text-[11px]`}>{label}</div>
      <div className={`mt-0.5 truncate text-[13px] font-semibold ${tone}`}>{value}</div>
    </div>
  );

  return (
    <div className="flex flex-col gap-2.5 rounded-[14px] border border-mw-border bg-mw-input p-3.5 font-mw-body text-mw-text">
      <div>
        <div className={`${lblClass} text-mw-accent-soft`}>{isStockRoute ? "Robinhood Stock Battlefield" : "Robinhood V3"}</div>
        <p className="m-0 mt-0.5 text-[13px] text-mw-muted">
          {isStockRoute
            ? `Native ETH in/out. Permanent liquidity market: ${pairLabel}.`
            : "Native ETH in/out. Liquidity remains WETH/token underneath."}
        </p>
      </div>

      {route ? (
        <div className="grid gap-2 rounded-[10px] border border-[#242A31] bg-[#13171C] p-3 sm:grid-cols-2">
          {infoCell("Permanent pair", pairLabel)}
          {infoCell("Route health", routeHealthLabel, "text-[#6EE7A0]")}
          {isStockRoute ? (
            <>
              {infoCell("Stock quote asset", `${stockToken?.displayName || stockSymbol} · ${shortAddress(route.quoteTokenAddress)}`)}
              {infoCell("Reference price", `${formatUsd(stockToken?.price?.priceUsd)} ${stockToken?.price?.healthy === false ? "· delayed" : stockToken?.price?.healthy ? "· healthy" : ""}`)}
              <div className="sm:col-span-2">
                {infoCell("Execution route", routeSummary, "text-mw-accent-soft")}
                <p className="m-0 mt-1 text-[11px] leading-relaxed text-mw-muted">
                  {stockSymbol} is an intermediate execution asset only. Your wallet supplies or receives ETH; the route is completed atomically inside MemeWarzone.
                </p>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {isStockRoute ? (
        <RobinhoodBeatTheMarketCard
          chainId={chainId}
          campaignAddress={campaign.campaign}
          memeSymbol={campaign.symbol || "MEME"}
          quoteSymbol={stockSymbol}
        />
      ) : null}

      <Tabs value={tab} onValueChange={(value) => { setTab(value as "buy" | "sell"); setAmount("0"); setQuoteDetails(null); setError(null); }}>
        <TabsList className="grid h-auto w-full grid-cols-2 gap-1 rounded-[10px] border border-[#242A31] bg-[#13171C] p-1">
          <TabsTrigger value="buy" className={`${segTriggerClass} data-[state=active]:bg-mw-buy data-[state=active]:text-[#04140A]`}>Buy</TabsTrigger>
          <TabsTrigger value="sell" className={`${segTriggerClass} data-[state=active]:bg-mw-sell data-[state=active]:text-[#FFF1F3]`}>Sell</TabsTrigger>
        </TabsList>
        <TabsContent value="buy" className="mt-2.5 flex flex-col gap-2.5">
          {denomChips("Pay in")}
          {amountInput}
          {balanceRow}
          <div className="flex items-center justify-between gap-2 font-mw-mono text-[13px]">
            <span className="truncate text-mw-muted">Min {formatAmount(minimumOut, TOKEN_DECIMALS, campaign.symbol || "TOKEN")}</span>
            <span className="truncate">
              {tradeInputDenom === "ETH"
                ? `get ~${formatAmount(quoteOut, TOKEN_DECIMALS, campaign.symbol || "TOKEN")}`
                : `pay ~${formatAmount(quoteOut, 18, "ETH")}`}
            </span>
          </div>
          <p className="m-0 text-center text-xs text-mw-muted">Minimum after 1.00% slippage: {formatAmount(minimumOut, TOKEN_DECIMALS, campaign.symbol || "TOKEN")}</p>
        </TabsContent>
        <TabsContent value="sell" className="mt-2.5 flex flex-col gap-2.5">
          {denomChips("Amount in")}
          {amountInput}
          {balanceRow}
          <div className="flex items-center justify-between gap-2 font-mw-mono text-[13px]">
            <span className="truncate text-mw-muted">Min {formatAmount(minimumOut, 18, "ETH")}</span>
            <span className="truncate">get ~{formatAmount(quoteOut, 18, "ETH")}</span>
          </div>
          <p className="m-0 text-center text-xs text-mw-muted">Minimum after 1.00% slippage: {formatAmount(minimumOut, 18, "ETH")}</p>
        </TabsContent>
      </Tabs>

      {isStockRoute && quoteDetails ? (
        <div className="grid gap-2 rounded-[10px] border border-[#5A3416] bg-mw-accent-fill p-3 sm:grid-cols-2">
          {infoCell(`Intermediate ${stockSymbol}`, formatAmount(quoteDetails.intermediateAmountOutRaw, stockDecimals, stockSymbol))}
          {infoCell("Route summary", routeSummary, "text-mw-accent-soft")}
          {infoCell("Hop 1 impact", formatBps(quoteDetails.firstLegPriceImpactBps))}
          {infoCell("Hop 2 impact", formatBps(quoteDetails.secondLegPriceImpactBps))}
          <p className="m-0 text-[11px] text-mw-muted sm:col-span-2">
            Route impact is measured per hop by the on-chain Stock execution adapter. Execution still enforces your 1.00% minimum outputs and the route's configured maximum impact policy.
          </p>
        </div>
      ) : null}

      {error ? <div role="alert" className="rounded-[10px] border border-[#5A1A26] bg-[#2A0E14] px-3 py-2 text-xs text-[#FFB4C0]">{error}</div> : null}
      {insufficient ? (
        <div className="text-xs text-[#FFB4C0]">
          {tab === "buy"
            ? `Not enough ETH. Keep about ${ethers.formatEther(ETH_BUY_GAS_RESERVE_WEI)} ETH in your wallet for gas.`
            : `Insufficient ${campaign.symbol || "token"} balance.`}
        </div>
      ) : null}

      <Button
        type="button"
        className={`min-h-12 w-full rounded-[10px] font-mw-body text-base font-bold disabled:opacity-50 ${tab === "buy" ? "border border-mw-buy bg-mw-buy text-[#04140A] hover:bg-[#15913F]" : "border border-mw-sell bg-mw-sell text-[#FFF1F3] hover:bg-[#C81A40]"}`}
        disabled={loading || insufficient || amountIn <= 0n}
        onClick={() => void executeTrade()}
      >
        {!wallet.isConnected || !wallet.account
          ? `Connect Robinhood wallet`
          : loading
            ? "Processing..."
            : tab === "buy"
              ? `Buy ${campaign.symbol || "token"}`
              : `Sell ${campaign.symbol || "token"}`}
      </Button>
    </div>
  );
}
