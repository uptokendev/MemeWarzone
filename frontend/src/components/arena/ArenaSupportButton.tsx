import { useState } from "react";
import { Contract, parseEther } from "ethers";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { postArenaSupportReceipt } from "@/features/postgrad/apiClient";
import { signArenaWalletAction } from "@/lib/arena/signArenaWalletAction";
import { getNativeSymbol } from "@/lib/chainConfig";
import { isSolanaWarzoneChain, SOLANA_WARZONE_ESCROW_NOT_LIVE } from "@/lib/arena/solanaWarzoneEscrow";

export function ArenaSupportButton({
  poolSubjectId,
  sideTokenId,
  chainId,
  nativeSymbol,
  treasury,
  poolId,
  abi,
  opened,
  configured,
  disabled,
  onDone,
}: {
  poolSubjectId: string;
  sideTokenId: string;
  chainId?: number;
  nativeSymbol?: string;
  treasury?: string;
  poolId?: string;
  abi?: string[];
  opened?: boolean;
  configured?: boolean;
  disabled?: boolean;
  onDone?: () => void;
}) {
  const wallet = useWallet();
  const { solanaAccount } = useSolanaWallet();
  const [amount, setAmount] = useState("0.05");
  const [busy, setBusy] = useState(false);
  const id = Number(chainId || wallet.chainId || 56);
  const symbol = nativeSymbol || getNativeSymbol(id);
  const solanaBlocked = isSolanaWarzoneChain(id);

  async function donate() {
    if (solanaBlocked) {
      toast.error(SOLANA_WARZONE_ESCROW_NOT_LIVE);
      return;
    }
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
      toast.error(`Enter a ${symbol} amount to Support.`);
      return;
    }
    const walletAddress = String(wallet.account || "").trim();
    if (!walletAddress) {
      toast.error("Connect a wallet to Support.");
      return;
    }
    setBusy(true);
    try {
      let txHash = "";
      if (configured) {
        if (!opened || !treasury || !poolId || !wallet.signer) {
          toast.error("Tournament/battle escrow is not open yet. Ops opens the treasury pool first.");
          return;
        }
        const contract = new Contract(treasury, abi || [], wallet.signer);
        const tx = await contract.donateSupport(poolId, { value: parseEther(String(n)) });
        await tx.wait();
        txHash = tx.hash;
      }
      const auth = await signArenaWalletAction({
        action: "arena_war_pool_support",
        extraLines: [`Pool: ${poolSubjectId}`, `Token: ${sideTokenId}`, txHash ? `Tx: ${txHash}` : ""].filter(Boolean),
        walletAddress,
        chainId: id,
        evmWallet: wallet,
        solanaAccount,
      });
      await postArenaSupportReceipt(poolSubjectId, {
        sideTokenId,
        amountNative: n,
        amountUsd: n,
        walletAddress,
        txHash,
        auth,
      });
      toast.success("Support recorded. This is a donation — supporters are not paid.");
      onDone?.();
    } catch (error) {
      toast.error(String((error as Error)?.message || "Support failed."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor={`support-${sideTokenId}`}>
        Support amount
      </label>
      <input
        id={`support-${sideTokenId}`}
        type="number"
        min="0"
        step="0.01"
        value={amount}
        disabled={disabled || busy}
        onChange={(event) => setAmount(event.target.value)}
        className="w-24 rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm text-foreground"
      />
      <Button size="sm" className="font-retro" disabled={disabled || busy || solanaBlocked || !sideTokenId} onClick={() => void donate()}>
        {busy ? "Supporting..." : solanaBlocked ? "SOL escrow not live" : `Support ${symbol}`}
      </Button>
      {solanaBlocked ? <p className="basis-full text-xs text-muted-foreground">{SOLANA_WARZONE_ESCROW_NOT_LIVE}</p> : null}
    </div>
  );
}
