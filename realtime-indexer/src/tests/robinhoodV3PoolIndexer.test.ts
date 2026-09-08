import test from "node:test";
import assert from "node:assert/strict";

process.env.RUNTIME_ENVIRONMENT = "local";
process.env.LOCAL_DISABLE_ABLY = "1";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/memewarzone_robinhood_local";
process.env.EVM_INDEXER_CHAIN_IDS = "46630";
process.env.DEFAULT_EVM_CHAIN_ID = "46630";
process.env.ENABLE_ROBINHOOD_V3_POOL_INDEXER = "0";

const { ethers } = await import("ethers");
const { robinhoodV3Internals } = await import("../robinhoodV3PoolIndexer.js");

const token = "0x0000000000000000000000000000000000000011";
const weth = "0x0000000000000000000000000000000000000022";
const stock = "0x0000000000000000000000000000000000000099";
const basePool = {
  chainId: 46630,
  pairAddress: "0x0000000000000000000000000000000000000033",
  campaignAddress: "0x0000000000000000000000000000000000000044",
  tokenAddress: token,
  wrappedNativeAddress: weth,
  baseTokenAddress: token,
  quoteTokenAddress: weth,
  quoteAssetType: "WRAPPED_NATIVE",
  baseDecimals: 18,
  quoteDecimals: 18,
  oracleFeedAddress: null,
  marketRole: "CANONICAL_NATIVE",
  routerAddress: "0x0000000000000000000000000000000000000055",
  factoryAddress: "0x0000000000000000000000000000000000000066",
  token0Address: token,
  token1Address: weth,
  feePpm: 3000,
  graduationBlock: 1,
  lastIndexedBlock: null,
};

test("stored decimals treat SQL null as missing instead of zero decimals", () => {
  assert.equal(robinhoodV3Internals.storedDecimals(null), null);
  assert.equal(robinhoodV3Internals.storedDecimals(undefined), null);
  assert.equal(robinhoodV3Internals.storedDecimals(""), null);
  assert.equal(robinhoodV3Internals.storedDecimals("0"), 0);
  assert.equal(robinhoodV3Internals.storedDecimals("18"), 18);
  assert.equal(robinhoodV3Internals.storedDecimals(36), 36);
  assert.equal(robinhoodV3Internals.storedDecimals(37), null);
  assert.equal(robinhoodV3Internals.storedDecimals(-1), null);
  assert.equal(robinhoodV3Internals.storedDecimals("not-a-number"), null);
});

test("normalizes Robinhood mock-V3 native->token as buy", () => {
  const iface = new ethers.Interface([
    "event Swap(address indexed sender,address indexed tokenIn,address indexed tokenOut,uint256 amountIn,uint256 amountOut,uint256 feeAmount,address recipient)",
  ]);
  const encoded = iface.encodeEventLog(iface.getEvent("Swap")!, [
    "0x0000000000000000000000000000000000000077",
    weth,
    token,
    1_000_000_000_000_000_000n,
    2_000_000_000_000_000_000n,
    3_000_000_000_000_000n,
    "0x0000000000000000000000000000000000000088",
  ]);
  const parsed = iface.parseLog({ topics: encoded.topics, data: encoded.data })!;
  const normalized = robinhoodV3Internals.normalizeMockSwap(basePool as any, parsed);
  assert.ok(normalized);
  assert.equal(normalized.side, "buy");
  assert.equal(normalized.quoteAmountRaw, 1_000_000_000_000_000_000n);
  assert.equal(normalized.baseAmountRaw, 2_000_000_000_000_000_000n);
  assert.equal(normalized.nativeAmountRaw, 1_000_000_000_000_000_000n);
  assert.equal(normalized.tokenAmountRaw, 2_000_000_000_000_000_000n);
});

test("normalizes Robinhood mock-V3 token->native as sell", () => {
  const iface = new ethers.Interface([
    "event Swap(address indexed sender,address indexed tokenIn,address indexed tokenOut,uint256 amountIn,uint256 amountOut,uint256 feeAmount,address recipient)",
  ]);
  const encoded = iface.encodeEventLog(iface.getEvent("Swap")!, [
    "0x0000000000000000000000000000000000000077",
    token,
    weth,
    2_000_000_000_000_000_000n,
    900_000_000_000_000_000n,
    6_000_000_000_000_000n,
    "0x0000000000000000000000000000000000000088",
  ]);
  const parsed = iface.parseLog({ topics: encoded.topics, data: encoded.data })!;
  const normalized = robinhoodV3Internals.normalizeMockSwap(basePool as any, parsed);
  assert.ok(normalized);
  assert.equal(normalized.side, "sell");
  assert.equal(normalized.baseAmountRaw, 2_000_000_000_000_000_000n);
  assert.equal(normalized.quoteAmountRaw, 900_000_000_000_000_000n);
  assert.equal(normalized.nativeAmountRaw, 900_000_000_000_000_000n);
});

test("normalizes canonical Uniswap V3 deltas without BNB assumptions", () => {
  const iface = new ethers.Interface([
    "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)",
  ]);
  const encoded = iface.encodeEventLog(iface.getEvent("Swap")!, [
    "0x0000000000000000000000000000000000000077",
    "0x0000000000000000000000000000000000000088",
    -2_000_000_000_000_000_000n,
    1_000_000_000_000_000_000n,
    1n,
    1n,
    0,
  ]);
  const parsed = iface.parseLog({ topics: encoded.topics, data: encoded.data })!;
  const normalized = robinhoodV3Internals.normalizeCanonicalSwap(basePool as any, parsed);
  assert.ok(normalized);
  assert.equal(normalized.side, "buy");
  assert.equal(normalized.baseAmountRaw, 2_000_000_000_000_000_000n);
  assert.equal(normalized.quoteAmountRaw, 1_000_000_000_000_000_000n);
  assert.equal(normalized.nativeAmountRaw, 1_000_000_000_000_000_000n);
});

test("stock-token quote swaps never populate native compatibility amount", () => {
  const iface = new ethers.Interface([
    "event Swap(address indexed sender,address indexed tokenIn,address indexed tokenOut,uint256 amountIn,uint256 amountOut,uint256 feeAmount,address recipient)",
  ]);
  const stockPool = {
    ...basePool,
    quoteTokenAddress: stock,
    quoteAssetType: "STOCK_TOKEN",
    quoteDecimals: 8,
    marketRole: "CANONICAL_STOCK",
    token0Address: stock,
    token1Address: token,
  };
  const encoded = iface.encodeEventLog(iface.getEvent("Swap")!, [
    "0x0000000000000000000000000000000000000077",
    stock,
    token,
    250_000_000n,
    10_000_000_000_000_000_000n,
    1_000_000n,
    "0x0000000000000000000000000000000000000088",
  ]);
  const parsed = iface.parseLog({ topics: encoded.topics, data: encoded.data })!;
  const normalized = robinhoodV3Internals.normalizeMockSwap(stockPool as any, parsed);
  assert.ok(normalized);
  assert.equal(normalized.side, "buy");
  assert.equal(normalized.baseAmountRaw, 10_000_000_000_000_000_000n);
  assert.equal(normalized.quoteAmountRaw, 250_000_000n);
  assert.equal(normalized.nativeAmountRaw, null);
});
