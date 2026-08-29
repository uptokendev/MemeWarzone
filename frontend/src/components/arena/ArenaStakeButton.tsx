import { useEffect, useState } from "react";
import { Contract } from "ethers";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useWallet } from "@/contexts/WalletContext";
import { fetchArenaStakeStatus, postArenaStakeReceipt } from "@/features/postgrad/apiClient";
import { battleDurationLabel } from "@/lib/arena/battleDuration";
import { signWalletAction } from "@/lib/walletActionAuth";
import { getNativeSymbol } from "@/lib/chainConfig";
import { isSolanaWarzoneChain, SOLANA_WARZONE_ESCROW_NOT_LIVE } from "@/lib/arena/solanaWarzoneEscrow";

type StakeStatus = {
  configured?: boolean;
  treasury?: string;
  poolId?: string;
  abi?: string[];
  ownerA?: string;
  ownerB?: string;
  stakeWei?: string;
  stakeNative?: number;
  nativeSymbol?: string;
  opened?: boolean;
  paidA?: boolean;
  paidB?: boolean;
  bothPaid?: boolean;
  myRole?: "a" | "b" | null;
  nextMethod?: "openBattlePool" | "depositStake" | null;
  canRefund?: boolean;
  depositDeadline?: number;
  resolveDeadline?: number;
  durationHours?: number;
  chainId?: number;
};

export function ArenaStakeButton({
  battleId,
  chainId,
  walletAddress,
  battleState,
}: {
  battleId: string;
  chainId?: number;
  walletAddress?: string;
  battleState?: string;
}) {
  const wallet = useWallet();
  const [status, setStatus] = useState<StakeStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const id = Number(chainId || wallet.chainId || 56);
  const solanaBlocked = isSolanaWarzoneChain(id);

  async function refresh() {
    const json = await fetchArenaStakeStatus(battleId, walletAddress || wallet.account || "");
    setStatus(json);
    return json;
  }

  useEffect(() => {
    if (solanaBlocked) return;
    void refresh().catch(() => setStatus(null));
  }, [battleId, walletAddress, battleState, solanaBlocked]);

  if (solanaBlocked) {
    return <p className="text-sm text-muted-foreground">{SOLANA_WARZONE_ESCROW_NOT_LIVE}</p>;
  }

  if (!status?.configured || status.bothPaid || battleState === "live" || battleState === "finished") return null;
  if (battleState && battleState !== "matched") return null;

  async function signReceipt(txHash: string) {
    return signWalletAction({
      action: "arena_deposit_stake",
      walletAddress: String(walletAddress || wallet.account),
      chainId: Number(status?.chainId || id),
      extraLines: [`Battle: ${battleId}`, `Tx: ${txHash}`],
      signer: wallet.signer,
    });
  }

  async function openPool() {
    if (!wallet.signer) {
      toast.error("Connect the owner wallet.");
      return;
    }
    setBusy("open");
    try {
      const latest = (await refresh()) || status;
      if (!latest?.treasury || !latest.poolId) throw new Error("War pool treasury is not deployed on this chain yet.");
      const contract = new Contract(latest.treasury, latest.abi || [], wallet.signer);
      const value = BigInt(latest.stakeWei || "0");
      const tx = await contract.openBattlePool(
        latest.poolId,
        latest.ownerA,
        latest.ownerB,
        value,
        latest.depositDeadline,
        latest.resolveDeadline,
        { value: 0n },
      );
      await tx.wait();
      toast.success("Agreed pool is open. Both owners can now deposit the same stake.");
      await refresh();
    } catch (error) {
      toast.error(String((error as Error)?.message || "Could not open the agreed pool."));
    } finally {
      setBusy(null);
    }
  }

  async function pay() {
    if (!wallet.signer) {
      toast.error("Connect the owner wallet to pay this stake.");
      return;
    }
    setBusy("pay");
    try {
      const latest = (await refresh()) || status;
      if (!latest?.treasury || !latest.poolId || latest.nextMethod !== "depositStake") {
        toast.error("The agreed pool must be open before anyone deposits.");
        return;
      }
      const contract = new Contract(latest.treasury, latest.abi || [], wallet.signer);
      const tx = await contract.depositStake(latest.poolId, { value: BigInt(latest.stakeWei || "0") });
      await tx.wait();
      const auth = await signReceipt(tx.hash);
      const receipt = await postArenaStakeReceipt(battleId, { txHash: tx.hash, auth });
      toast.success(receipt.bothPaid ? "Both stakes are in. The fight clock is live." : "Stake deposited. Waiting on the other owner.");
      await refresh();
    } catch (error) {
      toast.error(String((error as Error)?.message || "Stake deposit failed."));
    } finally {
      setBusy(null);
    }
  }

  async function refund() {
    if (!wallet.signer) {
      toast.error("Connect the owner wallet to refund.");
      return;
    }
    setBusy("refund");
    try {
      const latest = (await refresh()) || status;
      if (!latest?.treasury || !latest.poolId) throw new Error("Pool not found.");
      const contract = new Contract(latest.treasury, latest.abi || [], wallet.signer);
      const tx = await contract.refundStake(latest.poolId);
      await tx.wait();
      toast.success("Stake refunded. The other owner never deposited in time.");
      await refresh();
    } catch (error) {
      toast.error(String((error as Error)?.message || "Refund failed. Deposits can be pulled after the pay window."));
    } finally {
      setBusy(null);
    }
  }

  const minePaid = status.myRole === "a" ? status.paidA : status.myRole === "b" ? status.paidB : false;
  const length = battleDurationLabel(status.durationHours);

  return (
    <div className="flex flex-wrap gap-2">
      {status.nextMethod === "openBattlePool" ? (
        <Button className="font-retro" disabled={Boolean(busy)} onClick={() => void openPool()}>
          {busy === "open" ? "Opening pool..." : `Open agreed ${length} pool`}
        </Button>
      ) : null}
      {status.nextMethod === "depositStake" ? (
        <Button className="font-retro" disabled={Boolean(busy)} onClick={() => void pay()}>
          {busy === "pay" ? "Paying stake..." : `Pay ${status.stakeNative ?? ""} ${status.nativeSymbol || getNativeSymbol(id)}`}
        </Button>
      ) : null}
      {minePaid && !status.bothPaid && !status.canRefund ? (
        <Button className="font-retro" variant="outline" disabled>
          Waiting on rival
        </Button>
      ) : null}
      {status.canRefund ? (
        <Button className="font-retro" variant="outline" disabled={Boolean(busy)} onClick={() => void refund()}>
          {busy === "refund" ? "Refunding..." : "Refund stake"}
        </Button>
      ) : null}
    </div>
  );
}
