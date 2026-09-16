import { useState } from "react";
import { Contract, getAddress } from "ethers";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { useWallet } from "@/contexts/WalletContext";
import { apiFetch } from "@/lib/apiBase";
import { isSolanaWarzoneChain, isSolanaWarzoneMoneyLive, SOLANA_WARZONE_ESCROW_NOT_LIVE } from "@/lib/arena/solanaWarzoneEscrow";
import { getArenaWarPoolTreasuryAddress, getNativeSymbol, type SupportedChainId } from "@/lib/chainConfig";
import { requestWalletChainSwitch } from "@/lib/launchpadReadiness";
import { runSolanaArenaUserAction } from "@/lib/solanaArenaClient";
import { arenaPoolIdFromHex, buildArenaWinnerClaimV0Instruction } from "@/lib/solanaArenaV0";

function configuredWarPoolTreasury(chainId: number): string {
  const raw = String(getArenaWarPoolTreasuryAddress(chainId as SupportedChainId) || "").trim();
  return /^0x[a-fA-F0-9]{40}$/.test(raw) ? getAddress(raw) : "";
}

function resolveEvmWarPoolTreasury(statusTreasury: string | undefined, chainId: number): string {
  const backend = String(statusTreasury || "").trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(backend)) return getAddress(backend);
  return configuredWarPoolTreasury(chainId);
}

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
  const { solanaAccount } = useSolanaWallet();
  const [busy, setBusy] = useState(false);
  const id = Number(chainId || wallet.chainId || 56);
  const solanaChain = isSolanaWarzoneChain(id);
  const symbol = getNativeSymbol(id);

  if (!solanaChain && !configuredWarPoolTreasury(id)) return null;

  async function claim() {
    setBusy(true);
    try {
      const res = await apiFetch(`/api/arena/war-pools/${encodeURIComponent(battleId)}/claim-intent`, { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.ok === false) throw new Error(String(json?.error || `Claim intent failed (${res.status})`));

      if (solanaChain) {
        if (!isSolanaWarzoneMoneyLive({ configured: json.configured, live: json.live })) {
          throw new Error(SOLANA_WARZONE_ESCROW_NOT_LIVE);
        }
        if (!json.resolved) throw new Error("Waiting for Warzone resolution. Resolve stays operator-side.");
        const walletAddress = String(solanaAccount || "").trim();
        if (!walletAddress) throw new Error("Connect the winning campaign owner wallet.");
        if (json.winnerWallet && json.winnerWallet !== walletAddress) {
          throw new Error("Connect the winning campaign owner wallet.");
        }
        await runSolanaArenaUserAction({
          walletAddress,
          label: "claim Warzone winner share",
          build: (web3) =>
            buildArenaWinnerClaimV0Instruction({
              web3,
              poolId: arenaPoolIdFromHex(json.poolId),
              winner: walletAddress,
            }),
        });
        toast.success("War pool claimed. Protocol stays out of the send loop.");
        return;
      }

      if (!wallet.signer || !wallet.provider) {
        toast.error("Connect the winning campaign owner wallet.");
        return;
      }
      const targetChainId = Number(json.chainId || id);
      if (Number(wallet.chainId) !== targetChainId) await requestWalletChainSwitch(wallet.provider, targetChainId as any);
      const connectedChain = Number(BigInt(String(await wallet.provider.send("eth_chainId", []))));
      if (connectedChain !== targetChainId) throw new Error(`Wallet did not switch to battle chain ${targetChainId}.`);
      const treasury = resolveEvmWarPoolTreasury(json.treasury, targetChainId);
      const abi = Array.isArray(json.abi) && json.abi.length ? json.abi : [];
      if (!treasury || !abi.length) throw new Error("Arena war pool treasury is not deployed on this chain.");
      const contract = new Contract(treasury, abi, wallet.signer);
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
      {busy ? "Claiming..." : label || `Claim ${symbol} battle rewards`}
    </Button>
  );
}
