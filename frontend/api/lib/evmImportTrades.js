/**
 * Recent trades of an imported EVM coin read straight from its DEX pool's Swap logs (founder,
 * 2026-10-11: GeckoTerminal showed a Robinhood test buy only after several reloads). Robinhood
 * (4663, Uniswap V3) and BNB (56, PancakeSwap V3 and V2) pools. GeckoTerminal stays the fallback:
 * anything this module cannot read with certainty throws.
 *
 * Per pool: the type (V3 or V2) and the token order are read once and kept. A first pass scans
 * eth_getLogs backwards from the head in chunks until it has ITEM_CAP swaps or its call budget is
 * used; later passes only scan the blocks since the last head, so a poll costs one getBlockNumber
 * and one getLogs. Transactions (for the sender) and block timestamps are fetched only for swaps
 * that are returned, and kept (both are immutable). A pool's answer is shared by every viewer for a
 * few seconds and concurrent requests share one read.
 *
 * Measured 2026-10-11 against the public RPCs:
 *  - Robinhood mainnet: 0.10 s per block (about 864,000 per day). With a topic filter eth_getLogs
 *    allows 100,000 blocks per call (about 2.8 h, 140 ms each), so 8 calls cover roughly 22 h.
 *  - BSC: 0.45 s per block (about 190,000 per day). bsc-dataseed.binance.org and defibit refuse every
 *    eth_getLogs ("limit exceeded"), so BSC_RPC_URL must be a provider that serves logs.
 *    publicnode serves logs only about 10,000 blocks (75 min) back from the head and refuses older
 *    ones as archive. Chunk 5,000 (about 38 min), 8 calls: a provider with deeper logs reaches about
 *    5 h, publicnode stops at the depth it allows (the older chunks failing is tolerated once a
 *    newer chunk answered). BSC_IMPORT_LOGS_CHUNK raises the chunk for a provider with a bigger range.
 *  A pass that finds no swap at all throws, so a quiet coin shows GeckoTerminal's 24 h list.
 */

import { ethers } from "ethers";

const ITEM_CAP = 40;
const RESULT_TTL_MS = 5_000;
const MAX_CACHED_TX = 5_000;
const MAX_CACHED_BLOCKS = 5_000;

const WRAPPED_NATIVE = {
  4663: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
  56: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
};
const LOG_PLAN = {
  4663: { chunk: 100_000, calls: 8 },
  56: { chunk: 5_000, calls: 8 },
};

const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function decimals() view returns (uint8)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint128 protocolFeesToken0, uint128 protocolFeesToken1)",
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
];
const iface = new ethers.Interface(POOL_ABI);
const SWAP_EVENTS = iface.fragments.filter((f) => f.type === "event");
const SWAP_TOPICS = SWAP_EVENTS.map((f) => f.topicHash);
const V3_TOPICS = SWAP_EVENTS.filter((f) => f.inputs.length > 6).map((f) => f.topicHash);

export function evmImportRpcUrl(chainId, env = process.env) {
  const id = Number(chainId);
  const pick = (...keys) => keys.map((k) => String(env[k] || "").trim()).find(Boolean) || "";
  // Server env only: the app's VITE_ RPCs are browser settings.
  if (id === 4663) return pick("ROBINHOOD_MAINNET_RPC_URL", "ROBINHOOD_RPC_URL") || "https://rpc.mainnet.chain.robinhood.com";
  if (id === 56) return pick("BSC_RPC_URL", "BSC_RPC_HTTP") || "https://bsc-dataseed.binance.org";
  return "";
}

export function isEvmImportTradeChain(chainId) {
  return Number(chainId) in WRAPPED_NATIVE;
}

const lower = (a) => String(a || "").toLowerCase();
const units = (raw, decimals) => Number(ethers.formatUnits(raw < 0n ? -raw : raw, decimals));

