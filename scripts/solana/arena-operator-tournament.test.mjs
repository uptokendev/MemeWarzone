import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";

import {
  ARENA_BUYIN_DISCRIMINATOR,
  REWARDS_TREASURY_PROGRAM_ID,
} from "../../frontend/src/lib/solanaArenaLayout.mjs";
import {
  ARENA_KIND_TOURNAMENT,
  ARENA_PROGRAM_ID,
  deriveArenaBuyInReceipt,
} from "./arena-operator-v0.mjs";
import {
  ARENA_KIND_TOURNAMENT_CODE,
  ARENA_RESULT_WINNER,
  ARENA_SIDE_NONE,
  ARENA_STATE_LIVE,
  ARENA_STATE_RESOLVED,
  RESOLVE_POOL_V2_DISCRIMINATOR,
  SOLANA_DEFAULT_PUBKEY,
  assertEd25519Adjacency,
  buildPlannedResolveInstructions,
  canonicalTournamentPoolIdBytes,
  planOperatorClaim,
  planTournamentResolve,
  tournamentOutcomeHash,
} from "./arena-operator-resolve.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const tournamentId = "tourney-1";
const poolId = canonicalTournamentPoolIdBytes(tournamentId);
const winnerAsset = Keypair.generate().publicKey;
const winnerWallet = Keypair.generate().publicKey;
const protocolReceiver = Keypair.generate().publicKey;

function writeU64le(data, offset, value) {
  let n = BigInt(value);
  for (let i = 0; i < 8; i += 1) {
    data[offset + i] = Number(n & 0xffn);
    n >>= 8n;
  }
}

function receiptAccount({ amount = 100n, refunded = false, asset = winnerAsset, wallet = winnerWallet, pool = poolId } = {}) {
  const data = new Uint8Array(8 + 32 + 32 + 32 + 8 + 1 + 1);
  data.set(ARENA_BUYIN_DISCRIMINATOR, 0);
  data.set(pool, 8);
  data.set(asset.toBytes(), 40);
  data.set(wallet.toBytes(), 72);
  writeU64le(data, 104, amount);
  data[112] = refunded ? 1 : 0;
  return {
    data,
    owner: REWARDS_TREASURY_PROGRAM_ID,
    pubkey: deriveArenaBuyInReceipt(pool, asset.toBase58(), wallet.toBase58()),
  };
}

function tournament(overrides = {}) {
  return {
    id: tournamentId,
    winner_token: winnerAsset.toBase58(),
    winner_wallet: winnerWallet.toBase58(),
    ...overrides,
  };
}

function pool(overrides = {}) {
  return {
    kind: ARENA_KIND_TOURNAMENT_CODE,
    state: ARENA_STATE_LIVE,
    poolId,
    assetA: "",
    assetB: "",
    ownerA: "",
    ownerB: "",
    depositedStakeA: 0n,
    depositedStakeB: 0n,
    supportTotal: 50n,
    prizeBoostTotal: 0n,
    buyInTotal: 200n,
    buyInLamports: 100n,
    resolveDeadline: 2_000_000_000,
    actionNonce: 0n,
    claimedProtocol: false,
    claimedMwl: false,
    pendingProtocol: 10n,
    pendingMwl: 20n,
    ...overrides,
  };
}

test("canonical tournament pool id matches ethers.id arena-tournament prefix", () => {
  assert.equal(
    canonicalTournamentPoolIdBytes("tourney-1").toString("hex"),
    "bce8013cde5396814e7c297d611deae8312e6ef2a3c41d87fefdfac2f0d3410d",
  );
});

test("tournament resolve requires winner token, wallet, and canonical buy-in receipt", () => {
  assert.equal(
    planTournamentResolve({ tournament: tournament({ winner_token: "" }), pool: pool(), receiptAccount: receiptAccount() }).reason,
    "missing-money-winner",
  );
  assert.equal(
    planTournamentResolve({ tournament: tournament({ winner_wallet: "" }), pool: pool(), receiptAccount: receiptAccount() }).reason,
    "missing-winner-wallet",
  );
  assert.equal(
    planTournamentResolve({
      tournament: tournament({ winner_token: SOLANA_DEFAULT_PUBKEY }),
      pool: pool(),
      receiptAccount: receiptAccount(),
    }).reason,
    "default-winner-asset",
  );
  assert.equal(
    planTournamentResolve({
      tournament: tournament({ winner_wallet: SOLANA_DEFAULT_PUBKEY }),
      pool: pool(),
      receiptAccount: receiptAccount(),
    }).reason,
    "default-winner-wallet",
  );
  assert.equal(
    planTournamentResolve({ tournament: tournament(), pool: pool(), receiptAccount: null }).reason,
    "buy-in-receipt-missing-account",
  );
  const refunded = planTournamentResolve({
    tournament: tournament(),
    pool: pool(),
    receiptAccount: receiptAccount({ refunded: true }),
  });
  assert.equal(refunded.reason, "buy-in-receipt-refunded");
  assert.equal(
    planTournamentResolve({
      tournament: tournament(),
      pool: pool(),
      receiptAccount: receiptAccount({ amount: 99n }),
    }).reason,
    "buy-in-receipt-amount-mismatch",
  );
  assert.equal(
    planTournamentResolve({
      tournament: tournament(),
      pool: pool(),
      receiptAccount: { ...receiptAccount(), owner: Keypair.generate().publicKey.toBase58() },
    }).reason,
    "buy-in-receipt-wrong-owner",
  );
});

