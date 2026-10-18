import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ethers } from "ethers";
import {
  RH_MOCK_FEED_INTERVAL_MS,
  RH_MOCK_FEED_REFRESH_AGE_SEC,
  RH_TESTNET_MOCK_FEED,
  RH_TESTNET_MOCK_FEED_SIGNER,
  planRhTestnetMockFeedRefresh,
  rhTestnetMockFeedWallet,
  runRhTestnetMockFeedOnce,
} from "../evm/rhTestnetMockFeed.js";

const ANSWER = 3000n * 10n ** 8n;
const HASH = `0x${"ab".repeat(32)}`;

function harness(chainId: number, opts: { timestamp?: number; updatedAt?: bigint; answer?: bigint; roundId?: bigint; status?: number } = {}) {
  const writes: bigint[][] = [];
  let reads = 0;
  const timestamp = opts.timestamp ?? 1_000_000;
  const updatedAt = opts.updatedAt ?? BigInt(timestamp - RH_MOCK_FEED_REFRESH_AGE_SEC);
  return {
    writes,
    reads: () => reads,
    provider: {
      async send(method: string) {
        if (method !== "eth_chainId") throw new Error(method);
        return `0x${chainId.toString(16)}`;
      },
      async getBlock() {
        return { timestamp };
      },
    },
    feed: {
      async latestRoundData() {
        reads += 1;
        return [opts.roundId ?? 10n, opts.answer ?? ANSWER, updatedAt, updatedAt, opts.roundId ?? 10n] as const;
      },
      async setRoundData(...args: bigint[]) {
        writes.push(args);
        return { hash: HASH, async wait() { return { status: opts.status ?? 1 }; } };
      },
    },
  };
}

test("the refresh is every 12 hours and keeps the feed's own answer", () => {
  assert.equal(RH_MOCK_FEED_INTERVAL_MS, 12 * 60 * 60 * 1000);
  assert.equal(RH_MOCK_FEED_REFRESH_AGE_SEC, 12 * 60 * 60);
  const now = 2_000_000n;
  const plan = planRhTestnetMockFeedRefresh({
    chainId: 46630,
    feed: RH_TESTNET_MOCK_FEED,
    signer: RH_TESTNET_MOCK_FEED_SIGNER,
    now,
    round: { roundId: 10n, answer: ANSWER, updatedAt: now - BigInt(RH_MOCK_FEED_REFRESH_AGE_SEC) },
  });
  assert.deepEqual(plan, { kind: "send", roundId: 11n, answer: ANSWER, timestamp: now });
});

test("a round younger than 12 hours is left alone", () => {
  const now = 2_000_000n;
  const plan = planRhTestnetMockFeedRefresh({
    chainId: 46630,
    feed: RH_TESTNET_MOCK_FEED,
    signer: RH_TESTNET_MOCK_FEED_SIGNER,
    now,
    round: { roundId: 11n, answer: ANSWER, updatedAt: now - 6n },
  });
  assert.deepEqual(plan, { kind: "skip", reason: "fresh" });
});

test("a future timestamp is restamped, because the oracle treats it as stale", () => {
  const now = 2_000_000n;
  const plan = planRhTestnetMockFeedRefresh({
    chainId: 46630,
    feed: RH_TESTNET_MOCK_FEED,
    signer: RH_TESTNET_MOCK_FEED_SIGNER,
    now,
    round: { roundId: 4n, answer: ANSWER, updatedAt: now + 10n },
  });
  assert.equal(plan.kind, "send");
});

test("chain 4663, 56, and 1 never read or write the feed", async () => {
  for (const chainId of [4663, 56, 1]) {
    const box = harness(chainId);
    await assert.rejects(
      () => runRhTestnetMockFeedOnce({ provider: box.provider, feed: box.feed, signer: RH_TESTNET_MOCK_FEED_SIGNER }),
      /only on chain 46630/,
    );
    assert.equal(box.reads(), 0);
    assert.equal(box.writes.length, 0);
  }
});

test("the mainnet feed and the mainnet deployer are refused before a write", () => {
  assert.throws(
    () => planRhTestnetMockFeedRefresh({
      chainId: 46630,
      feed: "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9",
      signer: RH_TESTNET_MOCK_FEED_SIGNER,
      now: 10n,
      round: { roundId: 1n, answer: ANSWER, updatedAt: 0n },
    }),
    /Robinhood testnet feed/,
  );
  assert.throws(
    () => planRhTestnetMockFeedRefresh({
      chainId: 46630,
      feed: RH_TESTNET_MOCK_FEED,
      signer: "0xE242e3536f386d947BbED83a3481cAa2c4dAB749",
      now: 10n,
      round: { roundId: 1n, answer: ANSWER, updatedAt: 0n },
    }),
    /signs only from/,
  );
});

test("a stale 46630 round is written once, then the call returns", async () => {
  const box = harness(46630, { timestamp: 1_000_000, roundId: 10n });
  const result = await runRhTestnetMockFeedOnce({ provider: box.provider, feed: box.feed, signer: RH_TESTNET_MOCK_FEED_SIGNER });
  assert.equal(result.kind, "refreshed");
  assert.equal(box.writes.length, 1);
  assert.deepEqual(box.writes[0].map(String), [11n, ANSWER, 1_000_000n, 1_000_000n, 11n].map(String));
});

test("a fresh 46630 round does not send", async () => {
  const box = harness(46630, { timestamp: 1_000_000, updatedAt: 999_990n });
  const result = await runRhTestnetMockFeedOnce({ provider: box.provider, feed: box.feed, signer: RH_TESTNET_MOCK_FEED_SIGNER });
  assert.deepEqual(result, { kind: "skip", reason: "fresh" });
  assert.equal(box.writes.length, 0);
});

test("the key must be the testnet deployer, and an empty key stays off", () => {
  assert.equal(rhTestnetMockFeedWallet({} as NodeJS.ProcessEnv), null);
  const other = ethers.Wallet.createRandom().privateKey;
  assert.throws(() => rhTestnetMockFeedWallet({ RH46630_MOCK_FEED_PRIVATE_KEY: other } as NodeJS.ProcessEnv), /signs only from/);
});

test("main starts this job and the writer names only the testnet feed", () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const main = fs.readFileSync(path.join(here, "../main.ts"), "utf8");
  const src = fs.readFileSync(path.join(here, "../evm/rhTestnetMockFeed.ts"), "utf8");
  assert.match(main, /startRhTestnetMockFeedRefresh\(\)/);
  assert.match(src, /new ethers\.Contract\(RH_TESTNET_MOCK_FEED, FEED_ABI/);
  assert.equal(src.includes("0x5D2A88b0963Bb5b561B495a5fDCba869C01a8cAb"), false);
});
