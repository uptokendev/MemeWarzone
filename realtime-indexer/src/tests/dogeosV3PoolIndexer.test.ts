import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// DogeOS 6281971 in the V3 pool indexer (plan t19, spec §4 graduated trades + oracle reading).
// Env is fixed before any module import because env.ts snapshots it.
process.env.RUNTIME_ENVIRONMENT = "local";
process.env.LOCAL_DISABLE_ABLY = "1";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/memewarzone_dogeos_local";
process.env.DB_WATCHDOG_EXIT = "0";
process.env.EVM_INDEXER_CHAIN_IDS = "46630,4663,6281971";
process.env.DEFAULT_EVM_CHAIN_ID = "46630";
process.env.ENABLE_ROBINHOOD_V3_POOL_INDEXER = "0";
process.env.DOGEOS_RPC_HTTP_6281971 = "https://rpc.testnet.dogeos.com";
process.env.ROBINHOOD_RPC_HTTP_46630 = "https://rh-testnet-rpc.test.invalid";
process.env.ROBINHOOD_RPC_HTTP_4663 = "https://rh-mainnet-rpc.test.invalid";
process.env.ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_6281971 = "0x54f7D7f6FeDf4E930eFd6b4742Ba0B9E8a6dC1CB";
process.env.ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_46630 = "0x00000000000000000000000000000000000046a0";
process.env.ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_4663 = "0x0000000000000000000000000000000000004663";
delete process.env.ROBINHOOD_V3_LOG_CHUNK_SIZE; // the 50,000 default is what Robinhood runs on
process.env.LOG_CHUNK_SIZE = "500";
process.env.INDEXER_LOG_CALL_DELAY_MS = "0";
delete process.env.DOGEOS_NATIVE_USD_ORACLE_ADDRESS_6281971;
delete process.env.ROBINHOOD_NATIVE_USD_ORACLE_ADDRESS_46630;
delete process.env.VITE_ROBINHOOD_NATIVE_USD_ORACLE_ADDRESS_46630;
delete process.env.ROBINHOOD_NATIVE_USD_MAX_ORACLE_AGE_SECONDS;
delete process.env.ROBINHOOD_STOCK_GRADUATION_MAX_ORACLE_AGE_SECONDS;

