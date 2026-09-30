/**
 * Bind quote tokens on the generation 6 BNB quote adapter (BnbQuoteGraduationAdapter, admin = the Safe) and
 * the creator vault (CreatorRewardsVaultV2.setQuoteRoute), from config/bnb/mainnet-quote-routes.json
 * (written by scripts/scan-bnb-quote-routes.mjs from facts). Mirror of the Robinhood script for the Topaz
 * side; every fact is re-derived from chain: token and feed have code, the feed answered within the adapter's
 * oracle age, the acquisition pool is the canonical Topaz volatile WBNB/token pool (the adapter's own rule)
 * and not stable, and its WBNB side values at least the floor. The policy is checked against the adapter's
 * `MAX_ROUTE_LIMIT_BPS` (100) first (`assertPolicyFitsQuoteAdapter`).
 *
 * Who sends: the adapter's and the vault's admin is immutable (the Safe on 56), so the calls become a Safe
 * Transaction Builder batch (deployments/bnb/mainnet.quote-routes.Q.safe-batch.json), each simulated with
 * eth_call from the Safe first. Only when the signer is itself the admin does ROUTES_SEND=1 send.
 * If batch B has not bound the adapter to the factory yet, the bind is the batch's first call.
 *
 *   npx hardhat run scripts/configure-bnb-quote-routes.ts --network bscMainnet
 *   ROUTES_GENERATION_RECORD=<path> ...   # another generation record (the fork rehearsal uses its own)
 */
import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";
import { PlannedCall, simulateAsAdmin, tupleArg, writeSafeBatch } from "./lib/safeCallPlan";
import { profileNetworkName, rehearsalPath } from "./lib/forkRehearsal";
import { sendPlanned } from "./configure-robinhood-stock-routes";

export const BNB_MAINNET_CHAIN_ID = 56n;
const ROOT = path.resolve(__dirname, "..");
export const CONFIG_PATH = path.join(ROOT, "config", "bnb", "mainnet-quote-routes.json");
export const RECORD_PATH = path.join(ROOT, "deployments", "bnb", "mainnet.quote-routes.json");
export const BATCH_PATH = path.join(ROOT, "deployments", "bnb", "mainnet.quote-routes.Q.safe-batch.json");
export const GENERATION_RECORD = path.join(ROOT, "deployments", "bnb", "mainnet.quote-generation.json");
/** BnbQuoteGraduationAdapter.MAX_ROUTE_LIMIT_BPS. */
export const QUOTE_ADAPTER_MAX_ROUTE_LIMIT_BPS = 100;

export const ADAPTER_ABI = [
  "function admin() view returns (address)",
  "function campaignFactory() view returns (address)",
  "function campaignFactoryLocked() view returns (bool)",
  "function topazFactory() view returns (address)",
  "function WBNB() view returns (address)",
  "function nativeUsdOracle() view returns (address)",
  "function maxOracleAgeSeconds() view returns (uint32)",
  "function MAX_ROUTE_LIMIT_BPS() view returns (uint16)",
  "function quoteRoutes(address) view returns (address oracleFeed,address acquisitionPool,uint256 minimumRouteLiquidityUsdWad,uint16 maxSwapSlippageBps,uint16 maxOracleDeviationBps,uint16 maxPriceImpactBps,uint16 maxGraduationPriceDeviationBps,bool enabled)",
  "function setCampaignFactoryOnce(address)",
  "function configureQuoteRoute(address quoteToken, (address oracleFeed,address acquisitionPool,uint256 minimumRouteLiquidityUsdWad,uint16 maxSwapSlippageBps,uint16 maxOracleDeviationBps,uint16 maxPriceImpactBps,uint16 maxGraduationPriceDeviationBps,bool enabled) route)",
];
const VAULT_ABI = ["function admin() view returns (address)", "function quoteRoutePool(address) view returns (address)"];
const FACTORY_ABI = ["function bnbQuoteGraduationAdapter() view returns (address)"];
const TOPAZ_FACTORY_ABI = ["function getPool(address,address,bool) view returns (address)"];
const POOL_ABI = ["function stable() view returns (bool)"];
const FEED_ABI = ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)", "function decimals() view returns (uint8)"];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
const ROUTE_FIELDS = ["oracleFeed", "acquisitionPool", "minimumRouteLiquidityUsdWad", "maxSwapSlippageBps", "maxOracleDeviationBps", "maxPriceImpactBps", "maxGraduationPriceDeviationBps", "enabled"];

export type RouteInput = { symbol: string; quoteToken: string; oracleFeed: string; acquisitionPool: string };
export type Policy = { minimumRouteLiquidityUsd: string; maxSwapSlippageBps: number; maxOracleDeviationBps: number; maxPriceImpactBps: number; maxGraduationPriceDeviationBps: number };

