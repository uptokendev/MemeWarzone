import { ethers } from "ethers";
import { Connection, PublicKey } from "@solana/web3.js";

import { dexScreenerChainSlug, fetchDexScreenerPairs, geckoTerminalNetwork } from "./arenaImportMarketFeed.js";
import { PROBE_KIND, simulateRoundTrip, simulateRoundTripV4 } from "./importSwapProbe/simulateRoundTrip.js";

const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function owner() view returns (address)",
  "function getOwner() view returns (address)",
  "function paused() view returns (bool)",
];
const FACTORY_ABI = ["function getPool(address tokenA,address tokenB,bool stable) view returns (address pool)"];
const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn,(address from,address to,bool stable,address factory)[] routes) view returns (uint256[] amounts)",
];
const V3_FACTORY_ABI = ["function getPool(address tokenA,address tokenB,uint24 fee) view returns (address pool)"];
// Uniswap QuoterV2: struct input, non-view, must be staticCall'd.
const V3_QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
];
const BALANCE_ABI = ["function balanceOf(address) view returns (uint256)"];
const V2_FACTORY_ABI = ["function getPair(address tokenA,address tokenB) view returns (address pair)"];
const V2_ROUTER_ABI = ["function getAmountsOut(uint256 amountIn,address[] path) view returns (uint256[] amounts)"];
const PROBE_AMOUNT_IN = 10n ** 15n; // 0.001 wrapped native: quotes and the simulated round trip
// A V2/V3 pool holding less wrapped native than this is a leftover, not the coin's market: skipped, so a coin is
// judged on the pool people trade (WORM, 2026-10-12: 0.0000117 WETH in V3, $133K in its V4 pool).
export const MIN_POOL_NATIVE = 10n ** 16n;

const ZERO = ethers.ZeroAddress;

/**
 * A quote that reverted is evidence (0 = no trade); any other failure (timeout, rate limit, RPC down) is not, and
 * returns null = unknown. A transient RPC error must never read as a honeypot: that finding is a permanent decline.
 */
async function quoteOrUnknown(read) {
  try {
    return BigInt((await read()) ?? 0);
  } catch (error) {
    return error?.code === "CALL_EXCEPTION" ? 0n : null;
  }
}

const quoteOk = (value) => (value === null ? null : value > 0n);

export const ARENA_IMPORT_SCAN_VERSION = "arena-import-scan-v2";
export const FINDING_AUTHORITY = Object.freeze({
  REVIEWABLE: "REVIEWABLE",
  NON_OVERRIDABLE: "NON_OVERRIDABLE",
});
export const IMPORT_SCAN_STATUS = Object.freeze({
  PASSED: "passed",
  NEEDS_REVIEW: "needs_review",
  HARD_FAILURE: "declined",
  STALE: "stale",
});

const NON_OVERRIDABLE_CODES = new Set([
  "not_a_contract",
  "not_a_mint",
  "honeypot_sell_failed",
  "non_transferable",
  "paused",
  "transfer_tax_too_high",
  "unsupported_chain",
]);

function env(...keys) {
  for (const key of keys) {
    const value = String(process.env[key] || "").trim();
    if (value) return value;
  }
  return "";
}

export function importScannerChainFamily(chainId) {
  const id = Number(chainId);
  if (id === 56 || id === 97) return "evm";
  if (id === 4663 || id === 46630) return "evm";
  if (id === 101 || id === 102) return "solana";
  return null;
}

function rpcUrl(chainId) {
  const id = Number(chainId);
  if (id === 101) {
    return env("SOLANA_RPC_URL", "VITE_SOLANA_RPC_URL", "VITE_SOLANA_MAINNET_RPC") || "https://api.mainnet-beta.solana.com";
  }
  if (id === 102) {
    return env("SOLANA_DEVNET_RPC_URL", "VITE_SOLANA_DEVNET_RPC_URL") || "https://api.devnet.solana.com";
  }
  if (id === 56) {
    return env("BSC_RPC_URL", "VITE_PUBLIC_RPC_56") || "https://bsc-dataseed.binance.org";
  }
  if (id === 97) {
    return env("BSC_TESTNET_RPC_URL", "VITE_PUBLIC_RPC_97") || "https://bsc-testnet-rpc.publicnode.com";
  }
  if (id === 4663) {
    // Server env only, like the other Robinhood readers: the app's VITE_ RPC is a browser setting.
    return env("ROBINHOOD_MAINNET_RPC_URL", "ROBINHOOD_RPC_URL") || "https://rpc.mainnet.chain.robinhood.com";
  }
  if (id === 46630) {
    return env("ROBINHOOD_TESTNET_RPC_URL");
  }
  return "";
}

