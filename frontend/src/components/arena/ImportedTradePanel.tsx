import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { toast } from "sonner";
import { announceImportTrade } from "@/lib/importTradeEvents";

import { Button } from "@/components/ui/button";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { getNativeSymbol, isRobinhoodChainId, isSolanaChainId, type SupportedChainId } from "@/lib/chainConfig";
import { getReadProvider } from "@/lib/readProvider";
import { resolveImportedTopazRoute } from "@/lib/arenaImportedTopaz";
import { NO_IMPORT_SWAP_ROUTE, executeFeeRouterTrade, importSwapFeeRouterAddress, quoteFeeRouterTrade } from "@/lib/importSwapFeeRouter.mjs";
import {
  executeRobinhoodV3Buy,
  executeRobinhoodV3Sell,
  ensureRobinhoodV3SellAllowance,
  quoteRobinhoodV3Buy,
  quoteRobinhoodV3Sell,
  resolveImportedRobinhoodV3Route,
} from "@/lib/arenaImportedRobinhood";
import type { ArenaImportItem } from "@/lib/arenaImports";
import { activeImportSwapFeeTerms4663, executeImportSwap4663, quoteImportSwap4663, resolveImportPool } from "@/lib/robinhoodImportSwap.mjs";
import {
  importSwapFeeLabel,
  importSwapVenueLabel,
  executeBscImportSwap,
  executeSolanaImportSwap,
  quoteImportSwap,
  readImportTokenDecimals,
  type ImportSwapQuote,
} from "@/lib/importSwap";

/**
 * Reads for an EVM import go to the coin's own chain, never through the wallet: a wallet sitting on
 * another chain would read the wrong network (no pool, wrong decimals) before the user even trades.
 */
function importReadProvider(chainId: number): ethers.Provider | null {
  if (isSolanaChainId(chainId)) return null;
  try {
    return getReadProvider(chainId as SupportedChainId);
  } catch {
    return null;
  }
}

