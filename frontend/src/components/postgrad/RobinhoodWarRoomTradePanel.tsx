import { useCallback, useEffect, useMemo, useState } from "react";
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
import LaunchTokenArtifact from "@/abi/LaunchToken.json";

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
      const provider = wallet.provider && Number(wallet.chainId) === chainId
        ? wallet.provider
        : null;
      if (!provider) {
        setRoute(null);
        return;
      }
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
  }, [campaign.campaign, campaign.token, chainId, wallet.chainId, wallet.provider]);

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
      if (!route || !wallet.provider) return;
      const amountIn = parseAmount(amount, TOKEN_DECIMALS);
      if (amountIn <= 0n) return;
      try {
        setLoading(true);
        setError(null);
        const quote = tab === "buy"
          ? await quoteRobinhoodV3Buy(wallet.provider, route, amountIn, SLIPPAGE_BPS)
          : await quoteRobinhoodV3Sell(wallet.provider, route, amountIn, SLIPPAGE_BPS);
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
  }, [amount, route, tab, wallet.provider]);

  const executeTrade = async () => {
    if (!connectedOnCampaignChain || !wallet.signer || !wallet.provider || !route) {
      openWalletModal();
      return;
    }
    const amountIn = parseAmount(amount, TOKEN_DECIMALS);
    if (amountIn <= 0n) return;

    try {
      setLoading(true);
      setError(null);
      if (tab === "buy") {
        const quote = await quoteRobinhoodV3Buy(wallet.provider, route, amountIn, SLIPPAGE_BPS);
        const tx = await executeRobinhoodV3Buy({ signer: wallet.signer, quote });
        await tx.wait();
        toast({
          title: "Robinhood buy confirmed",
          description: route.routeKind === "STOCK_TWO_HOP"
            ? `${formatAmount(amountIn, 18, "ETH")} routed atomically through ${route.market.stockToken?.symbol || "Stock Token"} into ${campaign.symbol || "the token"}.`
            : `${formatAmount(amountIn, 18, "ETH")} traded on the Robinhood V3 pool.`,
        });
      } else {
        const quote = await quoteRobinhoodV3Sell(wallet.provider, route, amountIn, SLIPPAGE_BPS);
        await ensureRobinhoodV3SellAllowance({ signer: wallet.signer, route, amountInRaw: amountIn });
        const tx = await executeRobinhoodV3Sell({ signer: wallet.signer, quote });
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
  const insufficient = tab === "buy"
    ? nativeBalance != null && amountIn > nativeBalance
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

  return (
    <div className="rounded-[18px] border border-orange-400/20 bg-black/30 p-3 md:rounded-[20px] md:p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.22em] text-orange-300">
            {isStockRoute ? "Robinhood Stock Battlefield" : "Robinhood V3"}
          </div>
          <div className="mt-1 text-xs text-white/55">
            {isStockRoute
              ? `Native ETH in/out. Permanent liquidity market: ${pairLabel}.`
              : "Native ETH in/out. Liquidity remains WETH/token underneath."}
          </div>
        </div>
        <div className="text-right text-[10px] text-white/45">
          <div>{formatAmount(nativeBalance, 18, "ETH")}</div>
          <div>{formatAmount(tokenBalance, TOKEN_DECIMALS, campaign.symbol || "TOKEN")}</div>
        </div>
      </div>

      {route ? (
        <div className="mb-3 grid gap-2 rounded-xl border border-white/10 bg-black/25 p-3 text-[11px] text-white/55 sm:grid-cols-2">
          <div>
            <div className="text-[9px] uppercase tracking-[0.16em] text-white/35">Permanent pair</div>
            <div className="mt-1 font-medium text-white/85">{pairLabel}</div>
          </div>
          <div>
            <div className="text-[9px] uppercase tracking-[0.16em] text-white/35">Route health</div>
            <div className="mt-1 font-medium text-green-300">{routeHealthLabel}</div>
          </div>
          {isStockRoute ? (
            <>
              <div>
                <div className="text-[9px] uppercase tracking-[0.16em] text-white/35">Stock quote asset</div>
                <div className="mt-1 text-white/85">
                  {stockToken?.displayName || stockSymbol} · {shortAddress(route.quoteTokenAddress)}
                </div>
              </div>
              <div>
                <div className="text-[9px] uppercase tracking-[0.16em] text-white/35">Reference price</div>
                <div className="mt-1 text-white/85">
                  {formatUsd(stockToken?.price?.priceUsd)} {stockToken?.price?.healthy === false ? "· delayed" : stockToken?.price?.healthy ? "· healthy" : ""}
                </div>
              </div>
              <div className="sm:col-span-2">
                <div className="text-[9px] uppercase tracking-[0.16em] text-white/35">Execution route</div>
                <div className="mt-1 font-medium text-orange-200">{routeSummary}</div>
                <div className="mt-1 text-[10px] leading-relaxed text-white/35">
                  {stockSymbol} is an intermediate execution asset only. Your wallet supplies or receives ETH; the route is completed atomically inside MemeWarzone.
                </div>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {isStockRoute ? (
        <div className="mb-3">
          <RobinhoodBeatTheMarketCard
            chainId={chainId}
            campaignAddress={campaign.campaign}
            memeSymbol={campaign.symbol || "MEME"}
            quoteSymbol={stockSymbol}
          />
        </div>
      ) : null}

      <Tabs value={tab} onValueChange={(value) => { setTab(value as "buy" | "sell"); setAmount("0"); setQuoteDetails(null); setError(null); }}>
        <TabsList className="grid h-auto w-full grid-cols-2 gap-2 bg-transparent p-0">
          <TabsTrigger value="buy" className="border border-orange-400/35 data-[state=active]:bg-orange-500 data-[state=active]:text-white">Buy</TabsTrigger>
          <TabsTrigger value="sell" className="border border-orange-400/35 data-[state=active]:bg-orange-500 data-[state=active]:text-white">Sell</TabsTrigger>
        </TabsList>
        <TabsContent value="buy" className="mt-3 space-y-3">
          <label className="block text-[10px] uppercase tracking-[0.18em] text-white/45">ETH amount</label>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className="w-full rounded-lg border border-white/10 bg-black/35 px-3 py-3 text-sm text-white outline-none focus:border-orange-400/60" />
          <div className="text-xs text-white/55">Estimated receive: {formatAmount(quoteOut, TOKEN_DECIMALS, campaign.symbol || "TOKEN")}</div>
          <div className="text-[10px] text-white/35">Minimum after 1.00% slippage: {formatAmount(minimumOut, TOKEN_DECIMALS, campaign.symbol || "TOKEN")}</div>
        </TabsContent>
        <TabsContent value="sell" className="mt-3 space-y-3">
          <label className="block text-[10px] uppercase tracking-[0.18em] text-white/45">{campaign.symbol || "Token"} amount</label>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className="w-full rounded-lg border border-white/10 bg-black/35 px-3 py-3 text-sm text-white outline-none focus:border-orange-400/60" />
          <div className="text-xs text-white/55">Estimated receive: {formatAmount(quoteOut, 18, "ETH")}</div>
          <div className="text-[10px] text-white/35">Minimum after 1.00% slippage: {formatAmount(minimumOut, 18, "ETH")}</div>
        </TabsContent>
      </Tabs>

      {isStockRoute && quoteDetails ? (
        <div className="mt-3 grid gap-2 rounded-xl border border-orange-400/20 bg-orange-500/5 p-3 text-[11px] sm:grid-cols-2">
          <div>
            <div className="text-[9px] uppercase tracking-[0.16em] text-white/35">Intermediate {stockSymbol}</div>
            <div className="mt-1 text-white/80">
              {formatAmount(quoteDetails.intermediateAmountOutRaw, stockDecimals, stockSymbol)}
            </div>
          </div>
          <div>
            <div className="text-[9px] uppercase tracking-[0.16em] text-white/35">Route summary</div>
            <div className="mt-1 font-medium text-orange-200">{routeSummary}</div>
          </div>
          <div>
            <div className="text-[9px] uppercase tracking-[0.16em] text-white/35">Hop 1 impact</div>
            <div className="mt-1 text-white/80">{formatBps(quoteDetails.firstLegPriceImpactBps)}</div>
          </div>
          <div>
            <div className="text-[9px] uppercase tracking-[0.16em] text-white/35">Hop 2 impact</div>
            <div className="mt-1 text-white/80">{formatBps(quoteDetails.secondLegPriceImpactBps)}</div>
          </div>
          <div className="sm:col-span-2 text-[10px] text-white/35">
            Route impact is measured per hop by the on-chain Stock execution adapter. Execution still enforces your 1.00% minimum outputs and the route's configured maximum impact policy.
          </div>
        </div>
      ) : null}

      {error ? <div className="mt-3 rounded-lg border border-red-400/25 bg-red-500/10 px-3 py-2 text-xs text-red-200">{error}</div> : null}
      {insufficient ? <div className="mt-3 text-xs text-red-300">Insufficient {tab === "buy" ? "ETH" : campaign.symbol || "token"} balance.</div> : null}

      <Button
        type="button"
        className="mt-3 w-full font-retro"
        disabled={loading || insufficient || amountIn <= 0n || (connectedOnCampaignChain && !route)}
        onClick={() => void executeTrade()}
      >
        {!connectedOnCampaignChain
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