const { ethers } = await import("ethers");
const { pool } = await import("../db.js");
const { robinhoodV3Internals } = await import("../robinhoodV3PoolIndexer.js");
const { resolveRobinhoodQuoteUsdReference } = await import("../robinhoodMarketValuation.js");
const { getDogeosNativeUsdReference, evaluateDogeosNativeUsdRound, dogeosNativeUsdOracleInternals } = await import(
  "../dogeosNativeUsdOracle.js"
);
const { healRobinhoodGraduatedCms, robinhoodCmsHealInternals } = await import("../robinhoodCmsHeal.js");
const { registerRobinhoodMarketContinuityRoutes, robinhoodMarketApiInternals } = await import("../robinhoodMarketApi.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(here, "../../../test/fixtures");
const muchfiSwap = JSON.parse(readFileSync(path.join(fixtureDir, "muchfiSwapLog.json"), "utf8"));
const muchfiSlot0 = JSON.parse(readFileSync(path.join(fixtureDir, "muchfiSlot0.json"), "utf8"));

const DOGEOS = 6281971;
const WDOGE = "0xf6bdb158a5ddf77f1b83bc9074f6a472c58d78ae";

// ---------------------------------------------------------------------------------------------
// DB stub: every query is recorded and answers with no rows, so nothing touches a database.
type RecordedQuery = { sql: string; params: unknown[] };
const queries: RecordedQuery[] = [];
const stubQuery = async (sql: unknown, params: unknown[] = []) => {
  queries.push({ sql: String(sql), params });
  return { rows: [], rowCount: 0 };
};
(pool as any).query = stubQuery;
(pool as any).connect = async () => ({ query: stubQuery, release() {} });

function insertsInto(table: string): RecordedQuery[] {
  return queries.filter((q) => new RegExp(`insert into public\\.${table}\\b`).test(q.sql));
}

// ---------------------------------------------------------------------------------------------
// A provider that only does what scanPool needs, and refuses getLogs windows above maxRange.
type GetLogsCall = { fromBlock: number; toBlock: number; width: number; topics: unknown; ok: boolean };
function fakeProvider(input: { maxRange?: number; logs?: any[] } = {}) {
  const calls: GetLogsCall[] = [];
  return {
    calls,
    async getLogs(filter: any) {
      const width = Number(filter.toBlock) - Number(filter.fromBlock) + 1;
      const ok = input.maxRange == null || width <= input.maxRange;
      calls.push({ fromBlock: Number(filter.fromBlock), toBlock: Number(filter.toBlock), width, topics: filter.topics, ok });
      if (!ok) throw new Error(`query exceeds max block range ${input.maxRange}`);
      return (input.logs || []).filter((log) => log.blockNumber >= filter.fromBlock && log.blockNumber <= filter.toBlock);
    },
    async getBlock(_blockNumber: number) {
      return { hash: `0x${"ab".repeat(32)}`, timestamp: 1_791_619_061 };
    },
    async getTransaction(_hash: string) {
      return null;
    },
  };
}

function dogeosPool(overrides: Record<string, unknown> = {}) {
  const token0 = muchfiSwap.pool.token0.toLowerCase();
  return {
    chainId: DOGEOS,
    pairAddress: muchfiSwap.pool.address.toLowerCase(),
    campaignAddress: "0x00000000000000000000000000000000000000c1",
    tokenAddress: token0,
    wrappedNativeAddress: WDOGE,
    baseTokenAddress: token0,
    quoteTokenAddress: WDOGE,
    quoteAssetType: "WRAPPED_NATIVE",
    baseDecimals: 18,
    quoteDecimals: 18,
    oracleFeedAddress: null,
    marketRole: "CANONICAL_NATIVE",
    routerAddress: muchfiSwap.decoded.sender.toLowerCase(),
    factoryAddress: muchfiSwap.pool.factory.toLowerCase(),
    token0Address: token0,
    token1Address: WDOGE,
    feePpm: 10_000,
    graduationBlock: 1,
    lastIndexedBlock: null,
    ...overrides,
  };
}

const RH_TOKEN = "0x0000000000000000000000000000000000000011";
const RH_WETH = "0x0000000000000000000000000000000000000022";
function robinhoodPool(overrides: Record<string, unknown> = {}) {
  return {
    ...dogeosPool(),
    chainId: 46630,
    pairAddress: "0x0000000000000000000000000000000000000033",
    campaignAddress: "0x0000000000000000000000000000000000000044",
    tokenAddress: RH_TOKEN,
    wrappedNativeAddress: RH_WETH,
    baseTokenAddress: RH_TOKEN,
    quoteTokenAddress: RH_WETH,
    token0Address: RH_TOKEN,
    token1Address: RH_WETH,
    feePpm: 3000,
    ...overrides,
  };
}

function muchfiLog(blockNumber = muchfiSwap.log.blockNumber) {
  return {
    address: muchfiSwap.log.address,
    topics: muchfiSwap.log.topics,
    data: muchfiSwap.log.data,
    blockNumber,
    transactionHash: muchfiSwap.log.transactionHash,
    index: muchfiSwap.log.logIndex,
  };
}

// ---------------------------------------------------------------------------------------------
// Chain config, chunk sizes, narrowing

test("the DogeOS chain config is built from the t17 env: DogeOS RPC and the MuchFi SmartRouter", () => {
  const configs = robinhoodV3Internals.chainConfigs();
  const dogeos = configs.find((config: any) => config.chainId === DOGEOS);
  assert.ok(dogeos, "6281971 must be configured when it is active and its RPC is set");
  assert.deepEqual(dogeos.rpcUrls, ["https://rpc.testnet.dogeos.com"]);
  assert.equal(dogeos.swapRouterAddress, "0x54f7d7f6fedf4e930efd6b4742ba0b9e8a6dc1cb");

  // Robinhood configs unchanged: their own RPCs and routers, same order as before.
  assert.deepEqual(
    configs.map((config: any) => config.chainId),
    [46630, 4663, DOGEOS],
  );
  const rh = configs.find((config: any) => config.chainId === 46630);
  assert.deepEqual(rh.rpcUrls, ["https://rh-testnet-rpc.test.invalid"]);
  assert.equal(rh.swapRouterAddress, "0x00000000000000000000000000000000000046a0");
});

test("starting getLogs chunk is 10,000 for 6281971 and stays 50,000 for 46630 / 4663", () => {
  assert.equal(robinhoodV3Internals.startingLogChunk(DOGEOS), 10_000);
  assert.equal(robinhoodV3Internals.startingLogChunk(46630), 50_000);
  assert.equal(robinhoodV3Internals.startingLogChunk(4663), 50_000);
});

test("scanPool opens with a 10,000-block window on 6281971 and 50,000 on 46630", async () => {
  queries.length = 0;
  const dogeosProvider = fakeProvider();
  await robinhoodV3Internals.scanPool(dogeosProvider as any, dogeosPool() as any, 100_000);
  assert.equal(dogeosProvider.calls[0].fromBlock, 1);
  assert.equal(dogeosProvider.calls[0].width, 10_000);
  assert.ok(dogeosProvider.calls.every((call) => call.width <= 10_000));

  const rhProvider = fakeProvider();
  await robinhoodV3Internals.scanPool(rhProvider as any, robinhoodPool() as any, 100_000);
  assert.equal(rhProvider.calls[0].width, 50_000);
});

test("narrowing: a provider rejecting more than 2,500 blocks shrinks the 6281971 window to <= 2,500 and completes", async () => {
  queries.length = 0;
  const provider = fakeProvider({ maxRange: 2_500 });
  const head = 25_000;
  await robinhoodV3Internals.scanPool(provider as any, dogeosPool() as any, head);

  const rejected = provider.calls.filter((call) => !call.ok);
  const accepted = provider.calls.filter((call) => call.ok);
  assert.equal(rejected.length, 1, "one rejection at the 10,000 start, then chunk/4 = 2,500 fits");
  assert.equal(rejected[0].width, 10_000);
  assert.ok(accepted.length > 0);
  assert.ok(accepted.every((call) => call.width <= 2_500));

  // Completes: the accepted windows tile the whole range [1, head] with no gap.
  let expectedFrom = 1;
  for (const call of accepted) {
    assert.equal(call.fromBlock, expectedFrom);
    expectedFrom = call.toBlock + 1;
  }
  assert.equal(expectedFrom, head + 1);
  const cursorWrites = queries.filter((q) => /update public\.dex_pools set last_indexed_block=\$3/.test(q.sql));
  assert.equal(cursorWrites[cursorWrites.length - 1].params[2], head + 1);
});

// ---------------------------------------------------------------------------------------------
// Swap decoding

test("the MuchFi Swap topic is the one recorded on Chikyu, distinct from Uniswap's", () => {
  assert.equal(robinhoodV3Internals.MUCHFI_SWAP_TOPIC, muchfiSwap.topic0);
  assert.equal(
    ethers.id(muchfiSwap.eventSignature),
    muchfiSwap.topic0,
  );
  assert.notEqual(robinhoodV3Internals.CANONICAL_SWAP_TOPIC, muchfiSwap.topic0);
  assert.equal(robinhoodV3Internals.CANONICAL_SWAP_TOPIC, muchfiSwap.uniswapV3SwapTopic0NotUsed);
});

test("getLogs asks 6281971 for the MuchFi Swap topic; 46630 keeps exactly [mock, Uniswap]", async () => {
  const dogeosProvider = fakeProvider();
  await robinhoodV3Internals.scanPool(dogeosProvider as any, dogeosPool() as any, 10);
  assert.deepEqual(dogeosProvider.calls[0].topics, [[
    robinhoodV3Internals.MOCK_SWAP_TOPIC,
    robinhoodV3Internals.CANONICAL_SWAP_TOPIC,
    muchfiSwap.topic0,
  ]]);

  const rhProvider = fakeProvider();
  await robinhoodV3Internals.scanPool(rhProvider as any, robinhoodPool() as any, 10);
  assert.deepEqual(rhProvider.calls[0].topics, [[
    robinhoodV3Internals.MOCK_SWAP_TOPIC,
    robinhoodV3Internals.CANONICAL_SWAP_TOPIC,
  ]]);
});

test("a recorded MuchFi Swap log decodes on 6281971 to the right amounts, side and price", async () => {
  queries.length = 0;
  const provider = fakeProvider({ logs: [muchfiLog()] });
  await robinhoodV3Internals.scanPool(
    provider as any,
    dogeosPool({ graduationBlock: muchfiSwap.log.blockNumber - 10 }) as any,
    muchfiSwap.log.blockNumber + 10,
  );

  const trades = insertsInto("dex_trades");
  assert.equal(trades.length, 1, "the MuchFi swap reaches dex_trades");
  const p = trades[0].params as any[];
  // amount0 < 0: token0 (base) left the pool, amount1 > 0: WDOGE entered it -> a buy.
  assert.equal(p[0], DOGEOS);
  assert.equal(p[4], muchfiSwap.log.transactionHash.toLowerCase());
  assert.equal(p[5], muchfiSwap.log.logIndex);
  assert.equal(p[9], "buy");
  assert.equal(p[10], muchfiSwap.decoded.sender.toLowerCase());
  assert.equal(p[11], muchfiSwap.decoded.recipient.toLowerCase());
  assert.equal(p[18], (-BigInt(muchfiSwap.decoded.amount0)).toString(), "base amount raw");
  assert.equal(p[19], BigInt(muchfiSwap.decoded.amount1).toString(), "quote amount raw");
  assert.equal(p[14], BigInt(muchfiSwap.decoded.amount1).toString(), "native (WDOGE) amount raw");
  const expectedPrice = Number(BigInt(muchfiSwap.decoded.amount1)) / Number(-BigInt(muchfiSwap.decoded.amount0));
  assert.ok(Math.abs(Number(p[22]) - expectedPrice) / expectedPrice < 1e-12, `price_quote ${p[22]} ~ ${expectedPrice}`);
});

test("the MuchFi Swap's sqrtPriceX96 gives the spot price its tick says", () => {
  const spot = robinhoodV3Internals.spotQuotePerBase(
    BigInt(muchfiSwap.decoded.sqrtPriceX96),
    muchfiSwap.pool.token0.toLowerCase(),
    muchfiSwap.pool.token0.toLowerCase(),
    18,
    18,
  );
  const fromTick = Math.pow(1.0001, muchfiSwap.decoded.tick);
  assert.ok(spot);
  assert.ok(Math.abs(Number(spot) - fromTick) / fromTick < 1e-4, `${spot} ~ ${fromTick}`);
});

test("a Uniswap Swap log on 46630 still decodes as before; a MuchFi-topic log there is ignored", async () => {
  queries.length = 0;
  const iface = new ethers.Interface([
    "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)",
  ]);
  const encoded = iface.encodeEventLog(iface.getEvent("Swap")!, [
    "0x0000000000000000000000000000000000000077",
    "0x0000000000000000000000000000000000000088",
    -2_000_000_000_000_000_000n,
    1_000_000_000_000_000_000n,
    1n << 96n,
    1n,
    0,
  ]);
  const uniswapLog = {
    address: "0x0000000000000000000000000000000000000033",
    topics: encoded.topics,
    data: encoded.data,
    blockNumber: 5,
    transactionHash: `0x${"11".repeat(32)}`,
    index: 0,
  };
  const provider = fakeProvider({ logs: [uniswapLog, muchfiLog(6)] });
  await robinhoodV3Internals.scanPool(provider as any, robinhoodPool() as any, 10);

  const trades = insertsInto("dex_trades");
  assert.equal(trades.length, 1, "only the Uniswap log is decoded on Robinhood");
  const p = trades[0].params as any[];
  assert.equal(p[0], 46630);
  assert.equal(p[9], "buy");
  assert.equal(p[18], "2000000000000000000");
  assert.equal(p[19], "1000000000000000000");
  assert.equal(p[22], "0.5");
});

// ---------------------------------------------------------------------------------------------
// slot0 (spot price read)

test("slot0 for 6281971 decodes MuchFi's uint32 feeProtocol from the recorded pool; Robinhood's ABI is unchanged", () => {
  const dogeosIface = new ethers.Interface(robinhoodV3Internals.slot0AbiFor(DOGEOS));
  const decoded = dogeosIface.decodeFunctionResult("slot0", muchfiSlot0.rawReturn);
  assert.equal(decoded[0].toString(), muchfiSlot0.decoded.sqrtPriceX96);
  assert.equal(Number(decoded[1]), muchfiSlot0.decoded.tick);
  assert.equal(Number(decoded[5]), muchfiSlot0.decoded.feeProtocol);
  assert.equal(decoded[6], true);

  assert.deepEqual(
    [...robinhoodV3Internals.slot0AbiFor(46630)],
    ["function slot0() view returns (uint160 sqrtPriceX96,int24,uint16,uint16,uint16,uint8,bool)"],
  );
  assert.deepEqual([...robinhoodV3Internals.slot0AbiFor(4663)], [...robinhoodV3Internals.slot0AbiFor(46630)]);
});

// ---------------------------------------------------------------------------------------------
// Native USD oracle + valuation dispatch

type OracleRpc = { url: string; requests: string[]; close: () => Promise<void> };
async function startOracleRpc(input: {
  chainId: number;
  oracle: string;
  answer: bigint;
  updatedAt: number;
  decimals: number;
}): Promise<OracleRpc> {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const requests: string[] = [];
  const handle = (req: any) => {
    requests.push(req.method);
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
    const fail = (message: string) => ({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message } });
    switch (req.method) {
      case "eth_chainId":
        return reply(`0x${input.chainId.toString(16)}`);
      case "eth_blockNumber":
        return reply("0x10");
      case "eth_getCode":
        return reply(String(req.params?.[0] || "").toLowerCase() === input.oracle.toLowerCase() ? "0x6080604052" : "0x");
      case "eth_call": {
        const call = req.params?.[0] || {};
        if (String(call.to || "").toLowerCase() !== input.oracle.toLowerCase()) return fail("execution reverted");
        const selector = String(call.data || call.input || "").slice(0, 10);
        if (selector === "0xfeaf968c") {
          return reply(coder.encode(
            ["uint80", "int256", "uint256", "uint256", "uint80"],
            [7n, input.answer, BigInt(input.updatedAt), BigInt(input.updatedAt), 7n],
          ));
        }
        if (selector === "0x313ce567") return reply(coder.encode(["uint8"], [input.decimals]));
        return fail("execution reverted");
      }
      default:
        return fail(`unsupported ${req.method}`);
    }
  };
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      const out = Array.isArray(parsed) ? parsed.map(handle) : handle(parsed);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

const DOGEOS_ORACLE = "0x00000000000000000000000000000000000d0e05";
const RH_ORACLE = "0x0000000000000000000000000000000000046630";

test("DogeOS reader: same AggregatorV3 evaluation shape, max age 3600 s", () => {
  assert.equal(dogeosNativeUsdOracleInternals.MAX_AGE_SECONDS, 3600);
  const fresh = evaluateDogeosNativeUsdRound({
    nowSeconds: 10_000,
    roundId: 3n,
    answeredInRound: 3n,
    answer: 25_000_000n,
    updatedAtSeconds: 10_000 - 3_000,
    decimals: 8,
    maxAgeSeconds: 3600,
  });
  assert.equal(fresh.healthy, true);
  assert.equal(fresh.priceUsd, "0.25");
  const stale = evaluateDogeosNativeUsdRound({
    nowSeconds: 10_000,
    roundId: 3n,
    answeredInRound: 3n,
    answer: 25_000_000n,
    updatedAtSeconds: 10_000 - 3_601,
    decimals: 8,
    maxAgeSeconds: 3600,
  });
  assert.equal(stale.healthy, false);
  assert.match(stale.error || "", /DogeOS native USD oracle is stale/);
  const zero = evaluateDogeosNativeUsdRound({
    nowSeconds: 10_000, roundId: 3n, answeredInRound: 3n, answer: 0n, updatedAtSeconds: 9_999, decimals: 8, maxAgeSeconds: 3600,
  });
  assert.equal(zero.healthy, false);
  assert.match(zero.error || "", /non-positive/);
});

test("DogeOS reader refuses other chains and reports a missing oracle address without any RPC call", async () => {
  const other = await getDogeosNativeUsdReference(46630);
  assert.equal(other.healthy, false);
  assert.match(other.error || "", /Unsupported DogeOS chain/);
  const unconfigured = await getDogeosNativeUsdReference(DOGEOS);
  assert.equal(unconfigured.healthy, false);
  assert.match(unconfigured.error || "", /DogeOS native USD oracle is not configured/);
});

test("valuation for 6281971 reads the DogeOS oracle over the DogeOS RPC; 46630 still uses the Robinhood reader", async () => {
  const now = Math.floor(Date.now() / 1000);
  // 2,000 s old: healthy under DogeOS's 3600 s, stale under Robinhood's 900 s default.
  const dogeosRpc = await startOracleRpc({ chainId: DOGEOS, oracle: DOGEOS_ORACLE, answer: 25_000_000n, updatedAt: now - 2_000, decimals: 8 });
  const rhRpc = await startOracleRpc({ chainId: 46630, oracle: RH_ORACLE, answer: 250_000_000_000n, updatedAt: now - 2_000, decimals: 8 });
  const saved = {
    dogeosRpc: process.env.DOGEOS_RPC_HTTP_6281971,
    rhRpc: process.env.ROBINHOOD_RPC_HTTP_46630,
  };
  process.env.DOGEOS_RPC_HTTP_6281971 = dogeosRpc.url;
  process.env.DOGEOS_NATIVE_USD_ORACLE_ADDRESS_6281971 = DOGEOS_ORACLE;
  process.env.ROBINHOOD_RPC_HTTP_46630 = rhRpc.url;
  process.env.ROBINHOOD_NATIVE_USD_ORACLE_ADDRESS_46630 = RH_ORACLE;
  try {
    const dogeos = await resolveRobinhoodQuoteUsdReference({
      chainId: DOGEOS,
      quoteTokenAddress: WDOGE,
      quoteAssetType: "WRAPPED_NATIVE",
      bypassCache: true,
    });
    assert.equal(dogeos.error, null);
    assert.equal(dogeos.healthy, true);
    assert.equal(dogeos.priceUsd, "0.25");
    assert.equal(dogeos.source, "native_oracle:aggregator_v3");
    assert.ok(dogeosRpc.requests.includes("eth_call"), "the DogeOS RPC served the oracle read");

    const rhCallsBefore = rhRpc.requests.length;
    const robinhood = await resolveRobinhoodQuoteUsdReference({
      chainId: 46630,
      quoteTokenAddress: RH_WETH,
      quoteAssetType: "WRAPPED_NATIVE",
      bypassCache: true,
    });
    assert.ok(rhRpc.requests.length > rhCallsBefore, "46630 read its own RPC");
    assert.equal(robinhood.healthy, false);
    assert.match(robinhood.error || "", /Robinhood native USD oracle is stale/);
    assert.equal(robinhood.source, "native_oracle:chainlink");
    assert.equal(robinhood.priceUsd, "2500.0");
  } finally {
    process.env.DOGEOS_RPC_HTTP_6281971 = saved.dogeosRpc;
    process.env.ROBINHOOD_RPC_HTTP_46630 = saved.rhRpc;
    delete process.env.DOGEOS_NATIVE_USD_ORACLE_ADDRESS_6281971;
    delete process.env.ROBINHOOD_NATIVE_USD_ORACLE_ADDRESS_46630;
    await dogeosRpc.close();
    await rhRpc.close();
  }
});

// ---------------------------------------------------------------------------------------------
// CMS heal + market routes (the token page's post-grad panel reads these for every EVM chain)

function throwingProvider() {
  return {
    async call() { throw new Error("rpc down"); },
    async getLogs() { throw new Error("rpc down"); },
    async getBlock() { throw new Error("rpc down"); },
  };
}

test("CMS heal runs for 6281971 and still refuses BNB chains", async () => {
  const campaign = "0x00000000000000000000000000000000000000c1";
  const dogeos = await healRobinhoodGraduatedCms(throwingProvider() as any, DOGEOS, campaign, null);
  assert.equal(dogeos.healed, false);
  assert.match(dogeos.reason, /^rpc_read_failed:/, "6281971 reaches the on-chain read");
  for (const chainId of [56, 97]) {
    const bnb = await healRobinhoodGraduatedCms(throwingProvider() as any, chainId, campaign, null);
    assert.deepEqual(bnb, { healed: false, reason: "not_robinhood_chain" });
  }
});

test("the market-state heal reads 6281971 through the DogeOS RPC, never a Robinhood one", () => {
  assert.equal(robinhoodMarketApiInternals.marketStateHealRpcUrl(DOGEOS), "https://rpc.testnet.dogeos.com");
  assert.equal(robinhoodMarketApiInternals.marketStateHealRpcUrl(4663), "https://rh-mainnet-rpc.test.invalid");
  assert.equal(robinhoodMarketApiInternals.marketStateHealRpcUrl(46630), "https://rh-testnet-rpc.test.invalid");
});

function captureRoutes() {
  const routes = new Map<string, (req: any, res: any, next: () => void) => Promise<unknown>>();
  registerRobinhoodMarketContinuityRoutes({ get: (route: string, handler: any) => { routes.set(route, handler); } } as any);
  return routes;
}

function fakeResponse() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  return res;
}

