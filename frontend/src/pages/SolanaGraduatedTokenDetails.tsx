import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, ExternalLink } from "lucide-react";
import { ethers } from "ethers";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { useSolUsdPrice } from "@/hooks/useSolUsdPrice";
import { useTokenStatsRealtime } from "@/hooks/useTokenStatsRealtime";
import { getPublicRpcUrl, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import type { CampaignInfo } from "@/lib/launchpadClient";
import {
  fetchSolanaCampaignCurveState,
  type SolanaCampaignCurveState,
} from "@/lib/solanaCampaignRead";
import {
  executeSolanaMeteoraSwap,
  quoteSolanaMeteoraExactIn,
  type SolanaMeteoraQuote,
  type SolanaMeteoraSide,
} from "@/lib/solanaMeteoraTrade";
import { peekPendingSolanaDexTrade, takePendingSolanaDexTrade } from "@/lib/solanaGraduationHandoff";
import { getSolanaTokenBalanceRaw } from "@/lib/solanaTradeV1";
import { loadSolanaWeb3 } from "@/lib/solanaWeb3";

const DEVNET_EXPLORER_BASE = "https://explorer.solana.com";
const SLIPPAGE_PCT = 5;
const FEE_BUFFER_LAMPORTS = 5_000_000n;

type SolanaGraduatedTokenDetailsProps = {
  routeId: string;
  campaign: CampaignInfo | null;
  initialCurve: SolanaCampaignCurveState | null;
};

function shortenAddress(value?: string | null): string {
  const raw = String(value || "").trim();
  if (!raw) return "—";
  return raw.length > 12 ? `${raw.slice(0, 6)}...${raw.slice(-4)}` : raw;
}

function trimFormatted(value: string): string {
  return value
    .replace(/(\.\d*?[1-9])0+$/, "$1")
    .replace(/\.0+$/, "")
    .replace(/\.$/, "");
}

function formatRawAmount(value: bigint | null | undefined, decimals: number, places = 6): string {
  if (value == null) return "—";
  try {
    const text = ethers.formatUnits(value, decimals);
    const [whole, fraction = ""] = text.split(".");
    if (!fraction) return whole;
    return trimFormatted(`${whole}.${fraction.slice(0, places)}`);
  } catch {
    return "—";
  }
}

function rawToInputString(value: bigint, decimals: number): string {
  return trimFormatted(ethers.formatUnits(value, decimals));
}

function formatNative(value?: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value === 0) return "0 SOL";
  if (value >= 1) return `${value.toFixed(4)} SOL`;
  if (value >= 0.01) return `${value.toFixed(6)} SOL`;
  if (value >= 0.000001) return `${value.toFixed(8)} SOL`;
  return `${value.toPrecision(4)} SOL`;
}

function formatUsd(value?: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(abs >= 10_000_000_000 ? 1 : 2)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(abs >= 10_000 ? 1 : 2)}K`;
  if (abs >= 1) return `$${value.toFixed(2)}`;
  if (abs >= 0.01) return `$${value.toFixed(4)}`;
  if (abs >= 0.000001) return `$${value.toFixed(8)}`;
  return `$${value.toPrecision(4)}`;
}

function formatPercent(value?: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(2)}%`;
}

function explorerHref(kind: "address" | "tx", value?: string | null): string | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const segment = kind === "tx" ? "tx" : "address";
  return `${DEVNET_EXPLORER_BASE}/${segment}/${encodeURIComponent(raw)}`;
}

function friendlyError(error: unknown): string {
  const message = String((error as any)?.message || error || "Swap failed.").trim();
  if (!message) return "Swap failed.";
  return message;
}