/** One Swap log -> { coinDelta (pool's change, in raw units), nativeRaw } or null when it has no coin leg. */
export function decodeSwap(log, { coinIs0 }) {
  const parsed = iface.parseLog({ topics: log.topics, data: log.data });
  if (!parsed) return null;
  let coin;
  let native;
  if (V3_TOPICS.includes(log.topics[0])) {
    const [a0, a1] = [parsed.args.amount0, parsed.args.amount1];
    coin = coinIs0 ? a0 : a1;
    native = coinIs0 ? a1 : a0;
  } else {
    const { amount0In: i0, amount1In: i1, amount0Out: o0, amount1Out: o1 } = parsed.args;
    const [a0, a1] = [i0 - o0, i1 - o1];
    coin = coinIs0 ? a0 : a1;
    native = coinIs0 ? a1 : a0;
  }
  if (coin === 0n || native === 0n) return null;
  return { coinDelta: coin, nativeRaw: native };
}

export function createEvmImportTrades({
  providerFor,
  nativeUsdPrice = async () => 0,
  now = () => Date.now(),
  env = process.env,
} = {}) {
  const pools = new Map(); // key -> { at, trades }
  const inflight = new Map();
  const meta = new Map(); // key -> { kind, coinIs0, coinDecimals }
  const state = new Map(); // key -> { head, swaps: [{ txHash, logIndex, blockNumber, coinDelta, nativeRaw }] }
  const txFrom = new Map(); // txHash -> sender
  const blockTime = new Map(); // block number -> unix seconds
  let calls = 0;

  function plan(chainId) {
    const base = LOG_PLAN[Number(chainId)];
    const override = Number(chainId) === 56 ? Number(env.BSC_IMPORT_LOGS_CHUNK) : 0;
    return { ...base, chunk: override > 0 ? override : base.chunk };
  }

  async function poolMeta(key, provider, chainId, pairAddress, tokenAddress) {
    const hit = meta.get(key);
    if (hit) return hit;
    const pool = new ethers.Contract(pairAddress, POOL_ABI, provider);
    const [t0, t1] = await Promise.all([pool.token0(), pool.token1()]);
    const native = WRAPPED_NATIVE[Number(chainId)];
    const coin = lower(tokenAddress);
    const sides = [lower(t0), lower(t1)];
    if (!sides.includes(coin)) throw new Error("Token is not in this pool");
    if (!sides.includes(native)) throw new Error("Pool is not paired with the wrapped native coin");
    const coinIs0 = sides[0] === coin;
    // V3 answers fee() and slot0(); V2 answers getReserves(). A pool that is neither is not read.
    const isV3 = await Promise.all([pool.fee(), pool.slot0()]).then(() => true, () => false);
    const isV2 = isV3 ? false : await pool.getReserves().then(() => true, () => false);
    if (!isV3 && !isV2) throw new Error("Unsupported pool type");
    const coinDecimals = Number(await new ethers.Contract(tokenAddress, POOL_ABI, provider).decimals());
    const value = { kind: isV3 ? "v3" : "v2", coinIs0, coinDecimals };
    meta.set(key, value);
    return value;
  }

  async function logsBetween(provider, address, from, to) {
    calls += 1;
    const logs = await provider.getLogs({ address, fromBlock: from, toBlock: to, topics: [SWAP_TOPICS] });
    return logs.map((l) => ({ ...l, logIndex: Number(l.index ?? l.logIndex) }));
  }

  /** Decoded swaps of [from, to] by chunks, newest first, stopping at `want` swaps or `maxCalls` reads. */
  async function scan(provider, address, from, to, m, { chunk, maxCalls, want, tolerateDeep = false }) {
    const found = [];
    let hi = to;
    for (let i = 0; i < maxCalls && hi >= from && found.length < want; i += 1) {
      const lo = Math.max(from, hi - chunk + 1);
      let logs;
      try {
        logs = await logsBetween(provider, address, lo, hi);
      } catch (error) {
        // Older chunks beyond the provider's depth are given up on; the newest chunk must answer.
        if (!tolerateDeep || i === 0) throw error;
        break;
      }
      for (const log of logs) {
        const d = decodeSwap(log, m);
        if (d) found.push({ txHash: log.transactionHash, logIndex: log.logIndex, blockNumber: Number(log.blockNumber), ...d });
      }
      hi = lo - 1;
    }
    found.sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
    return { found, reachedFrom: hi < from };
  }

  async function refresh(chainId, pairAddress, tokenAddress, key) {
    const provider = providerFor(chainId);
    if (!provider) throw new Error("EVM RPC is not configured");
    const m = await poolMeta(key, provider, chainId, pairAddress, tokenAddress);
    const head = Number(await provider.getBlockNumber());
    const { chunk, calls: maxCalls } = plan(chainId);
    let st = state.get(key);
    if (st && head > st.head) {
      // Only the blocks since the last pass; a gap too wide for the budget starts over.
      const gap = await scan(provider, pairAddress, st.head + 1, head, m, { chunk, maxCalls, want: Infinity });
      if (gap.reachedFrom) {
        const known = new Set(st.swaps.map((s) => `${s.txHash}:${s.logIndex}`));
        st = { head, swaps: [...gap.found.filter((s) => !known.has(`${s.txHash}:${s.logIndex}`)), ...st.swaps].slice(0, ITEM_CAP) };
      } else st = null;
    } else if (st) st = { ...st, head: Math.max(st.head, head) };
    if (!st) {
      const first = await scan(provider, pairAddress, Math.max(0, head - chunk * maxCalls + 1), head, m, { chunk, maxCalls, want: ITEM_CAP, tolerateDeep: true });
      st = { head, swaps: first.found.slice(0, ITEM_CAP) };
    }
    state.set(key, st);
    if (!st.swaps.length) throw new Error("No swaps in the scanned window");

    const nativeUsd = st.swaps.length ? Number(await nativeUsdPrice(chainId).catch(() => 0)) || 0 : 0;
    const items = await Promise.all(
      st.swaps.map(async (s) => {
        if (!txFrom.has(s.txHash)) {
          const tx = await provider.getTransaction(s.txHash);
          if (!tx?.from) throw new Error("Transaction not available");
          txFrom.set(s.txHash, tx.from);
          if (txFrom.size > MAX_CACHED_TX) txFrom.delete(txFrom.keys().next().value);
        }
        if (!blockTime.has(s.blockNumber)) {
          const block = await provider.getBlock(s.blockNumber);
          if (!block) throw new Error("Block not available");
          blockTime.set(s.blockNumber, Number(block.timestamp));
          if (blockTime.size > MAX_CACHED_BLOCKS) blockTime.delete(blockTime.keys().next().value);
        }
        const nativeAmount = units(s.nativeRaw, 18);
        return {
          txHash: s.txHash,
          // The pool's coin balance going up is a sell, going down a buy.
          side: s.coinDelta > 0n ? "sell" : "buy",
          maker: txFrom.get(s.txHash),
          tokenAmount: units(s.coinDelta, m.coinDecimals),
          nativeAmount,
          volumeUsd: nativeUsd > 0 ? nativeAmount * nativeUsd : null,
          blockTime: blockTime.get(s.blockNumber),
          blockNumber: s.blockNumber,
        };
      }),
    );
    return items.sort((a, b) => b.blockTime - a.blockTime || b.blockNumber - a.blockNumber);
  }

  /** Newest trades first. Throws when the chain cannot be read (the caller falls back). */
  async function trades({ chainId, pairAddress, tokenAddress }) {
    if (!isEvmImportTradeChain(chainId)) throw new Error("No on-chain trade source for this chain");
    if (!ethers.isAddress(pairAddress) || !ethers.isAddress(tokenAddress)) throw new Error("Invalid pool or token address");
    const key = `${Number(chainId)}:${lower(pairAddress)}:${lower(tokenAddress)}`;
    const hit = pools.get(key);
    if (hit && now() - hit.at < RESULT_TTL_MS) return hit.trades;
    if (inflight.has(key)) return inflight.get(key);
    const request = refresh(Number(chainId), pairAddress, tokenAddress, key)
      .then((list) => {
        pools.set(key, { at: now(), trades: list });
        return list;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, request);
    return request;
  }

  return { trades, stats: () => ({ calls, pools: pools.size, transactions: txFrom.size }) };
}

/** Production wiring: one JSON-RPC provider per chain, created on first use. */
export function createEvmProviderFactory(env = process.env) {
  const providers = new Map();
  return (chainId) => {
    const url = evmImportRpcUrl(chainId, env);
    if (!url) return null;
    if (!providers.has(Number(chainId))) {
      providers.set(Number(chainId), new ethers.JsonRpcProvider(url, Number(chainId), { staticNetwork: true }));
    }
    return providers.get(Number(chainId));
  };
}
