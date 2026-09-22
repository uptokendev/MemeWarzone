/**
 * Automated verification of Quote Asset Catalog candidates.
 *
 * A human should not type CoinGecko ids, router addresses and oracle feeds
 * into an approval form; that is where typos become wrong graduations. This
 * module asks the chain and the market-data sources instead:
 *
 *   identity        contract / mint exists, symbol and decimals match the catalog,
 *                   Solana token program (Token-2022 allowed, but only within
 *                   the extension allowlist graduation enforces)
 *   price           stablecoin -> fixed $1 with a deviation check; native -> the
 *                   chain coin; otherwise CoinGecko by contract address
 *   route           BNB: a volatile Topaz WBNB/quote pool with reserves and a
 *                   Chainlink <SYMBOL>/USD feed (the adapter needs both);
 *                   Solana mainnet: a Jupiter quote for a graduation-sized swap
 *                   within the impact limit; Solana devnet: the certified Orca
 *                   route from an earlier policy; Robinhood: the generic quote
 *                   route is not deployed, so non-native assets stay pending
 *   liquidity/volume floors from the change order (Community V1 floors)
 *
 * The result is a snapshot with the gates it attested, the metrics it saw,
 * the policy values it proposes and the flags a human must look at. Assets
 * that pass every gate and come from a known provider class are activated
 * without a human; anything flagged waits for manual review. Everything the
 * verifier does is written to quote_asset_scan_history.
 */
import { ethers } from "ethers";
import { pool } from "../../server/db.js";
import { getRpcUrls } from "./getServerReadProvider.js";
import { decideQuoteCatalogDeployment, getQuoteCatalogAdminDetail } from "./quoteAssetCatalogAdmin.js";

export const VERIFIER_ACTOR = "system:quote-verifier";

const SOLANA_NATIVE_MINT = "So11111111111111111111111111111111111111112";
const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const JUPITER_V6_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

const COINGECKO_PLATFORMS = Object.freeze({ "56": "binance-smart-chain", "101": "solana" });
const NATIVE_COINGECKO_IDS = Object.freeze({ "56": "binancecoin", "97": "binancecoin", "101": "solana", "4663": "ethereum", "46630": "ethereum" });
const CHAINLINK_DIRECTORY_FILES = Object.freeze({ "56": "feeds-bsc-mainnet.json", "97": "feeds-bsc-testnet.json" });
const TESTNET_CHAIN_IDS = new Set(["97", "46630"]);
const BNB_CHAIN_IDS = new Set(["56", "97"]);
const ROBINHOOD_CHAIN_IDS = new Set(["4663", "46630"]);
/** Provider classes whose assets are activated automatically when every gate passes. */
const AUTO_ACTIVATE_PROVIDER_CLASSES = new Set(["BASIC", "STABLECOIN", "ECOSYSTEM", "PROVIDER_RWA"]);

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Floors from docs/build_plans/multiselectpairtoken.md section 11, overridable per deployment env. */
export function verificationThresholds(env = process.env) {
  return {
    minMarketCapUsd: num(env.QUOTE_VERIFY_MIN_MARKET_CAP_USD, 100_000),
    minLiquidityUsd: num(env.QUOTE_VERIFY_MIN_LIQUIDITY_USD, 50_000),
    minVolume24hUsd: num(env.QUOTE_VERIFY_MIN_VOLUME_24H_USD, 100_000),
    maxImpactBps: num(env.QUOTE_VERIFY_MAX_IMPACT_BPS, 200),
    maxDeviationBps: num(env.QUOTE_VERIFY_MAX_DEVIATION_BPS, 200),
    routeAmountUsd: num(env.QUOTE_VERIFY_ROUTE_AMOUNT_USD, 25_000),
  };
}

function isTestnet(item) {
  return TESTNET_CHAIN_IDS.has(String(item.chainId)) || item.solanaCluster === "devnet";
}

function isNative(item) {
  return item.identityKind === "NATIVE" || String(item.nativeWrappedStatus || "").toUpperCase() === "WRAPPED_NATIVE" || String(item.assetClass || "").toUpperCase() === "NATIVE";
}

function isStable(item) {
  return String(item.assetClass || "").toUpperCase() === "STABLECOIN";
}

function bpsBetween(a, b) {
  if (!(a > 0) || !(b > 0)) return null;
  return Math.round((Math.abs(a - b) / b) * 10_000);
}

/* ------------------------------------------------------------------ sources */

async function fetchJson(url, { headers = {}, timeoutMs = 15_000, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { headers: { accept: "application/json", ...headers }, signal: controller.signal });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} ${url}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
];
const ROUTER_ABI = ["function defaultFactory() view returns (address)", "function factory() view returns (address)", "function weth() view returns (address)"];
const FACTORY_ABI = ["function getPool(address,address,bool) view returns (address)", "function getPair(address,address,bool) view returns (address)"];
const POOL_ABI = ["function token0() view returns (address)", "function getReserves() view returns (uint256,uint256,uint256)"];

