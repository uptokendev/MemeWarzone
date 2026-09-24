/**
 * Bind Robinhood stock tokens (and USDG) as graduation quotes on mainnet.
 *
 * Reads config/robinhood/mainnet-stock-routes.json -- a facts file built on
 * 2026-09-24 from Robinhood's own asset list, Chainlink's Robinhood-chain feed
 * directory and the Uniswap V3 factory -- and, for every route, re-derives the
 * facts from chain before touching anything: the token and feed have code, the
 * feed answered within the oracle age the adapter enforces, the acquisition
 * pool is the canonical V3 pool for (WETH, token, feeTier) -- the adapter's own
 * rule -- and its WETH side values at least the liquidity floor. Anything that
 * fails is refused, not skipped silently.
 *
 * Step 0: the stock adapter deployed on 2026-09-24 was never bound to the
 * factory (campaignFactory() == 0x0); every stock graduation would revert
 * CampaignFactoryMissing. setCampaignFactoryOnce is one-shot and
 * admin-only, so it is done here, after checking the factory names this
 * adapter back.
 *
 *   npx hardhat run scripts/configure-robinhood-stock-routes.ts --network robinhoodMainnet            # dry run
 *   ROUTES_SEND=1 npx hardhat run scripts/configure-robinhood-stock-routes.ts --network robinhoodMainnet
 *
 * Rehearsed on a local chain by test/RobinhoodStockRoutesConfigure.spec.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";

export const ROBINHOOD_MAINNET_CHAIN_ID = 4663n;
const ROOT = path.resolve(__dirname, "..");
export const CONFIG_PATH = path.join(ROOT, "config", "robinhood", "mainnet-stock-routes.json");
export const RECORD_PATH = path.join(ROOT, "deployments", "robinhood", "mainnet.stock-routes.json");

export const ADAPTER_ABI = [
  "function admin() view returns (address)",
  "function campaignFactory() view returns (address)",
  "function campaignFactoryLocked() view returns (bool)",
  "function v3Factory() view returns (address)",
  "function WETH() view returns (address)",
  "function nativeUsdOracle() view returns (address)",
  "function maxOracleAgeSeconds() view returns (uint256)",
  "function stockRoutes(address) view returns (address oracleFeed,address acquisitionPool,uint24 acquisitionFeeTier,uint256 minimumRouteLiquidityUsdWad,uint16 maxSwapSlippageBps,uint16 maxOracleDeviationBps,uint16 maxPriceImpactBps,bool enabled)",
  "function setCampaignFactoryOnce(address)",
  "function configureStockRoute(address stockToken, (address oracleFeed,address acquisitionPool,uint24 acquisitionFeeTier,uint256 minimumRouteLiquidityUsdWad,uint16 maxSwapSlippageBps,uint16 maxOracleDeviationBps,uint16 maxPriceImpactBps,bool enabled) route)",
];
const FACTORY_ABI = ["function stockGraduationAdapter() view returns (address)"];
const V3_FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const FEED_ABI = ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)", "function decimals() view returns (uint8)"];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

export type RouteInput = { symbol: string; stockToken: string; oracleFeed: string; acquisitionPool: string; acquisitionFeeTier: number };
export type Policy = { minimumRouteLiquidityUsd: string; maxSwapSlippageBps: number; maxOracleDeviationBps: number; maxPriceImpactBps: number };

export function routeStruct(r: RouteInput, policy: Policy) {
  return {
    oracleFeed: ethers.getAddress(r.oracleFeed),
    acquisitionPool: ethers.getAddress(r.acquisitionPool),
    acquisitionFeeTier: r.acquisitionFeeTier,
    minimumRouteLiquidityUsdWad: ethers.parseUnits(policy.minimumRouteLiquidityUsd, 18),
    maxSwapSlippageBps: policy.maxSwapSlippageBps,
    maxOracleDeviationBps: policy.maxOracleDeviationBps,
    maxPriceImpactBps: policy.maxPriceImpactBps,
    enabled: true,
  };
}

/** Re-derive every fact for one route from chain. Throws on the first one that does not hold. */
export async function verifyRouteFacts(provider: any, adapter: any, r: RouteInput, policy: Policy, nowSeconds: number) {
  const token = ethers.getAddress(r.stockToken);
  const [v3FactoryAddr, weth, nativeOracle, maxAge] = await Promise.all([adapter.v3Factory(), adapter.WETH(), adapter.nativeUsdOracle(), adapter.maxOracleAgeSeconds()]);
  if (token === ethers.getAddress(weth)) throw new Error(`${r.symbol}: token is WETH`);
  if ((await provider.getCode(token)) === "0x") throw new Error(`${r.symbol}: token ${token} has no code`);
  if ((await provider.getCode(r.oracleFeed)) === "0x") throw new Error(`${r.symbol}: oracle feed ${r.oracleFeed} has no code`);
  const feed = new ethers.Contract(r.oracleFeed, FEED_ABI, provider);
  const [, answer, , updatedAt] = await feed.latestRoundData();
  const age = nowSeconds - Number(updatedAt);
  if (answer <= 0n) throw new Error(`${r.symbol}: feed answer ${answer}`);
  if (age > Number(maxAge)) throw new Error(`${r.symbol}: feed is ${age}s old, adapter allows ${maxAge}s`);
  const v3 = new ethers.Contract(v3FactoryAddr, V3_FACTORY_ABI, provider);
  const canonical = await v3.getPool(weth, token, r.acquisitionFeeTier);
  if (canonical === ethers.ZeroAddress) throw new Error(`${r.symbol}: no V3 pool for (WETH, token, ${r.acquisitionFeeTier})`);
  if (ethers.getAddress(canonical) !== ethers.getAddress(r.acquisitionPool)) throw new Error(`${r.symbol}: configured pool ${r.acquisitionPool} is not the canonical ${canonical}`);
  const nativeFeed = new ethers.Contract(nativeOracle, FEED_ABI, provider);
  const [, ethAnswer] = await nativeFeed.latestRoundData();
  const ethDecimals = Number(await nativeFeed.decimals());
  const wethInPool = await new ethers.Contract(weth, ERC20_ABI, provider).balanceOf(canonical);
  const wethSideUsd = Number(ethers.formatEther(wethInPool)) * (Number(ethAnswer) / 10 ** ethDecimals);
  const floorUsd = Number(policy.minimumRouteLiquidityUsd);
  if (wethSideUsd * 2 < floorUsd) throw new Error(`${r.symbol}: pool ~$${Math.round(wethSideUsd * 2)} is below the $${floorUsd} floor`);
  const feedDecimals = Number(await feed.decimals());
  return { token, canonical, feedPrice: Number(answer) / 10 ** feedDecimals, feedAgeSeconds: age, poolUsd: Math.round(wethSideUsd * 2) };
}

