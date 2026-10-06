// Arena pool accounts of the rewards treasury program (programs/mwz_rewards_treasury/src/arena.rs):
// PDA derivation and the claim / refund receipt decoders. No ethers, no RPC, no database, so the
// finance read (financePayoutsArena.js) and the chain indexer (arenaWarPoolChainIndex.js, which also
// runs in the slim resolve-due image) share one copy.

import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";

import { REWARDS_TREASURY_PROGRAM_ID } from "../../src/lib/solanaArenaLayout.mjs";

function anchorDiscriminator(name) {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

export const ARENA_CLAIM_RECEIPT_DISCRIMINATOR = anchorDiscriminator("ArenaClaimReceipt");
export const ARENA_REFUND_RECEIPT_DISCRIMINATOR = anchorDiscriminator("ArenaRefundReceipt");

/** ArenaClaimReceipt { pool_id, bucket u8, recipient, amount_lamports u64, bump }. */
export function decodeClaimReceipt(data) {
  const bytes = Buffer.from(data);
  if (bytes.length < 8 + 32 + 1 + 32 + 8 || !bytes.subarray(0, 8).equals(ARENA_CLAIM_RECEIPT_DISCRIMINATOR)) return null;
  return {
    poolId: bytes.subarray(8, 40).toString("hex"),
    bucket: bytes[40],
    recipient: new PublicKey(bytes.subarray(41, 73)).toBase58(),
    amount: bytes.readBigUInt64LE(73),
  };
}

/** ArenaRefundReceipt { pool_id, wallet, identity, amount_lamports u64, kind u8, bump }. */
export function decodeRefundReceipt(data) {
  const bytes = Buffer.from(data);
  if (bytes.length < 8 + 32 * 3 + 8 || !bytes.subarray(0, 8).equals(ARENA_REFUND_RECEIPT_DISCRIMINATOR)) return null;
  return { poolId: bytes.subarray(8, 40).toString("hex"), wallet: new PublicKey(bytes.subarray(40, 72)).toBase58(), amount: bytes.readBigUInt64LE(104) };
}

function programKey(programId = REWARDS_TREASURY_PROGRAM_ID) {
  return new PublicKey(programId);
}

function poolIdBytes(poolIdHex) {
  return Buffer.from(String(poolIdHex).replace(/^0x/i, ""), "hex");
}

export function deriveSolanaArenaAccounts(poolIdHex, programId = REWARDS_TREASURY_PROGRAM_ID) {
  const id = poolIdBytes(poolIdHex);
  const program = programKey(programId);
  const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, program)[0].toBase58();
  return {
    pool: pda([Buffer.from("arena_pool"), id]),
    vault: pda([Buffer.from("arena_vault"), id]),
    claim: (bucket) => pda([Buffer.from("arena_claim"), id, Buffer.from([bucket])]),
    refund: (wallet, kind) => pda([Buffer.from("arena_refund"), id, new PublicKey(wallet).toBuffer(), Buffer.from([kind])]),
  };
}