function topazAddresses(chainId) {
  const id = Number(chainId);
  return {
    factory: env(`TOPAZ_FACTORY_ADDRESS_${id}`, `VITE_TOPAZ_FACTORY_ADDRESS_${id}`, "VITE_TOPAZ_FACTORY_ADDRESS"),
    router: env(`TOPAZ_ROUTER_ADDRESS_${id}`, `VITE_TOPAZ_ROUTER_ADDRESS_${id}`, "VITE_TOPAZ_ROUTER_ADDRESS"),
    wbnb: env(`TOPAZ_WBNB_ADDRESS_${id}`, `VITE_TOPAZ_WBNB_ADDRESS_${id}`, "VITE_TOPAZ_WBNB_ADDRESS"),
  };
}

/**
 * Robinhood memecoins trade on Uniswap V3, not Topaz. Mainnet defaults are the real deployment
 * (docs/claude/evm-deployments.md: the canonical 0x1F98431c... address is an empty placeholder
 * there); testnet comes from env only.
 */
const ROBINHOOD_V3_DEFAULTS = {
  4663: {
    factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
    quoter: "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7",
    weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    // SwapRouter02; verified on chain 2026-10-11: factory() and WETH9() match the two above.
    router: "0xCaf681a66D020601342297493863E78C959E5cb2",
  },
};

function uniswapV3Addresses(chainId) {
  const id = Number(chainId);
  const fallback = ROBINHOOD_V3_DEFAULTS[id] || {};
  return {
    factory: env(`ROBINHOOD_V3_FACTORY_ADDRESS_${id}`, `VITE_ROBINHOOD_V3_FACTORY_ADDRESS_${id}`) || fallback.factory || "",
    quoter: env(`ROBINHOOD_V3_QUOTER_ADDRESS_${id}`, `VITE_ROBINHOOD_V3_QUOTER_ADDRESS_${id}`) || fallback.quoter || "",
    weth: env(`ROBINHOOD_WETH_ADDRESS_${id}`, `VITE_ROBINHOOD_WETH_ADDRESS_${id}`) || fallback.weth || "",
    router: env(`ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_${id}`, `VITE_ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_${id}`) || fallback.router || "",
    fees: [100, 500, 3000, 10000],
  };
}

/**
 * BNB memecoins trade on PancakeSwap, not Topaz (four.meme graduates to Pancake). BSC mainnet
 * only; verified on chain 2026-10-11: QuoterV2.factory() = the V3 factory, Router.factory() = the
 * V2 factory, SmartRouter.factory()/factoryV2() = both, all report WBNB (same factories as
 * projectImportBnbMarket.js).
 */
const PANCAKE_BSC = {
  v3: {
    factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
    quoter: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997",
    weth: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    router: "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4",
    fees: [100, 500, 2500, 10000],
  },
  v2: {
    factory: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
    router: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
    weth: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    feeBps: 25,
  },
};

function isRobinhoodChain(chainId) {
  const id = Number(chainId);
  return id === 4663 || id === 46630;
}

export function classifyFinding(code, detail = null) {
  const normalized = String(code || "").trim();
  return {
    code: normalized,
    authority: NON_OVERRIDABLE_CODES.has(normalized)
      ? FINDING_AUTHORITY.NON_OVERRIDABLE
      : FINDING_AUTHORITY.REVIEWABLE,
    ...(detail ? { detail } : {}),
  };
}