test("V3 market routes serve 6281971 instead of falling through to the BNB/Topaz handlers", async () => {
  const routes = captureRoutes();
  const campaign = "0x00000000000000000000000000000000000000c1";
  for (const route of [
    "/api/token/:campaign/market-state",
    "/api/token/:campaign/trade-route",
    "/api/token/:campaign/market-summary",
    "/api/token/:campaign/market-trades",
  ]) {
    const handler = routes.get(route);
    assert.ok(handler, route);
    let nextCalled = 0;
    await handler({ query: { chainId: "56" }, params: { campaign } }, fakeResponse(), () => { nextCalled += 1; });
    assert.equal(nextCalled, 1, `${route}: BNB still falls through`);

    nextCalled = 0;
    const res = fakeResponse();
    await handler({ query: { chainId: String(DOGEOS) }, params: { campaign } }, res, () => { nextCalled += 1; });
    assert.equal(nextCalled, 0, `${route}: 6281971 is served here`);
    assert.notEqual(res.body, undefined, `${route}: 6281971 got a response`);
  }

  const stateRes = fakeResponse();
  await routes.get("/api/token/:campaign/market-state")!(
    { query: { chainId: String(DOGEOS) }, params: { campaign } },
    stateRes,
    () => {},
  );
  assert.equal(stateRes.statusCode, 200);
  assert.equal(stateRes.body.chainId, DOGEOS);
  assert.equal(stateRes.body.provisional, true);
});

