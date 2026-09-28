/**
 * Browser wrapper: sign and send a DBC bonding-curve swap (or locked creator buy).
 */
import { getSolanaProvider } from "@/lib/solanaWallet";
import { getPublicRpcUrl, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import { loadSolanaWeb3 } from "@/lib/solanaWeb3";
import { buildDbcSwapTransaction, submitPreparedDbcTrade } from "@/lib/dbcTrade.mjs";
import { buildDbcLockedBuyTransaction } from "@/lib/dbcLockedBuy.mjs";
import { buildClaimVestingInstruction } from "@/lib/dbcJupiterLock.mjs";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, Transaction } from "@solana/web3.js";

export async function submitDbcBondingTrade(input: {
  pool: string;
  trader: string;
  side: "buy" | "sell";
  amountIn: bigint;
  lockedBuy?: boolean;
  tokenAmountOut?: bigint;
}): Promise<{
  signature: string;
  serializedBytes: number;
  signerCount: number;
  escrow?: string;
  quoted: unknown;
}> {
  const web3 = await loadSolanaWeb3();
  const provider = getSolanaProvider();
  if (!provider?.signTransaction) {
    throw new Error("This Solana wallet cannot sign transactions.");
  }
  const rpc = getPublicRpcUrl(SOLANA_CHAIN_ID);
  if (!rpc) throw new Error("Solana RPC is not configured.");
  const connection = new web3.Connection(rpc, "confirmed");
  const env = typeof import.meta !== "undefined" ? import.meta.env : {};
  if (input.lockedBuy) {
    const built = await buildDbcLockedBuyTransaction({
      connection,
      poolAddress: input.pool,
      trader: input.trader,
      tokenAmountOut: input.tokenAmountOut ?? 0n,
      env,
      KeypairCtor: web3.Keypair,
    });
    const sent = await submitPreparedDbcTrade({
      connection,
      transaction: built.tx,
      trader: input.trader,
      pool: input.pool,
      allowLock: true,
      extraSigners: built.extraSigners,
      signTransaction: (unsigned: unknown) => provider.signTransaction(unsigned),
    });
    return { ...sent, escrow: built.escrow, quoted: built.quoted, mint: built.mint, schedule: built.schedule };
  }
  const built = await buildDbcSwapTransaction({
    connection,
    poolAddress: input.pool,
    trader: input.trader,
    side: input.side,
    amountIn: input.amountIn,
    env,
  });
  const sent = await submitPreparedDbcTrade({
    connection,
    transaction: built.tx,
    trader: input.trader,
    pool: input.pool,
    signTransaction: (unsigned: unknown) => provider.signTransaction(unsigned),
  });
  return { ...sent, quoted: built.quoted };
}

export async function submitDbcLockClaim(input: {
  escrow: string;
  mint: string;
  recipient: string;
}): Promise<{ signature: string }> {
  const web3 = await loadSolanaWeb3();
  const provider = getSolanaProvider();
  if (!provider?.signTransaction) {
    throw new Error("This Solana wallet cannot sign transactions.");
  }
  const rpc = getPublicRpcUrl(SOLANA_CHAIN_ID);
  if (!rpc) throw new Error("Solana RPC is not configured.");
  const connection = new web3.Connection(rpc, "confirmed");
  const mint = new PublicKey(input.mint);
  const recipient = new PublicKey(input.recipient);
  const escrow = new PublicKey(input.escrow);
  const recipientToken = getAssociatedTokenAddressSync(mint, recipient);
  const escrowToken = getAssociatedTokenAddressSync(mint, escrow, true);
  const tx = new Transaction().add(
    buildClaimVestingInstruction({
      escrow,
      escrowToken,
      recipient,
      recipientToken,
    }),
  );
  tx.feePayer = recipient;
  const sent = await submitPreparedDbcTrade({
    connection,
    transaction: tx,
    trader: input.recipient,
    pool: input.escrow,
    allowLock: true,
    requirePool: false,
    signTransaction: (unsigned: unknown) => provider.signTransaction(unsigned),
  });
  return { signature: sent.signature };
}