export function classifyScan({ reasons = [], warnings = [] } = {}) {
  const findings = [...new Set(reasons)].map((code) => classifyFinding(code));
  const hardFindings = findings.filter((finding) => finding.authority === FINDING_AUTHORITY.NON_OVERRIDABLE);
  const reviewableFindings = findings.filter((finding) => finding.authority === FINDING_AUTHORITY.REVIEWABLE);
  const reviewWarnings = new Set([
    "owner_present",
    "mint_authority_present",
    "freeze_authority_present",
    "no_topaz_pool",
    "no_uniswap_pool",
    "transfer_fee",
    "permanent_delegate",
    // A probe that did not run or did not produce a trustworthy trade result is
    // uncertainty, never evidence that an external EVM token is safe.
    "topaz_env_missing",
    "getPool_failed",
    "topaz_buy_quote_failed",
    "uniswap_env_missing",
    "uniswap_getPool_failed",
    "uniswap_buy_quote_failed",
    "no_pancake_pool",
    "pancake_getPool_failed",
    "pancakeswap_buy_quote_failed",
    // A V4 pool was listed but its key could not be proven from the PositionManager.
    "v4_pool_key_unknown",
    // The simulated buy reverted: sellability could not be shown, a reviewer decides.
    "buy_simulation_failed",
    // The sell quote could not be read (RPC error, not a revert): unknown, a reviewer decides.
    "sell_quote_unavailable",
    "supply_unreadable",
    "zero_supply",
  ]);
  if (hardFindings.length) {
    return { status: IMPORT_SCAN_STATUS.HARD_FAILURE, findings, hardFindings, reviewableFindings };
  }
  if (reviewableFindings.length || warnings.some((warning) => reviewWarnings.has(warning))) {
    return { status: IMPORT_SCAN_STATUS.NEEDS_REVIEW, findings, hardFindings, reviewableFindings };
  }
  return { status: IMPORT_SCAN_STATUS.PASSED, findings, hardFindings, reviewableFindings };
}

function finalizeScan({ name = null, symbol = null, scan = {}, scannedAt = new Date().toISOString() }) {
  const warnings = Array.isArray(scan.warnings) ? scan.warnings : [];
  const reasons = Array.isArray(scan.reasons) ? scan.reasons : [];
  const classification = classifyScan({ reasons, warnings });
  return {
    status: classification.status,
    name,
    symbol,
    scanVersion: ARENA_IMPORT_SCAN_VERSION,
    scannedAt,
    scan: {
      ...scan,
      ok: classification.status === IMPORT_SCAN_STATUS.PASSED,
      warnings,
      reasons,
      findings: classification.findings,
      hardFindings: classification.hardFindings,
      reviewableFindings: classification.reviewableFindings,
      scanVersion: ARENA_IMPORT_SCAN_VERSION,
      scannedAt,
    },
  };
}

async function probeOwner(contract) {
  for (const method of ["owner", "getOwner"]) {
    try {
      const owner = await contract[method]();
      if (owner && owner !== ZERO) return owner;
    } catch {
      // optional
    }
  }
  return null;
}

async function probeTopaz(provider, chainId, token) {
  const addrs = topazAddresses(chainId);
  if (!ethers.isAddress(addrs.factory) || !ethers.isAddress(addrs.wbnb) || !ethers.isAddress(addrs.router)) {
    return { pair: null, buyQuoteOk: false, sellQuoteOk: false, skipped: "topaz_env_missing" };
  }
  const factory = new ethers.Contract(addrs.factory, FACTORY_ABI, provider);
  let pair = ZERO;
  try {
    pair = await factory.getPool(token, addrs.wbnb, false);
  } catch {
    return { pair: null, buyQuoteOk: false, sellQuoteOk: false, skipped: "getPool_failed" };
  }
  if (!pair || pair === ZERO) return { pair: null, buyQuoteOk: false, sellQuoteOk: false };
  const router = new ethers.Contract(addrs.router, ROUTER_ABI, provider);
  const buyRoute = [{ from: addrs.wbnb, to: token, stable: false, factory: addrs.factory }];
  const sellRoute = [{ from: token, to: addrs.wbnb, stable: false, factory: addrs.factory }];
  const last = (amounts) => amounts?.[amounts.length - 1];
  const buyQuoteOk = quoteOk(await quoteOrUnknown(async () => last(await router.getAmountsOut(ethers.parseEther("0.01"), buyRoute))));
  const sellQuoteOk = quoteOk(await quoteOrUnknown(async () => last(await router.getAmountsOut(10n ** 15n, sellRoute))));
  return { pair, buyQuoteOk, sellQuoteOk, factory: addrs.factory, router: addrs.router, wbnb: addrs.wbnb };
}

/**
 * The deepest wrapped-native pool of the token on a Uniswap-V3-style DEX (by the pool's
 * wrapped-native balance), then a buy and a sell quote through its QuoterV2. Same evidence as
 * probeTopaz: a pool that quotes a buy but not a sell is the honeypot signal; a missing pool or a
 * failed lookup is uncertainty for review.
 */
