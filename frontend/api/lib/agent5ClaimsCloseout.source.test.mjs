import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalSolanaClaimIdentity } from "./solanaClaimEnvironment.js";
import { EVM_LEAGUE_LOG_QUERY_MAX_BLOCKS, scanEvmLeagueClaimLogsBackwards } from "./evmLeagueClaimVerification.js";
import {
  buildBsc97ObservedBalanceProof,
  captureBsc97LiveBalanceEvidence,
  loadBsc97LiveBalanceEvidence,
} from "../../../scripts/agent5-bsc97-live-balance-evidence.mjs";

function read(pathname) {
  return fs.readFileSync(new URL(`../${pathname}`, import.meta.url), "utf8");
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

test("EVM League reconciliation chunks provider log ranges at 5000 blocks with gapless inclusive boundaries", async () => {
  const calls = [];
  const address = "0x0000000000000000000000000000000000000097";
  const topics = ["0xaaa", "0xbbb"];
  const provider = {
    async getBlockNumber() { return 12_345; },
    async getLogs(filter) {
      calls.push({ ...filter, topics: [...filter.topics] });
      const width = Number(filter.toBlock) - Number(filter.fromBlock) + 1;
      assert.ok(width <= EVM_LEAGUE_LOG_QUERY_MAX_BLOCKS, `provider range exceeded cap: ${width}`);
      if (calls.length < 3) return [];
      return [
        { blockNumber: 2_344, index: 1, transactionHash: "0xolder" },
        { blockNumber: 2_345, index: 0, transactionHash: "0xnewer" },
        { blockNumber: 2_345, index: 2, transactionHash: "0xnewest" },
      ];
    },
  };

  const logs = await scanEvmLeagueClaimLogsBackwards(provider, {
    address,
    topics,
    lookbackBlocks: 10_002,
    chunkBlocks: 50_000,
  });

  assert.deepEqual(calls.map(({ fromBlock, toBlock }) => [fromBlock, toBlock]), [
    [7_346, 12_345],
    [2_346, 7_345],
    [2_344, 2_345],
  ]);
  for (const call of calls) {
    assert.equal(call.address, address);
    assert.deepEqual(call.topics, topics);
  }
  assert.equal(calls[1].toBlock + 1, calls[0].fromBlock);
  assert.equal(calls[2].toBlock + 1, calls[1].fromBlock);
  assert.deepEqual(logs.map((log) => log.transactionHash), ["0xnewest", "0xnewer", "0xolder"]);
  assert.equal(calls.length, 3, "scan must stop after the first conclusive matching chunk");
});

test("BSC97 balance evidence uses live pre/post samples when historical getBalance is unsupported", async () => {
  const calls = [];
  const balances = new Map([
    ["0x0000000000000000000000000000000000000001", [10_000n, 10_900n]],
    ["0x0000000000000000000000000000000000000002", [5_000n, 4_000n]],
  ]);
  const indexes = new Map();
  const provider = {
    async getBlockNumber() { return calls.length < 2 ? 100 : 101; },
    async getBalance(address, blockTag) {
      if (blockTag !== undefined) throw Object.assign(new Error("not supported"), { code: -32000 });
      calls.push([address, blockTag]);
      const key = String(address).toLowerCase();
      const index = indexes.get(key) || 0;
      indexes.set(key, index + 1);
      return balances.get(key)[index];
    },
  };
  const file = path.join(os.tmpdir(), `agent5-balance-${Date.now()}-${Math.random()}.jsonl`);
  try {
    const { snapshot } = await captureBsc97LiveBalanceEvidence({
      provider,
      senderAddress: "0x0000000000000000000000000000000000000001",
      contractAddress: "0x0000000000000000000000000000000000000002",
      evidenceFile: file,
      sendTransaction: async () => ({
        hash: "0xabc",
        wait: async () => ({ hash: "0xabc", blockNumber: 101, gasUsed: 100n, gasPrice: 1n }),
      }),
    });
    const loaded = loadBsc97LiveBalanceEvidence(file);
    assert.equal(loaded.get("0xabc").txHash, "0xabc");
    assert.ok(calls.every(([, blockTag]) => blockTag === undefined), "historical balance block tags must never be used");
    const proof = buildBsc97ObservedBalanceProof({
      snapshot,
      txHash: "0xabc",
      blockNumber: 101,
      contractAddress: "0x0000000000000000000000000000000000000002",
      recipient: "0x0000000000000000000000000000000000000001",
      amount: 1_000n,
    });
    assert.equal(proof.available, true);
    assert.equal(proof.recipientNetCreditWei, "1000");
    assert.equal(proof.contractDebitWei, "1000");
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("BSC97 balance evidence marks missing pre-transaction samples unavailable instead of synthesizing latest", () => {
  const proof = buildBsc97ObservedBalanceProof({
    snapshot: null,
    txHash: "0xmissing",
    blockNumber: 100,
    contractAddress: "0x0000000000000000000000000000000000000002",
    recipient: "0x0000000000000000000000000000000000000001",
    amount: 1n,
  });
  assert.equal(proof.available, false);
  assert.equal(proof.reason, "before_balance_not_sampled_before_transaction");
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