export function ImportedTradePanel({ item, initialSide = "buy" }: { item: ArenaImportItem; initialSide?: "buy" | "sell" }) {
  const wallet = useWallet();
  const { solanaAccount } = useSolanaWallet();
  const solana = isSolanaChainId(item.chainId);
  const robinhood = isRobinhoodChainId(item.chainId);
  const native = getNativeSymbol(item.chainId);
  // Imports on Solana (Jupiter) and BNB mainnet (KyberSwap over the coin's DEX pools: PancakeSwap,
  // Topaz, Uniswap, THENA, Biswap, ...) swap through the aggregator path with the platform fee the API quotes; Robinhood keeps its Uniswap V3 route.
  const aggregated = solana || Number(item.chainId) === 56;
  const readProvider = importReadProvider(item.chainId);
  // Robinhood mainnet imports swap through Uniswap's Universal Router with the platform fee of
  // robinhoodImportSwap.mjs (founder, 2026-10-03); the testnet keeps the fee-less adapter route.
  const robinhoodFee = Number(item.chainId) === 4663;
  // BNB coins with no Kyber route (IMPORT_SWAP_NO_ROUTE on 56; always on testnet 97, where
  // Kyber does not exist) trade their Topaz pool through ImportSwapFeeRouter, with the fee. Without a
  // configured router there is no trade: never the fee-free Topaz swap (CO-IMP rev 2 CI4).
  const bscTestnet = Number(item.chainId) === 97;
  const feeRouter = importSwapFeeRouterAddress(item.chainId) as string | null;
  const scanDecimals = (item.scan as { decimals?: number } | undefined)?.decimals;
  const [chainDecimals, setChainDecimals] = useState<number | null>(null);
  const decimals = Number(chainDecimals ?? scanDecimals ?? (solana ? 9 : 18));
  const [poolLabel, setPoolLabel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState("");
  const [side, setSide] = useState<"buy" | "sell">(initialSide);
  const [preview, setPreview] = useState<ImportSwapQuote | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [noAggregatorRoute, setNoAggregatorRoute] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void readImportTokenDecimals(item.chainId, item.tokenAddress, readProvider).then((value) => {
      if (!cancelled && value !== null) setChainDecimals(value);
    });
    return () => {
      cancelled = true;
    };
  }, [item.chainId, item.tokenAddress, readProvider]);

  function amountRaw(): bigint | null {
    const text = String(amount || "").trim();
    if (!text || !(Number(text) > 0)) return null;
    try {
      return side === "buy" ? ethers.parseUnits(text, solana ? 9 : 18) : ethers.parseUnits(text, decimals);
    } catch {
      return null;
    }
  }

  // Live quote: what you receive, the route and the fee, before you sign.
  useEffect(() => {
    if (!aggregated && !robinhood && !bscTestnet) return;
    const raw = amountRaw();
    setPreviewError(null);
    if (!raw) {
      setPreview(null);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      (robinhood ? quoteRobinhoodPreview(raw) : bscTestnet ? quoteFeeRouterPreview(raw) : quoteBscOrFeeRouterPreview(raw, controller.signal))
        .then((next) => {
          if (controller.signal.aborted) return;
          setPreview(next);
          setNoAggregatorRoute(next.provider === "import-swap-fee-router");
        })
        .catch((error: Error & { code?: string }) => {
          if (controller.signal.aborted) return;
          setPreview(null);
          if (error?.code === "IMPORT_SWAP_NO_ROUTE") setNoAggregatorRoute(true);
          setPreviewError(String(error?.message || "No quote"));
        });
    }, 450);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aggregated, robinhood, bscTestnet, feeRouter, amount, side, decimals, item.chainId, item.tokenAddress]);

  /** BNB: Kyber first; with no Kyber route, the fee router's Topaz quote when a router is configured. */
  async function quoteBscOrFeeRouterPreview(raw: bigint, signal: AbortSignal): Promise<ImportSwapQuote> {
    try {
      return await quoteImportSwap({ chainId: item.chainId, token: item.tokenAddress, side, amountRaw: raw, signal });
    } catch (error) {
      if ((error as { code?: string })?.code === "IMPORT_SWAP_NO_ROUTE" && Number(item.chainId) === 56 && feeRouter) return quoteFeeRouterPreview(raw);
      throw error;
    }
  }

  /** Topaz through ImportSwapFeeRouter, same preview shape; amountOut is after the fee. */
  async function quoteFeeRouterPreview(raw: bigint): Promise<ImportSwapQuote> {
    if (!feeRouter || !readProvider) throw Object.assign(new Error(NO_IMPORT_SWAP_ROUTE), { code: "IMPORT_SWAP_NO_ROUTE" });
    const resolved = await resolveImportedTopazRoute({ provider: readProvider, tokenAddress: item.tokenAddress, chainId: item.chainId });
    if (!resolved) throw Object.assign(new Error(NO_IMPORT_SWAP_ROUTE), { code: "IMPORT_SWAP_NO_ROUTE" });
    const quote = await quoteFeeRouterTrade({ provider: readProvider, routerAddress: feeRouter, resolved, side, amountIn: raw, slippageBps: 100 });
    return {
      chainId: item.chainId,
      provider: "import-swap-fee-router",
      side,
      amountIn: quote.amountIn.toString(),
      amountOut: quote.amountOut.toString(),
      minAmountOut: quote.minOut.toString(),
      priceImpactPct: null,
      feeBps: quote.feeBps,
      creatorShareBps: quote.creatorShareBps,
      feeNativeRaw: quote.feeWei.toString(),
      route: [`Topaz ${resolved.pairAddress.slice(0, 10)}…`],
      quote: null,
    };
  }

  /** Robinhood quotes on chain (QuoterV2 through the coin's deepest Uniswap V3 pool), same preview shape. */
  async function quoteRobinhoodPreview(raw: bigint): Promise<ImportSwapQuote> {
    if (!readProvider) throw new Error("Robinhood RPC is not configured.");
    if (robinhoodFee) {
      const quote = await quoteImportSwap4663({ provider: readProvider, token: item.tokenAddress, side, amountIn: raw, slippageBps: 100 });
      return {
        chainId: item.chainId,
        provider: "uniswap-universal-router",
        side,
        amountIn: quote.amountIn.toString(),
        amountOut: quote.amountOut.toString(),
        minAmountOut: quote.minOut.toString(),
        priceImpactPct: null,
        feeBps: quote.feeBps,
        creatorShareBps: quote.creatorShareBps,
        feeNativeRaw: quote.feeWei.toString(),
        route: [`Uniswap V3 ${(quote.route.fee / 10000).toFixed(2)}%`],
        quote: null,
      };
    }
    const route = await resolveImportedRobinhoodV3Route({ provider: readProvider, tokenAddress: item.tokenAddress, chainId: item.chainId });
    if (!route) throw new Error("No Uniswap V3 pool with ETH for this token.");
    const quote = side === "buy" ? await quoteRobinhoodV3Buy(readProvider, route, raw, 100) : await quoteRobinhoodV3Sell(readProvider, route, raw, 100);
    return {
      chainId: item.chainId,
      provider: "uniswap-v3",
      side,
      amountIn: quote.amountInRaw.toString(),
      amountOut: quote.amountOutRaw.toString(),
      minAmountOut: quote.minimumOutRaw.toString(),
      priceImpactPct: null,
      feeBps: 0,
      feeNativeRaw: null,
      route: [`Uniswap V3 ${(route.fee / 10000).toFixed(2)}%`],
      quote: null,
    };
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (solana) {
          if (!cancelled) setPoolLabel("Jupiter");
          return;
        }
        if (Number(item.chainId) === 56) {
          if (!cancelled) setPoolLabel("KyberSwap");
          return;
        }
        if (!readProvider) {
          if (!cancelled) setPoolLabel(null);
          return;
        }
        if (robinhoodFee) {
          const pool = await resolveImportPool(readProvider, item.tokenAddress);
          if (!cancelled) setPoolLabel(pool ? `Uniswap V3 ${pool.pool.slice(0, 10)}…` : "");
          return;
        }
        if (robinhood) {
          const route = await resolveImportedRobinhoodV3Route({
            provider: readProvider,
            tokenAddress: item.tokenAddress,
            chainId: item.chainId,
          });
          if (!cancelled) setPoolLabel(route ? `Uniswap V3 ${route.poolAddress.slice(0, 10)}…` : "");
          return;
        }
        const route = await resolveImportedTopazRoute({
          provider: readProvider,
          tokenAddress: item.tokenAddress,
          chainId: item.chainId,
        });
        if (!cancelled) setPoolLabel(route ? `Topaz ${route.pairAddress.slice(0, 10)}…` : null);
      } catch {
        if (!cancelled) setPoolLabel(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [decimals, item.chainId, item.tokenAddress, robinhood, solana, readProvider]);

  if (robinhood && poolLabel === "") {
    return (
      <p className="text-sm text-muted-foreground" data-robinhood-import-trade-pending="true">
        No Uniswap V3 pool with ETH for this token yet
      </p>
    );
  }
  if (bscTestnet && !feeRouter) {
    return (
      <p className="text-sm text-muted-foreground" data-import-no-fee-route="true">
        {NO_IMPORT_SWAP_ROUTE}
      </p>
    );
  }
  if (!poolLabel) {
    return (
      <p className="text-sm text-muted-foreground">
        In-app swaps for this imported token are not available on this chain yet.
      </p>
    );
  }

  async function trade() {
    const raw = Number(amount);
    if (!Number.isFinite(raw) || raw <= 0) {
      toast.error("Enter an amount.");
      return;
    }
    setBusy(true);
    try {
      const amountInRaw = amountRaw();
      if (!amountInRaw) throw new Error("Enter an amount.");
      if (solana) {
        if (!solanaAccount) throw new Error("Connect the Solana wallet first.");
        // Re-quote at submit so the signed route is current.
        const quote = await quoteImportSwap({ chainId: item.chainId, token: item.tokenAddress, side, amountRaw: amountInRaw });
        const signature = await executeSolanaImportSwap({ token: item.tokenAddress, side, wallet: solanaAccount, quote });
        toast.success(`Swap confirmed: ${signature.slice(0, 10)}…`);
        announceImportTrade({ chainId: item.chainId, tokenAddress: item.tokenAddress, side, maker: solanaAccount, amount: raw, txHash: signature });
        setAmount("");
        return;
      }
      if (!wallet.provider || !wallet.signer || !wallet.account) throw new Error(`Connect the ${native} wallet first.`);
      // The trade signs on the coin's own chain: switch the wallet first (same as our own coins'
      // panels) and sign with the fresh signer, never one bound to the previous network.
      let tradeSigner = wallet.signer;
      let tradeAccount = wallet.account;
      if (Number(wallet.chainId) !== Number(item.chainId)) {
        const switched = await wallet.switchToChain(item.chainId as SupportedChainId);
        tradeSigner = switched.signer;
        tradeAccount = switched.account || wallet.account;
      }
      if (Number(item.chainId) === 56 && !noAggregatorRoute) {
        const quote = await quoteImportSwap({ chainId: 56, token: item.tokenAddress, side, amountRaw: amountInRaw });
        const hash = await executeBscImportSwap({ token: item.tokenAddress, side, account: tradeAccount, signer: tradeSigner, quote, amountRaw: amountInRaw });
        toast.success(`Swap confirmed: ${hash.slice(0, 10)}…`);
        announceImportTrade({ chainId: item.chainId, tokenAddress: item.tokenAddress, side, maker: tradeAccount, amount: raw, txHash: hash });
        setAmount("");
        return;
      }
      const reads = readProvider || wallet.provider;
      if (robinhoodFee) {
        // Quote on the read RPC, then one Universal Router transaction (a sell adds a signed Permit2
        // permit and, the first time, an exact ERC20 approval to Permit2).
        const quote = await quoteImportSwap4663({ provider: reads, token: item.tokenAddress, side, amountIn: amountInRaw, slippageBps: 100 });
        await executeImportSwap4663({ signer: tradeSigner, quote, token: item.tokenAddress });
        toast.success("Swap confirmed.");
        announceImportTrade({ chainId: item.chainId, tokenAddress: item.tokenAddress, side, maker: tradeAccount, amount: raw });
        setAmount("");
        return;
      }
      if (robinhood) {
        const route = await resolveImportedRobinhoodV3Route({
          provider: reads,
          tokenAddress: item.tokenAddress,
          chainId: item.chainId,
        });
        if (!route) throw new Error("No Uniswap V3 pool with ETH for this token.");
        if (side === "buy") {
          const quote = await quoteRobinhoodV3Buy(reads, route, amountInRaw, 100);
          const tx = await executeRobinhoodV3Buy({ signer: tradeSigner, quote, recipient: tradeAccount });
          const receipt = await tx.wait();
          if (receipt && Number(receipt.status) !== 1) throw new Error("Swap transaction reverted.");
        } else {
          await ensureRobinhoodV3SellAllowance({ signer: tradeSigner, route, amountInRaw });
          const quote = await quoteRobinhoodV3Sell(reads, route, amountInRaw, 100);
          const tx = await executeRobinhoodV3Sell({ signer: tradeSigner, quote, recipient: tradeAccount });
          const receipt = await tx.wait();
          if (receipt && Number(receipt.status) !== 1) throw new Error("Swap transaction reverted.");
        }
        toast.success("Swap confirmed.");
        announceImportTrade({ chainId: item.chainId, tokenAddress: item.tokenAddress, side, maker: tradeAccount, amount: raw });
        setAmount("");
        return;
      }
      // BNB with no Kyber route: the coin's Topaz pool through ImportSwapFeeRouter, never fee-free.
      if (!feeRouter) throw new Error(NO_IMPORT_SWAP_ROUTE);
      const route = await resolveImportedTopazRoute({
        provider: reads,
        tokenAddress: item.tokenAddress,
        chainId: item.chainId,
      });
      if (!route) throw new Error(NO_IMPORT_SWAP_ROUTE);
      const quote = await quoteFeeRouterTrade({ provider: reads, routerAddress: feeRouter, resolved: route, side, amountIn: amountInRaw, slippageBps: 100 });
      const hash = await executeFeeRouterTrade({ signer: tradeSigner, account: tradeAccount, quote });
      toast.success(`Swap confirmed: ${hash.slice(0, 10)}…`);
      announceImportTrade({ chainId: item.chainId, tokenAddress: item.tokenAddress, side, maker: tradeAccount, amount: raw, txHash: hash });
      setAmount("");
      return;
    } catch (error) {
      toast.error(String((error as Error)?.message || "Swap failed."));
    } finally {
      setBusy(false);
    }
  }

  // UI redesign: the same panel look as a launched coin (founder: "we shouldn't see any difference");
  // the route underneath (Jupiter / KyberSwap over the coin's DEX pools / Uniswap V3) is unchanged.
  // BNB without a Kyber route and without the fee router: no trade at all.
  const noFeeRoute = !feeRouter && Number(item.chainId) === 56 && noAggregatorRoute;
  const feeRouted = Boolean(feeRouter) && (bscTestnet || (Number(item.chainId) === 56 && noAggregatorRoute));
  // BNB via Kyber: the DEX names of the quoted route (the coin's own pool), KyberSwap until a quote is in.
  const kyberRoute = !solana && preview?.provider === "kyberswap";
  const bscVenues = kyberRoute && preview ? Array.from(new Set(preview.route.map(importSwapVenueLabel))) : [];
  const routeLabels = preview ? (kyberRoute ? bscVenues : Array.from(new Set(preview.route))) : [];
  const dex = aggregated && !noAggregatorRoute ? (solana ? "Jupiter" : bscVenues.length ? bscVenues.join(" + ") : "KyberSwap") : feeRouted ? "Topaz" : robinhood ? "Uniswap" : poolLabel || "the DEX";
  const segTrigger = "mw-focus min-h-10 rounded-lg font-mw-body text-[15px] font-bold transition-colors";
  const chip = "inline-flex min-h-[30px] items-center rounded-lg border border-[#2E353D] bg-[#171B20] px-2.5 font-mw-mono text-[13px] text-[#C9CED4]";
  return (
    <div className="flex flex-col gap-2.5 font-mw-body text-mw-text">
      <div className="grid grid-cols-2 gap-1 rounded-[10px] border border-[#242A31] bg-[#13171C] p-1" role="tablist" aria-label="Buy or sell">
        <button type="button" role="tab" aria-selected={side === "buy"} className={`${segTrigger} ${side === "buy" ? "bg-mw-buy text-[#04140A]" : "text-mw-muted hover:text-mw-text"}`} onClick={() => setSide("buy")}>
          Buy
        </button>
        <button type="button" role="tab" aria-selected={side === "sell"} className={`${segTrigger} ${side === "sell" ? "bg-mw-sell text-[#FFF1F3]" : "text-mw-muted hover:text-mw-text"}`} onClick={() => setSide("sell")}>
          Sell
        </button>
      </div>
      <div className="flex items-center justify-between gap-2 text-[13px]">
        <span className="text-mw-muted">{side === "buy" ? "Pay in" : "Amount in"}</span>
        <span className={`${chip} border-mw-accent bg-[#2A1609] text-mw-accent-soft`}>{side === "buy" ? native : item.symbol || "token"}</span>
      </div>
      <div className="relative">
        <input
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          inputMode="decimal"
          aria-label={`Amount (${side === "buy" ? native : item.symbol || "token"})`}
          className="mw-focus h-12 w-full rounded-[10px] border border-[#2E353D] bg-mw-input pl-3.5 pr-20 font-mw-mono text-lg text-mw-text placeholder:text-[#5C6670] focus:border-mw-accent focus:outline-none"
          placeholder="0"
        />
        <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 font-mw-mono text-[13px] text-mw-muted">{side === "buy" ? native : item.symbol || "token"}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[13px] text-mw-muted">
          {aggregated && !noAggregatorRoute ? `Best price via ${solana ? "Jupiter" : "KyberSwap"}` : `Pool ${feeRouted && poolLabel === "KyberSwap" ? "Topaz" : poolLabel || "resolving…"}`}
        </span>
        {(aggregated && !noAggregatorRoute) || robinhoodFee || feeRouted ? (
          preview ? <span className={chip}>Fee {importSwapFeeLabel(preview.feeBps)}</span> : robinhoodFee ? <span className={chip}>Fee {importSwapFeeLabel(activeImportSwapFeeTerms4663().feeBps)}</span> : null
        ) : null}
      </div>
      {(aggregated || robinhood || bscTestnet) && preview ? (
        <div className="flex flex-col gap-1 font-mw-mono text-[13px]" data-import-swap-preview="true">
          <div className="flex justify-between gap-2">
            <span className="text-mw-muted">You receive ≈</span>
            <span>
              {side === "buy"
                ? `${Number(ethers.formatUnits(preview.amountOut, decimals)).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${item.symbol || "tokens"}`
                : `${Number(ethers.formatUnits(preview.amountOut, solana ? 9 : 18)).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${native}`}
            </span>
          </div>
          {preview.feeNativeRaw ? (
            <div className="flex justify-between gap-2 text-mw-muted">
              <span>Platform fee</span>
              <span>{Number(ethers.formatUnits(preview.feeNativeRaw, solana ? 9 : 18)).toLocaleString(undefined, { maximumFractionDigits: 6 })} {native}</span>
            </div>
          ) : null}
          {preview.feeNativeRaw && preview.creatorShareBps && preview.feeBps ? (
            <div className="flex justify-between gap-2 text-mw-muted" data-import-swap-creator-share="true">
              <span>Of which to the coin&apos;s creator</span>
              <span>{Number(ethers.formatUnits((BigInt(preview.feeNativeRaw) * BigInt(preview.creatorShareBps)) / BigInt(preview.feeBps), solana ? 9 : 18)).toLocaleString(undefined, { maximumFractionDigits: 6 })} {native}</span>
            </div>
          ) : null}
          {preview.route.length ? (
            <div className="flex justify-between gap-2 text-mw-muted">
              <span>Route</span>
              <span className="truncate">{routeLabels.join(" → ")}</span>
            </div>
          ) : null}
          {preview.priceImpactPct != null && preview.priceImpactPct > 1 ? (
            <div className={preview.priceImpactPct > 5 ? "text-mw-down" : "text-[#FF9A4D]"}>Price impact {preview.priceImpactPct.toFixed(2)}%</div>
          ) : null}
        </div>
      ) : null}
      {(aggregated || robinhood || bscTestnet) && previewError && !preview ? <p className="m-0 text-xs text-[#FF9A4D]">{previewError}</p> : null}
      {noFeeRoute ? (
        <p className="m-0 text-sm text-muted-foreground" data-import-no-fee-route="true">
          {NO_IMPORT_SWAP_ROUTE}
        </p>
      ) : null}
      <Button
        className={`min-h-12 w-full rounded-[10px] font-mw-body text-base font-bold disabled:opacity-50 ${side === "buy" ? "border border-mw-buy bg-mw-buy text-[#04140A] hover:bg-[#15913F]" : "border border-mw-sell bg-mw-sell text-[#FFF1F3] hover:bg-[#C81A40]"}`}
        disabled={busy || !amount || noFeeRoute}
        onClick={() => void trade()}
      >
        {busy ? "Swapping..." : `${side === "buy" ? "Buy" : "Sell"} on ${dex}`}
      </Button>
    </div>
  );
}
