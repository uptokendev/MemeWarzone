import { ethers } from "ethers";
import { getServerReadProvider } from "../lib/getServerReadProvider.js";
import { getRobinhoodStockGraduationAsset } from "../lib/robinhoodStockGraduationRegistry.js";
import { signRobinhoodStockCreateAuthorization } from "./robinhoodStockCreateAuthorizationSigner.js";

const ROBINHOOD_MAINNET_CHAIN_ID = 4663;
const ROBINHOOD_TESTNET_CHAIN_ID = 46630;
const LOCAL_HARDHAT_CHAIN_ID = 31337;
const ROBINHOOD_CHAIN_IDS = new Set([
  ROBINHOOD_MAINNET_CHAIN_ID,
  ROBINHOOD_TESTNET_CHAIN_ID,
  LOCAL_HARDHAT_CHAIN_ID,
]);

const STOCK_FACTORY_ABI = [
  "function stockGraduationAdapter() view returns (address)",
  "function stockCampaignImplementation() view returns (address)",
];
const STOCK_ADAPTER_ABI = [
  "function stockRoutes(address stockToken) view returns (address oracleFeed,address acquisitionPool,uint24 acquisitionFeeTier,uint256 minimumRouteLiquidityUsdWad,uint16 maxSwapSlippageBps,uint16 maxOracleDeviationBps,uint16 maxPriceImpactBps,bool enabled)",
];

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function normalizeAddress(value, label) {
  const raw = String(value || "").trim();
  if (!ethers.isAddress(raw) || raw === ethers.ZeroAddress) {
    throw new Error(`${label} must be a non-zero address`);
  }
  return ethers.getAddress(raw);
}

function policyChainId(chainId) {
  return Number(chainId) === LOCAL_HARDHAT_CHAIN_ID ? ROBINHOOD_TESTNET_CHAIN_ID : Number(chainId);
}

async function requireCode(provider, address, label) {
  const code = await provider.getCode(address);
  if (!code || code === "0x") throw new Error(`${label} has no deployed bytecode`);
}

export async function prepareRobinhoodStockCreateAuthorization({
  signer,
  chainId,
  factoryAddress,
  creator,
  request,
  stockToken,
  tradeRouteProfileId,
  finalizeRouteProfileId,
  deadline,
}) {
  const cid = Number(chainId);
  if (!ROBINHOOD_CHAIN_IDS.has(cid)) {
    throw new Error(`Stock Battlefield creation is Robinhood-only; got chain ${chainId}`);
  }

  const targetPolicyChainId = policyChainId(cid);
  if (!truthy(process.env.ROBINHOOD_STOCK_GRADUATION)) {
    throw new Error("Robinhood Stock Battlefield graduation is disabled in this environment");
  }
  if (targetPolicyChainId === ROBINHOOD_MAINNET_CHAIN_ID && !truthy(process.env.ROBINHOOD_STOCK_MARKETS)) {
    throw new Error("Robinhood mainnet Stock Battlefield markets are not enabled");
  }

  // Persistent DB registry is the sole offchain identity/eligibility authority.
  // Exact chainId + contractAddress lookup prevents ticker-only authorization.
  const asset = await getRobinhoodStockGraduationAsset({
    chainId: targetPolicyChainId,
    contractAddress: stockToken,
    requireFresh: true,
  });

  const provider = await getServerReadProvider(cid);
  const normalizedFactory = normalizeAddress(factoryAddress, "factoryAddress");
  const factory = new ethers.Contract(normalizedFactory, STOCK_FACTORY_ABI, provider);
  const [stockGraduationAdapterRaw, stockCampaignImplementationRaw] = await Promise.all([
    factory.stockGraduationAdapter(),
    factory.stockCampaignImplementation(),
  ]);
  const stockGraduationAdapter = normalizeAddress(stockGraduationAdapterRaw, "stockGraduationAdapter");
  const stockCampaignImplementation = normalizeAddress(stockCampaignImplementationRaw, "stockCampaignImplementation");

  await Promise.all([
    requireCode(provider, asset.contractAddress, "Stock Token"),
    requireCode(provider, stockGraduationAdapter, "Stock graduation adapter"),
    requireCode(provider, stockCampaignImplementation, "Stock campaign implementation"),
  ]);

  // Preserve the deployed Stock Graduation Adapter as the live route-safety authority.
  const adapter = new ethers.Contract(stockGraduationAdapter, STOCK_ADAPTER_ABI, provider);
  const route = await adapter.stockRoutes(asset.contractAddress);
  const oracleFeed = normalizeAddress(route?.oracleFeed ?? route?.[0], "stockRoute.oracleFeed");
  const acquisitionPool = normalizeAddress(route?.acquisitionPool ?? route?.[1], "stockRoute.acquisitionPool");
  const routeEnabled = route?.enabled === true || route?.[7] === true;
  if (!routeEnabled) throw new Error("Selected Stock Token graduation route is disabled onchain");

  const signature = await signRobinhoodStockCreateAuthorization({
    signer,
    chainId: cid,
    factoryAddress: normalizedFactory,
    creator,
    request,
    stockToken: asset.contractAddress,
    stockGraduationAdapter,
    stockCampaignImplementation,
    tradeRouteProfileId,
    finalizeRouteProfileId,
    deadline,
  });

  return {
    signature,
    stockToken: asset.contractAddress,
    stockGraduationAdapter,
    stockCampaignImplementation,
    marketPolicyVersion: "robinhood_market_v1",
    asset,
    route: {
      oracleFeed,
      acquisitionPool,
      acquisitionFeeTier: Number(route?.acquisitionFeeTier ?? route?.[2] ?? 0),
      minimumRouteLiquidityUsdWad: String(route?.minimumRouteLiquidityUsdWad ?? route?.[3] ?? 0),
      maxSwapSlippageBps: Number(route?.maxSwapSlippageBps ?? route?.[4] ?? 0),
      maxOracleDeviationBps: Number(route?.maxOracleDeviationBps ?? route?.[5] ?? 0),
      maxPriceImpactBps: Number(route?.maxPriceImpactBps ?? route?.[6] ?? 0),
      enabled: true,
    },
  };
}
