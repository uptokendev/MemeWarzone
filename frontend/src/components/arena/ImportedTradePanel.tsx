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

export function ImportedTradePanel({ item, initialSide = "buy" }: { item: ArenaImportItem; initialSide?: "buy" | "sell" }) {
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
  const [side, setSide] = useState<"buy" | "sell">(initialSide);
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

  // UI redesign: the same panel look as a launched coin (founder: "we shouldn't see any difference");
  // the route underneath (Jupiter / PancakeSwap via KyberSwap / Uniswap V3) is unchanged.
  const dex = aggregated && !noAggregatorRoute ? (solana ? "Jupiter" : "PancakeSwap") : poolLabel || "the DEX";
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
          {aggregated && !noAggregatorRoute ? `Best price via ${solana ? "Jupiter" : "PancakeSwap"}` : `Pool ${poolLabel || "resolving…"}`}
        </span>
        {aggregated && !noAggregatorRoute ? <span className={chip}>Fee {IMPORT_SWAP_FEE_LABEL}</span> : null}
      </div>
      {aggregated && preview ? (
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
          {preview.route.length ? (
            <div className="flex justify-between gap-2 text-mw-muted">
              <span>Route</span>
              <span className="truncate">{Array.from(new Set(preview.route)).join(" → ")}</span>
            </div>
          ) : null}
          {preview.priceImpactPct != null && preview.priceImpactPct > 1 ? (
            <div className={preview.priceImpactPct > 5 ? "text-mw-down" : "text-[#FF9A4D]"}>Price impact {preview.priceImpactPct.toFixed(2)}%</div>
          ) : null}
        </div>
      ) : null}
      {aggregated && previewError && !preview ? <p className="m-0 text-xs text-[#FF9A4D]">{previewError}</p> : null}
      <Button
        className={`min-h-12 w-full rounded-[10px] font-mw-body text-base font-bold disabled:opacity-50 ${side === "buy" ? "border border-mw-buy bg-mw-buy text-[#04140A] hover:bg-[#15913F]" : "border border-mw-sell bg-mw-sell text-[#FFF1F3] hover:bg-[#C81A40]"}`}
        disabled={busy || !amount}
        onClick={() => void trade()}
      >
        {busy ? "Swapping..." : `${side === "buy" ? "Buy" : "Sell"} on ${dex}`}
      </Button>
    </div>
  );
}