test("the stock-token registry route stays Robinhood-only (named exception)", async () => {
  const routes = captureRoutes();
  const res = fakeResponse();
  await routes.get("/api/robinhood/stock-tokens")!({ query: { chainId: String(DOGEOS) }, params: {} }, res, () => {});
  assert.equal(res.statusCode, 400);
});

// ---------------------------------------------------------------------------------------------
// CMS heal graduation anchor: getLogs <= 10,000 blocks per call on 6281971

function anchorProvider(input: { head: number; maxRange?: number; graduationBlock: number }) {
  const calls: Array<{ fromBlock: unknown; toBlock: unknown; topics: unknown }> = [];
  const gradTx = `0x${"9a".repeat(32)}`;
  return {
    calls,
    gradTx,
    async getBlockNumber() { return input.head; },
    async getLogs(filter: any) {
      calls.push({ fromBlock: filter.fromBlock, toBlock: filter.toBlock, topics: filter.topics });
      const from = Number(filter.fromBlock);
      const to = filter.toBlock === "latest" ? input.head : Number(filter.toBlock);
      if (input.maxRange != null && to - from + 1 > input.maxRange) throw new Error(`query exceeds max block range ${input.maxRange}`);
      return input.graduationBlock >= from && input.graduationBlock <= to
        ? [{ blockNumber: input.graduationBlock, transactionHash: gradTx, topics: [], data: "0x", index: 0 }]
        : [];
    },
    async getBlock(_n: number) { return { hash: `0x${"cd".repeat(32)}`, timestamp: 1_791_600_000 }; },
  };
}

