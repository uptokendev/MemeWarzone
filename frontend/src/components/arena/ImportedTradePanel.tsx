import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { PublicKey } from "@solana/web3.js";
import { toast } from "sonner";
import { announceImportTrade } from "@/lib/importTradeEvents";

import { Button } from "@/components/ui/button";
import { cp } from "@/components/token/coinPageStyles";
import { getSolanaReadConnection } from "@/lib/solanaReadConnection";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { getNativeSymbol, isRobinhoodChainId, isSolanaChainId, type SupportedChainId } from "@/lib/chainConfig";
import { getReadProvider } from "@/lib/readProvider";
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
import { executeImportSwap4663, quoteImportSwap4663, resolveImportPool } from "@/lib/robinhoodImportSwap.mjs";
import {
  IMPORT_SWAP_FEE_LABEL,
  importSwapFeeLabel,
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
  // Imports on Solana (Jupiter) and BNB mainnet (PancakeSwap via KyberSwap) swap through the
  // aggregator path with the 0.5% platform fee; Robinhood keeps its Uniswap V3 route.
  const aggregated = solana || Number(item.chainId) === 56;
  const readProvider = importReadProvider(item.chainId);
  // Robinhood mainnet imports swap through Uniswap's Universal Router with the same 0.5% platform
  // fee as BNB and Solana (founder, 2026-10-03); the testnet keeps the fee-less adapter route.
  const robinhoodFee = Number(item.chainId) === 4663;
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

  // Wallet balances for the Balance row (reads only; the swap itself does not use them).
  const account = solana ? (solanaAccount ? String(solanaAccount) : null) : wallet.account ? String(wallet.account) : null;
  const [balances, setBalances] = useState<{ nativeRaw: bigint; tokenRaw: bigint } | null>(null);
  useEffect(() => {
    if (!account) {
      setBalances(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        let nativeRaw: bigint;
        let tokenRaw = 0n;
        if (solana) {
          const connection = getSolanaReadConnection();
          const owner = new PublicKey(account);
          const [lamports, accounts] = await Promise.all([
            connection.getBalance(owner, "confirmed"),
            connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(item.tokenAddress) }, "confirmed"),
          ]);
          nativeRaw = BigInt(lamports);
          for (const entry of accounts.value) tokenRaw += BigInt((entry.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed?.info?.tokenAmount?.amount || "0");
        } else {
          if (!readProvider) return;
          const erc20 = new ethers.Contract(item.tokenAddress, ["function balanceOf(address) view returns (uint256)"], readProvider);
          const [native, token] = await Promise.all([readProvider.getBalance(account), erc20.balanceOf(account) as Promise<bigint>]);
          nativeRaw = BigInt(native);
          tokenRaw = BigInt(token);
        }
        if (!cancelled) setBalances({ nativeRaw, tokenRaw });
      } catch {
        if (!cancelled) setBalances(null);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [account, item.tokenAddress, readProvider, solana]);

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
    if (!aggregated && !robinhood) return;
    const raw = amountRaw();
    setPreviewError(null);
    if (!raw) {
      setPreview(null);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      (robinhood ? quoteRobinhoodPreview(raw) : quoteImportSwap({ chainId: item.chainId, token: item.tokenAddress, side, amountRaw: raw, signal: controller.signal }))
        .then((next) => {
          if (controller.signal.aborted) return;
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
  }, [aggregated, robinhood, amount, side, decimals, item.chainId, item.tokenAddress]);

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
        feeBps: 50,
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
          if (!cancelled) setPoolLabel("PancakeSwap");
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
      const route = await resolveImportedTopazRoute({
        provider: reads,
        tokenAddress: item.tokenAddress,
        chainId: item.chainId,
      });
      if (!route) throw new Error("Topaz pool is not available.");
      if (side === "buy") {
        const quote = await quoteTopazBuy({
          provider: reads,
          resolved: route,
          nativeAmountInRaw: ethers.parseEther(String(raw)),
          slippageBps: 100,
        });
        const tx = await executeTopazBuy({ signer: tradeSigner, recipient: tradeAccount, quote });
        await tx.wait();
      } else {
        const tokenAmount = ethers.parseUnits(String(raw), decimals);
        await ensureTopazSellAllowance({
          signer: tradeSigner,
          owner: tradeAccount,
          resolved: route,
          tokenAmountRaw: tokenAmount,
        });
        const quote = await quoteTopazSell({
          provider: reads,
          resolved: route,
          tokenAmountInRaw: tokenAmount,
          slippageBps: 100,
        });
        const tx = await executeTopazSell({ signer: tradeSigner, recipient: tradeAccount, quote });
        await tx.wait();
      }
      toast.success("Swap confirmed.");
      announceImportTrade({ chainId: item.chainId, tokenAddress: item.tokenAddress, side, maker: tradeAccount, amount: raw });
    } catch (error) {
      toast.error(String((error as Error)?.message || "Swap failed."));
    } finally {
      setBusy(false);
    }
  }

  // UI redesign: the same panel look as a launched coin (founder: "we shouldn't see any difference");
  // the route underneath (Jupiter / PancakeSwap via KyberSwap / Uniswap V3) is unchanged.
  const dex = aggregated && !noAggregatorRoute ? (solana ? "Jupiter" : "PancakeSwap") : robinhood ? "Uniswap" : poolLabel || "the DEX";
  const unit = side === "buy" ? native : item.symbol || "token";
  const nativeDecimals = solana ? 9 : 18;
  const fmt = (raw: string | bigint, units: number, digits: number) => Number(ethers.formatUnits(raw, units)).toLocaleString(undefined, { maximumFractionDigits: digits });
  const quoted = (aggregated && !noAggregatorRoute) || robinhoodFee;
  const feeLabel = preview ? importSwapFeeLabel(preview.feeBps) : robinhoodFee ? IMPORT_SWAP_FEE_LABEL : null;
  const row = "flex items-center justify-between gap-2";
  return (
    <div className="flex flex-col gap-3.5 font-mw-body text-mw-text">
      <div className={cp.segList} role="tablist" aria-label="Buy or sell">
        <button type="button" role="tab" aria-selected={side === "buy"} data-state={side === "buy" ? "active" : "inactive"} className={cp.segBuy} onClick={() => setSide("buy")}>
          Buy
        </button>
        <button type="button" role="tab" aria-selected={side === "sell"} data-state={side === "sell" ? "active" : "inactive"} className={cp.segSell} onClick={() => setSide("sell")}>
          Sell
        </button>
      </div>
      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-xs text-mw-muted">
            {aggregated && !noAggregatorRoute ? `Best price via ${solana ? "Jupiter" : "PancakeSwap"}` : `Pool ${poolLabel || "resolving…"}`}
          </span>
          {aggregated || robinhood ? <span className="whitespace-nowrap text-xs text-mw-muted">Slippage: 1%</span> : null}
        </div>
        <div className="relative">
          <input
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            inputMode="decimal"
            aria-label={`Amount (${unit})`}
            className={cp.amountInput}
            placeholder="0"
          />
          <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 font-mw-mono text-sm text-mw-muted">{unit}</span>
        </div>
        <div className={`${cp.inset} mt-3 flex flex-col gap-1.5 p-3 text-sm`} data-import-swap-preview={preview ? "true" : undefined}>
          <div className={row}>
            <span className="text-mw-muted">Balance</span>
            <span className="font-mw-mono text-mw-text">
              {balances ? (side === "buy" ? `${fmt(balances.nativeRaw, nativeDecimals, 4)} ${native}` : `${fmt(balances.tokenRaw, decimals, 2)} ${item.symbol || "tokens"}`) : "—"}
            </span>
          </div>
          <div className={row}>
            <span className="text-mw-muted">Pay</span>
            <span className="font-mw-mono text-mw-text">{amount && Number(amount) > 0 ? `${amount} ${unit}` : "—"}</span>
          </div>
          <div className={row}>
            <span className="text-mw-muted">Receive</span>
            <span className="font-mw-mono font-bold text-mw-text">
              {(aggregated || robinhood) && preview
                ? side === "buy"
                  ? `${fmt(preview.amountOut, decimals, 2)} ${item.symbol || "tokens"} (est.)`
                  : `${fmt(preview.amountOut, nativeDecimals, 6)} ${native} (est.)`
                : "—"}
            </span>
          </div>
          {quoted && feeLabel ? (
            <div className={row}>
              <span className="text-mw-muted">Fee {feeLabel}</span>
              <span className="font-mw-mono text-mw-muted">{preview?.feeNativeRaw ? `${fmt(preview.feeNativeRaw, nativeDecimals, 6)} ${native}` : "—"}</span>
            </div>
          ) : null}
          {preview?.feeNativeRaw && preview.creatorShareBps && preview.feeBps ? (
            <div className={row} data-import-swap-creator-share="true">
              <span className="text-mw-muted">Of which to the coin&apos;s creator</span>
              <span className="font-mw-mono text-mw-muted">{fmt((BigInt(preview.feeNativeRaw) * BigInt(preview.creatorShareBps)) / BigInt(preview.feeBps), nativeDecimals, 6)} {native}</span>
            </div>
          ) : null}
          {preview?.route.length ? (
            <div className={row}>
              <span className="text-mw-muted">Route</span>
              <span className="truncate font-mw-mono text-mw-muted">{Array.from(new Set(preview.route)).join(" → ")}</span>
            </div>
          ) : null}
        </div>
        {preview?.priceImpactPct != null && preview.priceImpactPct > 1 ? (
          <p className={`mt-2 text-center text-xs ${preview.priceImpactPct > 5 ? "text-mw-down" : "text-[#FF9A4D]"}`}>Price impact {preview.priceImpactPct.toFixed(2)}%</p>
        ) : null}
        {(aggregated || robinhood) && previewError && !preview ? <p className="mt-2 text-center text-xs text-mw-down">{previewError}</p> : null}
      </div>
      <Button
        className={`min-h-12 w-full rounded-[10px] font-mw-body text-base font-bold disabled:opacity-50 ${side === "buy" ? "border border-mw-buy bg-mw-buy text-[#04140A] hover:bg-[#15913F]" : "border border-mw-sell bg-mw-sell text-[#FFF1F3] hover:bg-[#C81A40]"}`}
        disabled={account ? busy || !amount : false}
        onClick={() => {
          // No wallet yet: open the app's wallet window, as the launched-coin panel does.
          if (!account) {
            try { window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal")); } catch { /* ignore */ }
            return;
          }
          void trade();
        }}
      >
        {!account ? `Connect ${solana ? "SOL" : robinhood ? "Robinhood" : "BNB"} wallet` : busy ? "Swapping..." : `${side === "buy" ? "Buy" : "Sell"} on ${dex}`}
      </Button>
    </div>
  );
}
