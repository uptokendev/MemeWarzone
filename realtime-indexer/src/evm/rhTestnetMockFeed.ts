/**
 * Keeps the Robinhood testnet mock ETH/USD feed fresh enough for gen-8 launches.
 *
 * GraduationOracle 0xE5A4c8DE… on chain 46630 reads MockUsdPriceFeed
 * 0x896C55A6… and reverts StalePrice when the round is older than 48 hours.
 * The feed has no owner. setRoundData is open. The gen-7 testnet updater
 * (refreshMockFeed in scripts/deploy-robinhood-testnet-gen6-fees.ts) republishes
 * that feed's current answer with a new timestamp. This job does the same thing,
 * every 12 hours, and only on chain 46630.
 *
 * It does not write the gen-7 infrastructure oracle 0x5D2A88…, the Robinhood
 * mainnet ETH/USD feed, or the BNB mainnet BNB/USD feed. BSC testnet oracle
 * 0xc9Ee6b5b… is not this job: it reads Chainlink BNB/USD 0x2514895c…, whose
 * aggregator is AccessControlledOffchainAggregator 3.0.0 (0xdbd22686…), owned
 * by 0xe21f52D2… and updated by Chainlink's transmitters.
 *
 *   RH46630_MOCK_FEED_PRIVATE_KEY   the testnet deployer 0x77F96A7d…. Any other key is refused.
 *   ROBINHOOD_RPC_HTTP_46630        the only RPC this job dials
 */
import { ethers } from "ethers";
import { createStaticJsonRpcProvider, parseRpcList } from "../rpcProvider.js";

export const RH_TESTNET_CHAIN_ID = 46630;
export const RH_TESTNET_MOCK_FEED = "0x896C55A66FD6e310f0e923ea682cBAA06bDf9bc4";
/** The testnet deployer. refreshMockFeed signs with this wallet. */
export const RH_TESTNET_MOCK_FEED_SIGNER = "0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714";
export const RH_MOCK_FEED_INTERVAL_MS = 12 * 60 * 60 * 1000;
/** Send a new round once the current one is this old. The oracle's cap is 48 hours. */
export const RH_MOCK_FEED_REFRESH_AGE_SEC = 12 * 60 * 60;

const FORBIDDEN_CHAIN_IDS = new Set([1, 56, 4663]);
const MAINNET_DEPLOYER = "0xE242e3536f386d947BbED83a3481cAa2c4dAB749";
const MAINNET_FEEDS = new Set([
  "0x78f3556b67e17df817d51ef5a990cdaf09e8d3a9",
  "0x0567f2323251f0aab15c8dfb1967e4e8a7d42aee",
]);

const FEED_ABI = [
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function setRoundData(uint80,int256,uint256,uint256,uint80)",
];

export type MockFeedRound = { roundId: bigint; answer: bigint; updatedAt: bigint };

export function assertRhTestnetMockFeedRefresh(input: { chainId: number; feed: string; signer: string }) {
  const chainId = Number(input.chainId);
  if (FORBIDDEN_CHAIN_IDS.has(chainId) || chainId !== RH_TESTNET_CHAIN_ID) {
    throw new Error(`REFUSED: mock feed refresh runs only on chain 46630 (got ${chainId}).`);
  }
  let feed: string;
  let signer: string;
  try {
    feed = ethers.getAddress(input.feed).toLowerCase();
    signer = ethers.getAddress(input.signer).toLowerCase();
  } catch {
    throw new Error("REFUSED: mock feed refresh was given a bad address.");
  }
  if (feed !== RH_TESTNET_MOCK_FEED.toLowerCase() || MAINNET_FEEDS.has(feed)) {
    throw new Error("REFUSED: mock feed refresh writes only the Robinhood testnet feed.");
  }
  if (signer === MAINNET_DEPLOYER.toLowerCase() || signer !== RH_TESTNET_MOCK_FEED_SIGNER.toLowerCase()) {
    throw new Error(`REFUSED: mock feed refresh signs only from ${RH_TESTNET_MOCK_FEED_SIGNER}.`);
  }
}

/** The next round, or a skip. The answer stays the one already on the feed. */
export function planRhTestnetMockFeedRefresh(input: {
  chainId: number;
  feed: string;
  signer: string;
  now: bigint;
  round: MockFeedRound;
}): { kind: "skip"; reason: string } | { kind: "send"; roundId: bigint; answer: bigint; timestamp: bigint } {
  assertRhTestnetMockFeedRefresh(input);
  if (input.round.answer <= 0n) throw new Error("REFUSED: the mock feed answer is not positive.");
  const age = input.now - input.round.updatedAt;
  if (age >= 0n && age < BigInt(RH_MOCK_FEED_REFRESH_AGE_SEC)) return { kind: "skip", reason: "fresh" };
  return { kind: "send", roundId: input.round.roundId + 1n, answer: input.round.answer, timestamp: input.now };
}

