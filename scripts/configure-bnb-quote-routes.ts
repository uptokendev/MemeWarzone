/**
 * Bind quote tokens on the BNB adapter from config/bnb/mainnet-quote-routes.json
 * (written by scripts/scan-bnb-quote-routes.mjs from facts). Mirror of the
 * Robinhood script for the Topaz side; every fact is re-derived from chain:
 * token and feed have code, the feed answered within the adapter's oracle age,
 * the acquisition pool is the canonical Topaz volatile WBNB/token pool (the
 * adapter's own rule) and not stable, and its WBNB side values at least the
 * floor. The factory binding is checked, not made: on BNB it was done at
 * deployment (locked to 0x632061cA...).
 *
 *   npx hardhat run scripts/configure-bnb-quote-routes.ts --network bscMainnet             # dry run
 *   ROUTES_SEND=1 npx hardhat run scripts/configure-bnb-quote-routes.ts --network bscMainnet
 */
import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";

export const BNB_MAINNET_CHAIN_ID = 56n;
const ROOT = path.resolve(__dirname, "..");
export const CONFIG_PATH = path.join(ROOT, "config", "bnb", "mainnet-quote-routes.json");
export const RECORD_PATH = path.join(ROOT, "deployments", "bnb", "mainnet.quote-routes.json");

export const ADAPTER_ABI = [
  "function admin() view returns (address)",
  "function campaignFactory() view returns (address)",
  "function campaignFactoryLocked() view returns (bool)",
  "function topazFactory() view returns (address)",
  "function WBNB() view returns (address)",
  "function nativeUsdOracle() view returns (address)",
  "function maxOracleAgeSeconds() view returns (uint32)",
  "function quoteRoutes(address) view returns (address oracleFeed,address acquisitionPool,uint256 minimumRouteLiquidityUsdWad,uint16 maxSwapSlippageBps,uint16 maxOracleDeviationBps,uint16 maxPriceImpactBps,uint16 maxGraduationPriceDeviationBps,bool enabled)",
  "function configureQuoteRoute(address quoteToken, (address oracleFeed,address acquisitionPool,uint256 minimumRouteLiquidityUsdWad,uint16 maxSwapSlippageBps,uint16 maxOracleDeviationBps,uint16 maxPriceImpactBps,uint16 maxGraduationPriceDeviationBps,bool enabled) route)",
];
const TOPAZ_FACTORY_ABI = ["function getPool(address,address,bool) view returns (address)"];
const POOL_ABI = ["function stable() view returns (bool)"];
const FEED_ABI = ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)", "function decimals() view returns (uint8)"];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

export type RouteInput = { symbol: string; quoteToken: string; oracleFeed: string; acquisitionPool: string };
export type Policy = { minimumRouteLiquidityUsd: string; maxSwapSlippageBps: number; maxOracleDeviationBps: number; maxPriceImpactBps: number; maxGraduationPriceDeviationBps: number };

export function routeStruct(r: RouteInput, policy: Policy) {
  return { oracleFeed: ethers.getAddress(r.oracleFeed), acquisitionPool: ethers.getAddress(r.acquisitionPool), minimumRouteLiquidityUsdWad: ethers.parseUnits(policy.minimumRouteLiquidityUsd, 18), maxSwapSlippageBps: policy.maxSwapSlippageBps, maxOracleDeviationBps: policy.maxOracleDeviationBps, maxPriceImpactBps: policy.maxPriceImpactBps, maxGraduationPriceDeviationBps: policy.maxGraduationPriceDeviationBps, enabled: true };
}

export async function verifyRouteFacts(provider: any, adapter: any, r: RouteInput, policy: Policy, nowSeconds: number) {
  const token = ethers.getAddress(r.quoteToken);
  const [topazFactoryAddr, wbnb, nativeOracle, maxAge] = await Promise.all([adapter.topazFactory(), adapter.WBNB(), adapter.nativeUsdOracle(), adapter.maxOracleAgeSeconds()]);
  if (token === ethers.getAddress(wbnb)) throw new Error(`${r.symbol}: token is WBNB`);
  if ((await provider.getCode(token)) === "0x") throw new Error(`${r.symbol}: token ${token} has no code`);
  if ((await provider.getCode(r.oracleFeed)) === "0x") throw new Error(`${r.symbol}: oracle feed ${r.oracleFeed} has no code`);
  const feed = new ethers.Contract(r.oracleFeed, FEED_ABI, provider);
  const [, answer, , updatedAt] = await feed.latestRoundData();
  const age = nowSeconds - Number(updatedAt);
  if (answer <= 0n) throw new Error(`${r.symbol}: feed answer ${answer}`);
  if (age > Number(maxAge)) throw new Error(`${r.symbol}: feed is ${age}s old, adapter allows ${maxAge}s`);
  const canonical = await new ethers.Contract(topazFactoryAddr, TOPAZ_FACTORY_ABI, provider).getPool(wbnb, token, false);
  if (canonical === ethers.ZeroAddress) throw new Error(`${r.symbol}: no volatile Topaz WBNB pool`);
  if (ethers.getAddress(canonical) !== ethers.getAddress(r.acquisitionPool)) throw new Error(`${r.symbol}: configured pool ${r.acquisitionPool} is not the canonical ${canonical}`);
  if (await new ethers.Contract(canonical, POOL_ABI, provider).stable()) throw new Error(`${r.symbol}: canonical pool is a stable pool`);
  const nativeFeed = new ethers.Contract(nativeOracle, FEED_ABI, provider);
  const [, bnbAnswer] = await nativeFeed.latestRoundData();
  const bnbUsd = Number(bnbAnswer) / 10 ** Number(await nativeFeed.decimals());
  const wbnbInPool = await new ethers.Contract(wbnb, ERC20_ABI, provider).balanceOf(canonical);
  const poolUsd = Math.round(Number(ethers.formatEther(wbnbInPool)) * bnbUsd * 2);
  if (poolUsd < Number(policy.minimumRouteLiquidityUsd)) throw new Error(`${r.symbol}: pool ~$${poolUsd} is below the $${policy.minimumRouteLiquidityUsd} floor`);
  return { token, canonical, feedPrice: Number(answer) / 10 ** Number(await feed.decimals()), feedAgeSeconds: age, poolUsd };
}

