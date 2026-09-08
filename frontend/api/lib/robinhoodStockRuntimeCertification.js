import { ethers } from "ethers";
import { findManifestAsset } from "./approvedQuoteCatalog.js";

export const ROBINHOOD_STOCK_PROVIDER = "robinhood-stock-token";
export const ROBINHOOD_STOCK_PROVIDER_AUTHORITY = "ROBINHOOD_CANONICAL";
export const ROBINHOOD_MAINNET_CHAIN_ID = 4663;

const BPS = 10_000n;
const WAD = 10n ** 18n;

const FACTORY_ABI = [
  "function stockGraduationAdapter() view returns (address)",
  "function stockCampaignImplementation() view returns (address)",
  "function permanentLpLocker() view returns (address)",
];
const ADAPTER_ABI = [
  "function v3Factory() view returns (address)",
  "function positionManager() view returns (address)",
  "function swapRouter() view returns (address)",
  "function WETH() view returns (address)",
  "function permanentPositionLocker() view returns (address)",
  "function nativeUsdOracle() view returns (address)",
  "function feeTier() view returns (uint24)",
  "function maxOracleAgeSeconds() view returns (uint32)",
  "function campaignFactory() view returns (address)",
  "function campaignFactoryLocked() view returns (bool)",
  "function stockRoutes(address stockToken) view returns (address oracleFeed,address acquisitionPool,uint24 acquisitionFeeTier,uint256 minimumRouteLiquidityUsdWad,uint16 maxSwapSlippageBps,uint16 maxOracleDeviationBps,uint16 maxPriceImpactBps,bool enabled)",
];
const V3_FACTORY_ABI = [
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)",
  "function feeAmountTickSpacing(uint24 fee) view returns (int24)",
];
const ROUTER_ABI = [
  "function quoteExactInputSingle(address tokenIn,address tokenOut,uint24 fee,uint256 amountIn) view returns (uint256 amountOut)",
];
const ORACLE_ABI = [
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
];
const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
];
const LOCKER_ABI = [
  "function authorizedIntegrationSource(address) view returns (bool)",
  "function v3Factory() view returns (address)",
  "function positionManager() view returns (address)",
  "function wrappedNative() view returns (address)",
  "function configuredFeeTier() view returns (uint24)",
];

export function normalizeRuntimeAddress(value) {
  const raw = String(value || "").trim();
  if (!ethers.isAddress(raw) || raw === ethers.ZeroAddress) return "";
  return ethers.getAddress(raw);
}

function sameAddress(a, b) {
  const left = normalizeRuntimeAddress(a);
  const right = normalizeRuntimeAddress(b);
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

async function requireCode(provider, address, label) {
  const normalized = normalizeRuntimeAddress(address);
  if (!normalized) throw new Error(`${label} is not configured`);
  const code = await provider.getCode(normalized);
  if (!code || code === "0x") throw new Error(`${label} has no deployed bytecode`);
  return normalized;
}

function pow10(decimals) {
  const digits = Number(decimals);
  if (!Number.isInteger(digits) || digits < 0 || digits > 36) throw new Error("token/oracle decimals invalid");
  return 10n ** BigInt(digits);
}

function normalizeOraclePriceWad(answer, decimals) {
  const value = BigInt(answer);
  const digits = Number(decimals);
  if (value <= 0n) throw new Error("oracle returned non-positive price");
  if (digits === 18) return value;
  if (digits < 18) return value * pow10(18 - digits);
  return value / pow10(digits - 18);
}

async function readFreshOracle(provider, address, label, maxAgeSeconds, nowSeconds) {
  const normalized = await requireCode(provider, address, label);
  const oracle = new ethers.Contract(normalized, ORACLE_ABI, provider);
  const [latest, decimals] = await Promise.all([oracle.latestRoundData(), oracle.decimals()]);
  const roundId = BigInt(latest.roundId ?? latest[0] ?? 0);
  const answer = BigInt(latest.answer ?? latest[1] ?? 0);
  const updatedAt = Number(latest.updatedAt ?? latest[3] ?? 0);
  const answeredInRound = BigInt(latest.answeredInRound ?? latest[4] ?? 0);
  if (roundId === 0n || answer <= 0n || updatedAt <= 0 || answeredInRound < roundId) throw new Error(`${label} is unhealthy`);
  const ageSeconds = nowSeconds - updatedAt;
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0 || ageSeconds > maxAgeSeconds) throw new Error(`${label} is stale (${ageSeconds}s)`);
  return { address: normalized, priceWad: normalizeOraclePriceWad(answer, Number(decimals)), updatedAt, ageSeconds, decimals: Number(decimals) };
}

