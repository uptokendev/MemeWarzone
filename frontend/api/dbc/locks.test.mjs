import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import { DBC_JUPITER_LOCK_PROGRAM_ID } from "../../shared/dbcEconomics.mjs";
import { encodeCreateVestingEscrowData } from "../../src/lib/dbcJupiterLock.mjs";
import { lockScheduleFromNow } from "../../shared/dbcLockSchedule.mjs";
import { assertEscrowMatchesLock, DbcLockRecordError, createDbcLocksHandler } from "./locks.js";

function escrowAccount({ recipient, mint, creator, amount, cancelMode = 0, updateRecipientMode = 0 }) {
  const disc = Buffer.from([244, 119, 183, 4, 73, 116, 135, 195]);
  const body = Buffer.alloc(208);
  Buffer.from(recipient.toBytes()).copy(body, 0);
  Buffer.from(mint.toBytes()).copy(body, 32);
  Buffer.from(creator.toBytes()).copy(body, 64);
  Buffer.from(Keypair.generate().publicKey.toBytes()).copy(body, 96);
  body[128] = 255;
  body[129] = updateRecipientMode;
  body[130] = cancelMode;
  const schedule = lockScheduleFromNow(1_700_000_000, amount);
  body.writeBigUInt64LE(BigInt(schedule.cliffTime), 136);
  body.writeBigUInt64LE(BigInt(schedule.frequency), 144);
  body.writeBigUInt64LE(schedule.cliffUnlockAmount, 152);
  body.writeBigUInt64LE(schedule.amountPerPeriod, 160);
  body.writeBigUInt64LE(BigInt(schedule.numberOfPeriod), 168);
  body.writeBigUInt64LE(0n, 176);
  body.writeBigUInt64LE(BigInt(schedule.vestingStartTime), 184);
  body.writeBigUInt64LE(0n, 192);
  return Buffer.concat([disc, body]);
}

test("lock-record refuses another recipient, mint, amount or cancel mode", async () => {
  const { parseVestingEscrow } = await import("../../src/lib/dbcJupiterLock.mjs");
  const creator = Keypair.generate();
  const mint = Keypair.generate();
  const other = Keypair.generate();
  const amount = 5_000_000n;
  const parsed = parseVestingEscrow(escrowAccount({
    recipient: creator.publicKey,
    mint: mint.publicKey,
    creator: creator.publicKey,
    amount,
  }));
  assert.doesNotThrow(() => assertEscrowMatchesLock({
    parsed,
    mint: mint.publicKey.toBase58(),
    creator: creator.publicKey.toBase58(),
    amount,
  }));
  assert.throws(
    () => assertEscrowMatchesLock({
      parsed,
      mint: mint.publicKey.toBase58(),
      creator: other.publicKey.toBase58(),
      amount,
    }),
    /recipient/,
  );
  assert.throws(
    () => assertEscrowMatchesLock({
      parsed,
      mint: other.publicKey.toBase58(),
      creator: creator.publicKey.toBase58(),
      amount,
    }),
    /mint/,
  );
  assert.throws(
    () => assertEscrowMatchesLock({
      parsed,
      mint: mint.publicKey.toBase58(),
      creator: creator.publicKey.toBase58(),
      amount: 10n,
    }),
    /amount/,
  );
  const cancelled = parseVestingEscrow(escrowAccount({
    recipient: creator.publicKey,
    mint: mint.publicKey,
    creator: creator.publicKey,
    amount,
    cancelMode: 1,
  }));
  assert.throws(
    () => assertEscrowMatchesLock({
      parsed: cancelled,
      mint: mint.publicKey.toBase58(),
      creator: creator.publicKey.toBase58(),
      amount,
    }),
    /cancel mode/,
  );
  assert.ok(createDbcLocksHandler);
  assert.equal(DBC_JUPITER_LOCK_PROGRAM_ID.length > 0, true);
  void encodeCreateVestingEscrowData;
  void DbcLockRecordError;
});
