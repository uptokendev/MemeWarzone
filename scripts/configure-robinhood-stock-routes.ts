/**
 * Bind Robinhood Stock Tokens (and USDG) as graduation quotes on the generation 6/5 stock adapter
 * (RobinhoodStockGraduationAdapterV2) and the creator vault (CreatorRewardsVaultV2.setQuoteRoute).
 *
 * Reads config/robinhood/mainnet-stock-routes.json and, for every route, re-derives the facts from chain
 * before planning anything: the token and feed have code, the feed answered within the adapter's oracle
 * age, the acquisition pool is the canonical V3 (WETH, token, feeTier) pool -- the adapter's own rule --
 * its fee tier is at most 3000 (E11), and the STOCK it holds is worth at least the floor (the adapter's
 * depth rule, `RouteLiquidityTooLow`). The policy itself is checked against the adapter's rules
 * (`assertPolicyFitsStockAdapterV2`): slippage 1..100 bps, the two reserved fields 0.
 *
 * Who sends: the adapter's and the vault's admin is immutable. On 4663 it is the Safe, so the planned calls
 * are written as a Safe Transaction Builder batch (deployments/robinhood/mainnet.stock-routes.Q.safe-batch.json)
 * and each call is simulated with eth_call from the Safe first; nothing is sent. Only when the signer is
 * itself the admin (a testnet cut) does ROUTES_SEND=1 send directly.
 *
 * Step 0: if the adapter is not yet bound to the factory (batch B normally does it), the bind is the batch's
 * first call, after checking the factory names this adapter back.
 *
 *   npx hardhat run scripts/configure-robinhood-stock-routes.ts --network robinhoodMainnet     # plan + simulate + batch
 *   ROUTES_GENERATION_RECORD=<path> ...   # another generation record (the fork rehearsal uses its own)
 *
 * Rehearsed by test/RobinhoodStockRoutesConfigure.spec.ts and, on a 4663 fork, by
 * scripts/rehearse-evm-gen6-mainnet-fork.ts (which executes the batch as the Safe).
 */
import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";
import { PlannedCall, simulateAsAdmin, tupleArg, writeSafeBatch } from "./lib/safeCallPlan";
import { profileNetworkName, rehearsalPath } from "./lib/forkRehearsal";

export const ROBINHOOD_MAINNET_CHAIN_ID = 4663n;
const ROOT = path.resolve(__dirname, "..");
export const CONFIG_PATH = path.join(ROOT, "config", "robinhood", "mainnet-stock-routes.json");
export const RECORD_PATH = path.join(ROOT, "deployments", "robinhood", "mainnet.stock-routes.json");
export const BATCH_PATH = path.join(ROOT, "deployments", "robinhood", "mainnet.stock-routes.Q.safe-batch.json");
export const GENERATION_RECORD = path.join(ROOT, "deployments", "robinhood", "mainnet.quote-generation.json");

/** RobinhoodStockGraduationAdapterV2 limits (contract constants; re-read from chain by the script). */
export const STOCK_ADAPTER_V2_RULES = { maxSwapSlippageBps: 100, maxAcquisitionFeeTier: 3000 } as const;