/** configureQuoteRoute's InvalidPolicy rules: slippage 1..100, the three other caps 0..100, a positive floor. */
export function quotePolicyViolations(policy: Policy): string[] {
  const out: string[] = [];
  const max = QUOTE_ADAPTER_MAX_ROUTE_LIMIT_BPS;
  if (!(policy.maxSwapSlippageBps > 0 && policy.maxSwapSlippageBps <= max)) out.push(`maxSwapSlippageBps ${policy.maxSwapSlippageBps} outside 1..${max}`);
  for (const k of ["maxOracleDeviationBps", "maxPriceImpactBps", "maxGraduationPriceDeviationBps"] as const) {
    if (!(Number.isInteger(policy[k]) && policy[k] >= 0 && policy[k] <= max)) out.push(`${k} ${policy[k]} outside 0..${max}`);
  }
  if (!(Number(policy.minimumRouteLiquidityUsd) > 0)) out.push("minimumRouteLiquidityUsd must be positive");
  return out;
}

export function assertPolicyFitsQuoteAdapter(policy: Policy) {
  const v = quotePolicyViolations(policy);
  if (v.length) throw new Error(`the BNB route policy does not satisfy BnbQuoteGraduationAdapter:\n  ${v.join("\n  ")}`);
}

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

/** Null when the adapter is locked to the factory; the bind call when it is unbound and the factory names it. */
export async function planFactoryBind(adapter: any, factoryAddress: string): Promise<PlannedCall | null> {
  const [locked, current] = await Promise.all([adapter.campaignFactoryLocked(), adapter.campaignFactory()]);
  const factory = ethers.getAddress(factoryAddress);
  if (locked) {
    if (ethers.getAddress(current) !== factory) throw new Error(`adapter campaign factory is ${current} (locked), expected ${factory}`);
    return null;
  }
  const back = await new ethers.Contract(factory, FACTORY_ABI, adapter.runner).bnbQuoteGraduationAdapter();
  if (ethers.getAddress(back) !== ethers.getAddress(await adapter.getAddress())) throw new Error(`factory ${factory} names ${back} as its quote adapter, not this one`);
  return { contract: "BnbQuoteGraduationAdapter", to: await adapter.getAddress(), fn: "setCampaignFactoryOnce", args: [factory] };
}

/** Kept for callers that require the binding (testnet cuts bind in the deploy script). */
export async function requireFactoryBound(adapter: any, factoryAddress: string) {
  const [locked, current] = await Promise.all([adapter.campaignFactoryLocked(), adapter.campaignFactory()]);
  if (!locked || ethers.getAddress(current) !== ethers.getAddress(factoryAddress)) throw new Error(`adapter campaign factory is ${current} (locked=${locked}), expected ${factoryAddress} locked`);
}

export async function planRoutes({ adapter, vault, routes, policy, nowSeconds }: { adapter: any; vault?: any; routes: RouteInput[]; policy: Policy; nowSeconds: number }) {
  assertPolicyFitsQuoteAdapter(policy);
  const provider = adapter.runner.provider;
  const adapterAddress = await adapter.getAddress();
  const calls: PlannedCall[] = [];
  const results: any[] = [];
  for (const r of routes) {
    const facts = await verifyRouteFacts(provider, adapter, r, policy, nowSeconds);
    const want = routeStruct(r, policy);
    const have = await adapter.quoteRoutes(facts.token);
    const same = have.enabled && ethers.getAddress(have.oracleFeed) === want.oracleFeed && ethers.getAddress(have.acquisitionPool) === want.acquisitionPool && have.minimumRouteLiquidityUsdWad === want.minimumRouteLiquidityUsdWad && Number(have.maxSwapSlippageBps) === want.maxSwapSlippageBps && Number(have.maxOracleDeviationBps) === want.maxOracleDeviationBps && Number(have.maxPriceImpactBps) === want.maxPriceImpactBps && Number(have.maxGraduationPriceDeviationBps) === want.maxGraduationPriceDeviationBps;
    if (!same) calls.push({ contract: "BnbQuoteGraduationAdapter", to: adapterAddress, fn: "configureQuoteRoute", args: [facts.token, tupleArg(want as any, ROUTE_FIELDS)] });
    let vaultAction = "none";
    if (vault) {
      if (ethers.getAddress(await vault.quoteRoutePool(facts.token)) === ethers.getAddress(facts.canonical)) vaultAction = "unchanged";
      else {
        vaultAction = "set";
        // Topaz: the vault reads the volatile WBNB/quote pool itself; the fee tier argument is unused (0).
        calls.push({ contract: "CreatorRewardsVaultV2", to: await vault.getAddress(), fn: "setQuoteRoute", args: [facts.token, 0] });
      }
    }
    results.push({ symbol: r.symbol, token: facts.token, pool: facts.canonical, feed: want.oracleFeed, feedPrice: facts.feedPrice, feedAgeSeconds: facts.feedAgeSeconds, poolUsd: facts.poolUsd, adapter: same ? "unchanged" : "configure", vault: vaultAction });
    console.log(`  ${(same ? "unchanged" : "configure").padEnd(10)} vault ${vaultAction.padEnd(9)} ${r.symbol.padEnd(7)} feed $${facts.feedPrice.toFixed(4)} (${facts.feedAgeSeconds}s)  pool ${facts.canonical.slice(0, 10)}… ~$${facts.poolUsd.toLocaleString()}`);
  }
  return { calls, results };
}