export async function probeV3Pool(provider, token, addrs, deps = {}) {
  if (!ethers.isAddress(addrs?.factory) || !ethers.isAddress(addrs?.quoter) || !ethers.isAddress(addrs?.weth)) {
    return { pair: null, buyQuoteOk: false, sellQuoteOk: false, skipped: "env_missing" };
  }
  const makeContract = deps.contract || ((address, abi) => new ethers.Contract(address, abi, provider));
  const factory = makeContract(addrs.factory, V3_FACTORY_ABI);
  const weth = makeContract(addrs.weth, BALANCE_ABI);
  let best = null;
  try {
    for (const fee of addrs.fees) {
      const pool = await factory.getPool(token, addrs.weth, fee);
      if (!pool || pool === ZERO) continue;
      const depth = BigInt(await weth.balanceOf(pool));
      if (!best || depth > best.depth) best = { pool: String(pool), fee, depth };
    }
  } catch {
    return { pair: null, buyQuoteOk: false, sellQuoteOk: false, skipped: "getPool_failed" };
  }
  if (!best || best.depth < (addrs.minDepth ?? MIN_POOL_NATIVE)) return { pair: null, buyQuoteOk: false, sellQuoteOk: false };
  const quoter = makeContract(addrs.quoter, V3_QUOTER_ABI);
  const quote = (tokenIn, tokenOut, amountIn) => quoteOrUnknown(async () => {
    const [amountOut] = await quoter.quoteExactInputSingle.staticCall({ tokenIn, tokenOut, amountIn, fee: best.fee, sqrtPriceLimitX96: 0n });
    return amountOut;
  });
  const bought = await quote(addrs.weth, token, PROBE_AMOUNT_IN);
  // Sell back what the buy would have returned, so the sell is sized to the pool like a real round trip.
  const sold = await quote(token, addrs.weth, bought > 0n ? bought : 10n ** 15n);
  const simulation = bought > 0n && ethers.isAddress(addrs.router)
    ? await (deps.simulate || simulateRoundTrip)(provider, {
      kind: PROBE_KIND.V3, pool: best.pool, router: addrs.router, weth: addrs.weth, token, amountIn: PROBE_AMOUNT_IN, v3Fee: best.fee,
    })
    : null;
  return {
    pair: best.pool,
    fee: best.fee,
    buyQuoteOk: quoteOk(bought),
    sellQuoteOk: quoteOk(sold),
    simulation,
    factory: addrs.factory,
    quoter: addrs.quoter,
    weth: addrs.weth,
  };
}

/** Uniswap-V2-style pair (PancakeSwap V2): getPair, then router buy and sell quotes, same rules. */
export async function probeV2Pool(provider, token, addrs, deps = {}) {
  const makeContract = deps.contract || ((address, abi) => new ethers.Contract(address, abi, provider));
  let pair = ZERO;
  try {
    pair = await makeContract(addrs.factory, V2_FACTORY_ABI).getPair(token, addrs.weth);
  } catch {
    return { pair: null, buyQuoteOk: false, sellQuoteOk: false, skipped: "getPool_failed" };
  }
  if (!pair || pair === ZERO) return { pair: null, buyQuoteOk: false, sellQuoteOk: false };
  try {
    const depth = BigInt(await makeContract(addrs.weth, BALANCE_ABI).balanceOf(pair));
    if (depth < (addrs.minDepth ?? MIN_POOL_NATIVE)) return { pair: null, buyQuoteOk: false, sellQuoteOk: false };
  } catch {
    return { pair: null, buyQuoteOk: false, sellQuoteOk: false, skipped: "getPool_failed" };
  }
  const router = makeContract(addrs.router, V2_ROUTER_ABI);
  const quote = (path, amountIn) => quoteOrUnknown(async () => {
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts?.[amounts.length - 1];
  });
  const bought = await quote([addrs.weth, token], PROBE_AMOUNT_IN);
  const sold = await quote([token, addrs.weth], bought > 0n ? bought : 10n ** 15n);
  const simulation = bought > 0n
    ? await (deps.simulate || simulateRoundTrip)(provider, {
      kind: PROBE_KIND.V2, pool: String(pair), router: addrs.router, weth: addrs.weth, token, amountIn: PROBE_AMOUNT_IN, v2FeeBps: addrs.feeBps,
    })
    : null;
  return { pair: String(pair), buyQuoteOk: quoteOk(bought), sellQuoteOk: quoteOk(sold), simulation, factory: addrs.factory, router: addrs.router, weth: addrs.weth };
}

