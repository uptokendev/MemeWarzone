/**
 * D12 locked creator buy: ExactOut swap + ATA for the escrow + create_vesting_escrow,
 * one transaction, two signers (trader + fresh escrow base).
 */
import BN from "bn.js";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { DBC_CREATOR_LOCK_COPY } from "../../shared/dbcEconomics.mjs";
import { lockAmountDivisible, lockScheduleFromNow } from "../../shared/dbcLockSchedule.mjs";
import {
  buildCreateVestingEscrowInstruction,
  deriveLockEscrow,
} from "./dbcJupiterLock.mjs";
import {
  applySlippageMaxIn,
  DBC_TRADE_SLIPPAGE_PCT,
  loadDbcPool,
  loadReferralTokenAccount,
  quoteDbcExactOut,
} from "./dbcTrade.mjs";

export { DBC_CREATOR_LOCK_COPY };

export async function buildDbcLockedBuyTransaction({
  connection,
  poolAddress,
  trader,
  tokenAmountOut,
  env,
  nowUnix,
  KeypairCtor = Keypair,
}) {
  const amountOut = lockAmountDivisible(tokenAmountOut);
  if (amountOut <= 0n) throw new Error("Locked buy amount must be a positive multiple of 5.");
  const loaded = await loadDbcPool(connection, poolAddress);
  const referral = await loadReferralTokenAccount(connection, env);
  const now = Number(nowUnix || loaded.nowUnix);
  const quoted = quoteDbcExactOut({
    client: loaded.client,
    pool: loaded.pool,
    config: loaded.config,
    amountOut,
    hasReferral: Boolean(referral),
    nowUnix: now,
    activationUnix: loaded.activationUnix,
  });
  const schedule = lockScheduleFromNow(now, amountOut);
  const base = KeypairCtor.generate();
  const [escrow] = deriveLockEscrow(base.publicKey);
  const mint = loaded.pool.baseMint instanceof PublicKey
    ? loaded.pool.baseMint
    : new PublicKey(String(loaded.pool.baseMint || loaded.pool.base_mint));
  const creatorToken = getAssociatedTokenAddressSync(mint, new PublicKey(trader));
  const escrowToken = getAssociatedTokenAddressSync(mint, escrow, true);
  const swapTx = await loaded.client.pool.swap2({
    owner: new PublicKey(trader),
    pool: loaded.poolPk,
    swapBaseForQuote: false,
    referralTokenAccount: referral,
    swapMode: SwapMode.ExactOut,
    amountOut: new BN(amountOut.toString()),
    maximumAmountIn: new BN(quoted.maximumAmountIn.toString()),
  });
  const tx = new Transaction().add(
    ...swapTx.instructions,
    createAssociatedTokenAccountIdempotentInstruction(
      new PublicKey(trader),
      escrowToken,
      escrow,
      mint,
    ),
    buildCreateVestingEscrowInstruction({
      base: base.publicKey,
      escrow,
      escrowToken,
      sender: trader,
      senderToken: creatorToken,
      recipient: trader,
      schedule,
    }),
  );
  tx.feePayer = new PublicKey(trader);
  return {
    tx,
    quoted,
    schedule,
    referral: referral ? referral.toBase58() : null,
    extraSigners: [base],
    escrow: escrow.toBase58(),
    escrowToken: escrowToken.toBase58(),
    mint: mint.toBase58(),
    copy: DBC_CREATOR_LOCK_COPY,
    loaded,
  };
}

export { lockAmountDivisible, applySlippageMaxIn, DBC_TRADE_SLIPPAGE_PCT, NATIVE_MINT };