function priceImpactBps(amountIn, amountOut, probeIn, probeOut) {
  if (amountIn <= 0n || amountOut <= 0n || probeIn <= 0n || probeOut <= 0n) throw new Error("route quote returned zero liquidity");
  const expectedAtProbeRate = (probeOut * amountIn) / probeIn;
  if (expectedAtProbeRate === 0n || amountOut >= expectedAtProbeRate) return 0n;
  return ((expectedAtProbeRate - amountOut) * BPS) / expectedAtProbeRate;
}

function deviationBps(observed, referenceValue) {
  if (referenceValue <= 0n) throw new Error("reference price is zero");
  const delta = observed > referenceValue ? observed - referenceValue : referenceValue - observed;
  return (delta * BPS) / referenceValue;
}

export function findExactRobinhoodManifestCandidate({ chainId, contractAddress }) {
  const address = normalizeRuntimeAddress(contractAddress);
  if (!address || Number(chainId) !== ROBINHOOD_MAINNET_CHAIN_ID) return null;
  return findManifestAsset({ chainId: String(ROBINHOOD_MAINNET_CHAIN_ID), provider: ROBINHOOD_STOCK_PROVIDER, address });
}

export function isExactRobinhoodReleaseCandidate({ chainId, contractAddress }) {
  return Boolean(findExactRobinhoodManifestCandidate({ chainId, contractAddress }));
}

export function certificationProbeNativeWei() {
  const raw = String(process.env.ROBINHOOD_STOCK_CERT_PROBE_NATIVE_WEI || "").trim();
  if (!/^\d+$/.test(raw) || BigInt(raw) <= 0n) return 0n;
  return BigInt(raw);
}

