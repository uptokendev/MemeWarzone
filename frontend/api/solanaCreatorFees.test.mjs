import assert from "node:assert/strict";
import test from "node:test";

import {
  CREATOR_FEE_VAULT_BYTES,
  FEE_ESCROW_BYTES,
  computeCreatorFeeClaimable,
} from "./lib/solanaCreatorFeeMath.js";

const PROGRAM = "3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt";
const ESCROW_RENT = 1_628_640;
const VAULT_RENT = 1_572_960;

function escrowAccount({ lamports, slices, owner = PROGRAM, size = FEE_ESCROW_BYTES }) {
  const data = Buffer.alloc(size);
  slices.forEach((value, lane) => data.writeBigUInt64LE(BigInt(value), 8 + 32 + lane * 8));
  return { lamports: BigInt(lamports), owner, data };
}

function vaultAccount({ lamports, owner = PROGRAM, size = CREATOR_FEE_VAULT_BYTES }) {
  return { lamports: BigInt(lamports), owner, data: Buffer.alloc(size) };
}

// The Et2Dx campaign on mainnet after the first V7.3 buy, to the lamport:
// total_received 235,292; six slices 204,902 (18,627 already flushed);
// escrow surplus 10,783; V7.0-era vault balance 980; claimable 11,763.
test("claimable is the escrow surplus above rent and the six slices, plus the old vault balance", () => {
  const escrow = escrowAccount({
    lamports: ESCROW_RENT + 204_902 + 10_783,
    slices: [24_263, 56_618, 26_959, 0, 5_391, 91_671],
  });
  const vault = vaultAccount({ lamports: VAULT_RENT + 980 });
  const out = computeCreatorFeeClaimable({ escrow, vault, escrowRent: ESCROW_RENT, vaultRent: VAULT_RENT, programId: PROGRAM });
  assert.equal(out.escrowSurplusLamports, 10_783n);
  assert.equal(out.vaultSurplusLamports, 980n);
  assert.equal(out.claimableLamports, 11_763n);
  assert.equal(out.escrowInitialized, true);
  assert.equal(out.vaultInitialized, true);
});

test("the six pending slices are never claimable, even when the escrow is fat", () => {
  const escrow = escrowAccount({ lamports: ESCROW_RENT + 1_000_000, slices: [1_000_000, 0, 0, 0, 0, 0] });
  const out = computeCreatorFeeClaimable({ escrow, vault: null, escrowRent: ESCROW_RENT, vaultRent: VAULT_RENT, programId: PROGRAM });
  assert.equal(out.claimableLamports, 0n);
});

test("rent is never claimable and a short balance never goes negative", () => {
  const escrow = escrowAccount({ lamports: ESCROW_RENT - 1, slices: [0, 0, 0, 0, 0, 0] });
  const vault = vaultAccount({ lamports: VAULT_RENT });
  const out = computeCreatorFeeClaimable({ escrow, vault, escrowRent: ESCROW_RENT, vaultRent: VAULT_RENT, programId: PROGRAM });
  assert.equal(out.claimableLamports, 0n);
});

test("accounts not owned by the program or of the wrong size are ignored", () => {
  const foreign = escrowAccount({ lamports: ESCROW_RENT + 5_000, slices: [0, 0, 0, 0, 0, 0], owner: "11111111111111111111111111111111" });
  const wrongSize = vaultAccount({ lamports: VAULT_RENT + 5_000, size: CREATOR_FEE_VAULT_BYTES + 1 });
  const out = computeCreatorFeeClaimable({ escrow: foreign, vault: wrongSize, escrowRent: ESCROW_RENT, vaultRent: VAULT_RENT, programId: PROGRAM });
  assert.equal(out.escrowInitialized, false);
  assert.equal(out.vaultInitialized, false);
  assert.equal(out.claimableLamports, 0n);
});

test("a missing escrow (campaign before the backfill) reports uninitialized and zero", () => {
  const out = computeCreatorFeeClaimable({ escrow: null, vault: null, escrowRent: ESCROW_RENT, vaultRent: VAULT_RENT, programId: PROGRAM });
  assert.equal(out.escrowInitialized, false);
  assert.equal(out.claimableLamports, 0n);
});
