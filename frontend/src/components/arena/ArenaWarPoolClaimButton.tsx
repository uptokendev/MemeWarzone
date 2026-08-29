import { useState } from "react";
import { Contract } from "ethers";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useWallet } from "@/contexts/WalletContext";
import { apiFetch } from "@/lib/apiBase";
import { getArenaWarPoolTreasuryAddress, type SupportedChainId } from "@/lib/chainConfig";
import { isSolanaWarzoneChain, SOLANA_WARZONE_ESCROW_NOT_LIVE } from "@/lib/arena/solanaWarzoneEscrow";

export function ArenaWarPoolClaimButton({
  battleId,
  chainId,
  label,
}: {
  battleId: string;
  chainId?: number;
  label?: string;
}) {
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  const id = Number(chainId || wallet.chainId || 56);
  const solanaBlocked = isSolanaWarzoneChain(id);

  if (solanaBlocked) {
    return <p className="text-sm text-muted-foreground">{SOLANA_WARZONE_ESCROW_NOT_LIVE}</p>;
  }
  if (!getArenaWarPoolTreasuryAddress(id as SupportedChainId)) return null;

  async function claim() {
    if (!wallet.signer) {
      toast.error("Connect the winning campaign owner wallet.");
      return;
    }
    setBusy(true);
    try {
      const res = await apiFetch(`/api/arena/war-pools/${encodeURIComponent(battleId)}/claim-intent`, { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.ok === false) throw new Error(String(json?.error || `Claim intent failed (${res.status})`));
      const contract = new Contract(json.treasury, json.abi, wallet.signer);
      const onchain = await contract.pools(json.poolId);
      if (Number(onchain.state) !== 2) {
        const tx = await contract.resolve(json.poolId, json.resolve.winnerPayout, json.resolve.deadline, json.resolve.signature);
        await tx.wait();
      }
      const claimTx = await contract.claimWinner(json.poolId);
      await claimTx.wait();
      toast.success("War pool claimed. Protocol stays out of the send loop.");
    } catch (error) {
      toast.error(String((error as Error)?.message || "Claim failed."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button className="font-retro" disabled={busy} onClick={() => void claim()}>
      {busy ? "Claiming..." : label || "Claim battle rewards"}
    </Button>
  );
}