const SolanaGraduatedTokenDetails = ({
  routeId,
  campaign,
  initialCurve,
}: SolanaGraduatedTokenDetailsProps) => {
  const { toast } = useToast();
  const {
    connectSolana,
    connectingSolana,
    isSolanaConnected,
    solanaAccount,
  } = useSolanaWallet();

  const [curveState, setCurveState] = useState<SolanaCampaignCurveState | null>(initialCurve);
  const [curveRefreshTick, setCurveRefreshTick] = useState(0);
  const [tab, setTab] = useState<SolanaMeteoraSide>("buy");
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<SolanaMeteoraQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [lastSignature, setLastSignature] = useState<string | null>(null);
  const [solBalanceLamports, setSolBalanceLamports] = useState<bigint | null>(null);
  const [tokenBalanceRaw, setTokenBalanceRaw] = useState<bigint | null>(null);
  const [balanceTick, setBalanceTick] = useState(0);
  const [handoffStarted, setHandoffStarted] = useState(false);

  const curveLookupAddress = useMemo(
    () => String(campaign?.campaign || initialCurve?.campaignAddress || routeId || "").trim(),
    [campaign?.campaign, initialCurve?.campaignAddress, routeId],
  );

  useEffect(() => {
    let cancelled = false;
    if (!curveLookupAddress) {
      setCurveState(null);
      return;
    }

    (async () => {
      try {
        const nextCurve = await fetchSolanaCampaignCurveState(curveLookupAddress);
        if (!cancelled && nextCurve) setCurveState(nextCurve);
      } catch {
        // Best-effort refresh only.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [curveLookupAddress, curveRefreshTick]);

  const campaignAddress = useMemo(
    () => String(campaign?.campaign || curveState?.campaignAddress || "").trim(),
    [campaign?.campaign, curveState?.campaignAddress],
  );
  const mintAddress = useMemo(
    () => String(campaign?.token || curveState?.mint || routeId || "").trim(),
    [campaign?.token, curveState?.mint, routeId],
  );
  const tokenDecimals = Number(curveState?.tokenDecimals ?? 6);

  const { stats } = useTokenStatsRealtime(
    campaignAddress || undefined,
    SOLANA_CHAIN_ID,
    Boolean(campaignAddress),
  );
  const { price: solUsd } = useSolUsdPrice(true);

  useEffect(() => {
    let cancelled = false;

    if (!isSolanaConnected || !solanaAccount || !mintAddress) {
      setSolBalanceLamports(null);
      setTokenBalanceRaw(null);
      return;
    }

    (async () => {
      try {
        const web3 = await loadSolanaWeb3();
        const connection = new web3.Connection(getPublicRpcUrl(SOLANA_CHAIN_ID), "confirmed");
        const [lamports, tokenRaw] = await Promise.all([
          connection.getBalance(new web3.PublicKey(solanaAccount), "confirmed"),
          getSolanaTokenBalanceRaw({ mint: mintAddress, owner: solanaAccount }),
        ]);
        if (!cancelled) {
          setSolBalanceLamports(BigInt(lamports));
          setTokenBalanceRaw(tokenRaw);
        }
      } catch {
        if (!cancelled) {
          setSolBalanceLamports(null);
          setTokenBalanceRaw(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [balanceTick, isSolanaConnected, mintAddress, solanaAccount]);

  const buySpendableLamports = useMemo(() => {
    if (solBalanceLamports == null || solBalanceLamports <= FEE_BUFFER_LAMPORTS) return 0n;
    return solBalanceLamports - FEE_BUFFER_LAMPORTS;
  }, [solBalanceLamports]);

  const logoUri = useMemo(() => {
    const raw = String(campaign?.logoURI || "").trim();
    return raw && raw !== "/placeholder.svg" ? raw : "";
  }, [campaign?.logoURI]);

  const displayName = String(campaign?.name || "Solana Token").trim() || "Solana Token";
  const displaySymbol = String(campaign?.symbol || "SOL").trim() || "SOL";

  const nativePrice = stats?.lastPriceBnb ?? null;
  const marketCapNative = stats?.marketcapBnb ?? null;
  const marketCapUsd = marketCapNative != null && solUsd ? marketCapNative * solUsd : null;
  const liquidityNative =
    stats?.graduationLiquidityNative != null && Number.isFinite(stats.graduationLiquidityNative)
      ? stats.graduationLiquidityNative * 2
      : null;
  const liquidityUsd = liquidityNative != null && solUsd ? liquidityNative * solUsd : null;

  const quoteInputDecimals = tab === "buy" ? 9 : tokenDecimals;
  const quoteOutputDecimals = tab === "buy" ? tokenDecimals : 9;

  useEffect(() => {
    let cancelled = false;
    const trimmed = String(amount || "").trim();

    if (!trimmed) {
      setQuote(null);
      setQuoteError(null);
      setQuoteLoading(false);
      return;
    }

    if (!curveState || !mintAddress) {
      setQuote(null);
      setQuoteError("Verified curve state is not available yet.");
      setQuoteLoading(false);
      return;
    }

    let amountInRaw: bigint;
    try {
      amountInRaw = ethers.parseUnits(trimmed, quoteInputDecimals);
    } catch {
      setQuote(null);
      setQuoteError("Enter a valid amount.");
      setQuoteLoading(false);
      return;
    }

    if (amountInRaw <= 0n) {
      setQuote(null);
      setQuoteError(null);
      setQuoteLoading(false);
      return;
    }

    setQuoteLoading(true);
    setQuoteError(null);

    (async () => {
      try {
        const nextQuote = await quoteSolanaMeteoraExactIn({
          side: tab,
          mint: curveState.mint,
          tokenDecimals,
          amountInRaw,
          slippagePct: SLIPPAGE_PCT,
          poolAddress: stats?.dexPool || undefined,
        });
        if (!cancelled) setQuote(nextQuote);
      } catch (error) {
        if (!cancelled) {
          setQuote(null);
          setQuoteError(friendlyError(error));
        }
      } finally {
        if (!cancelled) setQuoteLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [amount, curveState, mintAddress, quoteInputDecimals, stats?.dexPool, tab, tokenDecimals]);

  const quoteOutputLabel = useMemo(() => {
    if (!quote) return "—";
    return formatRawAmount(quote.amountOutRaw, quoteOutputDecimals, 8);
  }, [quote, quoteOutputDecimals]);

  const quoteMinimumLabel = useMemo(() => {
    if (!quote) return "—";
    return formatRawAmount(quote.minimumAmountOutRaw, quoteOutputDecimals, 8);
  }, [quote, quoteOutputDecimals]);

  const quoteFeeLabel = useMemo(() => {
    if (!quote) return "—";
    return formatRawAmount(quote.feeRaw, quoteInputDecimals, 8);
  }, [quote, quoteInputDecimals]);

  const handleCopy = useCallback(async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast({ title: `${label} copied`, description: shortenAddress(value) });
    } catch {
      toast({ title: `Could not copy ${label.toLowerCase()}`, variant: "destructive" });
    }
  }, [toast]);

  const handleSetMax = useCallback(() => {
    const nextRaw = tab === "buy" ? buySpendableLamports : tokenBalanceRaw ?? 0n;
    setAmount(nextRaw > 0n ? rawToInputString(nextRaw, quoteInputDecimals) : "");
  }, [buySpendableLamports, quoteInputDecimals, tab, tokenBalanceRaw]);

  useEffect(() => {
    if (handoffStarted || !curveState?.graduated || !curveState.mint) return;
    const pending = peekPendingSolanaDexTrade(curveState.campaignAddress);
    if (!pending) return;
    setTab(pending.side);
    if (pending.displayAmount) setAmount(pending.displayAmount);
    if (!isSolanaConnected || !solanaAccount) return;

    const queued = takePendingSolanaDexTrade(curveState.campaignAddress);
    if (!queued) return;
    setHandoffStarted(true);

    (async () => {
      try {
        setSubmitting(true);
        const amountInRaw = BigInt(queued.amountInRaw);
        if (amountInRaw <= 0n) return;
        toast({
          title: queued.side === "buy" ? "Submitting Meteora buy" : "Submitting Meteora sell",
          description: "Sending the trade you placed during graduation.",
        });
        const nextQuote = await quoteSolanaMeteoraExactIn({
          side: queued.side,
          mint: queued.mint || curveState.mint,
          tokenDecimals: queued.tokenDecimals || tokenDecimals,
          amountInRaw,
          slippagePct: SLIPPAGE_PCT,
        });
        const result = await executeSolanaMeteoraSwap({
          quote: nextQuote,
          mint: queued.mint || curveState.mint,
          tokenDecimals: queued.tokenDecimals || tokenDecimals,
          walletAddress: solanaAccount,
          poolAddress: nextQuote.pool,
        });
        setLastSignature(result.signature);
        setAmount("");
        setQuote(null);
        setBalanceTick((value) => value + 1);
        toast({
          title: queued.side === "buy" ? "Meteora buy confirmed" : "Meteora sell confirmed",
          description: shortenAddress(result.signature),
        });
      } catch (error) {
        const message = friendlyError(error);
        setQuoteError(message);
        toast({ title: "Queued trade waiting", description: message });
      } finally {
        setSubmitting(false);
      }
    })();
  }, [curveState, handoffStarted, isSolanaConnected, solanaAccount, toast, tokenDecimals]);

  const handlePrimaryAction = useCallback(async () => {
    if (!isSolanaConnected) {
      try {
        await connectSolana();
      } catch (error) {
        toast({ title: "Wallet connection failed", description: friendlyError(error), variant: "destructive" });
      }
      return;
    }

    if (!quote || !curveState) return;

    setSubmitting(true);
    setQuoteError(null);

    try {
      const result = await executeSolanaMeteoraSwap({
        quote,
        mint: curveState.mint,
        tokenDecimals,
        walletAddress: solanaAccount,
        poolAddress: stats?.dexPool || quote.pool,
      });
      setLastSignature(result.signature);
      setAmount("");
      setQuote(null);
      setBalanceTick((value) => value + 1);
      setCurveRefreshTick((value) => value + 1);
      toast({
        title: tab === "buy" ? "Meteora buy confirmed" : "Meteora sell confirmed",
        description: shortenAddress(result.signature),
      });
    } catch (error) {
      const message = friendlyError(error);
      setQuoteError(message);
      toast({ title: "Swap failed", description: message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }, [
    connectSolana,
    curveState,
    isSolanaConnected,
    quote,
    solanaAccount,
    stats?.dexPool,
    tab,
    toast,
    tokenDecimals,
  ]);

  const actionLabel = !isSolanaConnected
    ? connectingSolana
      ? "Connecting wallet..."
      : "Connect Solana wallet"
    : submitting
      ? tab === "buy"
        ? "Submitting buy..."
        : "Submitting sell..."
      : quoteLoading
        ? "Refreshing quote..."
        : tab === "buy"
          ? "Buy on Meteora"
          : "Sell on Meteora";

  const actionDisabled = Boolean(
    connectingSolana ||
      submitting ||
      (isSolanaConnected && (!quote || quoteLoading || !curveState)),
  );

  const websiteHref = String(campaign?.website || "").trim();
  const xHref = String(campaign?.xAccount || "").trim();
  const poolAddress = String(stats?.dexPool || quote?.pool || "").trim();
  const tokenExplorer = explorerHref("address", mintAddress);
  const campaignExplorer = explorerHref("address", campaignAddress);
  const poolExplorer = explorerHref("address", poolAddress);
  const txExplorer = explorerHref("tx", lastSignature);

  return (
    <div className="mx-auto w-full max-w-[1480px] px-3 pb-10 md:px-2">
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-center gap-4">
          {logoUri ? (
            <img src={logoUri} alt={displayName} className="h-16 w-16 rounded-2xl object-cover ring-1 ring-border/60" />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-border/60 bg-card/60 text-lg font-semibold">
              {displaySymbol.slice(0, 2).toUpperCase()}
            </div>
          )}
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 font-medium text-emerald-200">
                Graduated · Meteora
              </span>
              {isSolanaConnected ? (
                <span className="inline-flex items-center rounded-full border border-border/60 bg-card/60 px-2.5 py-1 text-muted-foreground">
                  {shortenAddress(solanaAccount)}
                </span>
              ) : null}
            </div>
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">
              {displayName}
              <span className="ml-2 text-lg font-medium text-muted-foreground">${displaySymbol}</span>
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>{shortenAddress(mintAddress)}</span>
              <Button type="button" variant="ghost" size="icon" onClick={() => handleCopy(mintAddress, "Mint")}> 
                <Copy className="h-4 w-4" />
              </Button>
              {tokenExplorer ? (
                <Button asChild variant="ghost" size="icon">
                  <a href={tokenExplorer} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </Button>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {websiteHref ? (
            <Button asChild variant="outline">
              <a href={websiteHref} target="_blank" rel="noreferrer">Website</a>
            </Button>
          ) : null}
          {xHref ? (
            <Button asChild variant="outline">
              <a href={xHref} target="_blank" rel="noreferrer">X</a>
            </Button>
          ) : null}
          {poolExplorer ? (
            <Button asChild variant="outline">
              <a href={poolExplorer} target="_blank" rel="noreferrer">Pool</a>
            </Button>
          ) : null}
        </div>
      </div>

      <div className="mb-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card className="rounded-lg">
          <CardHeader>
            <CardDescription>Spot price</CardDescription>
            <CardTitle className="text-xl">{formatNative(nativePrice)}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">{nativePrice != null && solUsd ? formatUsd(nativePrice * solUsd) : "—"}</CardContent>
        </Card>
        <Card className="rounded-lg">
          <CardHeader>
            <CardDescription>Market cap</CardDescription>
            <CardTitle className="text-xl">{formatNative(marketCapNative)}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">{formatUsd(marketCapUsd)}</CardContent>
        </Card>
        <Card className="rounded-lg">
          <CardHeader>
            <CardDescription>Liquidity</CardDescription>
            <CardTitle className="text-xl">{formatNative(liquidityNative)}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">{formatUsd(liquidityUsd)}</CardContent>
        </Card>
        <Card className="rounded-lg">
          <CardHeader>
            <CardDescription>Pool route</CardDescription>
            <CardTitle className="text-xl">{poolAddress ? shortenAddress(poolAddress) : "Pending"}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">{curveState?.graduated ? "Verified DAMM v2" : "Awaiting graduation sync"}</CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
        <Card className="rounded-lg">
          <CardHeader>
            <CardTitle className="text-2xl">Trade</CardTitle>
            <CardDescription>Exact-input Meteora route</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <Tabs value={tab} onValueChange={(next) => setTab(next as SolanaMeteoraSide)}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="buy">Buy</TabsTrigger>
                <TabsTrigger value="sell">Sell</TabsTrigger>
              </TabsList>
            </Tabs>

            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span>{tab === "buy" ? "Spend SOL" : `Sell ${displaySymbol}`}</span>
                <button type="button" className="font-medium text-foreground hover:text-accent" onClick={handleSetMax}>
                  Max
                </button>
              </div>
              <Input
                inputMode="decimal"
                placeholder={tab === "buy" ? "0.0" : `0.0 ${displaySymbol}`}
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
            </div>

            <div className="grid gap-3 rounded-lg border border-border/60 bg-card/35 p-4 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Expected out</span>
                <span>{quoteOutputLabel} {tab === "buy" ? displaySymbol : "SOL"}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Minimum out</span>
                <span>{quoteMinimumLabel} {tab === "buy" ? displaySymbol : "SOL"}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Fee</span>
                <span>{quoteFeeLabel} {tab === "buy" ? "SOL" : displaySymbol}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Price impact</span>
                <span>{quote ? formatPercent(quote.priceImpactPct) : "—"}</span>
              </div>
            </div>

            {quoteError ? <p className="text-sm text-destructive">{quoteError}</p> : null}

            <Button type="button" className="w-full" disabled={actionDisabled} onClick={handlePrimaryAction}>
              {actionLabel}
            </Button>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card className="rounded-lg">
            <CardHeader>
              <CardTitle className="text-2xl">Wallet</CardTitle>
              <CardDescription>Live Solana balances</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">SOL</span>
                <span>{formatRawAmount(solBalanceLamports, 9, 6)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{displaySymbol}</span>
                <span>{formatRawAmount(tokenBalanceRaw, tokenDecimals, 6)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Campaign</span>
                <span>{shortenAddress(campaignAddress)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Mint</span>
                <span>{shortenAddress(mintAddress)}</span>
              </div>
            </CardContent>
          </Card>

          <Card className="rounded-lg">
            <CardHeader>
              <CardTitle className="text-2xl">Route</CardTitle>
              <CardDescription>Graduated pool and authorities</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Pool</span>
                <span className="text-right">{poolAddress ? shortenAddress(poolAddress) : "Pending"}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Creator</span>
                <span className="text-right">{shortenAddress(curveState?.creator || campaign?.creator)}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Reserved LP</span>
                <span className="text-right">{formatRawAmount(curveState?.liquidityTokenSupply ?? null, tokenDecimals, 4)}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Buyer count</span>
                <span className="text-right">{curveState?.buyerCount != null ? curveState.buyerCount.toString() : "—"}</span>
              </div>
              <div className="flex flex-wrap gap-2 pt-2">
                {campaignExplorer ? (
                  <Button asChild variant="outline" size="sm">
                    <a href={campaignExplorer} target="_blank" rel="noreferrer">Campaign</a>
                  </Button>
                ) : null}
                {tokenExplorer ? (
                  <Button asChild variant="outline" size="sm">
                    <a href={tokenExplorer} target="_blank" rel="noreferrer">Mint</a>
                  </Button>
                ) : null}
                {poolExplorer ? (
                  <Button asChild variant="outline" size="sm">
                    <a href={poolExplorer} target="_blank" rel="noreferrer">Pool</a>
                  </Button>
                ) : null}
              </div>
            </CardContent>
          </Card>

          {lastSignature ? (
            <Card className="rounded-lg">
              <CardHeader>
                <CardTitle className="text-2xl">Latest swap</CardTitle>
                <CardDescription>Most recent confirmed Meteora transaction</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Signature</span>
                  <span>{shortenAddress(lastSignature)}</span>
                </div>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => handleCopy(lastSignature, "Signature")}>
                    Copy
                  </Button>
                  {txExplorer ? (
                    <Button asChild variant="outline" size="sm">
                      <a href={txExplorer} target="_blank" rel="noreferrer">Open</a>
                    </Button>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default SolanaGraduatedTokenDetails;