export function readGenerationRecord(file: string) {
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  const contracts = record.contracts || {};
  const adapter = contracts.BnbQuoteGraduationAdapter;
  const factory = contracts.BnbBasicLaunchFactory;
  const vault = record.inputs?.creatorVault;
  if (!adapter || !factory) throw new Error(`BnbQuoteGraduationAdapter / BnbBasicLaunchFactory not found in ${file}`);
  return { adapter: ethers.getAddress(adapter), factory: ethers.getAddress(factory), vault: vault ? ethers.getAddress(vault) : undefined };
}

export async function main() {
  const profileName = await profileNetworkName();
  const chainId = (await ethers.provider.getNetwork()).chainId;
  if (chainId !== BNB_MAINNET_CHAIN_ID || profileName !== "bscMainnet") throw new Error(`this script is for BNB mainnet (56) or its fork rehearsal; ${network.name} reports ${chainId}`);
  const send = process.env.ROUTES_SEND === "1";
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  assertPolicyFitsQuoteAdapter(cfg.policy);
  const addr = readGenerationRecord(String(process.env.ROUTES_GENERATION_RECORD || "").trim() || GENERATION_RECORD);
  const [signer] = await ethers.getSigners();
  const adapter = new ethers.Contract(addr.adapter, ADAPTER_ABI, signer);
  const vault = addr.vault ? new ethers.Contract(addr.vault, VAULT_ABI, signer) : undefined;
  const admin = ethers.getAddress(await adapter.admin());
  if (vault && ethers.getAddress(await vault.admin()) !== admin) throw new Error(`vault admin ${await vault.admin()} differs from adapter admin ${admin}`);
  if (Number(await adapter.MAX_ROUTE_LIMIT_BPS()) !== QUOTE_ADAPTER_MAX_ROUTE_LIMIT_BPS) throw new Error("adapter MAX_ROUTE_LIMIT_BPS differs from the script's 100");
  const signerIsAdmin = admin === ethers.getAddress(signer.address);
  console.log(`[bnb-routes] chain ${chainId} (${network.name}) adapter ${addr.adapter} factory ${addr.factory} vault ${addr.vault ?? "(none)"} admin ${admin}${signerIsAdmin ? " = signer" : " (Safe batch)"}`);
  const bind = await planFactoryBind(adapter, addr.factory);
  if (!cfg.routes.length && !bind) { console.log(`[bnb-routes] the facts file has no bindable route (floor $${cfg.floorUsd}); re-run scripts/scan-bnb-quote-routes.mjs when Topaz liquidity changes`); return { calls: [], results: [] }; }
  const nowSeconds = (await ethers.provider.getBlock("latest"))!.timestamp;
  const { calls: routeCalls, results } = await planRoutes({ adapter, vault, routes: cfg.routes, policy: cfg.policy, nowSeconds });
  const calls = [...(bind ? [bind] : []), ...routeCalls];
  if (!calls.length) { console.log("[bnb-routes] nothing to do"); return { calls, results }; }
  console.log(`[bnb-routes] simulating ${calls.length} call(s) as ${admin}`);
  await simulateAsAdmin(admin, calls);
  if (signerIsAdmin) {
    if (!send) { console.log("[bnb-routes] DRY RUN: the signer is the admin; ROUTES_SEND=1 to send."); return { calls, results }; }
    const txs = await sendPlanned(signer, calls);
    fs.writeFileSync(rehearsalPath(RECORD_PATH), JSON.stringify({ network: network.name, chainId: Number(chainId), at: new Date().toISOString(), ...addr, policy: cfg.policy, routes: results, txs }, null, 2) + "\n");
    return { calls, results };
  }
  if (send) throw new Error(`ROUTES_SEND=1 but the admin is ${admin}, not the signer: these calls are a Safe batch, never a deployer send`);
  const out = rehearsalPath(String(process.env.ROUTES_BATCH_OUT || "").trim() || BATCH_PATH);
  writeSafeBatch(out, Number(chainId), "MWZ gen6 Q: BNB quote routes", `${bind ? "bind quote adapter; " : ""}${routeCalls.length} route call(s): ${results.map((r) => r.symbol).join(", ") || "none"}`, calls);
  console.log(`[bnb-routes] wrote ${out} (${calls.length} call(s)); every call simulated OK as the Safe.`);
  return { calls, results, batch: out };
}

if (require.main === module) { main().catch((error) => { console.error(error); process.exitCode = 1; }); }
