#!/usr/bin/env node
import fs from "node:fs";
import { ethers } from "ethers";
import { proveRobinhoodProductionManifest } from "./prove-robinhood-production-manifest.mjs";

const CHAIN_ID = 4663;
const EXPECTED_FEE_TIER = 3000n;

const FACTORY_ABI = [
  "function owner() view returns (address)",
  "function FACTORY_GENERATION() view returns (uint32)",
  "function CAMPAIGN_GENERATION() view returns (uint32)",
  "function liquidityKind() view returns (uint8)",
  "function live() view returns (bool)",
  "function createPaused() view returns (bool)",
  "function securityDefaultsLocked() view returns (bool)",
  "function requireRouteAuthorization() view returns (bool)",
  "function requireAuthorizedTrading() view returns (bool)",
  "function routeAuthority() view returns (address)",
  "function campaignImplementation() view returns (address)",
  "function stockCampaignImplementation() view returns (address)",
  "function stockGraduationAdapter() view returns (address)",
  "function permanentLpLocker() view returns (address)",
  "function router() view returns (address)",
  "function graduationOracle() view returns (address)",
  "function creatorRegistry() view returns (address)",
  "function riskRegistry() view returns (address)",
  "function feeRecipient() view returns (address)",
  "function leagueReceiver() view returns (address)",
];
const GRADUATION_ADAPTER_ABI = [
  "function liquidityKind() view returns (uint8)",
  "function v3Factory() view returns (address)",
  "function positionManager() view returns (address)",
  "function WETH() view returns (address)",
  "function feeTier() view returns (uint24)",
];
const STOCK_GRADUATION_ADAPTER_ABI = [
  "function admin() view returns (address)",
  "function v3Factory() view returns (address)",
  "function positionManager() view returns (address)",
  "function swapRouter() view returns (address)",
  "function WETH() view returns (address)",
  "function permanentPositionLocker() view returns (address)",
  "function nativeUsdOracle() view returns (address)",
  "function feeTier() view returns (uint24)",
  "function campaignFactory() view returns (address)",
  "function campaignFactoryLocked() view returns (bool)",
  "function stockRoutes(address) view returns (address oracleFeed,address acquisitionPool,uint24 acquisitionFeeTier,uint256 minimumRouteLiquidityUsdWad,uint16 maxSwapSlippageBps,uint16 maxOracleDeviationBps,uint16 maxPriceImpactBps,bool enabled)",
];
const NATIVE_SWAP_ABI = [
  "function swapRouter() view returns (address)",
  "function wrappedNative() view returns (address)",
];
const MULTI_HOP_ABI = [
  "function admin() view returns (address)",
  "function v3Factory() view returns (address)",
  "function swapRouter() view returns (address)",
  "function wrappedNative() view returns (address)",
];
const TREASURY_ROUTER_ABI = ["function admin() view returns (address)"];
const UPVOTE_TREASURY_ABI = [
  "function owner() view returns (address)",
  "function feeReceiver() view returns (address)",
];
const LOCKER_ABI = [
  "function integrationSource() view returns (address)",
  "function authorizedIntegrationSource(address) view returns (bool)",
  "function v3Factory() view returns (address)",
  "function positionManager() view returns (address)",
  "function wrappedNative() view returns (address)",
  "function treasuryRouter() view returns (address)",
  "function configuredFeeTier() view returns (uint24)",
  "function CREATOR_FEE_BPS() view returns (uint16)",
  "function PROTOCOL_FEE_BPS() view returns (uint16)",
];
const ORACLE_ABI = [
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
];
const V3_FACTORY_ABI = ["function feeAmountTickSpacing(uint24) view returns (int24)"];

