import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";

import {
  ARENA_CLAIM_CHARITY,
  ARENA_CLAIM_MWL,
  ARENA_CLAIM_PROTOCOL,
  ARENA_KIND_BATTLE,
  ARENA_KIND_TOURNAMENT,
  ARENA_PROGRAM_ID,
  ARENA_RESOLUTION_DOMAIN,
  buildArenaOperatorClaimInstruction,
  buildArenaResolveInstructions,
  buildArenaResolutionMessage,
  deriveArenaBuyInReceipt,
  deriveArenaClaimReceipt,
  deriveArenaOperatorPdas,
} from "./arena-operator-v0.mjs";

const poolId = Buffer.alloc(32, 7);
const resolver = Keypair.generate();
const battleWinner = Keypair.generate().publicKey;

function resolution(overrides = {}) {
  return {
    resolver,
    kind: ARENA_KIND_BATTLE,
    poolId,
    version: 1,
    winner: battleWinner,
    resultType: 1,
    stakeTotal: 2_000_000_000n,
    supportTotal: 300_000_000n,
    buyInTotal: 0n,
    deadline: 1_800_000_000n,
    nonce: 4n,
    ...overrides,
  };
}

test("resolution message is domain-separated and replay-sensitive", () => {
  const { pool } = deriveArenaOperatorPdas(poolId);
  const base = buildArenaResolutionMessage({
    version: 1,
    poolId,
    pool,
    winner: battleWinner,
    resultType: 1,
    stakeTotal: 2_000_000_000n,
    supportTotal: 300_000_000n,
    buyInTotal: 0n,
    deadline: 1_800_000_000n,
    nonce: 4n,
  });
  const changedNonce = buildArenaResolutionMessage({
    version: 1,
    poolId,
    pool,
    winner: battleWinner,
    resultType: 1,
    stakeTotal: 2_000_000_000n,
    supportTotal: 300_000_000n,
    buyInTotal: 0n,
    deadline: 1_800_000_000n,
    nonce: 5n,
  });
  const otherPoolId = Buffer.alloc(32, 8);
  const otherPool = deriveArenaOperatorPdas(otherPoolId).pool;
  const changedPool = buildArenaResolutionMessage({
    version: 1,
    poolId: otherPoolId,
    pool: otherPool,
    winner: battleWinner,
    resultType: 1,
    stakeTotal: 2_000_000_000n,
    supportTotal: 300_000_000n,
    buyInTotal: 0n,
    deadline: 1_800_000_000n,
    nonce: 4n,
  });

  assert.deepEqual(base.subarray(0, ARENA_RESOLUTION_DOMAIN.length), ARENA_RESOLUTION_DOMAIN);
  assert.deepEqual(
    base.subarray(ARENA_RESOLUTION_DOMAIN.length, ARENA_RESOLUTION_DOMAIN.length + 32),
    ARENA_PROGRAM_ID.toBuffer(),
  );
  assert.notDeepEqual(base, changedNonce);
  assert.notDeepEqual(base, changedPool);
});

test("battle resolution emits Ed25519 first and uses pool as unused receipt placeholder", () => {
  const built = buildArenaResolveInstructions(resolution());
  assert.equal(built.verifyIx.programId.toBase58(), "Ed25519SigVerify111111111111111111111111111");
  assert.ok(built.resolveIx.programId.equals(ARENA_PROGRAM_ID));
  assert.ok(built.winnerReceipt.equals(built.pool));
  assert.ok(built.resolveIx.keys[2].pubkey.equals(built.pool));
  assert.deepEqual(built.verifyIx.data.subarray(-built.message.length), built.message);
});

test("tournament resolution requires the canonical winner buy-in receipt", () => {
  const entrant = Keypair.generate().publicKey;
  const expected = deriveArenaBuyInReceipt(poolId, entrant);
  const built = buildArenaResolveInstructions(
    resolution({
      kind: ARENA_KIND_TOURNAMENT,
      winner: entrant,
      stakeTotal: 0n,
      buyInTotal: 5_000_000_000n,
    }),
  );
  assert.ok(built.winnerReceipt.equals(expected));
  assert.ok(built.resolveIx.keys[2].pubkey.equals(expected));

  assert.throws(
    () => buildArenaResolveInstructions(
      resolution({
        kind: ARENA_KIND_TOURNAMENT,
        winner: entrant,
        stakeTotal: 0n,
        buyInTotal: 5_000_000_000n,
        winnerBuyInReceipt: Keypair.generate().publicKey,
      }),
    ),
    /canonical PDA/,
  );
});

test("claim receipt namespace isolates protocol, MWL and charity", () => {
  const protocol = deriveArenaClaimReceipt(poolId, ARENA_CLAIM_PROTOCOL);
  const mwl = deriveArenaClaimReceipt(poolId, ARENA_CLAIM_MWL);
  const charity = deriveArenaClaimReceipt(poolId, ARENA_CLAIM_CHARITY);
  assert.notEqual(protocol.toBase58(), mwl.toBase58());
  assert.notEqual(protocol.toBase58(), charity.toBase58());
  assert.notEqual(mwl.toBase58(), charity.toBase58());

  const caller = Keypair.generate().publicKey;
  const receiver = Keypair.generate().publicKey;
  const built = buildArenaOperatorClaimInstruction({
    caller,
    poolId,
    bucket: ARENA_CLAIM_PROTOCOL,
    receiver,
  });
  assert.ok(built.instruction.programId.equals(ARENA_PROGRAM_ID));
  assert.ok(built.claimReceipt.equals(protocol));
});

test("invalid pool kind is rejected before transaction construction", () => {
  assert.throws(() => buildArenaResolveInstructions(resolution({ kind: "other" })), /pool kind/);
});

test("program id remains the deployed same-ID treasury", () => {
  assert.equal(ARENA_PROGRAM_ID.toBase58(), "2NzthKEZHtbnqXxT4eeEnEQRHkQsdqgqVsfzcCCoZBKX");
  assert.ok(PublicKey.isOnCurve(battleWinner.toBytes()));
});
