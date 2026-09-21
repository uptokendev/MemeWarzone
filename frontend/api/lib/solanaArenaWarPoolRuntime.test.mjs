import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";

import {
  ARENA_BOOST_RECEIPT_DISCRIMINATOR,
  ARENA_BOOST_RECEIPT_SIZE,
  ARENA_WAR_POOL_PROGRAM_ID,
  buildSolanaBoostInstructionRequirements,
  deriveArenaBoostReceiptPda,
  deriveArenaWarPoolPdas,
  parseArenaBoostReceipt,
  splitWarPoolBoost,
} from "./solanaArenaWarPoolRuntime.mjs";

const POOL = "11".repeat(32);
const FUND = "22".repeat(32);
const FUNDER = Keypair.generate().publicKey;

test("boost requirements target the war pool with the six deposit_prize_boost_v2 accounts, funder first", () => {
  const req = buildSolanaBoostInstructionRequirements({ poolId: POOL, fundingId: FUND, wallet: FUNDER.toBase58(), grossLamports: 100n });
  assert.equal(req.programId, ARENA_WAR_POOL_PROGRAM_ID);
  assert.equal(req.instruction, "deposit_prize_boost_v2");
  assert.equal(req.accounts.length, 6);
  const pdas = deriveArenaWarPoolPdas(POOL);
  assert.deepEqual(
    req.accounts.map((a) => `${a.pubkey}:${a.isSigner ? "s" : "-"}${a.isWritable ? "w" : "-"}`),
    [
      `${FUNDER.toBase58()}:sw`,
      `${pdas.config.toBase58()}:--`,
      `${pdas.pool.toBase58()}:-w`,
      `${pdas.vault.toBase58()}:-w`,
      `${deriveArenaBoostReceiptPda(POOL, FUND, FUNDER).toBase58()}:-w`,
      "11111111111111111111111111111111:--",
    ],
  );
  // Only the vault and the receipt are writable program accounts: one fee destination.
  assert.equal(req.accounts.filter((a) => a.isWritable && !a.isSigner).length, 3);
  const data = Buffer.from(req.dataBase64, "base64");
  assert.equal(data.length, 8 + 32 + 32 + 8);
  assert.equal(data.subarray(8, 40).toString("hex"), POOL);
  assert.equal(data.subarray(40, 72).toString("hex"), FUND);
  assert.equal(data.readBigUInt64LE(72), 100n);
});

test("competitionId is accepted as an alias for poolId so quote rows keep their column", () => {
  const a = buildSolanaBoostInstructionRequirements({ competitionId: POOL, fundingId: FUND, wallet: FUNDER.toBase58(), grossLamports: 7n });
  const b = buildSolanaBoostInstructionRequirements({ poolId: POOL, fundingId: FUND, wallet: FUNDER.toBase58(), grossLamports: 7n });
  assert.deepEqual(a, b);
});

test("the war-pool PDAs use the program's seeds", () => {
  const pdas = deriveArenaWarPoolPdas(POOL);
  const program = new PublicKey(ARENA_WAR_POOL_PROGRAM_ID);
  assert.equal(pdas.pool.toBase58(), PublicKey.findProgramAddressSync([Buffer.from("arena_pool"), Buffer.from(POOL, "hex")], program)[0].toBase58());
  assert.equal(pdas.vault.toBase58(), PublicKey.findProgramAddressSync([Buffer.from("arena_vault"), Buffer.from(POOL, "hex")], program)[0].toBase58());
  assert.equal(
    deriveArenaBoostReceiptPda(POOL, FUND, FUNDER).toBase58(),
    PublicKey.findProgramAddressSync([Buffer.from("arena_boost"), Buffer.from(POOL, "hex"), Buffer.from(FUND, "hex"), FUNDER.toBuffer()], program)[0].toBase58(),
  );
});

test("a boost receipt round-trips through the Anchor layout", () => {
  const data = Buffer.alloc(ARENA_BOOST_RECEIPT_SIZE);
  ARENA_BOOST_RECEIPT_DISCRIMINATOR.copy(data, 0);
  Buffer.from(POOL, "hex").copy(data, 8);
  Buffer.from(FUND, "hex").copy(data, 40);
  FUNDER.toBuffer().copy(data, 72);
  data.writeBigUInt64LE(123_456_789n, 104);
  data[112] = 0;
  data[113] = 254;
  const receipt = parseArenaBoostReceipt(data);
  assert.deepEqual(receipt, { poolId: POOL, fundingId: FUND, funder: FUNDER.toBase58(), amountLamports: 123_456_789n, refunded: false, bump: 254 });
  const wrong = Buffer.from(data);
  wrong[0] ^= 1;
  assert.equal(parseArenaBoostReceipt(wrong), null);
  assert.equal(parseArenaBoostReceipt(data.subarray(0, 50)), null);
});

test("boost split is 90/10 and conserves every lamport", () => {
  for (const gross of [1n, 9n, 10n, 11n, 101n, 999n, 1_000_000_000n]) {
    const split = splitWarPoolBoost(gross);
    assert.equal(split.prize + split.protocol, gross);
    assert.equal(split.protocol, (gross * 1_000n) / 10_000n);
  }
  assert.throws(() => splitWarPoolBoost(0n));
});
