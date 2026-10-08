import { getPublicRpcUrl, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import { loadSolanaWeb3 } from "@/lib/solanaWeb3";

/** A wallet's SOL balance in lamports, read the way the create submit connects (null if unreadable). */
export async function readSolBalanceLamports(address: string): Promise<bigint | null> {
  if (!address) return null;
  try {
    const web3 = await loadSolanaWeb3();
    const connection = new web3.Connection(getPublicRpcUrl(SOLANA_CHAIN_ID), "confirmed");
    return BigInt(await connection.getBalance(new web3.PublicKey(address), "confirmed"));
  } catch {
    return null;
  }
}