/**
 * What the simulated round trip adds to the scan. A sell that fails through the public router, or
 * a tax above the threshold, is a reviewable finding, not a hard decline: a same-block sell also
 * trips legitimate anti-bot cooldowns, and a hard decline is never rescanned. A simulation that
 * could not run is recorded and changes nothing (the quote evidence stands).
 */
export const SWAP_TAX_REVIEW_BPS = 1000;
export const ROUND_TRIP_LOSS_REVIEW_BPS = 2500;

export function simulationFindings(simulation) {
  const reasons = [];
  const warnings = [];
  if (!simulation) return { reasons, warnings };
  if (!simulation.ran) warnings.push("swap_simulation_unavailable");
  else if (!simulation.buyOk) warnings.push("buy_simulation_failed");
  else if (!simulation.sellOk) reasons.push("sell_simulation_failed");
  else if (
    (simulation.buyTaxBps ?? 0) > SWAP_TAX_REVIEW_BPS
    || (simulation.sellTaxBps ?? 0) > SWAP_TAX_REVIEW_BPS
    || (simulation.roundTripLossBps ?? 0) > ROUND_TRIP_LOSS_REVIEW_BPS
  ) {
    reasons.push("swap_tax_high");
  }
  return { reasons, warnings };
}

/**
 * Uniswap V4 (founder 2026-10-12: our gen-8 coins and Pons coins trade there, so V4 is a normal venue, not a review
 * case). Verified in the gen-8 design (docs/evm-launch/EVM_GEN8_V4_DESIGN.md 2.1, fork-proven on both chains); the
 * UniversalRouter entries are the layout-v2.1 routers gen-8 pins (frontend/shared/evmGen8Swap.mjs).
 */
const UNISWAP_V4 = {
  4663: {
    poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    positionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
    quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
    router: "0x8876789976decbfcbbbe364623c63652db8c0904",
  },
  56: {
    poolManager: "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df",
    positionManager: "0x7a4a5c919ae2541aed11041a1aeee68f1287f95b",
    quoter: "0x9f75dd27d6664c475b90e105573e550ff69437b0",
    router: "0xDc264714F68d84CF29BC605589405E78bDBE7C9f",
  },
};
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const POSITION_MANAGER_ABI = ["function poolKeys(bytes25) view returns (address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)"];
const V4_QUOTER_ABI = [
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)",
];
const ERC20_DECIMALS_ABI = ["function decimals() view returns (uint8)"];
// What one probe trade is worth when the pool is quoted in a token (stock token, PONS, USDG) instead of the native coin.
const V4_PROBE_USD = 3;

/**
 * The token's V4 pools: DexScreener (Robinhood V4 is indexed there), else GeckoTerminal (indexes V4 on both chains;
 * DexScreener has no V4 on BSC). Each candidate: { poolId, liquidityUsd, quoteUsd }, deepest first.
 */
export async function findV4Pools(chainId, token, fetchImpl = fetch) {
  const out = [];
  const slug = dexScreenerChainSlug(chainId);
  if (slug) {
    const pairs = await fetchDexScreenerPairs(slug, [token], fetchImpl).catch(() => []);
    for (const pair of pairs) {
      const id = String(pair?.pairAddress || "");
      const v4 = (pair?.labels || []).some((label) => String(label).toLowerCase() === "v4");
      if (!v4 || !/^0x[0-9a-fA-F]{64}$/.test(id)) continue;
      if (String(pair?.baseToken?.address || "").toLowerCase() !== String(token).toLowerCase()) continue;
      const priceUsd = Number(pair?.priceUsd);
      const priceNative = Number(pair?.priceNative); // the coin's price in quote units
      out.push({ poolId: id.toLowerCase(), liquidityUsd: Number(pair?.liquidity?.usd) || 0, quoteUsd: priceUsd > 0 && priceNative > 0 ? priceUsd / priceNative : null });
    }
  }
  const network = geckoTerminalNetwork(chainId);
  if (!out.length && network) {
    const url = `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${encodeURIComponent(token)}/pools?page=1`;
    const get = () => fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    let res = await get();
    // The free tier allows ~30 calls a minute; one retry keeps a busy minute from reading as "no V4 pool".
    if (res?.status === 429) res = await new Promise((resolve) => setTimeout(resolve, 2_000)).then(get);
    const json = res?.ok ? await res.json().catch(() => null) : null;
    for (const pool of json?.data || []) {
      const dex = String(pool?.relationships?.dex?.data?.id || "");
      const id = String(pool?.attributes?.address || "");
      if (!dex.includes("v4") || !/^0x[0-9a-fA-F]{64}$/.test(id)) continue;
      const base = String(pool?.relationships?.base_token?.data?.id || "");
      const coinIsBase = base.toLowerCase().endsWith(String(token).toLowerCase());
      const quoteUsd = Number(coinIsBase ? pool?.attributes?.quote_token_price_usd : pool?.attributes?.base_token_price_usd);
      out.push({ poolId: id.toLowerCase(), liquidityUsd: Number(pool?.attributes?.reserve_in_usd) || 0, quoteUsd: quoteUsd > 0 ? quoteUsd : null });
    }
  }
  return out.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
}