export async function certifyRobinhoodStockRuntime({ row, provider, factoryAddress, now = Date.now(), probeNativeWei = certificationProbeNativeWei() }) {
  const chainId = Number(row?.chain_id ?? row?.chainId);
  const tokenAddress = normalizeRuntimeAddress(row?.contract_address ?? row?.contractAddress);
  const manifestAsset = findExactRobinhoodManifestCandidate({ chainId, contractAddress: tokenAddress });
  if (!manifestAsset) throw new Error("exact chain + provider + contract identity is not in the approved Robinhood manifest");
  if (String(manifestAsset.symbol).toUpperCase() !== String(row?.symbol || manifestAsset.symbol).toUpperCase()) throw new Error("provider symbol does not match exact approved manifest identity");
  if (probeNativeWei <= 0n) throw new Error("ROBINHOOD_STOCK_CERT_PROBE_NATIVE_WEI is required for launch-size route certification");

  const normalizedFactory = await requireCode(provider, factoryAddress, "Stock factory");
  await requireCode(provider, tokenAddress, "Stock Token");
  const factory = new ethers.Contract(normalizedFactory, FACTORY_ABI, provider);
  const [adapterRaw, implementationRaw, factoryLockerRaw] = await Promise.all([factory.stockGraduationAdapter(), factory.stockCampaignImplementation(), factory.permanentLpLocker()]);
  const adapterAddress = await requireCode(provider, adapterRaw, "Stock graduation adapter");
  const implementationAddress = await requireCode(provider, implementationRaw, "Stock campaign implementation");
  const factoryLocker = await requireCode(provider, factoryLockerRaw, "Permanent V3 position locker");

  const adapter = new ethers.Contract(adapterAddress, ADAPTER_ABI, provider);
  const [v3FactoryRaw, positionManagerRaw, swapRouterRaw, wethRaw, lockerRaw, nativeOracleRaw, memeFeeTierRaw, maxOracleAgeRaw, campaignFactoryRaw, campaignFactoryLocked, route] = await Promise.all([
    adapter.v3Factory(), adapter.positionManager(), adapter.swapRouter(), adapter.WETH(), adapter.permanentPositionLocker(), adapter.nativeUsdOracle(), adapter.feeTier(), adapter.maxOracleAgeSeconds(), adapter.campaignFactory(), adapter.campaignFactoryLocked(), adapter.stockRoutes(tokenAddress),
  ]);

  const v3FactoryAddress = await requireCode(provider, v3FactoryRaw, "V3 factory");
  const positionManager = await requireCode(provider, positionManagerRaw, "V3 position manager");
  const swapRouter = await requireCode(provider, swapRouterRaw, "V3 swap router");
  const weth = await requireCode(provider, wethRaw, "WETH");
  const lockerAddress = await requireCode(provider, lockerRaw, "Permanent V3 position locker");
  const nativeOracleAddress = await requireCode(provider, nativeOracleRaw, "Native/USD oracle");
  if (!sameAddress(lockerAddress, factoryLocker)) throw new Error("factory and Stock adapter permanent locker mismatch");
  if (campaignFactoryLocked !== true || !sameAddress(campaignFactoryRaw, normalizedFactory)) throw new Error("Stock adapter campaign factory is not locked to the selected factory");

  const oracleFeed = normalizeRuntimeAddress(route?.oracleFeed ?? route?.[0]);
  const acquisitionPool = normalizeRuntimeAddress(route?.acquisitionPool ?? route?.[1]);
  const acquisitionFeeTier = Number(route?.acquisitionFeeTier ?? route?.[2] ?? 0);
  const minimumRouteLiquidityUsdWad = BigInt(route?.minimumRouteLiquidityUsdWad ?? route?.[3] ?? 0);
  const maxSwapSlippageBps = BigInt(route?.maxSwapSlippageBps ?? route?.[4] ?? 0);
  const maxOracleDeviationBps = BigInt(route?.maxOracleDeviationBps ?? route?.[5] ?? 0);
  const maxPriceImpactBps = BigInt(route?.maxPriceImpactBps ?? route?.[6] ?? 0);
  const routeEnabled = route?.enabled === true || route?.[7] === true;
  if (!routeEnabled) throw new Error("onchain Stock Graduation Adapter route disabled");
  if (!oracleFeed) throw new Error("onchain Stock Graduation Adapter route has no oracle feed");
  if (!acquisitionPool) throw new Error("onchain Stock Graduation Adapter route has no acquisition pool");
  await requireCode(provider, oracleFeed, "Stock/USD oracle");
  await requireCode(provider, acquisitionPool, "WETH/Stock acquisition pool");
  if (!Number.isInteger(acquisitionFeeTier) || acquisitionFeeTier <= 0) throw new Error("acquisition fee tier invalid");
  if (minimumRouteLiquidityUsdWad <= 0n) throw new Error("minimum route liquidity policy is zero");
  if (maxSwapSlippageBps > BPS || maxOracleDeviationBps > BPS || maxPriceImpactBps > BPS) throw new Error("route risk policy exceeds 10000 bps");

  const v3Factory = new ethers.Contract(v3FactoryAddress, V3_FACTORY_ABI, provider);
  const [canonicalAcquisitionPool, acquisitionSpacing, memeSpacing] = await Promise.all([v3Factory.getPool(weth, tokenAddress, acquisitionFeeTier), v3Factory.feeAmountTickSpacing(acquisitionFeeTier), v3Factory.feeAmountTickSpacing(Number(memeFeeTierRaw))]);
  if (!sameAddress(canonicalAcquisitionPool, acquisitionPool)) throw new Error("configured acquisition pool is not the canonical WETH/selected-QUOTE pool");
  if (Number(acquisitionSpacing) <= 0 || Number(memeSpacing) <= 0) throw new Error("configured V3 fee tier is unsupported");

  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const [tokenDecimalsRaw, poolStockBalance] = await Promise.all([token.decimals(), token.balanceOf(acquisitionPool)]);
  const tokenDecimals = Number(tokenDecimalsRaw);
  if (tokenDecimals !== Number(manifestAsset.decimals)) throw new Error(`token decimals mismatch: manifest=${manifestAsset.decimals} runtime=${tokenDecimals}`);

  const maxOracleAgeSeconds = Number(maxOracleAgeRaw);
  if (!Number.isInteger(maxOracleAgeSeconds) || maxOracleAgeSeconds <= 0) throw new Error("adapter oracle freshness policy invalid");
  const nowSeconds = Math.floor(now / 1000);
  const [stockOracle, nativeOracle] = await Promise.all([readFreshOracle(provider, oracleFeed, "Stock/USD oracle", maxOracleAgeSeconds, nowSeconds), readFreshOracle(provider, nativeOracleAddress, "Native/USD oracle", maxOracleAgeSeconds, nowSeconds)]);
  const poolStockUsdWad = (BigInt(poolStockBalance) * stockOracle.priceWad) / pow10(tokenDecimals);
  if (poolStockUsdWad < minimumRouteLiquidityUsdWad) throw new Error(`acquisition pool liquidity below route minimum (${poolStockUsdWad} < ${minimumRouteLiquidityUsdWad})`);

  const router = new ethers.Contract(swapRouter, ROUTER_ABI, provider);
  const probeIn = probeNativeWei / 100n > 0n ? probeNativeWei / 100n : 1n;
  const [quotedOutRaw, probeOutRaw] = await Promise.all([router.quoteExactInputSingle(weth, tokenAddress, acquisitionFeeTier, probeNativeWei), router.quoteExactInputSingle(weth, tokenAddress, acquisitionFeeTier, probeIn)]);
  const quotedOut = BigInt(quotedOutRaw);
  const probeOut = BigInt(probeOutRaw);
  if (quotedOut <= 0n || probeOut <= 0n) throw new Error("launch-size acquisition quote returned zero");
  const impactBps = priceImpactBps(probeNativeWei, quotedOut, probeIn, probeOut);
  if (impactBps > maxPriceImpactBps) throw new Error(`launch-size price impact exceeds policy (${impactBps} > ${maxPriceImpactBps} bps)`);
  const stockUsdValueWad = (quotedOut * stockOracle.priceWad) / pow10(tokenDecimals);
  const impliedNativeUsdWad = (stockUsdValueWad * WAD) / probeNativeWei;
  const oracleDeviation = deviationBps(impliedNativeUsdWad, nativeOracle.priceWad);
  if (oracleDeviation > maxOracleDeviationBps) throw new Error(`route execution price deviates from oracle policy (${oracleDeviation} > ${maxOracleDeviationBps} bps)`);
  const minimumOutAtPolicy = (quotedOut * (BPS - maxSwapSlippageBps)) / BPS;
  if (minimumOutAtPolicy <= 0n) throw new Error("slippage policy produces zero minimum output");

  const locker = new ethers.Contract(lockerAddress, LOCKER_ABI, provider);
  const [lockerAuthorized, lockerFactory, lockerManager, lockerWeth, lockerFeeTier] = await Promise.all([locker.authorizedIntegrationSource(adapterAddress), locker.v3Factory(), locker.positionManager(), locker.wrappedNative(), locker.configuredFeeTier()]);
  if (lockerAuthorized !== true) throw new Error("PermanentV3PositionLocker does not authorize Stock graduation adapter");
  if (!sameAddress(lockerFactory, v3FactoryAddress)) throw new Error("locker V3 factory mismatch");
  if (!sameAddress(lockerManager, positionManager)) throw new Error("locker position manager mismatch");
  if (!sameAddress(lockerWeth, weth)) throw new Error("locker WETH mismatch");
  if (BigInt(lockerFeeTier) !== BigInt(memeFeeTierRaw)) throw new Error("locker final MEME/QUOTE fee tier mismatch");

  return {
    provider: ROBINHOOD_STOCK_PROVIDER_AUTHORITY,
    providerKey: ROBINHOOD_STOCK_PROVIDER,
    manifestAssetId: manifestAsset.providerAssetId,
    tokenAddress,
    implementationAddress,
    adapterAddress,
    acquisitionPool,
    acquisitionFeeTier,
    routeEnabled: true,
    minimumRouteLiquidityUsdWad: minimumRouteLiquidityUsdWad.toString(),
    poolStockUsdWad: poolStockUsdWad.toString(),
    oracleFeed,
    oracleFresh: true,
    oracleAgeSeconds: stockOracle.ageSeconds,
    referencePriceResult: "PASS",
    probeNativeWei: probeNativeWei.toString(),
    quotedStockOut: quotedOut.toString(),
    priceImpactBps: Number(impactBps),
    oracleDeviationBps: Number(oracleDeviation),
    maxSwapSlippageBps: Number(maxSwapSlippageBps),
    minimumOutAtPolicy: minimumOutAtPolicy.toString(),
    finalMemeQuoteCompatibility: true,
    lockerCompatibility: true,
    technicalEligibility: true,
    providerRestrictionStatus: "PROVIDER_JURISDICTION_POLICY_REQUIRED",
  };
}
