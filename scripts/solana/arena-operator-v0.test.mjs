import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";

import {
  ARENA_CANCEL_DOMAIN,
  ARENA_CLAIM_CHARITY,
  ARENA_CLAIM_MWL,
  ARENA_CLAIM_PROTOCOL,
  ARENA_KIND_BATTLE,
  ARENA_KIND_TOURNAMENT,
  ARENA_PROGRAM_ID,
  ARENA_RESOLUTION_DOMAIN,
  buildArenaCancelInstructions,
  buildArenaCancelMessage,
  buildArenaOperatorClaimInstruction,
  buildArenaResolveInstructions,
  buildArenaResolutionMessage,
  deriveArenaBuyInReceipt,
  deriveArenaClaimReceipt,
  deriveArenaOperatorPdas,
} from "./arena-operator-v0.mjs";

const poolId = Buffer.alloc(32, 7);
const resolver = Keypair.generate();
const ownerA = Keypair.generate().publicKey;
const ownerB = Keypair.generate().publicKey;
const assetA = Keypair.generate().publicKey;
const assetB = Keypair.generate().publicKey;
const zero = new PublicKey(new Uint8Array(32));

function resolution(overrides = {}) {
  return {
    resolver,
    kind: ARENA_KIND_BATTLE,
    poolId,
    version: 2,
    assetA,
    assetB,
    ownerA,
    ownerB,
    stakeA: 1_000_000_000n,
    stakeB: 1_200_000_000n,
    supportTotal: 300_000_000n,
    prizeBoostTotal: 700_000_000n,
    buyInTotal: 0n,
    winnerSide: 1,
    winnerAsset: assetA,
    winnerWallet: ownerA,
    resultType: 1,
    outcomeHash: Buffer.alloc(32, 3),
    deadline: 1_800_000_000n,
    nonce: 4n,
    ...overrides,
  };
}

function cancellation(overrides = {}) {
  return {
    resolver,
    poolId,
    version: 2,
    reasonCode: 2,
    stakeA: 1_000_000_000n,
    stakeB: 0n,
    supportTotal: 0n,
    buyInTotal: 0n,
    prizeBoostTotal: 700_000_000n,
    deadline: 1_800_000_000n,
    nonce: 1n,
    ...overrides,
  };
}

test("V2 resolution message is domain-separated and binds outcome/boost/nonce", () => {
  const { pool } = deriveArenaOperatorPdas(poolId);
  const base = buildArenaResolutionMessage({ ...resolution(), pool });
  const changedOutcome = buildArenaResolutionMessage({ ...resolution({ outcomeHash: Buffer.alloc(32, 4) }), pool });
  const changedBoost = buildArenaResolutionMessage({ ...resolution({ prizeBoostTotal: 700_000_001n }), pool });
  const changedNonce = buildArenaResolutionMessage({ ...resolution({ nonce: 5n }), pool });
  assert.deepEqual(base.subarray(0, ARENA_RESOLUTION_DOMAIN.length), ARENA_RESOLUTION_DOMAIN);
  assert.deepEqual(base.subarray(ARENA_RESOLUTION_DOMAIN.length, ARENA_RESOLUTION_DOMAIN.length + 32), ARENA_PROGRAM_ID.toBuffer());
  assert.notDeepEqual(base, changedOutcome);
  assert.notDeepEqual(base, changedBoost);
  assert.notDeepEqual(base, changedNonce);
});

test("battle V2 resolution emits Ed25519 first and uses pool placeholder receipt", () => {
  const built = buildArenaResolveInstructions(resolution());
  assert.equal(built.verifyIx.programId.toBase58(), "Ed25519SigVerify111111111111111111111111111");
  assert.ok(built.resolveIx.programId.equals(ARENA_PROGRAM_ID));
  assert.ok(built.winnerReceipt.equals(built.pool));
  assert.deepEqual(built.verifyIx.data.subarray(-built.message.length), built.message);
});

test("tournament winner receipt is bound to winner asset and wallet", () => {
  const winnerWallet = Keypair.generate().publicKey;
  const winnerAsset = Keypair.generate().publicKey;
  const expected = deriveArenaBuyInReceipt(poolId, winnerAsset, winnerWallet);
  const built = buildArenaResolveInstructions(resolution({
    kind: ARENA_KIND_TOURNAMENT,
    assetA: zero,
    assetB: zero,
    ownerA: Keypair.generate().publicKey,
    ownerB: zero,
    stakeA: 0n,
    stakeB: 0n,
    buyInTotal: 5_000_000_000n,
    winnerSide: 0,
    winnerAsset,
    winnerWallet,
  }));
  assert.ok(built.winnerReceipt.equals(expected));
  const otherAsset = Keypair.generate().publicKey;
  assert.notEqual(deriveArenaBuyInReceipt(poolId, otherAsset, winnerWallet).toBase58(), expected.toBase58());
  assert.throws(() => buildArenaResolveInstructions(resolution({
    kind: ARENA_KIND_TOURNAMENT,
    assetA: zero,
    assetB: zero,
    ownerB: zero,
    stakeA: 0n,
    stakeB: 0n,
    buyInTotal: 5_000_000_000n,
    winnerSide: 0,
    winnerAsset,
    winnerWallet,
    winnerBuyInReceipt: Keypair.generate().publicKey,
  })), /canonical asset\+wallet PDA/);
});

test("cancellation domain binds custody totals and nonce", () => {
  const { pool } = deriveArenaOperatorPdas(poolId);
  const base = buildArenaCancelMessage({ ...cancellation(), pool });
  const changedBoost = buildArenaCancelMessage({ ...cancellation({ prizeBoostTotal: 1n }), pool });
  const changedNonce = buildArenaCancelMessage({ ...cancellation({ nonce: 2n }), pool });
  assert.deepEqual(base.subarray(0, ARENA_CANCEL_DOMAIN.length), ARENA_CANCEL_DOMAIN);
  assert.notDeepEqual(base, changedBoost);
  assert.notDeepEqual(base, changedNonce);
  const built = buildArenaCancelInstructions(cancellation());
  assert.equal(built.verifyIx.programId.toBase58(), "Ed25519SigVerify111111111111111111111111111");
  assert.ok(built.cancelIx.programId.equals(ARENA_PROGRAM_ID));
  assert.deepEqual(built.verifyIx.data.subarray(-built.message.length), built.message);
});

test("claim receipt namespace isolates protocol, MWL and charity", () => {
  const protocol = deriveArenaClaimReceipt(poolId, ARENA_CLAIM_PROTOCOL);
  const mwl = deriveArenaClaimReceipt(poolId, ARENA_CLAIM_MWL);
  const charity = deriveArenaClaimReceipt(poolId, ARENA_CLAIM_CHARITY);
  assert.notEqual(protocol.toBase58(), mwl.toBase58());
  assert.notEqual(protocol.toBase58(), charity.toBase58());
  const built = buildArenaOperatorClaimInstruction({ caller: Keypair.generate().publicKey, poolId, bucket: ARENA_CLAIM_PROTOCOL, receiver: Keypair.generate().publicKey });
  assert.ok(built.instruction.programId.equals(ARENA_PROGRAM_ID));
  assert.ok(built.claimReceipt.equals(protocol));
});

test("invalid pool kind is rejected before resolver construction", () => {
  assert.throws(() => buildArenaResolveInstructions(resolution({ kind: "other" })), /pool kind/);
});

test("program id remains the deployed same-ID treasury", () => {
  assert.equal(ARENA_PROGRAM_ID.toBase58(), "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX");
  assert.ok(PublicKey.isOnCurve(ownerA.toBytes()));
});