function same(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

function eq(label, actual, expected) {
  if (String(actual) !== String(expected)) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

function addressEq(label, actual, expected) {
  if (!same(actual, expected)) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

async function requireCode(provider, address, label) {
  const code = await provider.getCode(address);
  if (!code || code === "0x") throw new Error(`${label} has no bytecode at ${address}`);
}

async function verifyOracle(provider, address, label, maxAgeSeconds) {
  await requireCode(provider, address, label);
  const oracle = new ethers.Contract(address, ORACLE_ABI, provider);
  const [latest, decimals] = await Promise.all([oracle.latestRoundData(), oracle.decimals()]);
  const now = Math.floor(Date.now() / 1000);
  const updatedAt = Number(latest.updatedAt || 0);
  const age = updatedAt > 0 ? now - updatedAt : Number.POSITIVE_INFINITY;
  if (BigInt(latest.answer) <= 0n) throw new Error(`${label} returned non-positive price`);
  if (BigInt(latest.roundId) <= 0n || BigInt(latest.answeredInRound) < BigInt(latest.roundId)) throw new Error(`${label} round is stale`);
  if (!Number.isInteger(Number(decimals)) || Number(decimals) < 0 || Number(decimals) > 36) throw new Error(`${label} decimals invalid`);
  if (updatedAt <= 0 || age < 0 || age > maxAgeSeconds) throw new Error(`${label} price is stale (${age}s)`);
}

export async function verifyRobinhoodProductionLive({ manifest, acceptedTestnet, candidateSha, rpcUrl }) {
  proveRobinhoodProductionManifest(manifest, { acceptedTestnet, candidateSha });
  if (!rpcUrl) throw new Error("Robinhood production RPC URL is required for live verification");
  const provider = new ethers.JsonRpcProvider(rpcUrl, CHAIN_ID, { staticNetwork: true });
  try {
    const network = await provider.getNetwork();
    eq("connected chain", Number(network.chainId), CHAIN_ID);
    const c = manifest.contracts;
    const allAddresses = [
      ...Object.entries(c),
      ["nativeUsdFeed", manifest.oracles.nativeUsdFeed],
      ...manifest.stock.registry.flatMap((entry) => [
        [`stock:${entry.symbol}:token`, entry.contractAddress],
        [`stock:${entry.symbol}:oracle`, entry.oracleFeedAddress],
        [`stock:${entry.symbol}:pool`, entry.acquisitionPoolAddress],
        [`stock:${entry.symbol}:router`, entry.acquisitionRouterAddress],
      ]),
    ];
    await Promise.all(allAddresses.map(([label, address]) => requireCode(provider, address, label)));

    const factory = new ethers.Contract(c.launchFactory, FACTORY_ABI, provider);
    const [factoryOwner,factoryGen,campaignGen,liquidityKind,live,createPaused,securityLocked,routeAuth,tradeAuth,routeAuthority,campaignImpl,stockCampaignImpl,stockAdapter,lockerAddress,router,graduationOracle,creatorRegistry,riskRegistry,feeRecipient,leagueReceiver] = await Promise.all([
      factory.owner(),factory.FACTORY_GENERATION(),factory.CAMPAIGN_GENERATION(),factory.liquidityKind(),factory.live(),factory.createPaused(),factory.securityDefaultsLocked(),factory.requireRouteAuthorization(),factory.requireAuthorizedTrading(),factory.routeAuthority(),factory.campaignImplementation(),factory.stockCampaignImplementation(),factory.stockGraduationAdapter(),factory.permanentLpLocker(),factory.router(),factory.graduationOracle(),factory.creatorRegistry(),factory.riskRegistry(),factory.feeRecipient(),factory.leagueReceiver(),
    ]);
    addressEq("factory owner", factoryOwner, manifest.admin);
    eq("factory generation", factoryGen, 4n);
    eq("campaign generation", campaignGen, 3n);
    eq("factory liquidity kind", liquidityKind, 2n);
    eq("factory live", live, false);
    eq("factory create paused", createPaused, true);
    eq("factory security defaults locked", securityLocked, true);
    eq("factory route auth required", routeAuth, true);
    eq("factory trade auth required", tradeAuth, true);
    addressEq("factory route authority", routeAuthority, manifest.routeAuthority);
    addressEq("factory campaign implementation", campaignImpl, c.launchCampaignImplementation);
    addressEq("factory Stock campaign implementation", stockCampaignImpl, c.stockCampaignImplementation);
    addressEq("factory Stock graduation adapter", stockAdapter, c.stockGraduationAdapter);
    addressEq("factory permanent locker", lockerAddress, c.permanentV3PositionLocker);
    addressEq("factory graduation router", router, c.graduationAdapter);
    addressEq("factory graduation oracle", graduationOracle, c.graduationOracle);
    addressEq("factory CreatorRegistry", creatorRegistry, c.creatorRegistry);
    addressEq("factory RiskRegistry", riskRegistry, c.riskRegistry);
    addressEq("factory fee recipient", feeRecipient, c.treasuryRouterV3);
    addressEq("factory league receiver", leagueReceiver, c.treasuryRouterV3);

    const treasuryRouter = new ethers.Contract(c.treasuryRouterV3, TREASURY_ROUTER_ABI, provider);
    addressEq("treasury router admin", await treasuryRouter.admin(), manifest.admin);

    const upVoteTreasury = new ethers.Contract(c.upVoteTreasury, UPVOTE_TREASURY_ABI, provider);
    const [upVoteOwner, upVoteFeeReceiver] = await Promise.all([upVoteTreasury.owner(), upVoteTreasury.feeReceiver()]);
    addressEq("UPVote treasury owner", upVoteOwner, manifest.admin);
    addressEq("UPVote treasury fee receiver", upVoteFeeReceiver, c.protocolRevenueVault);

    const graduation = new ethers.Contract(c.graduationAdapter, GRADUATION_ADAPTER_ABI, provider);
    const [gradKind,gradFactory,gradManager,gradWeth,gradFee] = await Promise.all([graduation.liquidityKind(),graduation.v3Factory(),graduation.positionManager(),graduation.WETH(),graduation.feeTier()]);
    eq("native graduation liquidity kind", gradKind, 2n);
    eq("native graduation fee tier", gradFee, EXPECTED_FEE_TIER);
    addressEq("native graduation V3 factory", gradFactory, c.v3Factory);
    addressEq("native graduation position manager", gradManager, c.nonfungiblePositionManager);
    addressEq("native graduation WETH", gradWeth, c.weth9);

    const nativeSwap = new ethers.Contract(c.v3NativeSwapAdapter, NATIVE_SWAP_ABI, provider);
    const [nativeRouter,nativeWrapped] = await Promise.all([nativeSwap.swapRouter(),nativeSwap.wrappedNative()]);
    addressEq("native swap router", nativeRouter, c.v3SwapRouter);
    addressEq("native swap WETH", nativeWrapped, c.weth9);

    const multiHop = new ethers.Contract(c.v3MultiHopSwapAdapter, MULTI_HOP_ABI, provider);
    const [hopAdmin,hopFactory,hopRouter,hopWrapped] = await Promise.all([multiHop.admin(),multiHop.v3Factory(),multiHop.swapRouter(),multiHop.wrappedNative()]);
    addressEq("multi-hop admin", hopAdmin, manifest.admin);
    addressEq("multi-hop V3 factory", hopFactory, c.v3Factory);
    addressEq("multi-hop router", hopRouter, c.v3SwapRouter);
    addressEq("multi-hop WETH", hopWrapped, c.weth9);

    const stockGraduation = new ethers.Contract(c.stockGraduationAdapter, STOCK_GRADUATION_ADAPTER_ABI, provider);
    const [stockAdmin,stockFactory,stockManager,stockRouter,stockWeth,stockLocker,nativeOracle,stockFee,campaignFactory,campaignFactoryLocked] = await Promise.all([
      stockGraduation.admin(),stockGraduation.v3Factory(),stockGraduation.positionManager(),stockGraduation.swapRouter(),stockGraduation.WETH(),stockGraduation.permanentPositionLocker(),stockGraduation.nativeUsdOracle(),stockGraduation.feeTier(),stockGraduation.campaignFactory(),stockGraduation.campaignFactoryLocked(),
    ]);
    addressEq("Stock graduation admin", stockAdmin, manifest.admin);
    addressEq("Stock graduation V3 factory", stockFactory, c.v3Factory);
    addressEq("Stock graduation position manager", stockManager, c.nonfungiblePositionManager);
    addressEq("Stock graduation router", stockRouter, c.v3SwapRouter);
    addressEq("Stock graduation WETH", stockWeth, c.weth9);
    addressEq("Stock graduation locker", stockLocker, c.permanentV3PositionLocker);
    addressEq("Stock graduation native/USD oracle", nativeOracle, manifest.oracles.nativeUsdFeed);
    eq("Stock graduation fee tier", stockFee, EXPECTED_FEE_TIER);
    addressEq("Stock graduation campaign factory", campaignFactory, c.launchFactory);
    eq("Stock graduation campaign factory locked", campaignFactoryLocked, true);

    const locker = new ethers.Contract(c.permanentV3PositionLocker, LOCKER_ABI, provider);
    const [primarySource,stockSourceAuthorized,lockerFactory,lockerManager,lockerWeth,lockerTreasury,lockerFee,creatorFee,protocolFee] = await Promise.all([
      locker.integrationSource(),locker.authorizedIntegrationSource(c.stockGraduationAdapter),locker.v3Factory(),locker.positionManager(),locker.wrappedNative(),locker.treasuryRouter(),locker.configuredFeeTier(),locker.CREATOR_FEE_BPS(),locker.PROTOCOL_FEE_BPS(),
    ]);
    addressEq("locker primary integration", primarySource, c.graduationAdapter);
    eq("locker Stock adapter authorized", stockSourceAuthorized, true);
    addressEq("locker V3 factory", lockerFactory, c.v3Factory);
    addressEq("locker position manager", lockerManager, c.nonfungiblePositionManager);
    addressEq("locker WETH", lockerWeth, c.weth9);
    addressEq("locker treasury", lockerTreasury, c.treasuryRouterV3);
    eq("locker fee tier", lockerFee, EXPECTED_FEE_TIER);
    eq("locker creator fee", creatorFee, 8000n);
    eq("locker protocol fee", protocolFee, 2000n);

    const v3Factory = new ethers.Contract(c.v3Factory, V3_FACTORY_ABI, provider);
    const spacing = await v3Factory.feeAmountTickSpacing(EXPECTED_FEE_TIER);
    if (Number(spacing) <= 0) throw new Error("production V3 factory does not support fee tier 3000");

    const maxAge = Math.max(60, Number(manifest.oracleMaxAgeSeconds || 900));
    await verifyOracle(provider, manifest.oracles.nativeUsdFeed, "native/USD oracle", maxAge);
    for (const entry of manifest.stock.registry) {
      await verifyOracle(provider, entry.oracleFeedAddress, `${entry.symbol} oracle`, maxAge);
      const route = await stockGraduation.stockRoutes(entry.contractAddress);
      addressEq(`${entry.symbol} Stock graduation oracle`, route.oracleFeed, entry.oracleFeedAddress);
      addressEq(`${entry.symbol} acquisition pool`, route.acquisitionPool, entry.acquisitionPoolAddress);
      eq(`${entry.symbol} acquisition fee tier`, route.acquisitionFeeTier, BigInt(entry.acquisitionFeeTier));
      eq(`${entry.symbol} Stock graduation route enabled`, route.enabled, true);
    }

    return { chainId: CHAIN_ID, sourceSha: manifest.sourceSha, contractsVerified: Object.keys(c).length, stockRoutesVerified: manifest.stock.registry.length, adminCustodyVerified: true, dark: true };
  } finally {
    provider.destroy();
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const manifestPath = process.argv[2] || process.env.ROBINHOOD_PRODUCTION_MANIFEST || "deployments/robinhood/mainnet.json";
  const acceptedPath = process.argv[3] || process.env.ROBINHOOD_ACCEPTED_TESTNET_MANIFEST || "deployments/robinhood/testnet.accepted.json";
  const candidateSha = process.argv[4] || process.env.ROBINHOOD_PRODUCTION_CANDIDATE_SHA || process.env.GITHUB_SHA;
  const rpcUrl = process.env.ROBINHOOD_MAINNET_RPC_URL || process.env.ROBINHOOD_RPC_HTTP_4663;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const acceptedTestnet = JSON.parse(fs.readFileSync(acceptedPath, "utf8"));
  const result = await verifyRobinhoodProductionLive({ manifest, acceptedTestnet, candidateSha, rpcUrl });
  console.log("Robinhood production live preflight passed", result);
}
