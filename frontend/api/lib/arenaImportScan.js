import { ethers } from "ethers";
import { Connection, PublicKey } from "@solana/web3.js";

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

const ZERO = ethers.ZeroAddress;

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
    return env("ROBINHOOD_MAINNET_RPC_URL", "ROBINHOOD_RPC_URL", "VITE_PUBLIC_RPC_4663") || "https://rpc.mainnet.chain.robinhood.com";
  }
  if (id === 46630) {
    return env("ROBINHOOD_TESTNET_RPC_URL", "VITE_PUBLIC_RPC_46630");
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
  },
};

function uniswapV3Addresses(chainId) {
  const id = Number(chainId);
  const fallback = ROBINHOOD_V3_DEFAULTS[id] || {};
  return {
    factory: env(`ROBINHOOD_V3_FACTORY_ADDRESS_${id}`, `VITE_ROBINHOOD_V3_FACTORY_ADDRESS_${id}`) || fallback.factory || "",
    quoter: env(`ROBINHOOD_V3_QUOTER_ADDRESS_${id}`, `VITE_ROBINHOOD_V3_QUOTER_ADDRESS_${id}`) || fallback.quoter || "",
    weth: env(`ROBINHOOD_WETH_ADDRESS_${id}`, `VITE_ROBINHOOD_WETH_ADDRESS_${id}`) || fallback.weth || "",
    fees: [100, 500, 3000, 10000],
  };
}

/**
 * BNB memecoins trade on PancakeSwap, not Topaz (four.meme graduates to Pancake). BSC mainnet
 * only; verified on chain 2026-10-11: QuoterV2.factory() = the V3 factory, Router.factory() = the
 * V2 factory, both report WBNB (same factories as projectImportBnbMarket.js).
 */
const PANCAKE_BSC = {
  v3: {
    factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
    quoter: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997",
    weth: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    fees: [100, 500, 2500, 10000],
  },
  v2: {
    factory: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
    router: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
    weth: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
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
  let buyQuoteOk = false;
  let sellQuoteOk = false;
  try {
    const amounts = await router.getAmountsOut(ethers.parseEther("0.01"), buyRoute);
    buyQuoteOk = BigInt(amounts?.[amounts.length - 1] ?? 0) > 0n;
  } catch {
    buyQuoteOk = false;
  }
  try {
    const amounts = await router.getAmountsOut(10n ** 15n, sellRoute);
    sellQuoteOk = BigInt(amounts?.[amounts.length - 1] ?? 0) > 0n;
  } catch {
    sellQuoteOk = false;
  }
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
  if (!best) return { pair: null, buyQuoteOk: false, sellQuoteOk: false };
  const quoter = makeContract(addrs.quoter, V3_QUOTER_ABI);
  const quote = async (tokenIn, tokenOut, amountIn) => {
    try {
      const [amountOut] = await quoter.quoteExactInputSingle.staticCall({ tokenIn, tokenOut, amountIn, fee: best.fee, sqrtPriceLimitX96: 0n });
      return BigInt(amountOut ?? 0);
    } catch {
      return 0n;
    }
  };
  const bought = await quote(addrs.weth, token, ethers.parseEther("0.001"));
  // Sell back what the buy would have returned, so the sell is sized to the pool like a real round trip.
  const sold = await quote(token, addrs.weth, bought > 0n ? bought : 10n ** 15n);
  return {
    pair: best.pool,
    fee: best.fee,
    buyQuoteOk: bought > 0n,
    sellQuoteOk: sold > 0n,
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
  const router = makeContract(addrs.router, V2_ROUTER_ABI);
  const quote = async (path, amountIn) => {
    try {
      const amounts = await router.getAmountsOut(amountIn, path);
      return BigInt(amounts?.[amounts.length - 1] ?? 0);
    } catch {
      return 0n;
    }
  };
  const bought = await quote([addrs.weth, token], ethers.parseEther("0.001"));
  const sold = await quote([token, addrs.weth], bought > 0n ? bought : 10n ** 15n);
  return { pair: String(pair), buyQuoteOk: bought > 0n, sellQuoteOk: sold > 0n, factory: addrs.factory, router: addrs.router, weth: addrs.weth };
}

/** Robinhood: Uniswap V3. Probe skips are prefixed so the review reasons name the venue. */
async function probeRobinhood(provider, chainId, token) {
  const pool = await probeV3Pool(provider, token, uniswapV3Addresses(chainId));
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
      if (pool.buyQuoteOk && !pool.sellQuoteOk) reasons.push("honeypot_sell_failed");
      if (!pool.buyQuoteOk) warnings.push(pool.venue ? `${pool.venue.split("_")[0]}_buy_quote_failed` : "topaz_buy_quote_failed");
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