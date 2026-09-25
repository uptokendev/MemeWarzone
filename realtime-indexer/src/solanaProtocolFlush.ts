import { createHash } from "node:crypto";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";

/**
 * The protocol's 42.5% of every Solana trade fee lands in the rewards treasury's protocol_vault
 * and only leaves through flush_operator_fill: the operator wallet up to its USD cap, the rest to
 * the overflow treasury (the multisig). The instruction is permissionless and nothing called it,
 * so 0.559 SOL sat in the vault while $0.16 had ever reached the operator (read 2026-09-25).
 * The fee-escrow worker now calls it on a timer. It moves only vault -> operator/overflow, which
 * the program pins to route_state, so the payer can never redirect it.
 */

export const FLUSH_OPERATOR_FILL_DISC = createHash("sha256").update("global:flush_operator_fill").digest().subarray(0, 8);
export const ROUTE_STATE_DISC = Buffer.from([83, 247, 97, 21, 140, 129, 221, 0]);
// discriminator(8) + authority(32) + operator(32) + overflow(32) + cap u64 + filled u64 + price u64 + bump u8
export const ROUTE_STATE_MIN_BYTES = 8 + 32 * 3 + 8 * 3 + 1;
// Rent-exempt minimum of an 8 + VaultState (1 byte) account; the program keeps it in the vault.
export const DEFAULT_PROTOCOL_FLUSH_MIN_LAMPORTS = 50_000_000n; // 0.05 SOL
export const DEFAULT_PROTOCOL_FLUSH_INTERVAL_MS = 60 * 60_000; // hourly

export type RouteStateView = {
  authority: string;
  operator: string;
  overflowTreasury: string;
  capUsdMicros: bigint;
  filledUsdMicros: bigint;
  nativeUsdMicros: bigint;
};

export function decodeRouteState(data: Buffer): RouteStateView | null {
  if (data.length < ROUTE_STATE_MIN_BYTES || !data.subarray(0, 8).equals(ROUTE_STATE_DISC)) return null;
  const key = (offset: number) => new PublicKey(data.subarray(offset, offset + 32)).toBase58();
  return {
    authority: key(8),
    operator: key(40),
    overflowTreasury: key(72),
    capUsdMicros: data.readBigUInt64LE(104),
    filledUsdMicros: data.readBigUInt64LE(112),
    nativeUsdMicros: data.readBigUInt64LE(120),
  };
}

/** Flush when enough has built up to be worth a transaction, at most once per interval. */
export function shouldFlushProtocolVault(input: {
  vaultLamports: bigint;
  rentMinimumLamports: bigint;
  minLamports: bigint;
  nowMs: number;
  lastAttemptMs: number;
  intervalMs: number;
}): boolean {
  if (input.nowMs - input.lastAttemptMs < input.intervalMs) return false;
  const spendable = input.vaultLamports - input.rentMinimumLamports;
  return spendable >= input.minLamports;
}

export function flushOperatorFillInstruction(input: {
  treasuryProgram: PublicKey;
  routeState: PublicKey;
  protocolVault: PublicKey;
  operator: PublicKey;
  overflowTreasury: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: input.treasuryProgram,
    keys: [
      { pubkey: input.operator, isSigner: false, isWritable: true },
      { pubkey: input.routeState, isSigner: false, isWritable: true },
      { pubkey: input.protocolVault, isSigner: false, isWritable: true },
      { pubkey: input.overflowTreasury, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(FLUSH_OPERATOR_FILL_DISC),
  });
}
