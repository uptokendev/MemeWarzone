import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { useWallet } from "@/contexts/WalletContext";
import { postArenaBuyInReceipt } from "@/features/postgrad/apiClient";
import { isSolanaWarzoneChain, isSolanaWarzoneMoneyLive, SOLANA_WARZONE_ESCROW_NOT_LIVE } from "@/lib/arena/solanaWarzoneEscrow";
import { signArenaWalletAction } from "@/lib/arena/signArenaWalletAction";
import { runSolanaArenaUserAction } from "@/lib/solanaArenaClient";
import { arenaPoolIdFromHex, buildArenaBuyInV0Instruction } from "@/lib/solanaArenaV0";

export function ArenaBuyInButton({
  tournamentId,
  tokenAddress,
  chainId,
  poolId,
  configured,
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
  if (!isSolanaWarzoneChain(id)) return null;
  const live = isSolanaWarzoneMoneyLive({ configured, live: configured });
  if (!live) return <p className="text-sm text-muted-foreground">{SOLANA_WARZONE_ESCROW_NOT_LIVE}</p>;
  if (buyInPaid) return <p className="text-sm text-muted-foreground">On-chain registration is recorded.</p>;
  if (!opened || !poolId) {
    return <p className="text-sm text-muted-foreground">Ops opens the tournament pool first. Opt-in is intent only until then.</p>;
  }

  async function register() {
    const walletAddress = String(solanaAccount || "").trim();
    if (!walletAddress) {
      toast.error("Connect the owner wallet to register on-chain.");
      return;
    }
    setBusy(true);
    try {
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
      const auth = await signArenaWalletAction({
        action: "arena_tournament_buy_in",
        extraLines: [`Tournament: ${tournamentId}`, `Token: ${tokenAddress}`, `Tx: ${signature}`],
        walletAddress,
        chainId: id,
        evmWallet: wallet,
        solanaAccount,
      });
      await postArenaBuyInReceipt(tournamentId, { tokenAddress, walletAddress, txHash: signature, auth });
      toast.success(
        Number(buyInNative) > 0
          ? `Buy-in recorded (${buyInNative} ${nativeSymbol || "SOL"}).`
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
      {busy ? "Registering..." : Number(buyInNative) > 0 ? `Pay ${buyInNative} ${nativeSymbol || "SOL"} buy-in` : "Register on-chain"}
    </Button>
  );
}
