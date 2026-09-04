import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { isSolanaChainId } from "@/lib/chainConfig";
import {
  executeTopazBuy,
  executeTopazSell,
  ensureTopazSellAllowance,
  quoteTopazBuy,
  quoteTopazSell,
  resolveImportedTopazRoute,
} from "@/lib/arenaImportedTopaz";
import {
  executeSolanaMeteoraSwap,
  fetchSolanaMeteoraPoolSnapshot,
  quoteSolanaMeteoraExactIn,
} from "@/lib/solanaMeteoraTrade";
import type { ArenaImportItem } from "@/lib/arenaImports";

export function ImportedTradePanel({ item }: { item: ArenaImportItem }) {
  const wallet = useWallet();
  const { solanaAccount } = useSolanaWallet();
  const solana = isSolanaChainId(item.chainId);
  const decimals = Number((item.scan as { decimals?: number } | undefined)?.decimals ?? (solana ? 9 : 18));
  const [poolLabel, setPoolLabel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState("");
  const [side, setSide] = useState<"buy" | "sell">("buy");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (solana) {
          const snap = await fetchSolanaMeteoraPoolSnapshot({ mint: item.tokenAddress, tokenDecimals: decimals });
          if (!cancelled) setPoolLabel(snap?.pool ? `Meteora ${snap.pool.slice(0, 8)}…` : null);
          return;
        }
        if (!wallet.provider) {
          if (!cancelled) setPoolLabel(null);
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
  }, [decimals, item.chainId, item.tokenAddress, solana, wallet.provider]);

  if (!poolLabel) {
    return (
      <p className="text-sm text-muted-foreground">
        In-app swaps for imported tokens are only enabled when a Topaz or Meteora pool is resolved. Uniswap V3 is detected in review only. This token is view-only until a supported pool is found.
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
      if (solana) {
        if (!solanaAccount) throw new Error("Connect the Solana wallet first.");
        const amountInRaw = side === "buy" ? ethers.parseUnits(String(raw), 9) : ethers.parseUnits(String(raw), decimals);
        const quote = await quoteSolanaMeteoraExactIn({
          mint: item.tokenAddress,
          tokenDecimals: decimals,
          side,
          amountInRaw,
          slippagePct: 1,
        });
        await executeSolanaMeteoraSwap({
          quote,
          mint: item.tokenAddress,
          tokenDecimals: decimals,
          walletAddress: solanaAccount,
        });
        toast.success("Swap submitted.");
        return;
      }
      if (!wallet.provider || !wallet.signer || !wallet.account) throw new Error("Connect the BNB wallet first.");
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
        Pool resolved: {poolLabel}. This is a direct DEX swap for an imported token — no bonding curve and no MemeWarzone campaign fees.
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
        Amount ({side === "buy" ? (solana ? "SOL" : "BNB") : item.symbol || "token"})
        <input
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          className="mt-1 w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-foreground"
          placeholder="0.0"
        />
      </label>
      <Button className="font-retro" disabled={busy || !amount} onClick={() => void trade()}>
        {busy ? "Swapping..." : `${side === "buy" ? "Buy" : "Sell"} on ${solana ? "Meteora" : "Topaz"}`}
      </Button>
    </div>
  );
}