export const ADAPTER_ABI = [
  "function admin() view returns (address)",
  "function campaignFactory() view returns (address)",
  "function campaignFactoryLocked() view returns (bool)",
  "function v3Factory() view returns (address)",
  "function WETH() view returns (address)",
  "function nativeUsdOracle() view returns (address)",
  "function maxOracleAgeSeconds() view returns (uint32)",
  "function MAX_SWAP_SLIPPAGE_BPS() view returns (uint16)",
  "function MAX_ACQUISITION_FEE_TIER() view returns (uint24)",
  "function stockRoutes(address) view returns (address oracleFeed,address acquisitionPool,uint24 acquisitionFeeTier,uint256 minimumRouteLiquidityUsdWad,uint16 maxSwapSlippageBps,uint16 maxOracleDeviationBps,uint16 maxPriceImpactBps,bool enabled)",
  "function setCampaignFactoryOnce(address)",
  "function configureStockRoute(address stockToken, (address oracleFeed,address acquisitionPool,uint24 acquisitionFeeTier,uint256 minimumRouteLiquidityUsdWad,uint16 maxSwapSlippageBps,uint16 maxOracleDeviationBps,uint16 maxPriceImpactBps,bool enabled) route)",
];
export const VAULT_ABI = ["function admin() view returns (address)", "function quoteRoutePool(address) view returns (address)"];
const FACTORY_ABI = ["function stockGraduationAdapter() view returns (address)"];
const V3_FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const FEED_ABI = ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)", "function decimals() view returns (uint8)"];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"];
const ROUTE_FIELDS = ["oracleFeed", "acquisitionPool", "acquisitionFeeTier", "minimumRouteLiquidityUsdWad", "maxSwapSlippageBps", "maxOracleDeviationBps", "maxPriceImpactBps", "enabled"];

export type RouteInput = { symbol: string; stockToken: string; oracleFeed: string; acquisitionPool: string; acquisitionFeeTier: number };
export type Policy = { minimumRouteLiquidityUsd: string; maxSwapSlippageBps: number; maxOracleDeviationBps: number; maxPriceImpactBps: number };

/**
 * The adapter's configureStockRoute rules, checked before any chain read: InvalidPolicy for slippage above
 * 100 or either reserved field non-zero or a zero floor; InvalidFeeTier above 3000. Returns every violation.
 */
export function stockRouteViolations(r: Pick<RouteInput, "symbol" | "acquisitionFeeTier">, policy: Policy): string[] {
  const out: string[] = [];
  if (!(policy.maxSwapSlippageBps > 0 && policy.maxSwapSlippageBps <= STOCK_ADAPTER_V2_RULES.maxSwapSlippageBps)) out.push(`${r.symbol}: maxSwapSlippageBps ${policy.maxSwapSlippageBps} outside 1..${STOCK_ADAPTER_V2_RULES.maxSwapSlippageBps}`);
  if (policy.maxOracleDeviationBps !== 0) out.push(`${r.symbol}: maxOracleDeviationBps must be 0 (reserved), is ${policy.maxOracleDeviationBps}`);
  if (policy.maxPriceImpactBps !== 0) out.push(`${r.symbol}: maxPriceImpactBps must be 0 (reserved), is ${policy.maxPriceImpactBps}`);
  if (!(Number(policy.minimumRouteLiquidityUsd) > 0)) out.push(`${r.symbol}: minimumRouteLiquidityUsd must be positive`);
  if (!(r.acquisitionFeeTier > 0 && r.acquisitionFeeTier <= STOCK_ADAPTER_V2_RULES.maxAcquisitionFeeTier)) out.push(`${r.symbol}: acquisitionFeeTier ${r.acquisitionFeeTier} above ${STOCK_ADAPTER_V2_RULES.maxAcquisitionFeeTier} (E11)`);
  return out;
}

