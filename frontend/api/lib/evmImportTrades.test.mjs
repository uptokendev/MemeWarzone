import test from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { createEvmImportTrades, createQuotePriceSource, decodeSwap, evmImportRpcUrl, SWAP_V4_TOPIC } from "./evmImportTrades.js";

const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const COIN = "0xe7dec18b0b29c8e02fb90a5dce413b3bc66e8251";
const OTHER = "0x55d398326f99059fF775485246999027B3197955";
const POOL = "0xD1c3AFDFec3b9933fb1826B667A12923911F4463";
const MAKER = "0x1a367016f10b230e28cf1abda2594c47bf60fe34";
const ROUTER = "0x00000000000000000000000000000000000000aa";

const abi = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function decimals() view returns (uint8)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint128 protocolFeesToken0, uint128 protocolFeesToken1)",
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
]);
const e18 = (n) => ethers.parseUnits(String(n), 18);

function swapLog(kind, args, { block = 100, index = 0, hash = "0x" + "11".repeat(32) } = {}) {
  const frag = abi.fragments.filter((f) => f.type === "event")[{ uni: 0, pancake: 1, v2: 2 }[kind]];
  const { topics, data } = abi.encodeEventLog(frag, args);
  return { topics, data, blockNumber: block, index, transactionHash: hash, address: POOL };
}
const v3 = (a0, a1) => [ROUTER, ROUTER, a0, a1, 1n, 1n, 1];
const pancake = (a0, a1) => [ROUTER, ROUTER, a0, a1, 1n, 1n, 1, 0n, 0n];

function fakeProvider({ type = "v3", token0 = WETH, token1 = COIN, decimals = 18, logs = [], head = 200, failLogs = false } = {}) {
  const seen = { logs: [], tx: [], blocks: [], calls: 0 };
  const provider = {
    seen,
    async call({ data }) {
      seen.calls += 1;
      const sel = data.slice(0, 10);
      const name = abi.getFunction(sel).name;
      if (name === "token0") return abi.encodeFunctionResult("token0", [token0]);
      if (name === "token1") return abi.encodeFunctionResult("token1", [token1]);
      if (name === "decimals") return abi.encodeFunctionResult("decimals", [decimals]);
      if (type === "v3" && name === "fee") return abi.encodeFunctionResult("fee", [10000]);
      if (type === "v3" && name === "slot0") return abi.encodeFunctionResult("slot0", [1n, 1, 0, 1, 1, 0, true]);
      if (type === "v2" && name === "getReserves") return abi.encodeFunctionResult("getReserves", [1n, 1n, 1]);
      throw new Error("execution reverted");
    },
    async getBlockNumber() { return head; },
    async getLogs(filter) {
      seen.logs.push(filter);
      if (failLogs) throw new Error("logs refused");
      return logs.filter((l) => l.blockNumber >= filter.fromBlock && l.blockNumber <= filter.toBlock);
    },
    async getTransaction(hash) { seen.tx.push(hash); return { from: MAKER, hash }; },
    async getBlock(n) { seen.blocks.push(n); return { timestamp: 1_700_000_000 + n }; },
  };
  return provider;
}
const make = (provider, extra = {}) => createEvmImportTrades({ providerFor: () => provider, nativeUsdPrice: async () => 3000, ...extra });
const ask = (t, chainId = 4663, pair = POOL, token = COIN) => t.trades({ chainId, pairAddress: pair, tokenAddress: token });

test("Uniswap V3 buy: coin leaves the pool, maker is tx.from, USD from the native price", async () => {
  // token0 = WETH: pool gains 0.000099 WETH, loses 25.69 coin.
  const p = fakeProvider({ logs: [swapLog("uni", v3(e18("0.000099"), -e18("25.69")), { block: 150 })] });
  const [item] = await ask(make(p));
  assert.equal(item.side, "buy");
  assert.equal(item.maker, MAKER);
  assert.equal(item.tokenAmount, 25.69);
  assert.equal(item.nativeAmount, 0.000099);
  assert.ok(Math.abs(item.volumeUsd - 0.297) < 1e-9);
  assert.equal(item.blockNumber, 150);
  assert.equal(item.blockTime, 1_700_000_150);
});

test("Uniswap V3 sell: coin enters the pool", async () => {
  const p = fakeProvider({ logs: [swapLog("uni", v3(-e18("0.5"), e18("1000")))] });
  const [item] = await ask(make(p));
  assert.equal(item.side, "sell");
  assert.equal(item.tokenAmount, 1000);
  assert.equal(item.nativeAmount, 0.5);
});

