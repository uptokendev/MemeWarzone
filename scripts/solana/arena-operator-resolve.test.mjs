import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";

import {
  ARENA_CLAIM_MWL,
  ARENA_CLAIM_PROTOCOL,
  ARENA_KIND_BATTLE,
  ARENA_PROGRAM_ID,
} from "./arena-operator-v0.mjs";
import {
  ARENA_RESULT_WINNER,
  ARENA_SIDE_A,
  ARENA_SIDE_B,
  ARENA_STATE_LIVE,
  ARENA_STATE_RESOLVED,
  battleOutcomeHash,
  buildPlannedResolveInstructions,
  planBattleResolve,
  planOperatorClaim,
} from "./arena-operator-resolve.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const assetA = Keypair.generate().publicKey;
const assetB = Keypair.generate().publicKey;
const ownerA = Keypair.generate().publicKey;
const ownerB = Keypair.generate().publicKey;
const poolId = Buffer.alloc(32, 9);

function pool(overrides = {}) {
  return {
    kind: 0,
    state: ARENA_STATE_LIVE,
    poolId,
    assetA: assetA.toBase58(),
    assetB: assetB.toBase58(),
    ownerA: ownerA.toBase58(),
    ownerB: ownerB.toBase58(),
    depositedStakeA: 1_000_000_000n,
    depositedStakeB: 1_000_000_000n,
    supportTotal: 100n,
    prizeBoostTotal: 0n,
    buyInTotal: 0n,
    resolveDeadline: 2_000_000_000,
    actionNonce: 0n,
    claimedProtocol: false,
    claimedMwl: false,
    pendingProtocol: 50n,
    pendingMwl: 100n,
    ...overrides,
  };
}

function settlement(overrides = {}) {
  return {
    id: "arena-battle-1",
    money_winner_token: assetA.toBase58(),
    mwl_draw: false,
    mwl_result: "left_win",
    mwl_winner_token: assetA.toBase58(),
    challenger_end_mcap_usd: 120,
    defender_end_mcap_usd: 90,
    settlement_version: 1,
    ...overrides,
  };
}

test("resolve consumes money_winner_token and never a missing payout winner", () => {
  const blocked = planBattleResolve({ settlement: settlement({ money_winner_token: "" }), pool: pool() });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "missing-money-winner");
  const planned = planBattleResolve({ settlement: settlement(), pool: pool() });
  assert.equal(planned.ok, true);
  assert.equal(planned.action, "resolve");
  assert.equal(planned.winnerSide, ARENA_SIDE_A);
  assert.equal(planned.winnerAsset, assetA.toBase58());
  assert.equal(planned.winnerWallet, ownerA.toBase58());
  assert.equal(planned.resultType, ARENA_RESULT_WINNER);
  assert.equal(planned.kind, ARENA_KIND_BATTLE);
});

test("MWL draw still resolves the money winner, not a null league winner", () => {
  const planned = planBattleResolve({
    settlement: settlement({
      mwl_draw: true,
      mwl_result: "draw",
      mwl_winner_token: "",
      money_winner_token: assetB.toBase58(),
    }),
    pool: pool(),
  });
  assert.equal(planned.ok, true);
  assert.equal(planned.winnerSide, ARENA_SIDE_B);
  assert.equal(planned.winnerWallet, ownerB.toBase58());
  assert.notEqual(planned.winnerAsset, planned.mwlWinnerToken);
});

test("non-draw MWL/money mismatch is blocked", () => {
  const blocked = planBattleResolve({
    settlement: settlement({
      mwl_draw: false,
      mwl_result: "left_win",
      mwl_winner_token: assetA.toBase58(),
      money_winner_token: assetB.toBase58(),
    }),
    pool: pool(),
  });
  assert.equal(blocked.reason, "mwl-money-mismatch");
});

test("unknown money winner token cannot resolve", () => {
  const blocked = planBattleResolve({
    settlement: settlement({
      money_winner_token: Keypair.generate().publicKey.toBase58(),
      mwl_winner_token: "",
    }),
    pool: pool(),
  });
  assert.equal(blocked.reason, "money-winner-not-in-pool");
});

