/**
 * Sign and send a DBC createPool transaction: mint key first, then the wallet.
 * Uses signTransaction then sendRawTransaction (same shape as solanaV4CreateSubmit).
 */
import { getSolanaProvider } from "@/lib/solanaWallet";
import { getPublicRpcUrl, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import { loadSolanaWeb3 } from "@/lib/solanaWeb3";

export type DbcCreateSubmitResult = {
  signature: string;
  pool: string;
  mintAddress: string;
};

export async function submitDbcCreateTransaction(input: {
  transactionBase64: string;
  mintSecretKey: Uint8Array;
  creatorAddress: string;
  pool: string;
  mintAddress: string;
}): Promise<DbcCreateSubmitResult> {
  const web3 = await loadSolanaWeb3();
  const provider = getSolanaProvider();
  if (!provider?.signTransaction) {
    throw new Error("This Solana wallet cannot sign transactions.");
  }
  const rpc = getPublicRpcUrl(SOLANA_CHAIN_ID);
  if (!rpc) throw new Error("Solana RPC is not configured.");
  const connection = new web3.Connection(rpc, "confirmed");
  const tx = web3.Transaction.from(Buffer.from(input.transactionBase64, "base64"));
  const mint = web3.Keypair.fromSecretKey(input.mintSecretKey);
  if (mint.publicKey.toBase58() !== input.mintAddress) {
    throw new Error("The mint key does not match the authorized token.");
  }
  tx.partialSign(mint);
  const signed = await provider.signTransaction(tx);
  const raw = typeof signed?.serialize === "function" ? signed.serialize() : signed;
  const signature = await connection.sendRawTransaction(raw, {
    skipPreflight: false,
    maxRetries: 3,
  });
  const latest = await connection.getLatestBlockhash("confirmed");
  const confirmation = await connection.confirmTransaction(
    { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
    "confirmed",
  );
  if (confirmation.value.err) {
    throw new Error(`DBC create transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  }
  return { signature, pool: input.pool, mintAddress: input.mintAddress };
}
