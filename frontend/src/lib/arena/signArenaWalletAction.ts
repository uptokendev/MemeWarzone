import { isSolanaAddress } from "@/lib/address";
import { isSolanaChainId } from "@/lib/chainConfig";
import { signSolanaMessage } from "@/lib/solanaWallet";
import { signWalletAction } from "@/lib/walletActionAuth";

type EvmWallet = {
  signer?: Parameters<typeof signWalletAction>[0]["signer"];
};

export async function signArenaWalletAction(input: {
  action: string;
  extraLines: string[];
  walletAddress: string;
  chainId?: number | null;
  evmWallet?: EvmWallet | null;
  solanaAccount?: string | null;
}) {
  const walletAddress = String(input.walletAddress || "").trim();
  if (!walletAddress) throw new Error("Connect a wallet first.");
  const solana = isSolanaChainId(Number(input.chainId)) || isSolanaAddress(walletAddress);
  if (solana) {
    if (!input.solanaAccount) throw new Error("Connect the Solana wallet that owns this coin.");
    return signWalletAction({
      action: input.action,
      walletAddress,
      chainId: Number(input.chainId || 101),
      extraLines: input.extraLines,
      walletType: "solana",
      signMessage: async (message) => (await signSolanaMessage(message, walletAddress)).signature,
    });
  }
  if (!input.evmWallet?.signer) throw new Error("Connect the wallet that owns this coin.");
  return signWalletAction({
    action: input.action,
    walletAddress,
    chainId: Number(input.chainId || 56),
    extraLines: input.extraLines,
    signer: input.evmWallet.signer,
  });
}
