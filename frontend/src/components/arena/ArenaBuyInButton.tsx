import { Contract, getAddress } from "ethers";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { useWallet } from "@/contexts/WalletContext";
import { postArenaBuyInReceipt } from "@/features/postgrad/apiClient";
import { apiFetch } from "@/lib/apiBase";
import { isSolanaWarzoneChain, isSolanaWarzoneMoneyLive, SOLANA_WARZONE_ESCROW_NOT_LIVE } from "@/lib/arena/solanaWarzoneEscrow";
import { signArenaWalletAction } from "@/lib/arena/signArenaWalletAction";
import { requestWalletChainSwitch } from "@/lib/launchpadReadiness";
import { runSolanaArenaUserAction } from "@/lib/solanaArenaClient";
import { arenaPoolIdFromHex, buildArenaBuyInV0Instruction } from "@/lib/solanaArenaV0";

const EVM_BUY_IN_ABI = ["function depositBuyIn(bytes32 poolId) payable"];

function configuredTournamentTreasury(chainId: number): string {
  const env = import.meta.env as Record<string, unknown>;
  const raw = String(env[`VITE_ARENA_WAR_POOL_TREASURY_V2_ADDRESS_${chainId}`] || "").trim();
  return /^0x[a-fA-F0-9]{40}$/.test(raw) ? getAddress(raw) : "";
}

async function fetchBuyInStatus(tournamentId: string, tokenAddress: string, walletAddress: string, chainId: number) {
  const params = new URLSearchParams({ tokenAddress, walletAddress, chainId: String(chainId) });
  const response = await apiFetch(`/api/arena/tournaments/${encodeURIComponent(tournamentId)}/buy-in-status?${params.toString()}`, {
    cache: "no-store",
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json?.ok === false) {
    throw new Error(String(json?.error || json?.reason || `Buy-in status unavailable (${response.status})`));
  }
  return json as {
    buyInPaid?: boolean;
    chainPaid?: boolean;
    chainId: number;
    amountRaw: string;
    amountNative: string;
    poolId: string;
    treasury?: string | null;
    recoveryAvailable?: boolean;
  };
}

export function ArenaBuyInButton({
  tournamentId,
  tokenAddress,
  chainId,
  poolId,
  configured,
  live: liveFlag,
  opened,
  buyInPaid,
  buyInNative,
  nativeSymbol,
  onDone,
}: {
  tournamentId: string;
  tokenAddress: string;
  chainId?: number;
  poolId?: string;
  configured?: boolean;
  live?: boolean;
  opened?: boolean;
  buyInPaid?: boolean;
  buyInNative?: number;
  nativeSymbol?: string;
  onDone?: () => void;
}) {
  const wallet = useWallet();
  const { solanaAccount } = useSolanaWallet();
  const [busy, setBusy] = useState(false);
  const id = Number(chainId || wallet.chainId || 56);
  const isSolana = isSolanaWarzoneChain(id);
  const live = isSolana ? isSolanaWarzoneMoneyLive({ configured, live: liveFlag }) : Boolean(configured && liveFlag);

  if (!live) {
    return <p className="text-sm text-muted-foreground">{isSolana ? SOLANA_WARZONE_ESCROW_NOT_LIVE : "Tournament buy-in escrow is not live on this chain."}</p>;
  }
  if (buyInPaid) return <p className="text-sm text-muted-foreground">On-chain registration is recorded.</p>;
  if (!opened || !poolId) {
    return <p className="text-sm text-muted-foreground">Ops opens the tournament pool first. Opt-in is intent only until then.</p>;
  }

  async function signedReceipt(walletAddress: string, txHash = "") {
    const auth = await signArenaWalletAction({
      action: "arena_tournament_buy_in",
      extraLines: [
        `Tournament: ${tournamentId}`,
        `Token: ${tokenAddress}`,
        txHash ? `Tx: ${txHash}` : "Reconcile: authoritative chain state",
      ],
      walletAddress,
      chainId: id,
      evmWallet: wallet,
      solanaAccount,
    });
    return postArenaBuyInReceipt(tournamentId, { tokenAddress, walletAddress, chainId: id, txHash: txHash || undefined, auth });
  }

  async function registerSolana() {
    const walletAddress = String(solanaAccount || "").trim();
    if (!walletAddress) throw new Error("Connect the owner wallet to register on-chain.");
    const signature = await runSolanaArenaUserAction({
      walletAddress,
      label: "register tournament buy-in",
      build: (web3) =>
        buildArenaBuyInV0Instruction({
          web3,
          poolId: arenaPoolIdFromHex(poolId!),
          entryAsset: tokenAddress,
          entrant: walletAddress,
        }),
    });
    await signedReceipt(walletAddress, signature);
  }

  async function registerEvm() {
    const walletAddress = String(wallet.account || "").trim();
    if (!walletAddress || !wallet.provider || !wallet.signer) {
      throw new Error("Connect the registered owner EVM wallet before paying the buy-in.");
    }

    // Read authoritative server/on-chain state before any economic transaction. If the
    // chain payment already exists after a reload/API crash, reconcile it instead of paying again.
    const status = await fetchBuyInStatus(tournamentId, tokenAddress, walletAddress, id);
    if (Number(status.chainId) !== id) throw new Error("Tournament buy-in status returned the wrong chain.");
    if (status.buyInPaid || status.chainPaid) {
      await signedReceipt(walletAddress);
      return;
    }

    const backendTreasury = String(status.treasury || "").trim();
    const frontendTreasury = configuredTournamentTreasury(id);
    if (!backendTreasury || !frontendTreasury || getAddress(backendTreasury) !== frontendTreasury) {
      throw new Error("Tournament Treasury identity does not match the frontend/backend chain configuration.");
    }
    if (String(status.poolId).toLowerCase() !== String(poolId).toLowerCase()) {
      throw new Error("Tournament pool identity changed; reload before paying.");
    }
    const amountRaw = BigInt(String(status.amountRaw || "0"));
    if (amountRaw <= 0n) throw new Error("Tournament buy-in amount is unavailable.");

    if (Number(wallet.chainId) !== id) {
      await requestWalletChainSwitch(wallet.provider, id as any);
    }
    const connectedChain = Number(BigInt(String(await wallet.provider.send("eth_chainId", []))));
    if (connectedChain !== id) throw new Error(`Wallet did not switch to tournament chain ${id}.`);

    const contract = new Contract(frontendTreasury, EVM_BUY_IN_ABI, wallet.signer);
    const tx = await contract.depositBuyIn(status.poolId, { value: amountRaw });
    const receipt = await tx.wait();
    if (!receipt || Number(receipt.status) !== 1) throw new Error("Tournament buy-in transaction did not confirm successfully.");
    await signedReceipt(walletAddress, String(tx.hash));
  }

  async function register() {
    if (busy) return;
    setBusy(true);
    try {
      if (isSolana) await registerSolana();
      else await registerEvm();
      toast.success(
        Number(buyInNative) > 0
          ? `Buy-in recorded (${buyInNative} ${nativeSymbol || (isSolana ? "SOL" : "native")}).`
          : "On-chain registration recorded.",
      );
      onDone?.();
    } catch (error) {
      toast.error(String((error as Error)?.message || "Buy-in failed."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button size="sm" className="font-retro" disabled={busy} onClick={() => void register()}>
      {busy ? "Confirming..." : Number(buyInNative) > 0 ? `Pay ${buyInNative} ${nativeSymbol || (isSolana ? "SOL" : "native")} buy-in` : "Register on-chain"}
    </Button>
  );
}