/**
 * The deepest V4 pool whose key the PositionManager knows (checked against the pool id), quoted with V4Quoter and
 * round-tripped through the UniversalRouter. A coin in the pool against the native coin trades 0.001 native; against
 * a token, about $3 of that token.
 */
export async function probeV4Pool(provider, chainId, token, deps = {}) {
  const addrs = deps.addresses || UNISWAP_V4[Number(chainId)];
  if (!addrs) return { pair: null, buyQuoteOk: false, sellQuoteOk: false, skipped: "env_missing" };
  const makeContract = deps.contract || ((address, abi) => new ethers.Contract(address, abi, provider));
  const candidates = await (deps.findPools || findV4Pools)(chainId, token);
  if (!candidates.length) return { pair: null, buyQuoteOk: false, sellQuoteOk: false };
  const positions = makeContract(addrs.positionManager, POSITION_MANAGER_ABI);
  let chosen = null;
  for (const candidate of candidates.slice(0, 3)) {
    try {
      const k = await positions.poolKeys(candidate.poolId.slice(0, 52));
      const key = { currency0: String(k[0]), currency1: String(k[1]), fee: Number(k[2]), tickSpacing: Number(k[3]), hooks: String(k[4]) };
      const id = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24", "int24", "address"], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
      const lowerToken = String(token).toLowerCase();
      if (id.toLowerCase() !== candidate.poolId) continue; // PositionManager never saw this pool
      if (key.currency0.toLowerCase() !== lowerToken && key.currency1.toLowerCase() !== lowerToken) continue;
      chosen = { ...candidate, key, coinIs0: key.currency0.toLowerCase() === lowerToken };
      break;
    } catch {
      // next candidate
    }
  }
  if (!chosen) return { pair: null, buyQuoteOk: false, sellQuoteOk: false, skipped: "v4_pool_key_unknown" };
  const quote = chosen.coinIs0 ? chosen.key.currency1 : chosen.key.currency0;
  let quoteIn = PROBE_AMOUNT_IN;
  if (quote !== ZERO) {
    const decimals = Number(await makeContract(quote, ERC20_DECIMALS_ABI).decimals().catch(() => 18));
    // Without a price, one whole quote token (a stock share or a PONS) is the trade size.
    quoteIn = chosen.quoteUsd ? ethers.parseUnits((V4_PROBE_USD / chosen.quoteUsd).toFixed(Math.min(decimals, 12)), decimals) : 10n ** BigInt(decimals);
  }
  const quoter = makeContract(addrs.quoter, V4_QUOTER_ABI);
  const keyTuple = [chosen.key.currency0, chosen.key.currency1, chosen.key.fee, chosen.key.tickSpacing, chosen.key.hooks];
  const quoteV4 = (zeroForOne, amount) => quoteOrUnknown(async () => {
    const [out] = await quoter.quoteExactInputSingle.staticCall([keyTuple, zeroForOne, amount, "0x"]);
    return out;
  });
  const bought = await quoteV4(!chosen.coinIs0, quoteIn);
  const sold = await quoteV4(chosen.coinIs0, bought > 0n ? bought : 10n ** 15n);
  const simulation = bought > 0n
    ? await (deps.simulateV4 || simulateRoundTripV4)(provider, {
      router: addrs.router, permit2: PERMIT2, poolManager: addrs.poolManager, key: chosen.key, coinIs0: chosen.coinIs0, quoteIn,
    })
    : null;
  return {
    pair: chosen.poolId,
    fee: chosen.key.fee,
    hooks: chosen.key.hooks,
    quoteToken: quote === ZERO ? "native" : quote,
    buyQuoteOk: quoteOk(bought),
    sellQuoteOk: quoteOk(sold),
    simulation,
  };
}