async function evmProvider(chainId) {
  const urls = getRpcUrls(chainId);
  let lastError = null;
  for (const url of urls) {
    try {
      const provider = new ethers.JsonRpcProvider(url, Number(chainId), { staticNetwork: true });
      await provider.getBlockNumber();
      return provider;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`No RPC answered for chain ${chainId}: ${String(lastError?.message || lastError || "none configured")}`);
}

async function evmTokenSource(item) {
  const provider = await evmProvider(item.chainId);
  const address = item.contractAddressOrMint;
  const code = await provider.getCode(address);
  if (!code || code === "0x") return { exists: false };
  const token = new ethers.Contract(address, ERC20_ABI, provider);
  const [symbol, name, decimals, totalSupply] = await Promise.all([
    token.symbol().catch(() => null),
    token.name().catch(() => null),
    token.decimals().catch(() => null),
    token.totalSupply().catch(() => null),
  ]);
  return {
    exists: true,
    codeBytes: (code.length - 2) / 2,
    symbol: symbol == null ? null : String(symbol),
    name: name == null ? null : String(name),
    decimals: decimals == null ? null : Number(decimals),
    totalSupply: totalSupply == null ? null : totalSupply.toString(),
  };
}

function solanaRpcUrlFor(item, env = process.env) {
  const runtime = String(env.SOLANA_CLUSTER || "").trim().toLowerCase();
  if (item.solanaCluster === "devnet") {
    return String(env.SOLANA_DEVNET_RPC_URL || (runtime === "devnet" ? env.SOLANA_RPC_URL : "") || "https://api.devnet.solana.com").trim();
  }
  return String(env.SOLANA_MAINNET_RPC_URL || (runtime !== "devnet" ? env.SOLANA_RPC_URL : "") || "https://api.mainnet-beta.solana.com").trim();
}

async function solanaRpc(url, method, params, fetchImpl = fetch) {
  const response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await response.json();
  if (body?.error) throw new Error(body.error.message || `Solana RPC ${method} failed`);
  return body?.result;
}

/**
 * Token-2022 extension discriminants, and the set the graduation program will
 * hold as a quote asset.
 *
 * This mirrors `quote_extension_allowed` in programs/memewarzone_solana/src/
 * graduation.rs. It is an allowlist in both places for the same reason: the
 * extension set grows with every Token-2022 release, and an unknown extension
 * must fail rather than be waved through. The two lists must agree -- a mint
 * activated here that the program refuses would fail at graduation, after the
 * campaign has already closed.
 */
const TOKEN_2022_EXTENSION_NAMES = Object.freeze({
  0: "Uninitialized", 1: "TransferFeeConfig", 2: "TransferFeeAmount", 3: "MintCloseAuthority",
  4: "ConfidentialTransferMint", 5: "ConfidentialTransferAccount", 6: "DefaultAccountState",
  7: "ImmutableOwner", 8: "MemoTransfer", 9: "NonTransferable", 10: "InterestBearingConfig",
  11: "CpiGuard", 12: "PermanentDelegate", 13: "NonTransferableAccount", 14: "TransferHook",
  15: "TransferHookAccount", 16: "ConfidentialTransferFeeConfig", 17: "ConfidentialTransferFeeAmount",
  18: "MetadataPointer", 19: "TokenMetadata", 20: "GroupPointer", 21: "TokenGroup",
  22: "GroupMemberPointer", 23: "TokenGroupMember",
});
const TOKEN_2022_MINT_EXTENSIONS_ALLOWED = Object.freeze(new Set([0, 18, 19, 20, 21, 22, 23]));

/**
 * A Token-2022 mint is the classic 82-byte layout, a one-byte account type at
 * offset 165, then TLV entries of [u16 type, u16 length, value].
 */
export function token2022MintExtensions(data) {
  if (!data || data.length <= 166) return [];
  const types = [];
  let offset = 166;
  while (offset + 4 <= data.length) {
    const type = data.readUInt16LE(offset);
    const length = data.readUInt16LE(offset + 2);
    if (type === 0 && length === 0) break;
    types.push(type);
    offset += 4 + length;
  }
  return types;
}

export function disallowedToken2022Extensions(data) {
  return token2022MintExtensions(data)
    .filter((type) => !TOKEN_2022_MINT_EXTENSIONS_ALLOWED.has(type))
    .map((type) => TOKEN_2022_EXTENSION_NAMES[type] || `Unknown(${type})`);
}

/** Reads a TLV entry's value bytes, or null when the extension is absent. */
function token2022ExtensionValue(data, wanted) {
  if (!data || data.length <= 166) return null;
  let offset = 166;
  while (offset + 4 <= data.length) {
    const type = data.readUInt16LE(offset);
    const length = data.readUInt16LE(offset + 2);
    if (type === 0 && length === 0) return null;
    if (type === wanted) return data.subarray(offset + 4, offset + 4 + length);
    offset += 4 + length;
  }
  return null;
}

const isZero = (bytes) => !bytes || bytes.every((byte) => byte === 0);

/**
 * What a creator is actually taking on by binding to this quote.
 *
 * Graduation no longer refuses these -- which asset a campaign graduates
 * against is the creator's decision -- so this exists to put the consequence in
 * front of them before they commit, and it reports what each extension is
 * actually configured to. An extension present with a null authority is a
 * different risk from one that is armed, and the xStocks arm several.
 *
 * The liquidity this binds is locked permanently and these are checked once, at
 * graduation, so an authority that is armed later cannot be caught: `armed`
 * describes today, not the life of the pool.
 */
export function token2022BindingRisks(data) {
  if (!data || data.length <= 166) return [];
  const risks = [];
  const add = (code, armed, title, detail) => risks.push({ code, armed, severity: armed ? "high" : "info", title, detail });

  const delegate = token2022ExtensionValue(data, 12);
  if (delegate) {
    add("PERMANENT_DELEGATE", !isZero(delegate.subarray(0, 32)),
      "The issuer can move this token out of the pool",
      "A permanent delegate lets the issuer transfer this token from any account, including the liquidity pool your graduation locks permanently.");
  }
  const hook = token2022ExtensionValue(data, 14);
  if (hook) {
    add("TRANSFER_HOOK", !isZero(hook.subarray(32, 64)),
      "Transfers can run the issuer's own code",
      "A transfer hook runs a third-party program on every transfer. No hook program is set today if this shows as not armed, but the issuer can set one later and the pool stays locked.");
  }
  const pausable = token2022ExtensionValue(data, 26);
  if (pausable) {
    add("PAUSABLE", !isZero(pausable.subarray(0, 32)),
      "The issuer can halt all transfers",
      "A pausable mint can be frozen globally by its authority, which would stop trading in your pool until it is unpaused.");
  }
  const fee = token2022ExtensionValue(data, 1);
  if (fee) {
    add("TRANSFER_FEE", true,
      "Every transfer is taxed by the issuer",
      "A transfer fee means the amount that arrives is less than the amount sent, including the residual swept back after graduation.");
  }
  const defaultState = token2022ExtensionValue(data, 6);
  if (defaultState) {
    add("DEFAULT_ACCOUNT_STATE", defaultState[0] === 2,
      "New accounts may start frozen",
      "This mint sets a default state for new token accounts. When that default is frozen, accounts cannot transact until the issuer unfreezes them.");
  }
  const scaled = token2022ExtensionValue(data, 25);
  if (scaled) {
    add("SCALED_UI_AMOUNT", !isZero(scaled.subarray(0, 32)),
      "The issuer can re-denominate the displayed balance",
      "A scaled UI amount changes how balances are displayed, for example on a stock split. Raw amounts and pool maths are unaffected, but quoted prices shift.");
  }
  if (token2022ExtensionValue(data, 4)) {
    add("CONFIDENTIAL_TRANSFER", false,
      "The mint supports confidential balances",
      "Confidential transfers hide balances for accounts that opt in. The pool's own accounts do not opt in, so this does not affect your liquidity.");
  }
  return risks;
}

async function solanaMintSource(item, { fetchImpl = fetch } = {}) {
  if (item.identityKind === "NATIVE") return { exists: true, native: true, decimals: 9, tokenProgram: "native" };
  const url = solanaRpcUrlFor(item);
  const result = await solanaRpc(url, "getAccountInfo", [item.contractAddressOrMint, { encoding: "base64", commitment: "confirmed" }], fetchImpl);
  const encoded = result?.value?.data?.[0];
  if (!encoded) return { exists: false };
  const data = Buffer.from(String(encoded), "base64");
  const owner = String(result.value.owner || "");
  const tokenProgram = owner === SPL_TOKEN_PROGRAM ? "spl-token" : owner === TOKEN_2022_PROGRAM ? "token-2022" : "unknown";
  if (data.length < 82) return { exists: true, tokenProgram, malformed: true };
  const mintAuthorityPresent = data.readUInt32LE(0) === 1;
  const supply = data.readBigUInt64LE(36).toString();
  const decimals = data.readUInt8(44);
  const initialized = data.readUInt8(45) === 1;
  const freezeAuthorityPresent = data.readUInt32LE(46) === 1;
  const disallowedExtensions = tokenProgram === "token-2022" ? disallowedToken2022Extensions(data) : [];
  const bindingRisks = tokenProgram === "token-2022" ? token2022BindingRisks(data) : [];
  // A freeze authority is not Token-2022-specific -- USDC has one too -- but a
  // creator binding away from SOL should still be told the issuer can freeze
  // the pool's account.
  if (freezeAuthorityPresent) {
    bindingRisks.push({
      code: "FREEZE_AUTHORITY", armed: true, severity: "medium",
      title: "The issuer can freeze accounts holding this token",
      detail: "A freeze authority can freeze any account, including your pool's. Most regulated stablecoins including USDC have one.",
    });
  }
  return { exists: true, tokenProgram, decimals, supply, initialized, mintAuthorityPresent, freezeAuthorityPresent, disallowedExtensions, bindingRisks };
}

function coinGeckoHeaders(env = process.env) {
  const key = String(env.COINGECKO_API_KEY || "").trim();
  return key ? { "x-cg-demo-api-key": key } : {};
}

function marketFromCoinGecko(body) {
  const market = body?.market_data || {};
  return {
    id: body?.id || null,
    symbol: body?.symbol ? String(body.symbol).toUpperCase() : null,
    priceUsd: num(market.current_price?.usd, null),
    volume24hUsd: num(market.total_volume?.usd, null),
    marketCapUsd: num(market.market_cap?.usd, null),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** CoinGecko's public tier allows a handful of calls per minute: back off on 429 rather than failing the check. */
async function coinGeckoFetch(url, { fetchImpl = fetch, attempts = 3 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fetchJson(url, { headers: coinGeckoHeaders(), fetchImpl });
    } catch (error) {
      lastError = error;
      if (error?.status === 429 || (error?.status >= 500 && error?.status < 600)) {
        await sleep(12_000 * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

const coinGeckoIdCache = new Map();
const COINGECKO_CACHE_MS = 5 * 60_000;

async function coinGeckoByContract(chainId, address, { fetchImpl = fetch } = {}) {
  const platform = COINGECKO_PLATFORMS[String(chainId)];
  if (!platform) return null;
  try {
    const body = await coinGeckoFetch(`https://api.coingecko.com/api/v3/coins/${platform}/contract/${encodeURIComponent(address)}`, { fetchImpl });
    return marketFromCoinGecko(body);
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

async function coinGeckoById(id, { fetchImpl = fetch } = {}) {
  const cached = coinGeckoIdCache.get(id);
  if (cached && Date.now() - cached.at < COINGECKO_CACHE_MS) return cached.value;
  const body = await coinGeckoFetch(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}?localization=false&tickers=false&community_data=false&developer_data=false`, { fetchImpl });
  const value = marketFromCoinGecko(body);
  coinGeckoIdCache.set(id, { value, at: Date.now() });
  return value;
}

/** Feed names use the underlying asset: wrapped and pegged symbols map onto it. */
const CHAINLINK_SYMBOL_ALIASES = Object.freeze({ WBNB: "BNB", WETH: "ETH", BTCB: "BTC", WBTC: "BTC", "BTCB.B": "BTC" });

const chainlinkDirectoryCache = new Map();
async function chainlinkFeed(chainId, symbol, { fetchImpl = fetch } = {}) {
  const file = CHAINLINK_DIRECTORY_FILES[String(chainId)];
  if (!file) return null;
  const base = String(process.env.CHAINLINK_FEEDS_DIRECTORY_BASE || "https://reference-data-directory.vercel.app").replace(/\/+$/, "");
  const url = `${base}/${file}`;
  let feeds = chainlinkDirectoryCache.get(url);
  if (!feeds) {
    feeds = await fetchJson(url, { fetchImpl, timeoutMs: 20_000 });
    chainlinkDirectoryCache.set(url, feeds);
  }
  const upper = String(symbol || "").toUpperCase();
  const wanted = `${CHAINLINK_SYMBOL_ALIASES[upper] || upper} / USD`;
  const matches = (Array.isArray(feeds) ? feeds : []).filter((feed) => String(feed?.name || "").toUpperCase() === wanted && feed?.proxyAddress);
  if (!matches.length) return null;
  const rank = (feed) => ({ low: 0, medium: 1, high: 2 }[String(feed.feedCategory || "").toLowerCase()] ?? 3);
  matches.sort((a, b) => rank(a) - rank(b) || Number(b.decimals || 0) - Number(a.decimals || 0));
  const feed = matches[0];
  return { name: feed.name, proxyAddress: feed.proxyAddress, decimals: Number(feed.decimals || 0), category: feed.feedCategory || null };
}

async function topazRouteSource(item, { db = pool } = {}) {
  const chainId = String(item.chainId);
  const env = process.env;
  let router = String(env[`TOPAZ_ROUTER_ADDRESS_${chainId}`] || env[`VITE_TOPAZ_PRODUCTION_ROUTER_ADDRESS_${chainId}`] || env[`VITE_TOPAZ_ROUTER_ADDRESS_${chainId}`] || "").trim();
  let factory = String(env[`TOPAZ_FACTORY_ADDRESS_${chainId}`] || env[`VITE_TOPAZ_FACTORY_ADDRESS_${chainId}`] || "").trim();
  let wrapped = String(env[`WRAPPED_NATIVE_ADDRESS_${chainId}`] || env[`VITE_WRAPPED_NATIVE_ADDRESS_${chainId}`] || env[`VITE_TOPAZ_WBNB_ADDRESS_${chainId}`] || "").trim();
  if (!router || !factory || !wrapped) {
    const indexed = await db.query(
      `select router_address, factory_address, wrapped_native_address, count(*)::int as pools
         from public.dex_pools where chain_id = $1 group by 1, 2, 3 order by pools desc limit 1`,
      [Number(chainId)],
    ).catch(() => ({ rows: [] }));
    const row = indexed.rows[0];
    router ||= String(row?.router_address || "");
    factory ||= String(row?.factory_address || "");
    wrapped ||= String(row?.wrapped_native_address || "");
  }
  if (!router && !factory) return { configured: false };
  const provider = await evmProvider(chainId);
  if (!factory && router) {
    const r = new ethers.Contract(router, ROUTER_ABI, provider);
    factory = await r.defaultFactory().catch(() => r.factory().catch(() => ""));
  }
  if (!wrapped && router) {
    wrapped = await new ethers.Contract(router, ROUTER_ABI, provider).weth().catch(() => "");
  }
  if (!factory || !wrapped) return { configured: false, router, factory, wrapped };
  const quote = item.contractAddressOrMint;
  const f = new ethers.Contract(factory, FACTORY_ABI, provider);
  let poolAddress = ethers.ZeroAddress;
  try { poolAddress = await f.getPool(wrapped, quote, false); } catch { try { poolAddress = await f.getPair(wrapped, quote, false); } catch { poolAddress = ethers.ZeroAddress; } }
  if (!poolAddress || poolAddress === ethers.ZeroAddress) return { configured: true, router, factory, wrapped, pool: null };
  const p = new ethers.Contract(poolAddress, POOL_ABI, provider);
  const [token0, reserves] = await Promise.all([p.token0(), p.getReserves()]);
  const wrappedIsToken0 = String(token0).toLowerCase() === wrapped.toLowerCase();
  return {
    configured: true,
    router,
    factory,
    wrapped,
    pool: poolAddress,
    wrappedReserveRaw: (wrappedIsToken0 ? reserves[0] : reserves[1]).toString(),
    quoteReserveRaw: (wrappedIsToken0 ? reserves[1] : reserves[0]).toString(),
  };
}

async function jupiterRouteSource(item, amountLamports, { fetchImpl = fetch } = {}) {
  const base = String(process.env.SOLANA_GRADUATION_JUPITER_API_BASE || "https://lite-api.jup.ag/swap/v1").replace(/\/$/, "");
  const url = `${base}/quote?inputMint=${SOLANA_NATIVE_MINT}&outputMint=${encodeURIComponent(item.contractAddressOrMint)}&amount=${amountLamports}&slippageBps=50&onlyDirectRoutes=false`;
  try {
    const body = await fetchJson(url, { fetchImpl });
    return {
      available: Boolean(body?.outAmount),
      outAmount: body?.outAmount ? String(body.outAmount) : null,
      priceImpactBps: body?.priceImpactPct != null ? Math.round(Number(body.priceImpactPct) * 10_000) : null,
      hops: Array.isArray(body?.routePlan) ? body.routePlan.length : null,
    };
  } catch (error) {
    return { available: false, error: String(error?.message || error).slice(0, 160) };
  }
}

/* ------------------------------------------------------------------ evaluate (pure) */

/**
 * Turn gathered facts into gates, metrics, a policy proposal and flags.
 * Pure: every network fact is in `facts`, so this is fully testable.
 */
export function evaluateVerification(item, facts, thresholds = verificationThresholds()) {
  const chainId = String(item.chainId);
  const family = item.chainFamily || (chainId === "101" ? "SOLANA" : "EVM");
  const flags = [];
  const gates = { identity: "PENDING", transferability: "PENDING", security: "PENDING", route: "PENDING", price: "PENDING", lp: "PENDING" };
  const metrics = {};
  const proposal = {};
  const native = isNative(item);
  const stable = isStable(item);
  const testnet = isTestnet(item);
  const providerClass = String(item.provider?.providerClass || "").toUpperCase();
  const community = String(item.assetClass || "").toUpperCase() === "COMMUNITY" || providerClass === "COMMUNITY";
  const flag = (code, message, blocking = true) => flags.push({ code, message, blocking });

  // identity
  const token = facts.token || {};
  if (item.identityKind === "NATIVE") {
    gates.identity = "VERIFIED";
  } else if (!token.exists) {
    gates.identity = "REJECTED";
    flag("IDENTITY_MISSING", `No ${family === "SOLANA" ? "mint" : "contract"} at ${item.contractAddressOrMint} on chain ${chainId}.`);
  } else {
    let ok = true;
    if (token.decimals != null && item.decimals != null && Number(token.decimals) !== Number(item.decimals)) {
      ok = false;
      flag("DECIMALS_MISMATCH", `On-chain decimals ${token.decimals} differ from catalog ${item.decimals}.`);
    }
    if (family === "EVM" && token.symbol && String(token.symbol).toUpperCase() !== String(item.symbol || "").toUpperCase()) {
      flag("SYMBOL_MISMATCH", `On-chain symbol ${token.symbol} differs from catalog ${item.symbol}.`, false);
    }
    if (family === "SOLANA" && token.tokenProgram === "token-2022") {
      // Graduation accepts these; the creator chooses the binding. Surface what
      // they are taking on instead of refusing on their behalf -- a refusal
      // here would remove the asset from the list rather than explain it.
      const disallowed = token.disallowedExtensions || [];
      if (disallowed.length) {
        flag("TOKEN_2022_ISSUER_POWERS", `Token-2022 mint carries ${disallowed.join(", ")}; the creator is warned before binding.`, false);
      }
    } else if (family === "SOLANA" && token.tokenProgram === "unknown") {
      ok = false;
      flag("NOT_A_TOKEN_MINT", "Account is not owned by the SPL Token program.");
    }
    gates.identity = ok ? "VERIFIED" : "REJECTED";
    metrics.onChain = { symbol: token.symbol ?? null, name: token.name ?? null, decimals: token.decimals ?? null, supply: token.totalSupply ?? token.supply ?? null, tokenProgram: token.tokenProgram ?? null };
    // Rendered in the confirmation the creator sees when they bind to anything
    // other than the chain's native asset.
    metrics.bindingRisks = token.bindingRisks || [];
  }

  // transferability + security: attested for known provider classes; community tokens need a human
  if (gates.identity === "VERIFIED") {
    if (community) {
      gates.transferability = "PENDING";
      gates.security = "PENDING";
      flag("COMMUNITY_MANUAL_REVIEW", "Community token: transferability and security need manual review (mint/freeze authority, taxes, hooks).", true);
    } else {
      gates.transferability = "VERIFIED";
      gates.security = "VERIFIED";
    }
    if (family === "SOLANA" && token.mintAuthorityPresent && !native && !stable && !community) {
      flag("MINT_AUTHORITY_PRESENT", "Mint authority is still set on this mint.", false);
    }
  } else {
    gates.transferability = "PENDING";
    gates.security = "PENDING";
  }

  // price
  const market = facts.market || null;
  const nativeMarket = facts.nativeMarket || null;
  if (native) {
    gates.price = "VERIFIED";
    if (NATIVE_COINGECKO_IDS[chainId]) proposal.coinGeckoId = NATIVE_COINGECKO_IDS[chainId];
    if (nativeMarket?.priceUsd) metrics.priceUsd = nativeMarket.priceUsd;
  } else if (stable) {
    gates.price = "VERIFIED";
    proposal.referenceUsdMicros = 1_000_000;
    if (market?.id) proposal.coinGeckoId = market.id;
    if (market?.priceUsd) {
      metrics.priceUsd = market.priceUsd;
      const deviation = bpsBetween(market.priceUsd, 1);
      metrics.pegDeviationBps = deviation;
      if (deviation != null && deviation > thresholds.maxDeviationBps) {
        gates.price = "STALE";
        flag("STABLE_DEPEG", `Stablecoin trades ${deviation} bps away from $1 (limit ${thresholds.maxDeviationBps}).`);
      }
    } else if (!testnet && facts.sources?.coingecko === "error") {
      flag("PRICE_SOURCE_UNAVAILABLE", "The market-data source did not answer (rate limit or outage); the $1 reference stands, verify again to record the peg.", false);
    } else if (!testnet) {
      flag("NO_MARKET_DATA", "No CoinGecko listing for this stablecoin; fixed $1 reference proposed.", false);
    }
  } else if (market?.id && market.priceUsd) {
    gates.price = "VERIFIED";
    proposal.coinGeckoId = market.id;
    metrics.priceUsd = market.priceUsd;
  } else if (testnet) {
    gates.price = "UNAVAILABLE";
    flag("TESTNET_NO_PRICE", "Test-network asset without a market price source; only stablecoins and natives can be priced here.");
  } else if (facts.sources?.coingecko === "error") {
    gates.price = "PENDING";
    flag("PRICE_SOURCE_UNAVAILABLE", "The market-data source did not answer (rate limit or outage); verify again later.");
  } else {
    gates.price = "UNAVAILABLE";
    flag("NO_PRICE_SOURCE", "No CoinGecko listing for this contract; no authoritative USD reference.");
  }
  if (market) {
    metrics.volume24hUsd = market.volume24hUsd ?? null;
    metrics.marketCapUsd = market.marketCapUsd ?? null;
  }

  // route + lp venue + oracle
  if (family === "SOLANA") {
    proposal.acquisitionAdapter = native ? "NATIVE" : item.solanaCluster === "devnet" ? "ORCA_WHIRLPOOL_DEVNET" : "JUPITER";
    proposal.acquisitionProgram = native ? SYSTEM_PROGRAM : item.solanaCluster === "devnet" ? (facts.existingPolicy?.acquisitionProgram || null) : JUPITER_V6_PROGRAM;
    // Meteora DAMM v2 takes a Token-2022 mint on either side of a pool -- its
    // SDK takes tokenAProgram and tokenBProgram separately -- so an accepted
    // Token-2022 quote has an LP venue like any other.
    if (gates.identity === "VERIFIED") {
      gates.lp = "VERIFIED";
      metrics.lpVenue = "meteora-damm-v2";
    }
    if (native) {
      gates.route = "VERIFIED";
    } else if (item.solanaCluster === "devnet") {
      const orca = facts.existingPolicy?.orcaPool || null;
      if (orca) {
        gates.route = "VERIFIED";
        proposal.orcaPool = orca;
        proposal.adapterConfig = { ...(facts.existingPolicy?.adapterConfig || {}) };
      } else {
        gates.route = "UNAVAILABLE";
        flag("DEVNET_ROUTE_MISSING", "No certified Orca devnet route for this mint; run the devnet certification and approve manually.");
      }
    } else {
      const route = facts.jupiterRoute || null;
      if (route?.available) {
        metrics.routeImpactBps = route.priceImpactBps;
        metrics.routeHops = route.hops;
        if (route.priceImpactBps != null && route.priceImpactBps > thresholds.maxImpactBps) {
          gates.route = "UNAVAILABLE";
          flag("ROUTE_IMPACT_TOO_HIGH", `Graduation-sized swap moves the price ${route.priceImpactBps} bps (limit ${thresholds.maxImpactBps}).`);
        } else {
          gates.route = "VERIFIED";
        }
      } else if (route?.error || facts.sources?.jupiter === "error") {
        gates.route = "PENDING";
        flag("ROUTE_SOURCE_UNAVAILABLE", `Jupiter did not answer${route?.error ? ` (${route.error})` : ""}; verify again later.`);
      } else {
        gates.route = "UNAVAILABLE";
        flag("NO_JUPITER_ROUTE", "Jupiter has no route from SOL for a graduation-sized swap.");
      }
    }
  } else if (BNB_CHAIN_IDS.has(chainId)) {
    gates.lp = gates.identity === "VERIFIED" ? "VERIFIED" : "PENDING";
    metrics.lpVenue = "topaz";
    if (native && item.identityKind === "NATIVE") {
      gates.route = "VERIFIED";
    } else {
      const topaz = facts.topaz || null;
      const feed = facts.chainlinkFeed || null;
      if (topaz?.router) proposal.routerAddress = topaz.router;
      if (feed?.proxyAddress) {
        proposal.oracleFeedAddress = feed.proxyAddress;
        metrics.oracleFeed = feed.name;
      }
      if (native) {
        // Wrapped native: the pool is the native side itself; only the native/USD feed matters.
        gates.route = "VERIFIED";
        if (!feed?.proxyAddress) flag("ORACLE_FEED_MISSING", "No Chainlink feed for the native coin in the directory.", false);
      } else if (!topaz?.configured) {
        gates.route = "PENDING";
        flag("TOPAZ_NOT_CONFIGURED", "No Topaz router/factory known for this chain (env or indexed pools).");
      } else if (!topaz.pool) {
        gates.route = "UNAVAILABLE";
        flag("TOPAZ_POOL_MISSING", `No volatile Topaz WBNB/${item.symbol} pool exists yet; create it before approving.`);
      } else {
        proposal.adapterConfig = { acquisitionPool: topaz.pool, wrappedNative: topaz.wrapped };
        const quoteReserve = Number(topaz.quoteReserveRaw || 0) / 10 ** Number(item.decimals ?? 18);
        const wrappedReserve = Number(topaz.wrappedReserveRaw || 0) / 1e18;
        const priceUsd = metrics.priceUsd ?? (stable ? 1 : null);
        const nativeUsd = nativeMarket?.priceUsd ?? null;
        const liquidityUsd = priceUsd != null && nativeUsd != null ? quoteReserve * priceUsd + wrappedReserve * nativeUsd : priceUsd != null ? quoteReserve * priceUsd * 2 : null;
        metrics.topazPool = topaz.pool;
        metrics.liquidityUsd = liquidityUsd;
        if (!feed?.proxyAddress) {
          gates.route = "PENDING";
          flag("ORACLE_FEED_MISSING", `No Chainlink ${item.symbol}/USD feed on this chain; the BNB quote adapter requires one.`);
        } else if (liquidityUsd != null && liquidityUsd < thresholds.minLiquidityUsd && !testnet) {
          gates.route = "UNAVAILABLE";
          flag("LOW_LIQUIDITY", `Topaz pool holds about $${Math.round(liquidityUsd).toLocaleString("en-US")} (floor $${thresholds.minLiquidityUsd.toLocaleString("en-US")}).`);
        } else {
          gates.route = "VERIFIED";
        }
      }
    }
  } else if (ROBINHOOD_CHAIN_IDS.has(chainId)) {
    if (native) {
      gates.route = "VERIFIED";
      gates.lp = "VERIFIED";
    } else {
      gates.route = "PENDING";
      gates.lp = "PENDING";
      flag("ROBINHOOD_GENERIC_ROUTE_NOT_DEPLOYED", "The Robinhood generic quote adapter is not deployed; only native ETH and registry stock tokens can graduate for now.");
    }
  }

  // market floors (natives and stables are exempt; testnets have no market data)
  if (!native && !stable && !testnet && gates.identity === "VERIFIED") {
    if (metrics.volume24hUsd != null && metrics.volume24hUsd < thresholds.minVolume24hUsd) {
      flag("LOW_VOLUME", `24h volume $${Math.round(metrics.volume24hUsd).toLocaleString("en-US")} is under the floor of $${thresholds.minVolume24hUsd.toLocaleString("en-US")}.`);
    }
    if (metrics.marketCapUsd != null && metrics.marketCapUsd > 0 && metrics.marketCapUsd < thresholds.minMarketCapUsd) {
      flag("LOW_MARKET_CAP", `Market cap $${Math.round(metrics.marketCapUsd).toLocaleString("en-US")} is under the floor of $${thresholds.minMarketCapUsd.toLocaleString("en-US")}.`);
    }
  }

  proposal.maxSlippageBps = native ? 0 : 100;
  proposal.maxImpactBps = native ? 0 : 100;
  proposal.maxDeviationBps = native ? 0 : 100;

  // A wrapped native (WBNB, WETH) is the chain's native default under another
  // name; listing both would show creators two identical markets. It verifies
  // but is never activated on its own.
  const wrappedNative = native && item.identityKind !== "NATIVE";
  if (wrappedNative) flag("WRAPPED_NATIVE_DUPLICATE", "Wrapped native duplicates the native default; activate only if you want it listed separately.", false);

  const allVerified = Object.values(gates).every((value) => value === "VERIFIED");
  const blocking = flags.some((entry) => entry.blocking);
  const state = gates.identity === "REJECTED" ? "failed" : allVerified && !blocking ? "passed" : "review";
  const autoActivate = state === "passed" && !community && !wrappedNative && AUTO_ACTIVATE_PROVIDER_CLASSES.has(providerClass) && String(item.provider?.authorityMode || "GENERIC_POLICY") === "GENERIC_POLICY";
  return { state, gates, metrics, proposal, flags, autoActivate };
}

/* ------------------------------------------------------------------ gather + record */

/** Collect every fact the evaluation needs. Network errors become flags, never crashes. */
export async function gatherVerificationFacts(item, { fetchImpl = fetch, db = pool } = {}) {
  const facts = { sources: {}, errors: [] };
  const chainId = String(item.chainId);
  const family = item.chainFamily || (chainId === "101" ? "SOLANA" : "EVM");
  const attempt = async (name, fn) => {
    try {
      const value = await fn();
      facts.sources[name] = "ok";
      return value;
    } catch (error) {
      facts.sources[name] = "error";
      facts.errors.push({ source: name, message: String(error?.message || error).slice(0, 200) });
      return null;
    }
  };

  facts.token = family === "SOLANA"
    ? await attempt("solana-rpc", () => solanaMintSource(item, { fetchImpl }))
    : item.identityKind === "NATIVE" ? { exists: true, native: true } : await attempt("evm-rpc", () => evmTokenSource(item));

  const nativeId = NATIVE_COINGECKO_IDS[chainId];
  if (nativeId) facts.nativeMarket = await attempt("coingecko-native", () => coinGeckoById(nativeId, { fetchImpl }));
  if (!isNative(item) && !isTestnet(item)) {
    facts.market = await attempt("coingecko", () => coinGeckoByContract(chainId, item.contractAddressOrMint, { fetchImpl }));
  }

  if (family === "SOLANA") {
    facts.existingPolicy = item.policy?.config?.solanaGraduation
      ? { orcaPool: item.policy.config.solanaGraduation.orcaPool || null, acquisitionProgram: item.policy.config.solanaGraduation.acquisitionProgram || null, adapterConfig: Object.fromEntries(Object.entries(item.policy.config.solanaGraduation).filter(([key]) => ["inputMint", "outputMint", "orcaTickSpacing", "orcaWhirlpoolsConfig", "certificationOnly"].includes(key))) }
      : null;
    if (!isNative(item) && item.solanaCluster !== "devnet") {
      const solUsd = facts.nativeMarket?.priceUsd || 0;
      const lamports = solUsd > 0 ? Math.round((verificationThresholds().routeAmountUsd / solUsd) * 1e9) : 100 * 1e9;
      facts.jupiterRoute = await attempt("jupiter", () => jupiterRouteSource(item, lamports, { fetchImpl }));
    }
  } else if (BNB_CHAIN_IDS.has(chainId)) {
    if (item.identityKind !== "NATIVE") {
      facts.topaz = await attempt("topaz", () => topazRouteSource(item, { db }));
      facts.chainlinkFeed = await attempt("chainlink-directory", () => chainlinkFeed(chainId, item.symbol, { fetchImpl }));
    }
  }
  return facts;
}

function catalogStateFor(current, result) {
  if (["ACTIVE", "SUSPENDED", "REJECTED"].includes(current)) return current;
  if (result.state === "failed") return "CANDIDATE";
  if (result.gates.route !== "VERIFIED") return "ROUTE_PENDING";
  if (result.gates.price !== "VERIFIED") return "PRICE_PENDING";
  if (result.gates.lp !== "VERIFIED") return "LP_PENDING";
  return "IDENTITY_VERIFIED";
}

function legacyStatus(gate, healthy = "verified") {
  if (gate === "VERIFIED") return healthy;
  if (gate === "REJECTED") return "rejected";
  return "review";
}

/**
 * Verify one deployment, persist the snapshot and history, and activate it
 * when the result allows. Returns the refreshed admin detail.
 */
export async function verifyQuoteCatalogDeployment(id, { autoActivate = true, actorIdentity = VERIFIER_ACTOR, db = pool, fetchImpl = fetch } = {}) {
  const detail = await getQuoteCatalogAdminDetail(id, { db });
  if (!detail) return null;
  const item = detail.item;
  const facts = await gatherVerificationFacts(item, { fetchImpl, db });
  const result = evaluateVerification(item, facts);
  const snapshot = {
    state: result.state,
    checkedAt: new Date().toISOString(),
    gates: result.gates,
    metrics: result.metrics,
    proposal: result.proposal,
    flags: result.flags,
    sources: facts.sources,
    errors: facts.errors,
    autoActivate: result.autoActivate && autoActivate,
  };
  const nextState = catalogStateFor(item.catalogState, result);
  const marketHealthy = result.state === "passed" ? "healthy" : result.state === "failed" ? "unhealthy" : "review";
  const updated = await db.query(
    `update public.quote_asset_deployments
        set verification = $2::jsonb, verified_at = now(),
            identity_status = $3, security_status = $4, market_health_status = $5,
            canonical_status = case when $3 = 'verified' and (canonical_status is null or canonical_status in ('', 'CANDIDATE', 'NONE')) then 'IDENTITY_VERIFIED' else canonical_status end,
            transferability_status = $6, acquisition_route_status = $7, price_authority_status = $8, lp_venue_status = $9,
            catalog_state = $10, last_scan_at = now(),
            last_identity_verified_at = case when $3 = 'verified' then now() else last_identity_verified_at end,
            last_route_verified_at = case when $7 = 'VERIFIED' then now() else last_route_verified_at end,
            last_price_verified_at = case when $8 = 'VERIFIED' then now() else last_price_verified_at end,
            last_lp_verified_at = case when $9 = 'VERIFIED' then now() else last_lp_verified_at end,
            state_version = state_version + 1, updated_at = now()
      where id = $1::uuid
      returning state_version, provider_id`,
    [
      id,
      JSON.stringify(snapshot),
      legacyStatus(result.gates.identity),
      legacyStatus(result.gates.security),
      marketHealthy,
      result.gates.transferability,
      result.gates.route,
      result.gates.price,
      result.gates.lp,
      nextState,
    ],
  );
  const row = updated.rows[0];
  await db.query(
    `insert into public.quote_asset_scan_history (deployment_id, provider_id, state_version, scan_kind, identity_status, security_status, market_health_status, evidence, scanner_identity)
     values ($1::uuid, $2, $3, 'automated_verification', $4, $5, $6, $7::jsonb, $8)`,
    [id, row.provider_id, Number(row.state_version), legacyStatus(result.gates.identity), legacyStatus(result.gates.security), marketHealthy, JSON.stringify(snapshot), actorIdentity],
  );

  if (snapshot.autoActivate && item.catalogState !== "ACTIVE") {
    const { adapterConfig, ...policyOverrides } = result.proposal;
    return decideQuoteCatalogDeployment({
      id,
      action: "approve",
      expectedVersion: Number(row.state_version),
      reason: `Automated verification passed every gate (${Object.keys(facts.sources).join(", ")}); activated by the verifier.`,
      policyOverrides: { ...policyOverrides, adapterConfig },
      evidence: [`verification:${snapshot.checkedAt}`],
      actorIdentity,
      db,
    });
  }
  return getQuoteCatalogAdminDetail(id, { db });
}

/** Verify every deployment on a chain, paced for the public market-data rate limits. */
export async function verifyQuoteCatalogChain({ chain, ids = null, autoActivate = true, pauseMs = 3_000, db = pool, fetchImpl = fetch, log = () => {} } = {}) {
  const { listQuoteCatalogAdmin } = await import("./quoteAssetCatalogAdmin.js");
  const listed = await listQuoteCatalogAdmin({ chain, db });
  const wanted = ids ? new Set(ids.map(String)) : null;
  const items = listed.items.filter((item) => !wanted || wanted.has(String(item.id)));
  const summary = { chain: listed.chain.key, checked: 0, passed: 0, review: 0, failed: 0, activated: 0, results: [] };
  for (const item of items) {
    try {
      const detail = await verifyQuoteCatalogDeployment(item.id, { autoActivate, db, fetchImpl });
      const verification = detail?.item?.verification || {};
      summary.checked += 1;
      summary[verification.state === "passed" ? "passed" : verification.state === "failed" ? "failed" : "review"] += 1;
      if (detail?.item?.catalogState === "ACTIVE" && item.catalogState !== "ACTIVE") summary.activated += 1;
      summary.results.push({ id: item.id, symbol: item.symbol, state: verification.state, catalogState: detail?.item?.catalogState, flags: (verification.flags || []).map((entry) => entry.code) });
      log(`${item.symbol}: ${verification.state} -> ${detail?.item?.catalogState}${verification.flags?.length ? ` [${verification.flags.map((entry) => entry.code).join(", ")}]` : ""}`);
    } catch (error) {
      summary.checked += 1;
      summary.failed += 1;
      summary.results.push({ id: item.id, symbol: item.symbol, state: "error", error: String(error?.message || error).slice(0, 200) });
      log(`${item.symbol}: error ${String(error?.message || error).slice(0, 120)}`);
    }
    if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  return summary;
}
