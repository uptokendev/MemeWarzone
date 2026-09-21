import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";

import {
  LEAGUE_EPOCH_ACCOUNT_SIZE,
  buildMerkleRoot,
  categoryHashBytes,
  deriveLeagueEpochPda,
  leagueLeaf,
  parseLeagueEpochAccount,
  periodCode,
} from "../rewards/solanaLeagueMerkle.js";

// The API module is the shape the claim proofs are built from; the job must
// publish exactly the root those proofs verify against.
const api = await import("../../../frontend/api/solanaLeagueMerkle.js");

const programId = "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZKX".length === 44
  ? new PublicKey("2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX")
  : new PublicKey("2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX");

test("period codes match the API and fail closed", () => {
  assert.equal(periodCode("weekly"), api.periodCode("weekly"));
  assert.equal(periodCode("monthly"), api.periodCode("monthly"));
  assert.equal(periodCode("quarterly"), api.periodCode("quarterly"));
  assert.equal(periodCode("quarterly"), 2);
  assert.throws(() => periodCode("yearly"), /Unknown league period/);
  assert.throws(() => api.periodCode("yearly"), /Unknown league period/);
});

test("leaf, root and epoch PDA are byte-for-byte the API's", () => {
  const epochStartSec = 1_789_000_000;
  const winners = Array.from({ length: 5 }, (_, i) => ({
    category: ["biggest_hit", "most_volume", "biggest_hit", "most_volume", "best_recruiter"][i],
    rank: (i % 2) + 1,
    recipient: Keypair.generate().publicKey.toBase58(),
    amountRaw: BigInt(1_000_000 * (i + 1)),
  }));
  for (const period of ["weekly", "monthly", "quarterly"]) {
    const ours = winners.map((w) => leagueLeaf({ epochStartSec, period, ...w }));
    const theirs = winners.map((w) => api.leagueLeaf({ epochStartSec, period, ...w }));
    assert.deepEqual(ours, theirs, `${period} leaves`);
    assert.equal(buildMerkleRoot(ours), api.buildMerkleRoot(theirs), `${period} root`);
    assert.equal(buildMerkleRoot(ours.slice(0, 3)), api.buildMerkleRoot(theirs.slice(0, 3)), `${period} odd root`);
    assert.equal(
      deriveLeagueEpochPda(programId, period, epochStartSec).toBase58(),
      api.deriveLeagueEpochPda(period, epochStartSec, programId.toBase58()).toString(),
      `${period} epoch PDA`,
    );
  }
  assert.equal(`0x${categoryHashBytes("biggest_hit").toString("hex")}`, `0x${api.categoryHashBytes("biggest_hit").toString("hex")}`);
});

test("league epoch account layout", () => {
  const data = Buffer.alloc(LEAGUE_EPOCH_ACCOUNT_SIZE);
  data[8] = 1;
  data.writeBigInt64LE(1_789_000_000n, 9);
  Buffer.from("ab".repeat(32), "hex").copy(data, 17);
  data.writeBigUInt64LE(5_000n, 49);
  data.writeBigUInt64LE(1_200n, 57);
  data[65] = 254;
  data[66] = 1;
  data[67] = 1;
  const parsed = parseLeagueEpochAccount(data);
  assert.equal(parsed.period, 1);
  assert.equal(parsed.epochStart, 1_789_000_000n);
  assert.equal(parsed.root, `0x${"ab".repeat(32)}`);
  assert.equal(parsed.totalLamports, 5_000n);
  assert.equal(parsed.claimedLamports, 1_200n);
  assert.equal(parsed.initialized, true);
  assert.equal(parsed.sealed, true);
  assert.throws(() => parseLeagueEpochAccount(data.subarray(0, 40)), /unexpected size/);
});