test("already-resolved pools skip resolve when the on-chain winner matches", () => {
  const skip = planBattleResolve({
    settlement: settlement(),
    pool: pool({ state: ARENA_STATE_RESOLVED, winnerAsset: assetA.toBase58() }),
  });
  assert.equal(skip.ok, true);
  assert.equal(skip.action, "skip");
  assert.equal(skip.reason, "already-resolved");
  const mismatch = planBattleResolve({
    settlement: settlement(),
    pool: pool({ state: ARENA_STATE_RESOLVED, winnerAsset: assetB.toBase58() }),
  });
  assert.equal(mismatch.reason, "resolved-winner-mismatch");
});

test("tournaments stay out of 4b", () => {
  assert.equal(planBattleResolve({ settlement: settlement(), pool: pool({ kind: 1 }) }).reason, "tournament-deferred-to-4c");
  assert.equal(planOperatorClaim({ pool: pool({ kind: 1, state: ARENA_STATE_RESOLVED }), bucket: ARENA_CLAIM_PROTOCOL, receiver: ownerA.toBase58() }).reason, "tournament-deferred-to-4c");
});

test("planned resolve is Ed25519 then resolve_pool_v2, never Phantom", () => {
  const resolver = Keypair.generate();
  const planned = planBattleResolve({ settlement: settlement(), pool: pool() });
  const built = buildPlannedResolveInstructions(planned, resolver);
  assert.equal(built.instructions.length, 2);
  assert.equal(built.instructions[0].programId.toBase58(), "Ed25519SigVerify111111111111111111111111111");
  assert.ok(built.instructions[1].programId.equals(ARENA_PROGRAM_ID));
  assert.equal(built.instructions[0], built.verifyIx);
  assert.equal(built.instructions[1], built.resolveIx);
  const source = fs.readFileSync(path.join(here, "arena-operator-resolve.mjs"), "utf8");
  assert.doesNotMatch(source, /window\.phantom/i);
  assert.doesNotMatch(source, /solanaUserV0Transaction/);
  assert.doesNotMatch(source, /new Transaction\s*\(/);
  assert.match(source, /Never route this through Phantom/);
  assert.match(source, /sendArenaOperatorV0/);
  assert.match(source, /money_winner_token/);
});

test("outcome hash is deterministic for the same settlement snapshot", () => {
  const a = battleOutcomeHash(settlement());
  const b = battleOutcomeHash(settlement());
  const c = battleOutcomeHash(settlement({ defender_end_mcap_usd: 91 }));
  assert.equal(a.length, 32);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test("protocol and MWL claims are fail-closed and idempotent", () => {
  const live = planOperatorClaim({
    pool: pool(),
    bucket: ARENA_CLAIM_PROTOCOL,
    receiver: ownerA.toBase58(),
  });
  assert.equal(live.reason, "pool-not-resolved");
  const ready = planOperatorClaim({
    pool: pool({ state: ARENA_STATE_RESOLVED }),
    bucket: ARENA_CLAIM_MWL,
    receiver: ownerB.toBase58(),
  });
  assert.equal(ready.ok, true);
  assert.equal(ready.action, "claim");
  assert.equal(ready.bucket, ARENA_CLAIM_MWL);
  const skipped = planOperatorClaim({
    pool: pool({ state: ARENA_STATE_RESOLVED, claimedMwl: true }),
    bucket: ARENA_CLAIM_MWL,
    receiver: ownerB.toBase58(),
  });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.action, "skip");
  assert.equal(skipped.reason, "already-claimed");
  const empty = planOperatorClaim({
    pool: pool({ state: ARENA_STATE_RESOLVED, pendingProtocol: 0n }),
    bucket: ARENA_CLAIM_PROTOCOL,
    receiver: ownerA.toBase58(),
  });
  assert.equal(empty.reason, "nothing-to-claim");
});

test("operator files stay off the user V0 / Phantom path", () => {
  const parent = fs.readFileSync(path.join(here, "arena-operator-v0.mjs"), "utf8");
  assert.match(parent, /Ed25519Program/);
  assert.match(parent, /sendServerV0/);
  assert.doesNotMatch(parent, /window\.phantom/i);
  assert.doesNotMatch(parent, /compileSolanaUserV0WithLatestBlockhash/);
});