test("PancakeSwap V3 (two extra Swap fields) buy and sell, coin is token0, coin decimals respected", async () => {
  const p = fakeProvider({
    token0: COIN,
    token1: WBNB,
    decimals: 6,
    logs: [
      swapLog("pancake", pancake(-5_000_000n, e18("0.01")), { block: 120, hash: "0x" + "22".repeat(32) }),
      swapLog("pancake", pancake(7_000_000n, -e18("0.014")), { block: 130, hash: "0x" + "33".repeat(32) }),
    ],
  });
  const items = await ask(make(p), 56, POOL, COIN);
  assert.deepEqual(items.map((i) => i.side), ["sell", "buy"]);
  assert.deepEqual(items.map((i) => i.tokenAmount), [7, 5]);
  assert.deepEqual(items.map((i) => i.nativeAmount), [0.014, 0.01]);
});

test("PancakeSwap V2 swap, both token orders", async () => {
  // coin is token1: buy = coin out (amount1Out), native in (amount0In).
  const buy = swapLog("v2", [ROUTER, e18("0.2"), 0n, 0n, e18("40"), ROUTER], { block: 140 });
  const sell = swapLog("v2", [ROUTER, 0n, e18("10"), e18("0.05"), 0n, ROUTER], { block: 141, hash: "0x" + "44".repeat(32) });
  const a = await ask(make(fakeProvider({ type: "v2", token0: WBNB, token1: COIN, logs: [buy, sell] })), 56);
  assert.deepEqual(a.map((i) => [i.side, i.tokenAmount, i.nativeAmount]), [["sell", 10, 0.05], ["buy", 40, 0.2]]);
  // coin is token0: the same trades with the legs swapped.
  const buy0 = swapLog("v2", [ROUTER, 0n, e18("0.2"), e18("40"), 0n, ROUTER], { block: 140 });
  const b = await ask(make(fakeProvider({ type: "v2", token0: COIN, token1: WBNB, logs: [buy0] })), 56);
  assert.deepEqual(b.map((i) => [i.side, i.tokenAmount, i.nativeAmount]), [["buy", 40, 0.2]]);
});

test("decodeSwap reads orientation from coinIs0", () => {
  const log = swapLog("uni", v3(e18("2"), -e18("3")));
  assert.deepEqual(decodeSwap(log, { coinIs0: true }), { coinDelta: e18("2"), nativeRaw: -e18("3") });
  assert.deepEqual(decodeSwap(log, { coinIs0: false }), { coinDelta: -e18("3"), nativeRaw: e18("2") });
});

test("a pool paired with something other than the wrapped native coin throws", async () => {
  const p = fakeProvider({ token0: OTHER, logs: [swapLog("uni", v3(1n, -1n))] });
  await assert.rejects(ask(make(p), 56), /wrapped native/);
  await assert.rejects(ask(make(fakeProvider({ token0: WETH, token1: OTHER })), 4663), /not in this pool/);
});

test("unsupported chains, bad addresses and an unknown pool type throw", async () => {
  await assert.rejects(ask(make(fakeProvider()), 1), /No on-chain/);
  await assert.rejects(ask(make(fakeProvider()), 4663, "nope"), /Invalid/);
  await assert.rejects(ask(make(fakeProvider({ type: "other" }))), /Unsupported pool type/);
});

test("no swap in the window throws (GeckoTerminal answers instead); a refused first chunk throws", async () => {
  await assert.rejects(ask(make(fakeProvider({ logs: [] }))), /No swaps/);
  await assert.rejects(ask(make(fakeProvider({ failLogs: true }))), /logs refused/);
});

test("results are cached for the TTL, concurrent calls share one read, transactions are fetched once", async () => {
  let clock = 0;
  const p = fakeProvider({ logs: [swapLog("uni", v3(e18("1"), -e18("2")), { block: 190 })] });
  const t = make(p, { now: () => clock });
  const [a, b] = await Promise.all([ask(t), ask(t)]);
  assert.equal(a, b);
  const logCalls = p.seen.logs.length;
  const callsAfterFirst = p.seen.calls;
  clock = 1_000;
  assert.equal(await ask(t), a);
  assert.equal(p.seen.logs.length, logCalls);
  clock = 10_000;
  const later = await ask(t);
  assert.equal(later[0].txHash, a[0].txHash);
  assert.equal(p.seen.tx.length, 1);
  assert.equal(p.seen.blocks.length, 1);
  assert.equal(p.seen.calls, callsAfterFirst, "pool type and decimals are read once");
});

