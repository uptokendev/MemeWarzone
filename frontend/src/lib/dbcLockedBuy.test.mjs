import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  DBC_CREATOR_LOCK_COPY,
  DBC_JUPITER_LOCK_PROGRAM_ID,
  DBC_LOCK_CLIFF_SECONDS,
  DBC_LOCK_FREQUENCY_SECONDS,
  DBC_LOCK_PERIODS,
  DBC_PROGRAM_ID,
} from "../../shared/dbcEconomics.mjs";
import { lockScheduleFromNow } from "../../shared/dbcLockSchedule.mjs";
import { encodeCreateVestingEscrowData } from "./dbcJupiterLock.mjs";
import { assertDbcTradeIntent } from "./dbcTrade.mjs";
import { DBC_CREATOR_LOCK_COPY as copyFromLockedBuy } from "./dbcLockedBuy.mjs";

test("locked-buy copy is the D12 sentence", () => {
  assert.equal(copyFromLockedBuy, DBC_CREATOR_LOCK_COPY);
  assert.match(DBC_CREATOR_LOCK_COPY, /20% is released after 30 days/);
});

test("locked-buy schedule is 20% at 30 days then 20% every 7 days for 4 periods", () => {
  const amount = 5_000_000n;
  const schedule = lockScheduleFromNow(1_700_000_000, amount);
  assert.equal(schedule.amount, amount);
  assert.equal(schedule.cliffUnlockAmount, 1_000_000n);
  assert.equal(schedule.amountPerPeriod, 1_000_000n);
  assert.equal(schedule.numberOfPeriod, DBC_LOCK_PERIODS);
  assert.equal(schedule.cliffTime, 1_700_000_000 + DBC_LOCK_CLIFF_SECONDS);
  assert.equal(schedule.frequency, DBC_LOCK_FREQUENCY_SECONDS);
  assert.equal(schedule.cancelMode, 0);
  assert.equal(schedule.updateRecipientMode, 0);
  const data = encodeCreateVestingEscrowData(schedule);
  assert.equal(data.length, 8 + 48 + 2);
  assert.equal(data.readBigUInt64LE(8 + 8), BigInt(schedule.cliffTime));
  assert.equal(data[8 + 48], 0);
  assert.equal(data[8 + 49], 0);
});

test("locked-buy transaction allows Jupiter Lock and requires two signers in the envelope", () => {
  const trader = Keypair.generate();
  const base = Keypair.generate();
  const pool = Keypair.generate();
  const tx = new Transaction();
  tx.feePayer = trader.publicKey;
  tx.recentBlockhash = "11111111111111111111111111111111";
  tx.add(new TransactionInstruction({
    keys: [
      { pubkey: trader.publicKey, isSigner: true, isWritable: true },
      { pubkey: pool.publicKey, isSigner: false, isWritable: true },
    ],
    programId: new PublicKey(DBC_PROGRAM_ID),
    data: Buffer.alloc(0),
  }));
  tx.add(new TransactionInstruction({
    keys: [
      { pubkey: base.publicKey, isSigner: true, isWritable: true },
      { pubkey: trader.publicKey, isSigner: true, isWritable: true },
    ],
    programId: new PublicKey(DBC_JUPITER_LOCK_PROGRAM_ID),
    data: encodeCreateVestingEscrowData(lockScheduleFromNow(1_700_000_000, 5n)),
  }));
  assert.doesNotThrow(() => assertDbcTradeIntent(tx, {
    trader: trader.publicKey.toBase58(),
    pool: pool.publicKey.toBase58(),
    allowLock: true,
  }));
  const signers = tx.instructions.flatMap((ix) => ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58()));
  assert.ok(signers.includes(trader.publicKey.toBase58()));
  assert.ok(signers.includes(base.publicKey.toBase58()));
});