export async function bindFactoryIfMissing(adapter: any, factoryAddress: string, send: boolean) {
  const [current, locked] = await Promise.all([adapter.campaignFactory(), adapter.campaignFactoryLocked()]);
  const factory = ethers.getAddress(factoryAddress);
  if (locked) {
    if (ethers.getAddress(current) !== factory) throw new Error(`adapter is locked to ${current}, not the factory ${factory}`);
    return { action: "already-bound" as const };
  }
  const factoryContract = new ethers.Contract(factory, FACTORY_ABI, adapter.runner);
  const back = await factoryContract.stockGraduationAdapter();
  if (ethers.getAddress(back) !== ethers.getAddress(await adapter.getAddress())) throw new Error(`factory ${factory} names ${back} as its stock adapter, not this one`);
  if (!send) return { action: "would-bind" as const };
  const tx = await adapter.setCampaignFactoryOnce(factory);
  await tx.wait();
  if (!(await adapter.campaignFactoryLocked()) || ethers.getAddress(await adapter.campaignFactory()) !== factory) throw new Error("bind did not take");
  return { action: "bound" as const, tx: tx.hash };
}

export async function configureRoutes({ adapter, routes, policy, send, nowSeconds }: { adapter: any; routes: RouteInput[]; policy: Policy; send: boolean; nowSeconds: number }) {
  const provider = adapter.runner.provider;
  const results: any[] = [];
  for (const r of routes) {
    const facts = await verifyRouteFacts(provider, adapter, r, policy, nowSeconds);
    const want = routeStruct(r, policy);
    const have = await adapter.stockRoutes(facts.token);
    const same = have.enabled && ethers.getAddress(have.oracleFeed) === want.oracleFeed && ethers.getAddress(have.acquisitionPool) === want.acquisitionPool && Number(have.acquisitionFeeTier) === want.acquisitionFeeTier && have.minimumRouteLiquidityUsdWad === want.minimumRouteLiquidityUsdWad && Number(have.maxSwapSlippageBps) === want.maxSwapSlippageBps && Number(have.maxOracleDeviationBps) === want.maxOracleDeviationBps && Number(have.maxPriceImpactBps) === want.maxPriceImpactBps;
    let action = same ? "unchanged" : send ? "configured" : "would-configure"; let txHash: string | undefined;
    if (!same && send) {
      const tx = await adapter.configureStockRoute(facts.token, want);
      await tx.wait(); txHash = tx.hash;
      const after = await adapter.stockRoutes(facts.token);
      if (!after.enabled || ethers.getAddress(after.acquisitionPool) !== want.acquisitionPool) throw new Error(`${r.symbol}: route did not take`);
    }
    results.push({ symbol: r.symbol, token: facts.token, pool: facts.canonical, feeTier: r.acquisitionFeeTier, feed: want.oracleFeed, feedPrice: facts.feedPrice, feedAgeSeconds: facts.feedAgeSeconds, poolUsd: facts.poolUsd, action, tx: txHash });
    console.log(`  ${action.padEnd(16)} ${r.symbol.padEnd(6)} feed $${facts.feedPrice.toFixed(2)} (${facts.feedAgeSeconds}s)  pool ${facts.canonical.slice(0, 10)}… fee ${r.acquisitionFeeTier} ~$${facts.poolUsd.toLocaleString()}${txHash ? `  tx ${txHash}` : ""}`);
  }
  return results;
}