test("a later pass scans only the new blocks and keeps the older swaps", async () => {
  let clock = 0;
  const logs = [swapLog("uni", v3(e18("1"), -e18("2")), { block: 150 })];
  const p = fakeProvider({ logs, head: 200 });
  const t = make(p, { now: () => clock });
  assert.equal((await ask(t)).length, 1);
  logs.push(swapLog("uni", v3(-e18("1"), e18("4")), { block: 205, hash: "0x" + "55".repeat(32) }));
  p.getBlockNumber = async () => 210;
  clock = 20_000;
  const before = p.seen.logs.length;
  const items = await ask(t);
  assert.equal(p.seen.logs.length - before, 1);
  assert.deepEqual(p.seen.logs.at(-1).fromBlock, 201);
  assert.deepEqual(items.map((i) => i.side), ["sell", "buy"]);
});

test("the first pass stops at the item cap and at the call budget; older chunks failing is tolerated", async () => {
  const many = Array.from({ length: 60 }, (_, i) => swapLog("uni", v3(e18("1"), -e18("2")), { block: 1_000_000 - i * 10, hash: "0x" + i.toString(16).padStart(64, "0") }));
  const p = fakeProvider({ logs: many, head: 1_000_000 });
  const items = await ask(make(p));
  assert.equal(items.length, 40);
  assert.equal(p.seen.logs.length, 1, "one chunk held enough swaps");
  const quiet = fakeProvider({ logs: [swapLog("uni", v3(e18("1"), -e18("2")), { block: 999_990 })], head: 1_000_000 });
  await ask(make(quiet));
  assert.equal(quiet.seen.logs.length, 8);
  // Chunk two refuses (provider depth): the newest chunk's swap is still returned.
  const shallow = fakeProvider({ logs: [swapLog("uni", v3(e18("1"), -e18("2")), { block: 999_990 })], head: 1_000_000 });
  const getLogs = shallow.getLogs;
  shallow.getLogs = async (f) => (f.toBlock < 999_000 ? Promise.reject(new Error("archive")) : getLogs(f));
  assert.equal((await ask(make(shallow))).length, 1);
});

test("rpc urls come from the same env names as the import scanner", () => {
  assert.equal(evmImportRpcUrl(56, { BSC_RPC_URL: "https://x" }), "https://x");
  assert.equal(evmImportRpcUrl(4663, {}), "https://rpc.mainnet.chain.robinhood.com");
  assert.equal(evmImportRpcUrl(1, {}), "");
});

// ---- Uniswap V4 ----
const PFE = "0x7066A64c24e4206CD62E83bf198c1E7EB361F51e";
const MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const HOOK = "0x00000000000000000000000000000000000000e5";
const v4abi = new ethers.Interface([
  "function poolKeys(bytes25) view returns (address,address,uint24,int24,address)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
]);
function v4Pool(c0, c1) {
  const key = [c0, c1, 10000, 200, HOOK];
  const id = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24", "int24", "address"], key));
  return { key, id };
}
function v4Log(id, a0, a1, { block = 100, hash = "0x" + "66".repeat(32), index = 0 } = {}) {
  const { topics, data } = v4abi.encodeEventLog("Swap", [id, ROUTER, a0, a1, 1n, 1n, 1, 10000]);
  return { topics, data, blockNumber: block, index, transactionHash: hash, address: MANAGER };
}
function v4Provider({ key, id, logs, quoteDecimals = 18, keyOverride }) {
  const p = fakeProvider({ logs: [] });
  p.getLogs = async (f) => {
    p.seen.logs.push(f);
    return logs.filter((l) => l.blockNumber >= f.fromBlock && l.blockNumber <= f.toBlock);
  };
  p.call = async ({ to, data }) => {
    const name = v4abi.getFunction(data.slice(0, 10)).name;
    if (name === "poolKeys") return v4abi.encodeFunctionResult("poolKeys", keyOverride || key);
    if (name === "decimals") return v4abi.encodeFunctionResult("decimals", [lowerEq(to, COIN) ? 18 : quoteDecimals]);
    return v4abi.encodeFunctionResult("symbol", ["PFE"]);
  };
  return p;
}
const lowerEq = (a, b) => a.toLowerCase() === b.toLowerCase();

