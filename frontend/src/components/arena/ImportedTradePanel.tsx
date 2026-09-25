import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { getNativeSymbol, isRobinhoodChainId, isSolanaChainId } from "@/lib/chainConfig";
import {
  executeTopazBuy,
  executeTopazSell,
  ensureTopazSellAllowance,
  quoteTopazBuy,
  quoteTopazSell,
  resolveImportedTopazRoute,
} from "@/lib/arenaImportedTopaz";
import {
  executeRobinhoodV3Buy,
  executeRobinhoodV3Sell,
  ensureRobinhoodV3SellAllowance,
  quoteRobinhoodV3Buy,
  quoteRobinhoodV3Sell,
  resolveImportedRobinhoodV3Route,
} from "@/lib/arenaImportedRobinhood";
import type { ArenaImportItem } from "@/lib/arenaImports";
import {
  IMPORT_SWAP_FEE_LABEL,
  executeBscImportSwap,
  executeSolanaImportSwap,
  quoteImportSwap,
  readImportTokenDecimals,
  type ImportSwapQuote,
} from "@/lib/importSwap";

export function ImportedTradePanel({ item }: { item: ArenaImportItem }) {
  const wallet = useWallet();
  const { solanaAccount } = useSolanaWallet();
  const solana = isSolanaChainId(item.chainId);
  const robinhood = isRobinhoodChainId(item.chainId);
  const native = getNativeSymbol(item.chainId);
  // Imports on Solana (Jupiter) and BNB mainnet (PancakeSwap via KyberSwap) swap through the
  // aggregator path with the 0.5% platform fee; Robinhood keeps its Uniswap V3 route.
  const aggregated = solana || Number(item.chainId) === 56;
  const scanDecimals = (item.scan as { decimals?: number } | undefined)?.decimals;
  const [chainDecimals, setChainDecimals] = useState<number | null>(null);
  const decimals = Number(chainDecimals ?? scanDecimals ?? (solana ? 9 : 18));
  const [poolLabel, setPoolLabel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState("");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [preview, setPreview] = useState<ImportSwapQuote | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [noAggregatorRoute, setNoAggregatorRoute] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void readImportTokenDecimals(item.chainId, item.tokenAddress, wallet.provider).then((value) => {
      if (!cancelled && value !== null) setChainDecimals(value);
    });
    return () => {
      cancelled = true;
    };
  }, [item.chainId, item.tokenAddress, wallet.provider]);

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
    if (!aggregated) return;
    const raw = amountRaw();
    setPreviewError(null);
    if (!raw) {
      setPreview(null);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      quoteImportSwap({ chainId: item.chainId, token: item.tokenAddress, side, amountRaw: raw, signal: controller.signal })
        .then((next) => {
          setPreview(next);
          setNoAggregatorRoute(false);
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
  }, [aggregated, amount, side, decimals, item.chainId, item.tokenAddress]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (solana) {
          if (!cancelled) setPoolLabel("Jupiter");
          return;
        }
        if (!wallet.provider) {
          if (!cancelled) setPoolLabel(null);
          return;
        }
        if (robinhood) {
          const route = await resolveImportedRobinhoodV3Route({
            provider: wallet.provider,
            tokenAddress: item.tokenAddress,
            chainId: item.chainId,
          });
          if (!cancelled) setPoolLabel(route ? `Uniswap V3 ${route.poolAddress.slice(0, 10)}…` : "");
          return;
        }
        if (Number(item.chainId) === 56) {
          if (!cancelled) setPoolLabel("PancakeSwap");
          return;
        }
        const route = await resolveImportedTopazRoute({
          provider: wallet.provider,
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
  }, [decimals, item.chainId, item.tokenAddress, robinhood, solana, wallet.provider]);

  if (robinhood && poolLabel === "") {
    return (
      <p className="text-sm text-muted-foreground" data-robinhood-import-trade-pending="true">
        Trading on Robinhood imports arrives next
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
        setAmount("");
        return;
      }
      if (!wallet.provider || !wallet.signer || !wallet.account) throw new Error(`Connect the ${native} wallet first.`);
      if (Number(item.chainId) === 56 && !noAggregatorRoute) {
        if (Number(wallet.chainId) !== 56) throw new Error("Switch your wallet to BNB Chain first.");
        const quote = await quoteImportSwap({ chainId: 56, token: item.tokenAddress, side, amountRaw: amountInRaw });
        const hash = await executeBscImportSwap({ token: item.tokenAddress, side, account: wallet.account, signer: wallet.signer, quote, amountRaw: amountInRaw });
        toast.success(`Swap confirmed: ${hash.slice(0, 10)}…`);
        setAmount("");
        return;
      }
      if (robinhood) {
        const route = await resolveImportedRobinhoodV3Route({
          provider: wallet.provider,
          tokenAddress: item.tokenAddress,
          chainId: item.chainId,
        });
        if (!route) throw new Error("Robinhood V3 pool is not available.");
        if (side === "buy") {
          const quote = await quoteRobinhoodV3Buy(wallet.provider, route, ethers.parseEther(String(raw)), 100);
          const tx = await executeRobinhoodV3Buy({ signer: wallet.signer, quote, recipient: wallet.account });
          await tx.wait();
        } else {
          const tokenAmount = ethers.parseUnits(String(raw), decimals);
          await ensureRobinhoodV3SellAllowance({ signer: wallet.signer, route, amountInRaw: tokenAmount });
          const quote = await quoteRobinhoodV3Sell(wallet.provider, route, tokenAmount, 100);
          const tx = await executeRobinhoodV3Sell({ signer: wallet.signer, quote, recipient: wallet.account });
          await tx.wait();
        }
        toast.success("Swap submitted.");
        return;
      }
      const route = await resolveImportedTopazRoute({
        provider: wallet.provider,
        tokenAddress: item.tokenAddress,
        chainId: item.chainId,
      });
      if (!route) throw new Error("Topaz pool is not available.");
      if (side === "buy") {
        const quote = await quoteTopazBuy({
          provider: wallet.provider,
          resolved: route,
          nativeAmountInRaw: ethers.parseEther(String(raw)),
          slippageBps: 100,
        });
        const tx = await executeTopazBuy({ signer: wallet.signer, recipient: wallet.account, quote });
        await tx.wait();
      } else {
        const tokenAmount = ethers.parseUnits(String(raw), decimals);
        await ensureTopazSellAllowance({
          signer: wallet.signer,
          owner: wallet.account,
          resolved: route,
          tokenAmountRaw: tokenAmount,
        });
        const quote = await quoteTopazSell({
          provider: wallet.provider,
          resolved: route,
          tokenAmountInRaw: tokenAmount,
          slippageBps: 100,
        });
        const tx = await executeTopazSell({ signer: wallet.signer, recipient: wallet.account, quote });
        await tx.wait();
      }
      toast.success("Swap confirmed.");
    } catch (error) {
      toast.error(String((error as Error)?.message || "Swap failed."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {aggregated && !noAggregatorRoute
          ? `Routed by ${solana ? "Jupiter" : "PancakeSwap"} at the best available price. ${IMPORT_SWAP_FEE_LABEL} platform fee.`
          : `Pool resolved: ${poolLabel}. Direct DEX swap for an imported token.`}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={`rounded px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] ${side === "buy" ? "bg-card text-foreground" : "text-muted-foreground"}`}
          onClick={() => setSide("buy")}
        >
          Buy
        </button>
        <button
          type="button"
          className={`rounded px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] ${side === "sell" ? "bg-card text-foreground" : "text-muted-foreground"}`}
          onClick={() => setSide("sell")}
        >
          Sell
        </button>
      </div>
      <label className="block text-xs uppercase tracking-[0.14em] text-muted-foreground">
        Amount ({side === "buy" ? native : item.symbol || "token"})
        <input
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          className="mt-1 w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-foreground"
          placeholder="0.0"
        />
      </label>
      {aggregated && preview ? (
        <div className="space-y-1 rounded-md border border-border/50 bg-background/40 px-3 py-2 text-xs text-muted-foreground" data-import-swap-preview="true">
          <div className="flex justify-between gap-2">
            <span>You receive ≈</span>
            <span className="text-foreground">
              {side === "buy"
                ? `${Number(ethers.formatUnits(preview.amountOut, decimals)).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${item.symbol || "tokens"}`
                : `${Number(ethers.formatUnits(preview.amountOut, solana ? 9 : 18)).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${native}`}
            </span>
          </div>
          <div className="flex justify-between gap-2">
            <span>Platform fee</span>
            <span>
              {IMPORT_SWAP_FEE_LABEL}
              {preview.feeNativeRaw ? ` (${Number(ethers.formatUnits(preview.feeNativeRaw, solana ? 9 : 18)).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${native})` : ""}
            </span>
          </div>
          {preview.route.length ? (
            <div className="flex justify-between gap-2">
              <span>Route</span>
              <span className="truncate">{Array.from(new Set(preview.route)).join(" → ")}</span>
            </div>
          ) : null}
          {preview.priceImpactPct != null && preview.priceImpactPct > 1 ? (
            <div className={preview.priceImpactPct > 5 ? "text-destructive" : "text-orange-300"}>Price impact {preview.priceImpactPct.toFixed(2)}%</div>
          ) : null}
        </div>
      ) : null}
      {aggregated && previewError && !preview ? <p className="text-xs text-orange-300">{previewError}</p> : null}
      <Button className="font-retro" disabled={busy || !amount} onClick={() => void trade()}>
        {busy ? "Swapping..." : side === "buy" ? "Buy" : "Sell"}
      </Button>
    </div>
  );
}