export function assertPolicyFitsStockAdapterV2(routes: RouteInput[], policy: Policy) {
  const all = routes.flatMap((r) => stockRouteViolations(r, policy));
  if (all.length) throw new Error(`the route file does not satisfy RobinhoodStockGraduationAdapterV2:\n  ${all.join("\n  ")}`);
}

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
  const [v3FactoryAddr, weth, maxAge] = await Promise.all([adapter.v3Factory(), adapter.WETH(), adapter.maxOracleAgeSeconds()]);
  if (token === ethers.getAddress(weth)) throw new Error(`${r.symbol}: token is WETH`);
  if ((await provider.getCode(token)) === "0x") throw new Error(`${r.symbol}: token ${token} has no code`);
  if ((await provider.getCode(r.oracleFeed)) === "0x") throw new Error(`${r.symbol}: oracle feed ${r.oracleFeed} has no code`);
  const feed = new ethers.Contract(r.oracleFeed, FEED_ABI, provider);
  const [, answer, , updatedAt] = await feed.latestRoundData();
  const age = nowSeconds - Number(updatedAt);
  if (answer <= 0n) throw new Error(`${r.symbol}: feed answer ${answer}`);
  if (age > Number(maxAge)) throw new Error(`${r.symbol}: feed is ${age}s old, adapter allows ${maxAge}s`);
  const canonical = await new ethers.Contract(v3FactoryAddr, V3_FACTORY_ABI, provider).getPool(weth, token, r.acquisitionFeeTier);
  if (canonical === ethers.ZeroAddress) throw new Error(`${r.symbol}: no V3 pool for (WETH, token, ${r.acquisitionFeeTier})`);
  if (ethers.getAddress(canonical) !== ethers.getAddress(r.acquisitionPool)) throw new Error(`${r.symbol}: configured pool ${r.acquisitionPool} is not the canonical ${canonical}`);
  // Depth the way the adapter measures it at graduation: STOCK held by the pool x the stock feed.
  const stock = new ethers.Contract(token, ERC20_ABI, provider);
  const [stockInPool, stockDecimals, feedDecimals] = await Promise.all([stock.balanceOf(canonical), stock.decimals(), feed.decimals()]);
  const feedPrice = Number(answer) / 10 ** Number(feedDecimals);
  const stockSideUsd = Math.round((Number(stockInPool) / 10 ** Number(stockDecimals)) * feedPrice);
  const floorUsd = Number(policy.minimumRouteLiquidityUsd);
  if (stockSideUsd < floorUsd) throw new Error(`${r.symbol}: pool holds ~$${stockSideUsd} of the stock, below the $${floorUsd} floor (RouteLiquidityTooLow at graduation)`);
  return { token, canonical, feedPrice, feedAgeSeconds: age, stockSideUsd };
}

/** The bind call, when the adapter is not yet locked to the factory (and the factory names this adapter). */
export async function planFactoryBind(adapter: any, factoryAddress: string): Promise<PlannedCall | null> {
  const [current, locked] = await Promise.all([adapter.campaignFactory(), adapter.campaignFactoryLocked()]);
  const factory = ethers.getAddress(factoryAddress);
  if (locked) {
    if (ethers.getAddress(current) !== factory) throw new Error(`adapter is locked to ${current}, not the factory ${factory}`);
    return null;
  }
  const back = await new ethers.Contract(factory, FACTORY_ABI, adapter.runner).stockGraduationAdapter();
  if (ethers.getAddress(back) !== ethers.getAddress(await adapter.getAddress())) throw new Error(`factory ${factory} names ${back} as its stock adapter, not this one`);
  return { contract: "RobinhoodStockGraduationAdapterV2", to: await adapter.getAddress(), fn: "setCampaignFactoryOnce", args: [factory] };
}

