import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { canonicalSolanaClaimIdentity } from "./solanaClaimEnvironment.js";

function read(path) {
  return fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("canonical Solana claims retire chain 102 and preserve staging/devnet", () => {
  const oldEnv = process.env.SOLANA_REWARD_ENVIRONMENT;
  const oldCluster = process.env.SOLANA_REWARD_CLUSTER;
  process.env.SOLANA_REWARD_ENVIRONMENT = "staging";
  process.env.SOLANA_REWARD_CLUSTER = "devnet";
  try {
    assert.deepEqual(
      canonicalSolanaClaimIdentity({ chainId: 101, environment: "staging", solanaCluster: "devnet" }),
      { chainId: 101, environment: "staging", solanaCluster: "devnet" },
    );
    assert.throws(
      () => canonicalSolanaClaimIdentity({ chainId: 102, environment: "staging", solanaCluster: "devnet" }),
      (error) => error?.code === "LEGACY_SOLANA_CLAIM_CHAIN_RETIRED",
    );
    assert.throws(
      () => canonicalSolanaClaimIdentity({ chainId: 101, environment: "production", solanaCluster: "mainnet-beta" }),
      (error) => error?.code === "SOLANA_CLAIM_ENVIRONMENT_MISMATCH" || error?.code === "SOLANA_CLAIM_CLUSTER_MISMATCH",
    );
  } finally {
    if (oldEnv == null) delete process.env.SOLANA_REWARD_ENVIRONMENT; else process.env.SOLANA_REWARD_ENVIRONMENT = oldEnv;
    if (oldCluster == null) delete process.env.SOLANA_REWARD_CLUSTER; else process.env.SOLANA_REWARD_CLUSTER = oldCluster;
  }
});

test("canonical Solana claims preserve production/mainnet-beta", () => {
  const oldEnv = process.env.SOLANA_REWARD_ENVIRONMENT;
  const oldCluster = process.env.SOLANA_REWARD_CLUSTER;
  process.env.SOLANA_REWARD_ENVIRONMENT = "production";
  process.env.SOLANA_REWARD_CLUSTER = "mainnet-beta";
  try {
    assert.deepEqual(
      canonicalSolanaClaimIdentity({ chainId: 101, environment: "production", solanaCluster: "mainnet-beta" }),
      { chainId: 101, environment: "production", solanaCluster: "mainnet-beta" },
    );
    assert.throws(
      () => canonicalSolanaClaimIdentity({ chainId: 101, environment: "staging", solanaCluster: "devnet" }),
      (error) => error?.code === "SOLANA_CLAIM_ENVIRONMENT_MISMATCH" || error?.code === "SOLANA_CLAIM_CLUSTER_MISMATCH",
    );
  } finally {
    if (oldEnv == null) delete process.env.SOLANA_REWARD_ENVIRONMENT; else process.env.SOLANA_REWARD_ENVIRONMENT = oldEnv;
    if (oldCluster == null) delete process.env.SOLANA_REWARD_CLUSTER; else process.env.SOLANA_REWARD_CLUSTER = oldCluster;
  }
});

test("claim entrypoints expose durable EVM reconciliation and immutable transaction guards", () => {
  const rewards = read("rewards.js");
  const closeout = read("dev-fix/reward-claim-closeout-router.js");
  const league = read("leagueRouter.js");
  const payouts = read("leaguePayouts.js");

  assert.match(rewards, /discoverEvmRewardClaim/);
  assert.match(rewards, /for update/);
  assert.match(rewards, /CLAIM_TX_REUSED/);
  assert.match(rewards, /CLAIM_ALREADY_RECORDED/);
  assert.match(rewards, /claim_reconciled_onchain/);
  assert.match(closeout, /reconcile-evm-claims/);
  assert.match(closeout, /LEGACY_SOLANA_CLAIM_CHAIN_RETIRED/);
  assert.match(closeout, /MISSING_SOLANA_REWARDS_PROGRAM_ID/);
  assert.match(league, /verifyEvmLeagueClaimTransaction/);
  assert.match(league, /discoverEvmLeagueClaimTransaction/);
  assert.match(league, /pg_advisory_xact_lock/);
  assert.match(league, /LEAGUE_TX_ALREADY_USED/);
  assert.match(league, /LEAGUE_PAYOUT_ALREADY_RECORDED/);
  assert.match(payouts, /pg_advisory_xact_lock/);
  assert.match(payouts, /LEAGUE_TX_ALREADY_USED/);
  assert.match(payouts, /LEAGUE_PAYOUT_ALREADY_RECORDED/);
});

test("mounted API routes use the claims closeout and League wrappers", () => {
  const server = read("server.mjs");
  const claimEntrypoint = read("dev-fix/reward-claim-intent.js");
  assert.match(server, /import league from "\.\/leagueRouter\.js"/);
  assert.match(server, /import \{ rewardClaimConfig, rewardClaimIntent, rewardClaimRecord \} from "\.\/dev-fix\/reward-claim-intent\.js"/);
  assert.match(claimEntrypoint, /reward-claim-closeout-router\.js/);
});

test("reward client no longer treats Solana 102 as a claim runtime", () => {
  const client = read("../src/lib/rewardProgramsApi.ts");
  assert.doesNotMatch(client, /chain === 101 \|\| chain === 102/);
  assert.doesNotMatch(client, /\[101, 102\]/);
  assert.match(client, /if\s*\(\s*[A-Za-z_$][\w$]*\s*!==\s*101\s*\)\s*return initial/);
  assert.match(client, /environment: params\.environment \|\| identity\.environment/);
  assert.match(client, /solanaCluster: params\.solanaCluster \|\| identity\.solanaCluster/);
});