async function withCampaignRow<T>(row: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  (pool as any).query = async (sql: unknown, params: unknown[] = []) => {
    queries.push({ sql: String(sql), params });
    return /from public\.campaigns/.test(String(sql)) ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
  };
  try {
    return await run();
  } finally {
    (pool as any).query = stubQuery;
  }
}

test("6281971 heal finds a graduation anchor beyond 10,000 blocks with getLogs windows <= 10,000", async () => {
  const provider = anchorProvider({ head: 45_000, maxRange: 10_000, graduationBlock: 25_123 });
  const anchor = await withCampaignRow({ created_block: 100 }, () =>
    robinhoodCmsHealInternals.findGraduationAnchor(provider as any, DOGEOS, "0x00000000000000000000000000000000000000c1"),
  );
  assert.ok(anchor, "anchor found");
  assert.equal(anchor.block, 25_123);
  assert.equal(anchor.txHash, provider.gradTx);
  assert.ok(provider.calls.length > 1);
  let expectedFrom = 100;
  for (const call of provider.calls) {
    assert.equal(call.fromBlock, expectedFrom, "windows are contiguous from created_block");
    assert.notEqual(call.toBlock, "latest");
    assert.ok(Number(call.toBlock) - Number(call.fromBlock) + 1 <= 10_000);
    expectedFrom = Number(call.toBlock) + 1;
  }
  assert.ok(Number(provider.calls[provider.calls.length - 1].toBlock) >= 25_123, "stops at the window holding the log");
  assert.ok(Number(provider.calls[provider.calls.length - 1].toBlock) < 45_000, "does not scan past the first match");
});

test("46630 heal keeps its single created_block -> latest getLogs call", async () => {
  const provider = anchorProvider({ head: 45_000, graduationBlock: 25_123 });
  const anchor = await withCampaignRow({ created_block: 100 }, () =>
    robinhoodCmsHealInternals.findGraduationAnchor(provider as any, 46630, "0x0000000000000000000000000000000000000044"),
  );
  assert.ok(anchor);
  assert.equal(anchor.block, 25_123);
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].fromBlock, 100);
  assert.equal(provider.calls[0].toBlock, "latest");
});