test("V4: swapper deltas, positive coin amount is a buy, negative a sell, both token orders", async () => {
  const { key, id } = v4Pool(ethers.ZeroAddress, COIN); // native ETH quote, coin is currency1
  const logs = [
    v4Log(id, -e18("0.5"), e18("1000"), { block: 150 }), // swapper paid ETH, received coin
    v4Log(id, e18("0.2"), -e18("400"), { block: 160, hash: "0x" + "77".repeat(32) }),
  ];
  const p = v4Provider({ key, id, logs });
  const items = await ask(make(p), 4663, id);
  assert.deepEqual(items.map((i) => [i.side, i.tokenAmount, i.nativeAmount, i.quoteSymbol]), [["sell", 400, 0.2, "ETH"], ["buy", 1000, 0.5, "ETH"]]);
  assert.equal(items[1].volumeUsd, 1500);
  assert.equal(p.seen.logs[0].address, MANAGER);
  assert.deepEqual(p.seen.logs[0].topics, [SWAP_V4_TOPIC, id]);
  // coin is currency0
  const flipped = v4Pool(COIN, WETH);
  const q = v4Provider({ ...flipped, logs: [v4Log(flipped.id, e18("30"), -e18("0.1"))] });
  const [item] = await ask(make(q), 4663, flipped.id);
  assert.deepEqual([item.side, item.tokenAmount, item.nativeAmount], ["buy", 30, 0.1]);
});

test("V4: the pool key must hash to the pool id", async () => {
  const { key, id } = v4Pool(ethers.ZeroAddress, COIN);
  const other = v4Pool(ethers.ZeroAddress, OTHER);
  const p = v4Provider({ key, id, logs: [], keyOverride: other.key });
  await assert.rejects(ask(make(p), 4663, id), /does not match/);
  await assert.rejects(ask(make(v4Provider({ ...other, logs: [] })), 4663, other.id), /not in this pool/);
});

test("V4: a token quote is priced in USD, native amount follows, quote fields are set", async () => {
  const { key, id } = v4Pool(PFE, COIN);
  const p = v4Provider({ key, id, logs: [v4Log(id, -e18("2"), e18("5000"))] });
  const quoteUsdPrice = async (chainId, token) => {
    assert.equal(chainId, 4663);
    assert.ok(lowerEq(token, PFE));
    return { priceUsd: 150, symbol: "PFE" };
  };
  const [item] = await ask(make(p, { quoteUsdPrice }), 4663, id);
  assert.equal(item.side, "buy");
  assert.equal(item.quoteAmount, 2);
  assert.equal(item.quoteSymbol, "PFE");
  assert.equal(item.volumeUsd, 300);
  assert.equal(item.nativeAmount, 0.1); // 300 / 3000
});

test("V4: a token quote without a USD price throws", async () => {
  const { key, id } = v4Pool(PFE, COIN);
  const p = v4Provider({ key, id, logs: [v4Log(id, -e18("2"), e18("5000"))] });
  await assert.rejects(ask(make(p, { quoteUsdPrice: async () => { throw new Error("No USD price for the quote token"); } }), 4663, id), /No USD price/);
  await assert.rejects(ask(make(p, { quoteUsdPrice: async () => ({ priceUsd: 0 }) }), 4663, id), /No USD price/);
});

test("decodeSwap reads the V4 event with the swapper sign convention", () => {
  const { id } = v4Pool(ethers.ZeroAddress, COIN);
  const log = v4Log(id, -e18("1"), e18("9"));
  assert.deepEqual(decodeSwap(log, { coinIs0: false }), { coinDelta: -e18("9"), nativeRaw: e18("1") });
});

test("quote price source: DexScreener deepest pair where the token is the base, GeckoTerminal fallback, 60 s cache", async () => {
  let clock = 0;
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.includes("dexscreener")) {
      return { ok: true, json: async () => [
        { baseToken: { address: PFE, symbol: "PFE" }, priceUsd: "100", liquidity: { usd: 10 } },
        { baseToken: { address: PFE, symbol: "PFE" }, priceUsd: "150", liquidity: { usd: 900 } },
        { baseToken: { address: COIN, symbol: "X" }, priceUsd: "1", liquidity: { usd: 99999 } },
      ] };
    }
    return { ok: true, json: async () => ({ data: { attributes: { price_usd: "7", symbol: "G" } } }) };
  };
  const price = createQuotePriceSource({ fetchImpl, now: () => clock });
  assert.deepEqual(await price(4663, PFE), { priceUsd: 150, symbol: "PFE" });
  clock = 30_000;
  await price(4663, PFE);
  assert.equal(urls.length, 1);
  const gecko = createQuotePriceSource({ fetchImpl: async (u) => (u.includes("dexscreener") ? { ok: true, json: async () => [] } : fetchImpl(u)), now: () => clock });
  assert.equal((await gecko(4663, OTHER)).priceUsd, 7);
  const none = createQuotePriceSource({ fetchImpl: async () => ({ ok: false }) });
  await assert.rejects(none(4663, PFE), /No USD price/);
});
