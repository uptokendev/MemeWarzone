import { useEffect, useState } from "react";
import { Contract } from "ethers";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { useWallet } from "@/contexts/WalletContext";
import { fetchArenaStakeStatus, postArenaStakeReceipt } from "@/features/postgrad/apiClient";
import { battleDurationLabel } from "@/lib/arena/battleDuration";
import { isSolanaWarzoneChain, isSolanaWarzoneMoneyLive, SOLANA_WARZONE_ESCROW_NOT_LIVE } from "@/lib/arena/solanaWarzoneEscrow";
import { signArenaWalletAction } from "@/lib/arena/signArenaWalletAction";
import { getNativeSymbol } from "@/lib/chainConfig";
import { runSolanaArenaUserAction } from "@/lib/solanaArenaClient";
import {
  arenaPoolIdFromHex,
  buildArenaDepositStakeV0Instruction,
  buildArenaOpenBattleV0Instruction,
  buildArenaSettleExpiredV0Instruction,
  buildArenaStakeRefundV0Instruction,
} from "@/lib/solanaArenaV0";
import { signWalletAction } from "@/lib/walletActionAuth";

type StakeStatus = {
  configured?: boolean;
  live?: boolean;
  treasury?: string;
  poolId?: string;
  abi?: string[];
  ownerA?: string;
  ownerB?: string;
  assetA?: string;
  assetB?: string;
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
  supportDeadline?: number;
  durationHours?: number;
  chainId?: number;
  onchainState?: number;
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
  const { solanaAccount } = useSolanaWallet();
  const [status, setStatus] = useState<StakeStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const id = Number(chainId || wallet.chainId || 56);
  const solanaChain = isSolanaWarzoneChain(id);
  const live = !solanaChain || isSolanaWarzoneMoneyLive(status);

  async function refresh() {
    const json = await fetchArenaStakeStatus(battleId, walletAddress || solanaAccount || wallet.account || "");
    setStatus(json);
    return json;
  }

  useEffect(() => {
    void refresh().catch(() => setStatus(null));
  }, [battleId, walletAddress, battleState, solanaAccount]);

  if (solanaChain && status && !live) {
    return <p className="text-sm text-muted-foreground">{SOLANA_WARZONE_ESCROW_NOT_LIVE}</p>;
  }
  if (!status?.configured || status.bothPaid || battleState === "live" || battleState === "finished") return null;
  if (battleState && battleState !== "matched") return null;

  async function signReceipt(txHash: string) {
    if (solanaChain) {
      return signArenaWalletAction({
        action: "arena_deposit_stake",
        extraLines: [`Battle: ${battleId}`, `Tx: ${txHash}`],
        walletAddress: String(walletAddress || solanaAccount || ""),
        chainId: Number(status?.chainId || id),
        evmWallet: wallet,
        solanaAccount,
      });
    }
    return signWalletAction({
      action: "arena_deposit_stake",
      walletAddress: String(walletAddress || wallet.account),
      chainId: Number(status?.chainId || id),
      extraLines: [`Battle: ${battleId}`, `Tx: ${txHash}`],
      signer: wallet.signer,
    });
  }

  async function record(txHash: string) {
    const auth = await signReceipt(txHash);
    const receipt = await postArenaStakeReceipt(battleId, { txHash, auth });
    toast.success(receipt.bothPaid ? "Both stakes are in. The fight clock is live." : "Stake deposited. Waiting on the other owner.");
    await refresh();
  }

  async function openPool() {
    if (solanaChain) {
      setBusy("open");
      try {
        const latest = (await refresh()) || status;
        if (!latest?.poolId || !latest.ownerA || !latest.ownerB || !latest.assetA || !latest.assetB) {
          throw new Error("Battle owners or token addresses are missing.");
        }
        const poolId = arenaPoolIdFromHex(latest.poolId);
        const signature = await runSolanaArenaUserAction({
          walletAddress: String(solanaAccount || ""),
          label: "open Warzone pool",
          build: (web3) =>
            buildArenaOpenBattleV0Instruction({
              web3,
              poolId,
              opener: String(solanaAccount),
              assetA: latest.assetA!,
              assetB: latest.assetB!,
              ownerA: latest.ownerA!,
              ownerB: latest.ownerB!,
              requiredStakeA: latest.stakeWei || "0",
              requiredStakeB: latest.stakeWei || "0",
              supportDeadline: latest.supportDeadline || latest.depositDeadline || 0,
              depositDeadline: latest.depositDeadline || 0,
              resolveDeadline: latest.resolveDeadline || 0,
            }),
        });
        await record(signature);
      } catch (error) {
        toast.error(String((error as Error)?.message || "Could not open the agreed pool."));
      } finally {
        setBusy(null);
      }
      return;
    }
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
    if (solanaChain) {
      setBusy("pay");
      try {
        const latest = (await refresh()) || status;
        if (!latest?.poolId || latest.nextMethod !== "depositStake") {
          toast.error("The agreed pool must be open before the rival deposits.");
          return;
        }
        const signature = await runSolanaArenaUserAction({
          walletAddress: String(solanaAccount || ""),
          label: "deposit Warzone stake",
          build: (web3) =>
            buildArenaDepositStakeV0Instruction({
              web3,
              poolId: arenaPoolIdFromHex(latest.poolId!),
              staker: String(solanaAccount),
            }),
        });
        await record(signature);
      } catch (error) {
        toast.error(String((error as Error)?.message || "Stake deposit failed."));
      } finally {
        setBusy(null);
      }
      return;
    }
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
      await record(tx.hash);
    } catch (error) {
      toast.error(String((error as Error)?.message || "Stake deposit failed."));
    } finally {
      setBusy(null);
    }
  }

  async function refund() {
    if (solanaChain) {
      setBusy("refund");
      try {
        const latest = (await refresh()) || status;
        if (!latest?.poolId) throw new Error("Pool not found.");
        const poolId = arenaPoolIdFromHex(latest.poolId);
        const signature = await runSolanaArenaUserAction({
          walletAddress: String(solanaAccount || ""),
          label: "refund Warzone stake",
          build: async (web3) => {
            const refund = await buildArenaStakeRefundV0Instruction({
              web3,
              poolId,
              staker: String(solanaAccount),
            });
            if (Number(latest.onchainState) === 3) return refund;
            const settle = await buildArenaSettleExpiredV0Instruction({ web3, poolId });
            return { instructions: [settle.instruction, refund.instruction], receipt: refund.receipt, pdas: refund.pdas };
          },
        });
        toast.success("Stake refunded. The other owner never deposited in time.");
        await refresh();
        return signature;
      } catch (error) {
        toast.error(String((error as Error)?.message || "Refund failed. Deposits can be pulled after the pay window."));
      } finally {
        setBusy(null);
      }
      return;
    }
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
  const symbol = status.nativeSymbol || getNativeSymbol(id);

  return (
    <div className="flex flex-wrap gap-2">
      {status.nextMethod === "openBattlePool" ? (
        <Button className="font-retro" disabled={Boolean(busy)} onClick={() => void openPool()}>
          {busy === "open"
            ? "Opening pool..."
            : solanaChain
              ? `Pay ${status.stakeNative ?? ""} ${symbol} and open pool`
              : `Open agreed ${length} pool`}
        </Button>
      ) : null}
      {status.nextMethod === "depositStake" ? (
        <Button className="font-retro" disabled={Boolean(busy)} onClick={() => void pay()}>
          {busy === "pay" ? "Paying stake..." : `Pay ${status.stakeNative ?? ""} ${symbol}`}
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