test("tournament resolve binds the derived buy-in PDA and uses SIDE_NONE", () => {
  const planned = planTournamentResolve({
    tournament: tournament(),
    pool: pool(),
    receiptAccount: receiptAccount(),
  });
  assert.equal(planned.ok, true);
  assert.equal(planned.kind, ARENA_KIND_TOURNAMENT);
  assert.equal(planned.winnerSide, ARENA_SIDE_NONE);
  assert.equal(planned.winnerAsset, winnerAsset.toBase58());
  assert.equal(planned.winnerWallet, winnerWallet.toBase58());
  assert.equal(planned.assetA, SOLANA_DEFAULT_PUBKEY);
  assert.equal(planned.assetB, SOLANA_DEFAULT_PUBKEY);
  assert.equal(planned.ownerB, SOLANA_DEFAULT_PUBKEY);
  const expectedPda = deriveArenaBuyInReceipt(poolId, winnerAsset.toBase58(), winnerWallet.toBase58());
  assert.equal(planned.winnerBuyInReceipt.toBase58(), expectedPda.toBase58());
  assert.deepEqual(planned.outcomeHash, tournamentOutcomeHash(tournament()));
});

test("wrong pool id or wrong receipt PDA is blocked", () => {
  assert.equal(planTournamentResolve({ tournament: tournament(), pool: pool({ kind: 0 }), receiptAccount: receiptAccount() }).reason, "not-tournament");
  assert.equal(
    planTournamentResolve({
      tournament: tournament(),
      pool: pool({ poolId: Buffer.alloc(32, 9) }),
      receiptAccount: receiptAccount(),
    }).reason,
    "pool-id-mismatch",
  );
  const otherPda = Keypair.generate().publicKey;
  assert.equal(
    planTournamentResolve({
      tournament: tournament(),
      pool: pool(),
      receiptAccount: { ...receiptAccount(), pubkey: otherPda },
    }).reason,
    "buy-in-receipt-pda-mismatch",
  );
  const { pubkey: _ignored, ...withoutPubkey } = receiptAccount();
  assert.equal(
    planTournamentResolve({
      tournament: tournament(),
      pool: pool(),
      receiptAccount: withoutPubkey,
    }).reason,
    "buy-in-receipt-pda-mismatch",
  );
  assert.equal(
    planTournamentResolve({
      tournament: tournament(),
      pool: pool(),
      receiptAccount: receiptAccount({ pool: Buffer.alloc(32, 3) }),
    }).reason,
    "buy-in-receipt-pool-mismatch",
  );
});

test("tournament resolve reuses Ed25519 immediately before resolve_pool_v2 and the buy-in receipt account", () => {
  const resolver = Keypair.generate();
  const planned = planTournamentResolve({
    tournament: tournament(),
    pool: pool(),
    receiptAccount: receiptAccount(),
  });
  const built = buildPlannedResolveInstructions(planned, resolver);
  assert.doesNotThrow(() => assertEd25519Adjacency(built.instructions));
  assert.ok(built.instructions[1].programId.equals(ARENA_PROGRAM_ID));
  assert.deepEqual(
    Buffer.from(built.instructions[1].data).subarray(0, 8),
    Buffer.from(RESOLVE_POOL_V2_DISCRIMINATOR),
  );
  const data = Buffer.from(built.resolveIx.data);
  assert.equal(data[8 + 32], ARENA_RESULT_WINNER);
  assert.equal(data[8 + 32 + 1], ARENA_SIDE_NONE);
  const receiptKey = built.resolveIx.keys[2].pubkey;
  assert.equal(receiptKey.toBase58(), planned.winnerBuyInReceipt.toBase58());
  assert.notEqual(receiptKey.toBase58(), built.pool.toBase58());
});

test("already-resolved tournament skip requires exact winner asset and wallet", () => {
  const skip = planTournamentResolve({
    tournament: tournament(),
    pool: pool({
      state: ARENA_STATE_RESOLVED,
      winnerAsset: winnerAsset.toBase58(),
      winnerWallet: winnerWallet.toBase58(),
    }),
  });
  assert.equal(skip.action, "skip");
  assert.equal(skip.reason, "already-resolved");
  assert.equal(
    planTournamentResolve({
      tournament: tournament(),
      pool: pool({ state: ARENA_STATE_RESOLVED, winnerAsset: "", winnerWallet: winnerWallet.toBase58() }),
    }).reason,
    "resolved-winner-missing",
  );
  assert.equal(
    planTournamentResolve({
      tournament: tournament(),
      pool: pool({
        state: ARENA_STATE_RESOLVED,
        winnerAsset: winnerAsset.toBase58(),
        winnerWallet: Keypair.generate().publicKey.toBase58(),
      }),
    }).reason,
    "resolved-wallet-mismatch",
  );
});

test("protocol claims are allowed for resolved tournament pots using config receivers", () => {
  const plan = planOperatorClaim({
    pool: pool({
      state: ARENA_STATE_RESOLVED,
      winnerAsset: winnerAsset.toBase58(),
      winnerWallet: winnerWallet.toBase58(),
    }),
    config: { protocolReceiver: protocolReceiver.toBase58(), mwlReceiver: Keypair.generate().publicKey.toBase58() },
    bucket: 1,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.receiver, protocolReceiver.toBase58());
});

test("tournament planner stays operator-only and off Phantom", () => {
  const source = fs.readFileSync(path.join(here, "arena-operator-resolve.mjs"), "utf8");
  assert.match(source, /planTournamentResolve/);
  assert.match(source, /verifyAuthoritativeBuyInReceipt/);
  assert.match(source, /winnerBuyInReceipt/);
  assert.match(source, /canonicalTournamentPoolIdBytes/);
  assert.doesNotMatch(source, /window\.phantom/i);
  assert.doesNotMatch(source, /solanaUserV0Transaction/);
});
