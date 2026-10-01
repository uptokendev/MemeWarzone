/**
 * Sign and send a DBC createPool transaction: the wallet first, then the mint key (Phantom blocks pre-signed requests).
 * Fresh blockhash, simulate, then signTransaction + sendRawTransaction.
 * Confirms against this transaction's blockhash / lastValidBlockHeight.
 */
import { getSolanaProvider } from "@/lib/solanaWallet";
import { getPublicRpcUrl, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import { loadSolanaWeb3 } from "@/lib/solanaWeb3";
import { submitPreparedDbcCreate } from "@/lib/dbcCreateIntent.mjs";

export type DbcCreateSubmitResult = {
  signature: string;
  pool: string;
  mintAddress: string;
  blockhash: string;
  lastValidBlockHeight: number;
  serializedBytes: number;
  signerCount: number;
};

export async function submitDbcCreateTransaction(input: {
  transactionBase64: string;
  mintSecretKey: Uint8Array;
  creatorAddress: string;
  pool: string;
  mintAddress: string;
  config: string;
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
  return submitPreparedDbcCreate({
    connection,
    transaction: tx,
    mintSecretKey: input.mintSecretKey,
    mintAddress: input.mintAddress,
    creatorAddress: input.creatorAddress,
    pool: input.pool,
    config: input.config,
    Keypair: web3.Keypair,
    signTransaction: (unsigned) => provider.signTransaction(unsigned),
  });
}