async function main() {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  if (chainId !== ROBINHOOD_MAINNET_CHAIN_ID) throw new Error(`this script is for Robinhood mainnet (4663); ${network.name} reports ${chainId}`);
  const send = process.env.ROUTES_SEND === "1";
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const record = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "robinhood", "mainnet.quote-generation.json"), "utf8"));
  const deployed = record.deployed || record.contracts || {};
  const adapterAddress = deployed.RobinhoodStockTokenGraduationAdapter;
  const factoryAddress = deployed.LaunchFactory;
  if (!adapterAddress || !factoryAddress) throw new Error("adapter/factory not found in deployments/robinhood/mainnet.quote-generation.json");
  const [signer] = await ethers.getSigners();
  const adapter = new ethers.Contract(adapterAddress, ADAPTER_ABI, signer);
  const admin = await adapter.admin();
  if (ethers.getAddress(admin) !== ethers.getAddress(signer.address)) throw new Error(`adapter admin is ${admin}, signer is ${signer.address}`);
  console.log(`[routes] chain ${chainId} mode=${send ? "SEND" : "dry-run"}  adapter ${adapterAddress}  factory ${factoryAddress}  signer ${signer.address} (${ethers.formatEther(await ethers.provider.getBalance(signer.address))} ETH)`);
  const bind = await bindFactoryIfMissing(adapter, factoryAddress, send);
  console.log(`[routes] campaign factory: ${bind.action}${"tx" in bind ? ` ${bind.tx}` : ""}`);
  const nowSeconds = (await ethers.provider.getBlock("latest"))!.timestamp;
  console.log(`[routes] ${cfg.routes.length} routes, floor $${cfg.policy.minimumRouteLiquidityUsd}, policy slippage ${cfg.policy.maxSwapSlippageBps} / oracle dev ${cfg.policy.maxOracleDeviationBps} / impact ${cfg.policy.maxPriceImpactBps} bps`);
  const results = await configureRoutes({ adapter, routes: cfg.routes, policy: cfg.policy, send, nowSeconds });
  if (send) {
    fs.writeFileSync(RECORD_PATH, JSON.stringify({ network: network.name, chainId: Number(chainId), at: new Date().toISOString(), adapter: adapterAddress, factory: factoryAddress, campaignFactory: bind, policy: cfg.policy, routes: results }, null, 2) + "\n");
    console.log(`[routes] wrote ${RECORD_PATH}`);
  } else {
    console.log("[routes] DRY RUN: nothing sent. ROUTES_SEND=1 to configure.");
  }
}

if (require.main === module) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