/** Robinhood: Uniswap V3, else Uniswap V4. Probe skips are prefixed so the review reasons name the venue. */
async function probeRobinhood(provider, chainId, token) {
  const pool = await probeV3Pool(provider, token, uniswapV3Addresses(chainId));
  if (pool.pair) return { ...pool, venue: "uniswap_v3" };
  const v4 = await probeV4Pool(provider, chainId, token);
  if (v4.pair) return { ...v4, venue: "uniswap_v4" };
  if (v4.skipped === "v4_pool_key_unknown") return { ...v4, venue: "uniswap_v4" };
  return {
    ...pool,
    venue: "uniswap_v3",
    ...(pool.skipped ? { skipped: `uniswap_${pool.skipped}` } : {}),
    ...(!pool.skipped && !pool.pair ? { missing: "no_uniswap_pool" } : {}),
  };
}

/**
 * BNB: the Topaz probe exactly as before. Only when Topaz has no pool (or cannot be checked) does
 * BSC mainnet fall through to PancakeSwap V3, then V2; the first venue with a pool decides. With no
 * pool anywhere the Topaz warning stays and no_pancake_pool is added, both for review.
 */
async function probeBnb(provider, chainId, token) {
  const topaz = await probeTopaz(provider, chainId, token);
  if (topaz.pair || Number(chainId) !== 56) return topaz;
  const topazWarning = topaz.skipped || "no_topaz_pool";
  const v3 = await probeV3Pool(provider, token, PANCAKE_BSC.v3);
  if (v3.pair) return { ...v3, venue: "pancakeswap_v3" };
  const v2 = await probeV2Pool(provider, token, PANCAKE_BSC.v2);
  if (v2.pair) return { ...v2, venue: "pancakeswap_v2" };
  const v4 = await probeV4Pool(provider, chainId, token);
  if (v4.pair) return { ...v4, venue: "uniswap_v4" };
  const pancakeWarning = v3.skipped || v2.skipped ? "pancake_getPool_failed" : "no_pancake_pool";
  return { pair: null, buyQuoteOk: false, sellQuoteOk: false, warnings: [topazWarning, pancakeWarning] };
}