export async function requireFactoryBound(adapter: any, factoryAddress: string) {
  const [locked, current] = await Promise.all([adapter.campaignFactoryLocked(), adapter.campaignFactory()]);
  if (!locked || ethers.getAddress(current) !== ethers.getAddress(factoryAddress)) throw new Error(`adapter campaign factory is ${current} (locked=${locked}), expected ${factoryAddress} locked`);
}

export async function configureRoutes({ adapter, routes, policy, send, nowSeconds }: { adapter: any; routes: RouteInput[]; policy: Policy; send: boolean; nowSeconds: number }) {
  const provider = adapter.runner.provider;
  const results: any[] = [];
  for (const r of routes) {
    const facts = await verifyRouteFacts(provider, adapter, r, policy, nowSeconds);
    const want = routeStruct(r, policy);
    const have = await adapter.quoteRoutes(facts.token);
    const same = have.enabled && ethers.getAddress(have.oracleFeed) === want.oracleFeed && ethers.getAddress(have.acquisitionPool) === want.acquisitionPool && have.minimumRouteLiquidityUsdWad === want.minimumRouteLiquidityUsdWad && Number(have.maxSwapSlippageBps) === want.maxSwapSlippageBps && Number(have.maxOracleDeviationBps) === want.maxOracleDeviationBps && Number(have.maxPriceImpactBps) === want.maxPriceImpactBps && Number(have.maxGraduationPriceDeviationBps) === want.maxGraduationPriceDeviationBps;
    let action = same ? "unchanged" : send ? "configured" : "would-configure"; let txHash: string | undefined;
    if (!same && send) {
      const tx = await adapter.configureQuoteRoute(facts.token, want); await tx.wait(); txHash = tx.hash;
      const after = await adapter.quoteRoutes(facts.token);
      if (!after.enabled || ethers.getAddress(after.acquisitionPool) !== want.acquisitionPool) throw new Error(`${r.symbol}: route did not take`);
    }
    results.push({ symbol: r.symbol, token: facts.token, pool: facts.canonical, feed: want.oracleFeed, feedPrice: facts.feedPrice, feedAgeSeconds: facts.feedAgeSeconds, poolUsd: facts.poolUsd, action, tx: txHash });
    console.log(`  ${action.padEnd(16)} ${r.symbol.padEnd(7)} feed $${facts.feedPrice.toFixed(4)} (${facts.feedAgeSeconds}s)  pool ${facts.canonical.slice(0, 10)}… ~$${facts.poolUsd.toLocaleString()}${txHash ? `  tx ${txHash}` : ""}`);
  }
  return results;
}

async function main() {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  if (chainId !== BNB_MAINNET_CHAIN_ID) throw new Error(`this script is for BNB mainnet (56); ${network.name} reports ${chainId}`);
  const send = process.env.ROUTES_SEND === "1";
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const record = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "bnb", "mainnet.quote-generation.json"), "utf8"));
  const contracts = record.contracts || {};
  const adapterAddress = Object.entries(contracts).find(([k]) => /QuoteGraduationAdapter/i.test(k))?.[1] as string;
  const factoryAddress = (Object.entries(contracts).find(([k]) => /^BnbBasicLaunchFactory$|^factory$/i.test(k))?.[1] as string) || "0x632061cA786f7B585Bbd46A792FDA92B02f70671";
  if (!adapterAddress) throw new Error("quote adapter not found in deployments/bnb/mainnet.quote-generation.json");
  const [signer] = await ethers.getSigners();
  const adapter = new ethers.Contract(adapterAddress, ADAPTER_ABI, signer);
  const admin = await adapter.admin();
  if (ethers.getAddress(admin) !== ethers.getAddress(signer.address)) throw new Error(`adapter admin is ${admin}, signer is ${signer.address}`);
  await requireFactoryBound(adapter, factoryAddress);
  console.log(`[bnb-routes] chain ${chainId} mode=${send ? "SEND" : "dry-run"}  adapter ${adapterAddress}  factory ${factoryAddress} (bound)  signer ${signer.address}`);
  if (!cfg.routes.length) { console.log(`[bnb-routes] the facts file has no bindable route (floor $${cfg.floorUsd}); re-run scripts/scan-bnb-quote-routes.mjs when Topaz liquidity changes`); return; }
  const nowSeconds = (await ethers.provider.getBlock("latest"))!.timestamp;
  const results = await configureRoutes({ adapter, routes: cfg.routes, policy: cfg.policy, send, nowSeconds });
  if (send) { fs.writeFileSync(RECORD_PATH, JSON.stringify({ network: network.name, chainId: Number(chainId), at: new Date().toISOString(), adapter: adapterAddress, policy: cfg.policy, routes: results }, null, 2) + "\n"); console.log(`[bnb-routes] wrote ${RECORD_PATH}`); }
  else console.log("[bnb-routes] DRY RUN: nothing sent. ROUTES_SEND=1 to configure.");
}

if (require.main === module) { main().catch((error) => { console.error(error); process.exitCode = 1; }); }
