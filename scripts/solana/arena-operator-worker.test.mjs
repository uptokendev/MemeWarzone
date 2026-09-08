import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";

import {
  ARENA_STATE_LIVE,
  ARENA_STATE_RESOLVED,
  canonicalBattlePoolIdBytes,
} from "./arena-operator-resolve.mjs";
import { runOperatorJob, settlementFromBattleRow } from "./arena-operator-worker.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const assetA = Keypair.generate().publicKey;
const assetB = Keypair.generate().publicKey;
const ownerA = Keypair.generate().publicKey;
const ownerB = Keypair.generate().publicKey;
const protocolReceiver = Keypair.generate().publicKey;
const mwlReceiver = Keypair.generate().publicKey;
const resolver = Keypair.generate();
const battleId = "arena-battle-1";
const poolId = canonicalBattlePoolIdBytes(battleId);

function row(overrides = {}) {
  return {
    id: battleId,
    chain_id: 101,
    state: "finished",
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
    supportTotal: 0n,
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

function config(overrides = {}) {
  return {
    resolver: resolver.publicKey.toBase58(),
    protocolReceiver: protocolReceiver.toBase58(),
    mwlReceiver: mwlReceiver.toBase58(),
    ...overrides,
  };
}

test("settlementFromBattleRow preserves durable 4a.2 fields without inference", () => {
  const mapped = settlementFromBattleRow(row({ mwl_draw: true, mwl_result: "draw", mwl_winner_token: "" }));
  assert.equal(mapped.mwl_draw, true);
  assert.equal(mapped.mwl_result, "draw");
  assert.equal(mapped.money_winner_token, assetA.toBase58());
});

test("worker never sends when planner skips or blocks", async () => {
  let sent = 0;
  const skipped = await runOperatorJob({
    command: "resolve",
    battleId,
    send: true,
    resolver,
    loadSettlement: async () => row(),
    loadPool: async () =>
      pool({
        state: ARENA_STATE_RESOLVED,
        winnerAsset: assetA.toBase58(),
        winnerWallet: ownerA.toBase58(),
      }),
    loadConfig: async () => config(),
    sendResolve: async () => {
      sent += 1;
      return "sig";
    },
  });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.action, "skip");
  assert.equal(sent, 0);

  const blocked = await runOperatorJob({
    command: "resolve",
    battleId,
    send: true,
    loadSettlement: async () => row({ state: "live" }),
    loadPool: async () => pool(),
    sendResolve: async () => {
      sent += 1;
      return "sig";
    },
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "battle-not-finished");
  assert.equal(sent, 0);
});

test("actionable resolve dry-run does not send; --send re-reads until skip", async () => {
  let sent = 0;
  const dry = await runOperatorJob({
    command: "resolve",
    battleId,
    send: false,
    resolver,
    loadSettlement: async () => row(),
    loadPool: async () => pool(),
    loadConfig: async () => config(),
    sendResolve: async () => {
      sent += 1;
      return "sig";
    },
  });
  assert.equal(dry.ok, true);
  assert.equal(dry.action, "resolve");
  assert.equal(dry.sent, false);
  assert.equal(sent, 0);

  let reads = 0;
  const sentResult = await runOperatorJob({
    command: "resolve",
    battleId,
    send: true,
    resolver,
    loadSettlement: async () => row(),
    loadConfig: async () => config(),
    loadPool: async () => {
      reads += 1;
      if (reads === 1) return pool();
      return pool({
        state: ARENA_STATE_RESOLVED,
        winnerAsset: assetA.toBase58(),
        winnerWallet: ownerA.toBase58(),
      });
    },
    sendResolve: async (plan) => {
      sent += 1;
      assert.equal(plan.action, "resolve");
      assert.equal(plan.moneyWinnerToken, assetA.toBase58());
      return "resolve-sig";
    },
  });
  assert.equal(sentResult.ok, true);
  assert.equal(sentResult.action, "sent");
  assert.equal(sentResult.signature, "resolve-sig");
  assert.equal(sentResult.after.action, "skip");
  assert.equal(sent, 1);
  assert.equal(reads, 2);
});

test("resolve blocks when canonical Arena config is missing or resolver mismatches", async () => {
  let sent = 0;
  const unread = await runOperatorJob({
    command: "resolve",
    battleId,
    send: true,
    resolver,
    loadSettlement: async () => row(),
    loadPool: async () => pool(),
    loadConfig: async () => null,
    sendResolve: async () => {
      sent += 1;
      return "sig";
    },
  });
  assert.equal(unread.reason, "config-unreadable");
  assert.equal(sent, 0);

  const mismatch = await runOperatorJob({
    command: "resolve",
    battleId,
    send: true,
    resolver,
    loadSettlement: async () => row(),
    loadPool: async () => pool(),
    loadConfig: async () => config({ resolver: Keypair.generate().publicKey.toBase58() }),
    sendResolve: async () => {
      sent += 1;
      return "sig";
    },
  });
  assert.equal(mismatch.reason, "resolver-config-mismatch");
  assert.equal(sent, 0);

  const missingKey = await runOperatorJob({
    command: "resolve",
    battleId,
    send: false,
    loadSettlement: async () => row(),
    loadPool: async () => pool(),
    loadConfig: async () => config(),
  });
  assert.equal(missingKey.reason, "missing-resolver");
});

test("claim worker uses Arena config receiver and skips after confirmation", async () => {
  let sent = 0;
  let reads = 0;
  const result = await runOperatorJob({
    command: "claim-mwl",
    battleId,
    send: true,
    loadSettlement: async () => row(),
    loadPool: async () => {
      reads += 1;
      if (reads === 1) {
        return pool({
          state: ARENA_STATE_RESOLVED,
          winnerAsset: assetA.toBase58(),
          winnerWallet: ownerA.toBase58(),
        });
      }
      return pool({
        state: ARENA_STATE_RESOLVED,
        winnerAsset: assetA.toBase58(),
        winnerWallet: ownerA.toBase58(),
        claimedMwl: true,
      });
    },
    loadConfig: async () => config(),
    sendClaim: async (plan) => {
      sent += 1;
      assert.equal(plan.receiver, mwlReceiver.toBase58());
      return "claim-sig";
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, "sent");
  assert.equal(result.after.action, "skip");
  assert.equal(sent, 1);
});

test("worker stays on the certified planner and server V0 send path", () => {
  const source = fs.readFileSync(path.join(here, "arena-operator-worker.mjs"), "utf8");
  const sender = fs.readFileSync(path.join(here, "send-server-v0.mjs"), "utf8");
  assert.match(source, /planBattleResolve/);
  assert.match(source, /planOperatorClaim/);
  assert.match(source, /sendPlannedResolve/);
  assert.match(source, /sendPlannedClaim/);
  assert.match(source, /Never route this through Phantom/);
  assert.doesNotMatch(source, /window\.phantom/i);
  assert.doesNotMatch(source, /solanaUserV0Transaction/);
  assert.doesNotMatch(source, /new Transaction\s*\(/);
  assert.match(sender, /compileToV0Message/);
  assert.doesNotMatch(sender, /ComputeBudget/);
  assert.doesNotMatch(sender, /instructions\.splice/);
  assert.doesNotMatch(sender, /instructions\.unshift/);
});
