/**
 * D7 compensation: SOL is a System transfer; a bound quote is TransferChecked
 * of the quote token to the creator.
 */
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { isNativeQuoteMint } from "./dbcQuoteNative.js";

export function buildD7CompensationIxs(input: {
  collector: PublicKey;
  creator: PublicKey;
  quoteMint: string;
  amount: bigint;
  decimals: number;
  tokenProgram?: PublicKey;
}): TransactionInstruction[] {
  if (input.amount <= 0n) return [];
  if (isNativeQuoteMint(input.quoteMint)) {
    return [
      SystemProgram.transfer({
        fromPubkey: input.collector,
        toPubkey: input.creator,
        lamports: Number(input.amount),
      }),
    ];
  }
  const mint = new PublicKey(input.quoteMint);
  const program = input.tokenProgram || TOKEN_PROGRAM_ID;
  const from = getAssociatedTokenAddressSync(mint, input.collector, false, program);
  const to = getAssociatedTokenAddressSync(mint, input.creator, false, program);
  return [
    createAssociatedTokenAccountIdempotentInstruction(
      input.collector,
      to,
      input.creator,
      mint,
      program,
    ),
    createTransferCheckedInstruction(
      from,
      mint,
      to,
      input.collector,
      input.amount,
      input.decimals,
      [],
      program,
    ),
  ];
}