export async function scanEvm(chainId, token) {
  const warnings = [];
  const reasons = [];
  if (importScannerChainFamily(chainId) !== "evm") {
    return finalizeScan({ scan: { reasons: ["unsupported_chain"], warnings } });
  }
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl(chainId), Number(chainId));
    const code = await provider.getCode(token);
    if (!code || code === "0x") {
      return finalizeScan({ scan: { reasons: ["not_a_contract"], warnings } });
    }
    const contract = new ethers.Contract(token, ERC20_ABI, provider);
    let name = null;
    let symbol = null;
    let decimals = null;
    let totalSupply = null;
    try { name = String(await contract.name()); } catch { warnings.push("name_unreadable"); }
    try { symbol = String(await contract.symbol()); } catch { warnings.push("symbol_unreadable"); }
    try { decimals = Number(await contract.decimals()); } catch { warnings.push("decimals_unreadable"); }
    try { totalSupply = (await contract.totalSupply()).toString(); } catch { warnings.push("supply_unreadable"); }
    const owner = await probeOwner(contract);
    if (owner) warnings.push("owner_present");
    try {
      if (await contract.paused()) {
        reasons.push("paused");
        warnings.push("paused");
      }
    } catch {
      // no paused()
    }
    if (!symbol && !name) reasons.push("erc20_metadata_unreadable");
    if (totalSupply === "0") warnings.push("zero_supply");
    if (warnings.includes("decimals_unreadable")) reasons.push("decimals_unreadable");

    const pool = isRobinhoodChain(chainId) ? await probeRobinhood(provider, chainId, token) : await probeBnb(provider, chainId, token);
    if (pool.warnings) warnings.push(...pool.warnings);
    else if (pool.skipped) warnings.push(pool.skipped);
    else if (!pool.pair) warnings.push(pool.missing || "no_topaz_pool");
    else {
      pool.pair = String(pool.pair);
      // Hard decline only on evidence: the buy quoted, the sell quote reverted, and no simulated router sell went
      // through (a sold round trip proves the sell, whatever the quoter said).
      const soldInSimulation = Boolean(pool.simulation?.ran && pool.simulation.sellOk);
      if (pool.buyQuoteOk === true && pool.sellQuoteOk === false && !soldInSimulation) reasons.push("honeypot_sell_failed");
      if (pool.buyQuoteOk !== true) warnings.push(pool.venue ? `${pool.venue.split("_")[0]}_buy_quote_failed` : "topaz_buy_quote_failed");
      if (pool.sellQuoteOk === null && !soldInSimulation) warnings.push("sell_quote_unavailable");
      const simulated = simulationFindings(pool.simulation);
      reasons.push(...simulated.reasons);
      warnings.push(...simulated.warnings);
    }

    return finalizeScan({
      name,
      symbol,
      scan: {
        decimals,
        totalSupply,
        owner,
        pool: pool.pair || null,
        ...(pool.venue ? { venue: pool.venue, poolFee: pool.fee ?? null } : {}),
        ...(pool.hooks ? { hooks: pool.hooks, quoteToken: pool.quoteToken } : {}),
        ...(pool.simulation ? { swapSimulation: pool.simulation } : {}),
        buyQuoteOk: Boolean(pool.buyQuoteOk),
        sellQuoteOk: Boolean(pool.sellQuoteOk),
        warnings,
        reasons,
      },
    });
  } catch (error) {
    return finalizeScan({ scan: { reasons: ["rpc_failed"], warnings, detail: String(error?.message || error) } });
  }
}

export async function scanSolana(chainId, token) {
  if (importScannerChainFamily(chainId) !== "solana") {
    return finalizeScan({ scan: { reasons: ["unsupported_chain"], warnings: [] } });
  }
  try {
    const connection = new Connection(rpcUrl(chainId), "confirmed");
    const pubkey = new PublicKey(token);
    const parsed = await connection.getParsedAccountInfo(pubkey);
    const data = parsed?.value?.data;
    const info = data && typeof data === "object" && "parsed" in data ? data.parsed?.info || {} : null;
    if (!info) return finalizeScan({ scan: { reasons: ["not_a_mint"], warnings: [] } });

    const warnings = [];
    const reasons = [];
    const mintAuthority = info.mintAuthority ? String(info.mintAuthority) : null;
    const freezeAuthority = info.freezeAuthority ? String(info.freezeAuthority) : null;
    if (mintAuthority) warnings.push("mint_authority_present");
    if (freezeAuthority) warnings.push("freeze_authority_present");
    const extensions = Array.isArray(info.extensions) ? info.extensions : [];
    for (const ext of extensions) {
      const extType = String(ext?.extension || ext?.type || "").toLowerCase();
      if (extType.includes("transferfee")) {
        warnings.push("transfer_fee");
        const bps = Number(ext?.state?.newerTransferFee?.transferFeeBasisPoints ?? ext?.state?.transferFeeBasisPoints ?? 0);
        if (bps > 1000) reasons.push("transfer_tax_too_high");
      }
      if (extType.includes("nontransferable") || extType.includes("defaultaccountstate")) reasons.push("non_transferable");
      if (extType.includes("permanentdelegate")) warnings.push("permanent_delegate");
    }
    const supply = info.supply != null ? String(info.supply) : null;
    const decimals = info.decimals != null ? Number(info.decimals) : null;
    if (decimals == null) reasons.push("mint_decimals_unreadable");

    // External Arena imports are not required to have graduated through MemeWarzone
    // or to have a Meteora graduation pool. Pool provenance is intentionally not an
    // eligibility finding; genuine mint/token safety findings above remain authoritative.
    return finalizeScan({
      scan: {
        decimals,
        totalSupply: supply,
        mintAuthority,
        freezeAuthority,
        warnings,
        reasons,
        poolProvenance: "external_not_required",
      },
    });
  } catch (error) {
    return finalizeScan({ scan: { reasons: ["solana_rpc_failed"], warnings: [], detail: String(error?.message || error) } });
  }
}