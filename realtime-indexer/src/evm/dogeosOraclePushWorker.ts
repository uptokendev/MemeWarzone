/**
 * DogeOS Chikyu (6281971) DOGE/USD oracle push (spec §4). Off unless enabled. Reads Binance spot
 * DOGEUSDT, converts it to the oracle's 8 decimals and calls DogeosTestnetDogeUsdOracle.updateAnswer,
 * signing only with the updater key.
 *
 *   DOGEOS_ORACLE_PUSH_ENABLED=true                 turns the worker on (it sends real transactions)
 *   DOGEOS_TESTNET_ORACLE_UPDATER_PRIVATE_KEY       updater key; no fallback to any other key name
 *   DOGEOS_NATIVE_USD_ORACLE_ADDRESS_6281971        the oracle (same name as dogeosNativeUsdOracle.ts)
 *   DOGEOS_RPC_HTTP_6281971                         DogeOS RPC (first entry); never a BSC/Robinhood one
 *   DOGEOS_ORACLE_PUSH_MAX_INTERVAL_SECONDS         default 1800, can be lowered, never raised past 1800
 *   DOGEOS_ORACLE_PUSH_DEVIATION_BPS                default 100
 *
 * Before the first push it refuses unless eth_chainId is 6281971, oracle.updater() is the signer,
 * decimals() is 8, and the signer is not the DogeOS deployer, keeper or route authority. A refusal
 * stops the worker; an RPC error retries on the next tick.
 *
 * Health is read from latestRoundData(), never from AnswerUpdated logs: the constructor's round 1
 * event carries the deployer as `updater`, so a log filter on the updater would miss round 1.
 */
import { Contract, ethers } from "ethers";
import { createStaticJsonRpcProvider } from "../rpcProvider.js";
import {
  DOGEOS_ORACLE_PUSH_CHAIN_ID,
  ORACLE_MAX_AGE_SECONDS,
  OraclePushRefused,
  assertOraclePushAllowed,
  oracleHealth,
  oraclePushConfig,
  oraclePushWallet,
  shouldPush,
  toOracleAnswer,
  type OraclePushDecisionConfig,
} from "./dogeosOraclePushConfig.js";

export const BINANCE_DOGEUSDT_URL = "https://api.binance.com/api/v3/ticker/price?symbol=DOGEUSDT";
const TICK_MS = 60_000;
const FIRST_TICK_MS = 15_000;
const FETCH_TIMEOUT_MS = 8_000;
const RECEIPT_TIMEOUT_MS = 120_000;

/** DogeosTestnetDogeUsdOracle's ABI subset used by the push. */
export const DOGEOS_ORACLE_PUSH_ABI = [
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
  "function updater() view returns (address)",
  "function updateAnswer(int256 newAnswer) returns (uint80 roundId)",
] as const;

/** The oracle as the push sees it: its ABI functions plus the RPC's eth_chainId. */
export type DogeosOracleClient = {
  chainId(): Promise<bigint>;
  updater(): Promise<string>;
  decimals(): Promise<bigint>;
  latestRoundData(): Promise<{ roundId: bigint; answer: bigint; startedAt: bigint; updatedAt: bigint; answeredInRound: bigint }>;
  updateAnswer(answer: bigint): Promise<{ hash: string; wait(): Promise<{ status: number | null } | null> }>;
};

export type OraclePushLog = { info(msg: string): void; warn(msg: string): void; error(msg: string): void };

const consoleLog: OraclePushLog = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
  error: (msg) => console.error(msg),
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createEthersOracleClient(provider: ethers.JsonRpcProvider, wallet: ethers.Wallet, oracleAddress: string): DogeosOracleClient {
  const signer = wallet.connect(provider);
  const oracle = new Contract(oracleAddress, DOGEOS_ORACLE_PUSH_ABI, signer) as any;
  return {
    // The provider pins a static network, so getNetwork() would echo 6281971 back; ask the node.
    chainId: async () => BigInt(await provider.send("eth_chainId", [])),
    updater: async () => String(await oracle.updater()),
    decimals: async () => BigInt(await oracle.decimals()),
    latestRoundData: async () => {
      const r = await oracle.latestRoundData();
      return {
        roundId: BigInt(r.roundId),
        answer: BigInt(r.answer),
        startedAt: BigInt(r.startedAt),
        updatedAt: BigInt(r.updatedAt),
        answeredInRound: BigInt(r.answeredInRound),
      };
    },
    updateAnswer: async (answer: bigint) => {
      const tx = await oracle.updateAnswer(answer);
      return { hash: String(tx.hash), wait: async () => tx.wait(1, RECEIPT_TIMEOUT_MS) };
    },
  };
}

