/**
 * Browser wrapper: creator signs graduation payout, reserve, or LP fee claims.
 */
import { getSolanaProvider } from "@/lib/solanaWallet";
import { getPublicRpcUrl, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import { loadSolanaWeb3 } from "@/lib/solanaWeb3";
import { submitPreparedDbcTrade } from "@/lib/dbcTrade.mjs";
import {
  DBC_CREATOR_CLAIM_EXTRA_PROGRAMS,
  buildCreatorLpFeeTransaction,
  buildGraduationPayoutTransaction,
  buildReserveClaimTransaction,
} from "@/lib/dbcGraduationClaims.mjs";

async function connectionAndSign() {
  const web3 = await loadSolanaWeb3();
  const provider = getSolanaProvider();
  if (!provider?.signTransaction) {
    throw new Error("This Solana wallet cannot sign transactions.");
  }
  const rpc = getPublicRpcUrl(SOLANA_CHAIN_ID);
  if (!rpc) throw new Error("Solana RPC is not configured.");
  const connection = new web3.Connection(rpc, "confirmed");
  return {
    connection,
    signTransaction: (unsigned: unknown) => provider.signTransaction(unsigned),
  };
}

export async function submitDbcGraduationPayout(input: {
  pool: string;
  creator: string;
}): Promise<{ signature: string }> {
  const { connection, signTransaction } = await connectionAndSign();
  const tx = await buildGraduationPayoutTransaction({
    connection,
    pool: input.pool,
    creator: input.creator,
  });
  const sent = await submitPreparedDbcTrade({
    connection,
    transaction: tx,
    trader: input.creator,
    pool: input.pool,
    extraPrograms: DBC_CREATOR_CLAIM_EXTRA_PROGRAMS,
    signTransaction,
  });
  return { signature: sent.signature };
}

export async function submitDbcReserveClaim(input: {
  mint: string;
  creator: string;
  locker: string;
}): Promise<{ signature: string }> {
  const { connection, signTransaction } = await connectionAndSign();
  const tx = await buildReserveClaimTransaction({
    connection,
    mint: input.mint,
    creator: input.creator,
    locker: input.locker,
  });
  const sent = await submitPreparedDbcTrade({
    connection,
    transaction: tx,
    trader: input.creator,
    pool: input.locker,
    allowLock: true,
    requirePool: false,
    extraPrograms: DBC_CREATOR_CLAIM_EXTRA_PROGRAMS,
    signTransaction,
  });
  return { signature: sent.signature };
}

export async function submitDbcCreatorLpClaim(input: {
  dammPool: string;
  creator: string;
}): Promise<{ signature: string }> {
  const { connection, signTransaction } = await connectionAndSign();
  const tx = await buildCreatorLpFeeTransaction({
    connection,
    dammPool: input.dammPool,
    creator: input.creator,
  });
  const sent = await submitPreparedDbcTrade({
    connection,
    transaction: tx,
    trader: input.creator,
    pool: input.dammPool,
    extraPrograms: DBC_CREATOR_CLAIM_EXTRA_PROGRAMS,
    signTransaction,
  });
  return { signature: sent.signature };
}
