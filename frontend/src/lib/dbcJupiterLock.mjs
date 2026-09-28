/**
 * Jupiter Lock (LocpQguc…) instruction builders. Encoded from the v0.4.0 IDL
 * so the browser does not need @coral-xyz/anchor.
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { DBC_JUPITER_LOCK_PROGRAM_ID } from "../../shared/dbcEconomics.mjs";
import { DBC_SYSTEM_PROGRAM_ID } from "./dbcCreateIntent.mjs";

export { DBC_JUPITER_LOCK_PROGRAM_ID };

const LOCK_PROGRAM = new PublicKey(DBC_JUPITER_LOCK_PROGRAM_ID);
const SYSTEM_PROGRAM = new PublicKey(DBC_SYSTEM_PROGRAM_ID);
const CREATE_DISC = Buffer.from([23, 100, 197, 94, 222, 153, 38, 90]);
const CLAIM_DISC = Buffer.from([62, 198, 214, 193, 213, 159, 108, 210]);
const ESCROW_DISC = Buffer.from([244, 119, 183, 4, 73, 116, 135, 195]);

export function deriveLockEscrow(base) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), new PublicKey(base).toBuffer()],
    LOCK_PROGRAM,
  );
}

export function deriveLockEventAuthority() {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], LOCK_PROGRAM)[0];
}

function u64le(value) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return buf;
}

export function encodeCreateVestingEscrowData(schedule) {
  return Buffer.concat([
    CREATE_DISC,
    u64le(schedule.vestingStartTime),
    u64le(schedule.cliffTime),
    u64le(schedule.frequency),
    u64le(schedule.cliffUnlockAmount),
    u64le(schedule.amountPerPeriod),
    u64le(schedule.numberOfPeriod),
    Buffer.from([Number(schedule.updateRecipientMode) & 0xff, Number(schedule.cancelMode) & 0xff]),
  ]);
}

export function buildCreateVestingEscrowInstruction({
  base,
  escrow,
  escrowToken,
  sender,
  senderToken,
  recipient,
  schedule,
}) {
  const eventAuthority = deriveLockEventAuthority();
  return new TransactionInstruction({
    programId: LOCK_PROGRAM,
    keys: [
      { pubkey: new PublicKey(base), isSigner: true, isWritable: true },
      { pubkey: new PublicKey(escrow), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(escrowToken), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(sender), isSigner: true, isWritable: true },
      { pubkey: new PublicKey(senderToken), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(recipient), isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: LOCK_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: encodeCreateVestingEscrowData(schedule),
  });
}

export function buildClaimVestingInstruction({ escrow, escrowToken, recipient, recipientToken, maxAmount }) {
  const eventAuthority = deriveLockEventAuthority();
  const amount = maxAmount == null ? (2n ** 64n - 1n) : BigInt(maxAmount);
  return new TransactionInstruction({
    programId: LOCK_PROGRAM,
    keys: [
      { pubkey: new PublicKey(escrow), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(escrowToken), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(recipient), isSigner: true, isWritable: true },
      { pubkey: new PublicKey(recipientToken), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: LOCK_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([CLAIM_DISC, u64le(amount)]),
  });
}

function readPubkey(data, offset) {
  return new PublicKey(data.subarray(offset, offset + 32)).toBase58();
}

function readU64(data, offset) {
  return data.readBigUInt64LE(offset);
}

/** VestingEscrow (bytemuck, 8-byte discriminator + repr C). */
export function parseVestingEscrow(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < 8 + 192) throw new Error("Vesting escrow account is too short.");
  if (!buf.subarray(0, 8).equals(ESCROW_DISC)) {
    throw new Error("Account is not a Jupiter Lock vesting escrow.");
  }
  const body = buf.subarray(8);
  return {
    recipient: readPubkey(body, 0),
    tokenMint: readPubkey(body, 32),
    creator: readPubkey(body, 64),
    base: readPubkey(body, 96),
    escrowBump: body[128],
    updateRecipientMode: body[129],
    cancelMode: body[130],
    tokenProgramFlag: body[131],
    cliffTime: readU64(body, 136),
    frequency: readU64(body, 144),
    cliffUnlockAmount: readU64(body, 152),
    amountPerPeriod: readU64(body, 160),
    numberOfPeriod: readU64(body, 168),
    totalClaimedAmount: readU64(body, 176),
    vestingStartTime: readU64(body, 184),
    cancelledAt: readU64(body, 192),
  };
}

export function escrowLockedAmount(parsed) {
  return BigInt(parsed.cliffUnlockAmount) + BigInt(parsed.amountPerPeriod) * BigInt(parsed.numberOfPeriod);
}

export function escrowReleasedAmount(parsed, nowUnix) {
  const now = BigInt(nowUnix);
  const cliff = BigInt(parsed.cliffTime);
  const freq = BigInt(parsed.frequency);
  const periods = BigInt(parsed.numberOfPeriod);
  const cliffAmt = BigInt(parsed.cliffUnlockAmount);
  const per = BigInt(parsed.amountPerPeriod);
  if (now < cliff) return 0n;
  let unlocked = cliffAmt;
  if (freq > 0n) {
    const elapsed = (now - cliff) / freq;
    const steps = elapsed > periods ? periods : elapsed;
    unlocked += per * steps;
  }
  const claimed = BigInt(parsed.totalClaimedAmount || 0n);
  return unlocked > claimed ? unlocked - claimed : 0n;
}