/** Binance spot DOGEUSDT as the raw decimal string. Throws on HTTP errors, timeouts and a missing price. */
export async function fetchBinanceDogeUsdt(fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(BINANCE_DOGEUSDT_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Binance DOGEUSDT HTTP ${res.status}`);
  const body: any = await res.json();
  const price = typeof body?.price === "string" ? body.price.trim() : "";
  if (!price || toOracleAnswer(price) === null) throw new Error(`Binance DOGEUSDT returned no positive price (${JSON.stringify(body?.price ?? null)})`);
  return price;
}

export async function preflightOraclePush(input: { client: DogeosOracleClient; signerAddress: string }): Promise<void> {
  const [chainId, oracleUpdater, decimals] = await Promise.all([input.client.chainId(), input.client.updater(), input.client.decimals()]);
  assertOraclePushAllowed({ chainId: Number(chainId), signerAddress: input.signerAddress, oracleUpdater, oracleDecimals: Number(decimals) });
}

export type OraclePushTickResult =
  | { kind: "pushed"; reason: string; answer: bigint; txHash: string }
  | { kind: "held"; reason: string; answer: bigint }
  | { kind: "skipped"; reason: "price-fetch-failed" | "invalid-price"; answer: null }
  | { kind: "failed"; reason: string; answer: bigint; txHash: string | null };

/** One pass: health check on the current round, fetch, convert, decide, push. Never pushes <= 0. */
export async function runOraclePushTick(input: {
  client: DogeosOracleClient;
  fetchPrice: () => Promise<unknown>;
  nowSeconds: number;
  cfg: OraclePushDecisionConfig;
  log?: OraclePushLog;
}): Promise<OraclePushTickResult> {
  const log = input.log ?? consoleLog;
  const round = await input.client.latestRoundData();
  const lastAnswer = BigInt(round.answer);
  const lastUpdatedAt = Number(round.updatedAt);
  const health = oracleHealth(lastUpdatedAt, input.nowSeconds);
  if (health.level === "warn") {
    log.warn(`[dogeos-oracle] stale soon: round ${round.roundId} is ${health.ageSeconds}s old, graduation pricing blocks past ${ORACLE_MAX_AGE_SECONDS}s`);
  } else if (health.level === "stale") {
    log.error(`[dogeos-oracle] stale: round ${round.roundId} is ${health.ageSeconds}s old (> ${ORACLE_MAX_AGE_SECONDS}s); createCampaign fails closed until a push lands`);
  }

  let raw: unknown;
  try {
    raw = await input.fetchPrice();
  } catch (error) {
    log.warn(`[dogeos-oracle] push skipped: price fetch failed: ${errorMessage(error)}`);
    return { kind: "skipped", reason: "price-fetch-failed", answer: null };
  }
  const answer = toOracleAnswer(raw);
  if (answer === null || answer <= 0n) {
    log.warn(`[dogeos-oracle] push skipped: non-positive or invalid price ${JSON.stringify(raw)}`);
    return { kind: "skipped", reason: "invalid-price", answer: null };
  }

  const decision = shouldPush({ lastAnswer, lastUpdatedAt, price: answer, now: input.nowSeconds, cfg: input.cfg });
  if (!decision.push) return { kind: "held", reason: decision.reason, answer };

  const tx = await input.client.updateAnswer(answer);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    log.error(`[dogeos-oracle] push ${tx.hash} did not succeed (status ${receipt?.status ?? "none"})`);
    return { kind: "failed", reason: decision.reason, answer, txHash: tx.hash };
  }
  log.info(`[dogeos-oracle] pushed ${answer} (8 dec) reason=${decision.reason} previous=${lastAnswer} age=${health.ageSeconds}s tx=${tx.hash}`);
  return { kind: "pushed", reason: decision.reason, answer, txHash: tx.hash };
}

let started = false;

export function startDogeosOraclePushWorker(env: NodeJS.ProcessEnv = process.env): "disabled" | "misconfigured" | "started" | "already-started" {
  if (started) return "already-started";
  started = true;
  const cfg = oraclePushConfig(env);
  if (!cfg.enabled) {
    console.log("[dogeos-oracle] disabled (set DOGEOS_ORACLE_PUSH_ENABLED=true)");
    return "disabled";
  }
  let wallet: ethers.Wallet | null = null;
  try {
    wallet = oraclePushWallet(env);
  } catch (error) {
    console.error("[dogeos-oracle] updater key refused", { error: errorMessage(error) });
    return "misconfigured";
  }
  if (!wallet || !cfg.oracleAddress || !cfg.rpcUrl) {
    console.warn("[dogeos-oracle] not started: needs DOGEOS_TESTNET_ORACLE_UPDATER_PRIVATE_KEY, DOGEOS_NATIVE_USD_ORACLE_ADDRESS_6281971 and DOGEOS_RPC_HTTP_6281971");
    return "misconfigured";
  }

  const provider = createStaticJsonRpcProvider(cfg.rpcUrl, DOGEOS_ORACLE_PUSH_CHAIN_ID, { timeoutMs: 15_000 });
  const client = createEthersOracleClient(provider, wallet, cfg.oracleAddress);
  const signerAddress = wallet.address;
  let verified = false;
  let stopped = false;
  let running = false;
  console.log("[dogeos-oracle] enabled", {
    chainId: DOGEOS_ORACLE_PUSH_CHAIN_ID,
    oracle: cfg.oracleAddress,
    updater: signerAddress,
    maxIntervalSeconds: cfg.maxIntervalSeconds,
    deviationBps: cfg.deviationBps,
  });

  let timer: ReturnType<typeof setInterval> | null = null;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      if (!verified) {
        await preflightOraclePush({ client, signerAddress });
        verified = true;
        console.log("[dogeos-oracle] preflight passed", { chainId: DOGEOS_ORACLE_PUSH_CHAIN_ID, updater: signerAddress });
      }
      await runOraclePushTick({ client, fetchPrice: () => fetchBinanceDogeUsdt(), nowSeconds: Math.floor(Date.now() / 1000), cfg });
    } catch (error) {
      if (error instanceof OraclePushRefused) {
        stopped = true;
        if (timer) clearInterval(timer);
        console.error("[dogeos-oracle] refused, worker stopped", { error: error.message });
      } else {
        console.error("[dogeos-oracle] pass failed", { error: errorMessage(error) });
      }
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), FIRST_TICK_MS);
  first.unref?.();
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  return "started";
}