/** Plan every route: verified facts, then the adapter call (skipped when identical) and the vault route. */
export async function planRoutes({ adapter, vault, routes, policy, nowSeconds }: { adapter: any; vault?: any; routes: RouteInput[]; policy: Policy; nowSeconds: number }) {
  assertPolicyFitsStockAdapterV2(routes, policy);
  const provider = adapter.runner.provider;
  const adapterAddress = await adapter.getAddress();
  const calls: PlannedCall[] = [];
  const results: any[] = [];
  // ROUTES_SKIP_SYMBOLS: leave named routes out of this batch entirely (a weekend-stale feed makes
  // configureStockRoute revert OracleStale on chain); a later run adds them once the feed is fresh.
  const skip = String(process.env.ROUTES_SKIP_SYMBOLS || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  for (const r of routes) {
    if (skip.includes(r.symbol.toUpperCase())) {
      console.log(`  skipped    ${r.symbol} (ROUTES_SKIP_SYMBOLS): not in this batch, add it in a later run`);
      continue;
    }
    const facts = await verifyRouteFacts(provider, adapter, r, policy, nowSeconds);
    const want = routeStruct(r, policy);
    const have = await adapter.stockRoutes(facts.token);
    const same = have.enabled && ethers.getAddress(have.oracleFeed) === want.oracleFeed && ethers.getAddress(have.acquisitionPool) === want.acquisitionPool && Number(have.acquisitionFeeTier) === want.acquisitionFeeTier && have.minimumRouteLiquidityUsdWad === want.minimumRouteLiquidityUsdWad && Number(have.maxSwapSlippageBps) === want.maxSwapSlippageBps && Number(have.maxOracleDeviationBps) === want.maxOracleDeviationBps && Number(have.maxPriceImpactBps) === want.maxPriceImpactBps;
    if (!same) calls.push({ contract: "RobinhoodStockGraduationAdapterV2", to: adapterAddress, fn: "configureStockRoute", args: [facts.token, tupleArg(want as any, ROUTE_FIELDS)] });
    let vaultAction = "none";
    if (vault) {
      const pool = await vault.quoteRoutePool(facts.token);
      if (ethers.getAddress(pool) === ethers.getAddress(facts.canonical)) vaultAction = "unchanged";
      else {
        vaultAction = "set";
        calls.push({ contract: "CreatorRewardsVaultV2", to: await vault.getAddress(), fn: "setQuoteRoute", args: [facts.token, r.acquisitionFeeTier], note: "the vault converts through the same canonical pool" });
      }
    }
    results.push({ symbol: r.symbol, token: facts.token, pool: facts.canonical, feeTier: r.acquisitionFeeTier, feed: want.oracleFeed, feedPrice: facts.feedPrice, feedAgeSeconds: facts.feedAgeSeconds, stockSideUsd: facts.stockSideUsd, adapter: same ? "unchanged" : "configure", vault: vaultAction });
    console.log(`  ${(same ? "unchanged" : "configure").padEnd(10)} vault ${vaultAction.padEnd(9)} ${r.symbol.padEnd(6)} feed $${facts.feedPrice.toFixed(2)} (${facts.feedAgeSeconds}s)  pool ${facts.canonical.slice(0, 10)}… fee ${r.acquisitionFeeTier} stock side ~$${facts.stockSideUsd.toLocaleString()}`);
  }
  return { calls, results };
}

/** Send planned calls from a signer that is the admin (testnet cuts only). */
export async function sendPlanned(signer: any, calls: PlannedCall[]) {
  const hashes: string[] = [];
  for (const c of calls) {
    const iface = (await ethers.getContractFactory(c.contract)).interface;
    const tx = await signer.sendTransaction({ to: c.to, data: iface.encodeFunctionData(c.fn, c.args as any[]) });
    const rc = await tx.wait();
    if (!rc || rc.status !== 1) throw new Error(`${c.fn} on ${c.to} failed`);
    hashes.push(tx.hash);
  }
  return hashes;
}

export function readGenerationRecord(file: string) {
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  const deployed = record.deployed || record.contracts || {};
  const adapter = String(process.env.ROUTES_STOCK_ADAPTER || "").trim() || deployed.RobinhoodStockGraduationAdapterV2;
  const factory = deployed.LaunchFactory;
  const vault = record.creatorVault;
  if (!adapter || !factory) throw new Error(`RobinhoodStockGraduationAdapterV2 / LaunchFactory not found in ${file} (a generation 6/5 record)`);
  return { adapter: ethers.getAddress(adapter), factory: ethers.getAddress(factory), vault: vault ? ethers.getAddress(vault) : undefined };
}

export async function main() {
  const profileName = await profileNetworkName();
  const chainId = (await ethers.provider.getNetwork()).chainId;
  if (chainId !== ROBINHOOD_MAINNET_CHAIN_ID || profileName !== "robinhoodMainnet") throw new Error(`this script is for Robinhood mainnet (4663) or its fork rehearsal; ${network.name} reports ${chainId}`);
  const send = process.env.ROUTES_SEND === "1";
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const recordFile = String(process.env.ROUTES_GENERATION_RECORD || "").trim() || GENERATION_RECORD;
  const addr = readGenerationRecord(recordFile);
  const [signer] = await ethers.getSigners();
  const adapter = new ethers.Contract(addr.adapter, ADAPTER_ABI, signer);
  const vault = addr.vault ? new ethers.Contract(addr.vault, VAULT_ABI, signer) : undefined;
  const admin = ethers.getAddress(await adapter.admin());
  if (vault && ethers.getAddress(await vault.admin()) !== admin) throw new Error(`vault admin ${await vault.admin()} differs from adapter admin ${admin}; split the batch by hand`);
  // The contract constants, so a policy file can never drift from the deployed adapter.
  const [maxSlip, maxTier] = await Promise.all([adapter.MAX_SWAP_SLIPPAGE_BPS(), adapter.MAX_ACQUISITION_FEE_TIER()]);
  if (Number(maxSlip) !== STOCK_ADAPTER_V2_RULES.maxSwapSlippageBps || Number(maxTier) !== STOCK_ADAPTER_V2_RULES.maxAcquisitionFeeTier) throw new Error(`adapter limits ${maxSlip}/${maxTier} differ from the script's ${JSON.stringify(STOCK_ADAPTER_V2_RULES)}`);
  const signerIsAdmin = admin === ethers.getAddress(signer.address);
  console.log(`[routes] chain ${chainId} (${network.name}) adapter ${addr.adapter} factory ${addr.factory} vault ${addr.vault ?? "(none)"} admin ${admin}${signerIsAdmin ? " = signer" : " (Safe batch)"}`);
  console.log(`[routes] ${cfg.routes.length} routes, floor $${cfg.policy.minimumRouteLiquidityUsd}, slippage ${cfg.policy.maxSwapSlippageBps} bps; excluded in the file: ${(cfg.excluded || []).map((e: any) => e.symbol).join(", ") || "none"}`);

  const bind = await planFactoryBind(adapter, addr.factory);
  const nowSeconds = (await ethers.provider.getBlock("latest"))!.timestamp;
  const { calls: routeCalls, results } = await planRoutes({ adapter, vault, routes: cfg.routes, policy: cfg.policy, nowSeconds });
  const calls = [...(bind ? [bind] : []), ...routeCalls];
  if (!calls.length) { console.log("[routes] nothing to do: every route is already configured"); return { calls, results }; }

  console.log(`[routes] simulating ${calls.length} call(s) as ${admin}`);
  await simulateAsAdmin(admin, calls);

  if (signerIsAdmin) {
    if (!send) { console.log("[routes] DRY RUN: the signer is the admin; ROUTES_SEND=1 to send."); return { calls, results }; }
    const hashes = await sendPlanned(signer, calls);
    fs.writeFileSync(await rehearsalPath(RECORD_PATH), JSON.stringify({ network: network.name, chainId: Number(chainId), at: new Date().toISOString(), ...addr, policy: cfg.policy, routes: results, txs: hashes }, null, 2) + "\n");
    return { calls, results };
  }
  if (send) throw new Error(`ROUTES_SEND=1 but the admin is ${admin}, not the signer: these calls are a Safe batch, never a deployer send`);
  const out = await rehearsalPath(String(process.env.ROUTES_BATCH_OUT || "").trim() || BATCH_PATH);
  writeSafeBatch(out, Number(chainId), "MWZ gen6 Q: Robinhood stock routes", `${bind ? "bind stock adapter; " : ""}${routeCalls.length} route call(s): ${results.map((r) => r.symbol).join(", ")}`, calls);
  console.log(`[routes] wrote ${out} (${calls.length} call(s)); every call simulated OK as the Safe. Check it with runbook 3.1, then sign.`);
  return { calls, results, batch: out };
}

if (require.main === module) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