type FeedReader = {
  latestRoundData(): Promise<readonly [bigint, bigint, bigint, bigint, bigint] | unknown[]>;
  setRoundData(roundId: bigint, answer: bigint, startedAt: bigint, updatedAt: bigint, answeredInRound: bigint): Promise<{ hash: string; wait(): Promise<{ status?: number } | null> }>;
};

type ChainReader = {
  send(method: string, params: unknown[]): Promise<unknown>;
  getBlock(tag: "latest"): Promise<{ timestamp: number } | null>;
};

export async function runRhTestnetMockFeedOnce(deps: { provider: ChainReader; feed: FeedReader; signer: string }) {
  const reported = await deps.provider.send("eth_chainId", []);
  const chainId = Number(BigInt(String(reported)));
  assertRhTestnetMockFeedRefresh({ chainId, feed: RH_TESTNET_MOCK_FEED, signer: deps.signer });
  const block = await deps.provider.getBlock("latest");
  if (!block) throw new Error("The Robinhood testnet head is missing.");
  const raw = await deps.feed.latestRoundData();
  const plan = planRhTestnetMockFeedRefresh({
    chainId,
    feed: RH_TESTNET_MOCK_FEED,
    signer: deps.signer,
    now: BigInt(block.timestamp),
    round: { roundId: BigInt(raw[0] as bigint | number | string), answer: BigInt(raw[1] as bigint | number | string), updatedAt: BigInt(raw[3] as bigint | number | string) },
  });
  if (plan.kind === "skip") return plan;
  const tx = await deps.feed.setRoundData(plan.roundId, plan.answer, plan.timestamp, plan.timestamp, plan.roundId);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error("The mock feed refresh reverted.");
  return { kind: "refreshed" as const, txHash: tx.hash, answer: plan.answer.toString(), roundId: plan.roundId.toString() };
}

export function rhTestnetMockFeedWallet(env: NodeJS.ProcessEnv = process.env): ethers.Wallet | null {
  const raw = String(env.RH46630_MOCK_FEED_PRIVATE_KEY || "").trim();
  if (!raw) return null;
  let wallet: ethers.Wallet;
  try {
    wallet = new ethers.Wallet(raw.startsWith("0x") ? raw : `0x${raw}`);
  } catch {
    throw new Error("REFUSED: RH46630_MOCK_FEED_PRIVATE_KEY is not a private key.");
  }
  assertRhTestnetMockFeedRefresh({ chainId: RH_TESTNET_CHAIN_ID, feed: RH_TESTNET_MOCK_FEED, signer: wallet.address });
  return wallet;
}

let started = false;

/** Off unless the testnet deployer key is set. A wrong chain id never reaches setRoundData. */
export function startRhTestnetMockFeedRefresh(env: NodeJS.ProcessEnv = process.env) {
  if (started) return;
  started = true;
  let wallet: ethers.Wallet | null = null;
  try {
    wallet = rhTestnetMockFeedWallet(env);
  } catch (error) {
    console.error("[rh-mock-feed] refused", error instanceof Error ? error.message : String(error));
    return;
  }
  if (!wallet) {
    console.log(`[rh-mock-feed] off (set RH46630_MOCK_FEED_PRIVATE_KEY to ${RH_TESTNET_MOCK_FEED_SIGNER})`);
    return;
  }
  const signerWallet = wallet;
  const url = parseRpcList(env.ROBINHOOD_RPC_HTTP_46630)[0] || "";
  if (!url) {
    console.warn("[rh-mock-feed] off (ROBINHOOD_RPC_HTTP_46630 is empty)");
    return;
  }
  const provider = createStaticJsonRpcProvider(url, RH_TESTNET_CHAIN_ID, { timeoutMs: 20_000 });
  const feed = new ethers.Contract(RH_TESTNET_MOCK_FEED, FEED_ABI, signerWallet.connect(provider));
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runRhTestnetMockFeedOnce({ provider, feed: feed as unknown as FeedReader, signer: signerWallet.address });
      console.log("[rh-mock-feed]", result.kind === "skip" ? "fresh" : result.txHash, { chainId: RH_TESTNET_CHAIN_ID, signer: signerWallet.address });
    } catch (error) {
      console.error("[rh-mock-feed] failed", error instanceof Error ? error.message : String(error));
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), 15_000);
  first.unref?.();
  const timer = setInterval(() => void tick(), RH_MOCK_FEED_INTERVAL_MS);
  timer.unref?.();
  console.log("[rh-mock-feed] enabled", { chainId: RH_TESTNET_CHAIN_ID, signer: wallet.address, everyMs: RH_MOCK_FEED_INTERVAL_MS });
}
