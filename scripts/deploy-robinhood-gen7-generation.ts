/**
 * Robinhood EVM launch generation 7 (factory 7 / campaign 6): docs/evm-launch/EVM_GEN7_V2_PLAN.md.
 *
 * WHY THIS SCRIPT ALSO DEPLOYS A FEES STACK (plan C10 does not hold as written on Robinhood):
 *   The live gen-6 stack cannot serve a second factory. LaunchFactoryGen7._createCampaign registers every coin's
 *   fee choice with `ICreatorRewardsVaultV2(feeRecipient.creatorRewardsVault()).setCampaignChoice`
 *   (contracts/gen7/LaunchFactoryGen7.sol:552, vault read at :1001), and CreatorRewardsVaultV2.setCampaignChoice
 *   is `msg.sender == factory` (contracts/CreatorRewardsVaultV2.sol:302) where `factory` is set once
 *   (setFactoryOnce, :237-245). On 4663 the live vault 0xEDCC2667… is pinned to the gen-6 factory 0xc673B116…
 *   (read from chain 2026-10-08), and TreasuryRouterV4.setCreatorRewardsVault is set-once ("already set",
 *   contracts/TreasuryRouterV4.sol:312-316). So a gen-7 factory whose feeRecipient is the live router V4 reverts
 *   OnlyFactory on every create (proven on the fork: test/evmgen7-rh-core-integration.fork.spec.ts). The vault's
 *   router is immutable too, so gen-7 gets its own TreasuryRouterV4 + CreatorRewardsVaultV2 + holder
 *   RewardDistributor (same bytecode, admin = the Safe), and a fresh CommunityRewardsVault: that vault serves one
 *   router (`onlyRouter` deposits, contracts/CommunityRewardsVault.sol:41-44,74-84) and re-pointing the live one
 *   would revert every gen-6 trade ("airdrop route failed", TreasuryRouterV4.sol _routeTrade). Weekly, monthly,
 *   recruiter and protocol vaults take plain value from any sender and are reused, read from the live router V4.
 *   This is the same shape the gen-6 testnet cuts used (deploy-robinhood-testnet-gen6-fees.ts).
 *   GEN-7 AIRDROP POT (founder, 2026-10-08: two pots per chain, everything automated; scripts/lib/gen7AirdropPot.ts):
 *   the live airdrop RewardDistributor serves one batchOperator, so the fees step also deploys a gen-7 airdrop
 *   RewardDistributor (owner = the Safe); A7 wires it (community vault setRewardDistributor + setAirdropOperator(= the
 *   live community vault's airdropOperator()), distributor setBatchOperator(community vault)) and pre-authorizes 12
 *   weeks x {airdrop_trader, airdrop_creator} with the runner's own ids at the main pot's current per-batch cap
 *   (GEN7_AIRDROP_CAP / GEN7_AIRDROP_OPERATOR override). After A7: COMMUNITY_REWARDS_VAULT_ADDRESS_GEN7_<id> +
 *   REWARD_DISTRIBUTOR_ADDRESS_GEN7_<id> on the API and the weekly airdrop job (printed by the fees step).
 *
 * What is new, and why (contract evidence):
 *   LaunchCampaignGen7 / RobinhoodStockLaunchCampaignGen7   the implementations the factory clones.
 *   LaunchFactoryGen7 + PermanentV3PositionLocker           C9; the locker's admin is the factory (immutable).
 *   RobinhoodV3NativeGraduationAdapterV2 (new instance)     setCampaignFactoryOnce binds one factory forever and
 *   RobinhoodStockGraduationAdapterV2 (new instance)        reads that factory's locker (RobinhoodV3PoolRepair.sol
 *                                                           :292-303); `_checkCaller` serves only that factory's
 *                                                           campaigns (:383-387). The live pair is bound to gen-6.
 *   LaunchTokenDeployer                                     stateless (contracts/token/LaunchTokenDeployer.sol);
 *                                                           a fresh one comes from wireGenerationCreatePath.
 * Reused unchanged: RobinhoodV3NativeSwapAdapter (stateless, constructor(swapRouter, weth)), GraduationOracle,
 * CreatorRegistry + RiskRegistry (Safe-owned; the Safe adds the gen-7 factory as a launch recorder, so cooldown
 * and live-coin counts span both generations), the Uniswap V3 stack, WETH, the Safe.
 *
 * Mainnet order (each step a founder go; every Safe batch is simulated as the Safe before it is written):
 *   1. RH_GEN7_STEP=fees        deployer: router V4 + vault V2 + distributor + community vault + gen-7 airdrop
 *                               distributor -> batch A7
 *   2. Safe executes A7         router vaults, distributor <-> vault, vault operator + caps (mirrors gen-6 live),
 *                               gen-7 airdrop pot wiring + 12 weeks pre-authorized
 *   3. RH_GEN7_STEP=generation  deployer: impls, adapters, locker + factory, create path, stock impl (R5
 *                               folded in: the deployer still owns the factory), registries, createPaused
 *                               -> batch B7 (locker on V4, vault pin, both adapter binds, launch recorder)
 *   4. Safe executes B7
 *   5. transfer-evm-ownership-to-safe.ts (factory)
 *   6. RH_GEN7_STEP=batches     rebuilds A7/B7 from chain (only what is still missing) + Q7 (stock routes on the
 *                               new adapter and vault) + H7 (gen-7 enableLive + setCreatePaused(false), gen-6
 *                               0xc673B116 setCreatePaused(true) = C11)
 *   7. Safe executes Q7, then H7 (after the canary and the founder's go)
 *
 * Testnet (46630): RH_GEN7_STEP=all deploys everything with the deployer as admin (as gen-6b), sends every
 * wiring call itself, reuses the gen-6b testnet vaults/registries/oracle/V3 stack from
 * deployments/robinhood/testnet.gen6b.json, lands createPaused and not live, and writes
 * deployments/robinhood/testnet.gen7.json. The lifecycle script opens it.
 *
 *   CONFIRM_ROBINHOOD_GEN7=I_UNDERSTAND_TESTNET RH_GEN7_STEP=all \
 *     npx hardhat run scripts/deploy-robinhood-gen7-generation.ts --network robinhoodTestnet
 *   CONFIRM_ROBINHOOD_GEN7=I_UNDERSTAND_MAINNET RH_GEN7_STEP=fees|generation \
 *     npx hardhat run scripts/deploy-robinhood-gen7-generation.ts --network robinhoodMainnet
 *   RH_GEN7_STEP=batches npx hardhat run scripts/deploy-robinhood-gen7-generation.ts --network robinhoodMainnet
 *
 * robinhoodForkRehearsal is accepted as robinhoodMainnet after scripts/lib/forkRehearsal.ts proves a local anvil
 * fork; records and batches then land under deployments/fork-rehearsal/.
 */
import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";
import { deployFactoryWithLocker } from "./lib/deployFactoryWithLocker";
import { isForkRehearsalNetwork, profileNetworkName, rehearsalPath } from "./lib/forkRehearsal";
import { PlannedCall, simulateAsAdmin, writeSafeBatch } from "./lib/safeCallPlan";
import { wireGenerationCreatePath } from "./lib/evmGenerationCreateWiring";
import { batchACalls, batchBFromChain, deployFeesStack, PINS, type Caps, type ChainPins } from "./deploy-evm-treasury-router-v4";
import {
  assertFeeTierSpacing,
  assertFeedWithinMaxAge,
  assertNativeAdapterMatches,
  assertRouterCanServeStrictRouting,
  bindAdapterToFactory,
  deployNativeGraduationAdapter,
  deployStockGraduationAdapter,
  maxOracleAgeFor,
  resolveAdapterAdmin,
  resolveRouteAuthorityAndOwner,
} from "./deploy-robinhood-quote-generation";
import { ADAPTER_ABI, VAULT_ABI, planRoutes } from "./configure-robinhood-stock-routes";
import { refreshMockFeed } from "./deploy-robinhood-testnet-gen6-fees";
import { deployGen7AirdropDistributor, planGen7AirdropCalls, printGen7AirdropEnv, resolveGen7AirdropSetup, type Gen7AirdropSetup } from "./lib/gen7AirdropPot";

const ROOT = path.resolve(__dirname, "..");
const DEPLOYMENTS = path.join(ROOT, "deployments", "robinhood");
const same = (a: string, b: string) => ethers.getAddress(a) === ethers.getAddress(b);

/** Robinhood mainnet (4663), read from deployments/robinhood/*.json and re-read from chain by every step. */
export const RH_MAINNET = {
  chainId: 4663,
  safe: "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7",
  deployer: "0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714",
  routeAuthority: "0xb989A99823eA96552c3E3198A40CdBF682EDf1aA",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  v3Factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
  positionManager: "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3",
  swapRouter: "0xCaf681a66D020601342297493863E78C959E5cb2",
  nativeUsdFeed: "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9",
  graduationOracle: "0xe635AA43fE5707561c8c3C655225da5C3e4C2239",
  // gen-6 (mainnet.quote-generation.json, mainnet.evmgen-fees.json), live since 2026-10-01
  gen6Factory: "0xc673B116b4eA8E8923Aad1fa60F0452966F2437F",
  gen6Router: "0x49Ae38B19664d90b410AE860B9604e1Bc5f7Ab5d",
  gen6Vault: "0xEDCC2667365F116b9971Cc02f198470BE23a5651",
  creatorRegistry: "0xAE3D6d8cde4daD5D835D7B487298F09Ec5b41589",
  riskRegistry: "0x174E4d5AF15dF8e600E2025acbd33B52485cEcA4",
  nativeSwapAdapter: "0xDfd381ECfA6D4CcD4248e319C6fecD76A6bf3296",
} as const;

/** The accepted gen-6b testnet cut (deployments/robinhood/testnet.gen6b.json). */
export const TESTNET_GEN6B_RECORD = path.join(DEPLOYMENTS, "testnet.gen6b.json");

export const RECORD_MAINNET = path.join(DEPLOYMENTS, "mainnet.gen7.json");
export const RECORD_TESTNET = path.join(DEPLOYMENTS, "testnet.gen7.json");
export const BATCH_FILES = {
  A: path.join(DEPLOYMENTS, "mainnet.gen7.A-fees.safe-batch.json"),
  B: path.join(DEPLOYMENTS, "mainnet.gen7.B-bind.safe-batch.json"),
  Q: path.join(DEPLOYMENTS, "mainnet.gen7.Q-stock-routes.safe-batch.json"),
  H: path.join(DEPLOYMENTS, "mainnet.gen7.H-open.safe-batch.json"),
};
const STOCK_ROUTES_CONFIG = path.join(ROOT, "config", "robinhood", "mainnet-stock-routes.json");

const PROFILES: Record<string, { chainId: bigint; confirm: string }> = {
  robinhoodTestnet: { chainId: 46630n, confirm: "I_UNDERSTAND_TESTNET" },
  robinhoodMainnet: { chainId: 4663n, confirm: "I_UNDERSTAND_MAINNET" },
};

const LIVE_ROUTER_ABI = [
  "function admin() view returns (address)",
  "function weeklyLeagueVault() view returns (address)",
  "function monthlyLeagueTreasury() view returns (address)",
  "function recruiterRewardsVault() view returns (address)",
  "function communityRewardsVault() view returns (address)",
  "function protocolRevenueVault() view returns (address)",
  "function creatorRewardsVault() view returns (address)",
];
const LIVE_VAULT_ABI = [
  "function factory() view returns (address)",
  "function operator() view returns (address)",
  "function limits() view returns (bool,uint256,uint256,uint256,uint256,uint256)",
];

export type Gen7Fees = {
  admin: string;
  router: string;
  vault: string;
  holderDistributor: string;
  communityRewardsVault: string;
  /** The gen-7 AIRDROP RewardDistributor (batchOperator = communityRewardsVault), not the holder distributor. */
  airdropDistributor: string;
  airdrop: Gen7AirdropSetup;
  reusedVaults: { weekly: string; monthly: string; recruiter: string; protocol: string };
  operator: string;
  caps: Record<string, string>;
  liveRouter: string;
  liveVaultPinnedTo: string;
};

function log(line: string) {
  console.log(`[rh-gen7] ${line}`);
}

async function requireCode(label: string, address: string) {
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") throw new Error(`${label} has no code at ${address}`);
}

async function waitTx(txPromise: Promise<any> | any, label: string) {
  const tx = await txPromise;
  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) throw new Error(`${label} failed`);
  log(`${label}: ${tx.hash}`);
  return receipt;
}

function bigJson(value: unknown) {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(bigJson(value), null, 2)}\n`);
  log(`wrote ${file}`);
}

/**
 * The live gen-6 fees stack this generation shares vaults with: league vaults, recruiter and protocol (any sender),
 * read from the live router; the vault operator and caps of the live vault (mirrored, so both generations pay out
 * under the same limits). Proves the live vault is pinned to another factory (why gen-7 needs its own).
 */
export async function readLiveFeesStack(liveRouter: string, liveVaultCapsFallback?: Partial<Caps>) {
  const r = new ethers.Contract(liveRouter, LIVE_ROUTER_ABI, ethers.provider);
  const [admin, weekly, monthly, recruiter, community, protocol, vault] = await Promise.all([
    r.admin(), r.weeklyLeagueVault(), r.monthlyLeagueTreasury(), r.recruiterRewardsVault(), r.communityRewardsVault(), r.protocolRevenueVault(), r.creatorRewardsVault(),
  ]);
  const v = new ethers.Contract(vault, LIVE_VAULT_ABI, ethers.provider);
  const [pinned, operator, lim] = await Promise.all([v.factory(), v.operator(), v.limits()]);
  for (const [k, a] of Object.entries({ weekly, monthly, recruiter, protocol })) {
    if (a === ethers.ZeroAddress) throw new Error(`live router ${liveRouter} ${k} is unset`);
    await requireCode(`live ${k} vault`, a);
  }
  const caps: Caps = {
    maxBuyPerTx: BigInt(lim[1]),
    maxBuybackPerCampaignWeek: BigInt(lim[2]),
    minBuyInterval: BigInt(lim[3]),
    maxImpactBps: BigInt(lim[4]),
    maxHolderBatchPerWeek: BigInt(lim[5]),
    holderBatchAuthorizationMax: liveVaultCapsFallback?.holderBatchAuthorizationMax ?? BigInt(lim[5]),
  };
  return {
    admin: ethers.getAddress(admin),
    weekly: ethers.getAddress(weekly),
    monthly: ethers.getAddress(monthly),
    recruiter: ethers.getAddress(recruiter),
    liveCommunity: ethers.getAddress(community),
    protocol: ethers.getAddress(protocol),
    liveVault: ethers.getAddress(vault),
    liveVaultPinnedTo: ethers.getAddress(pinned),
    operator: ethers.getAddress(operator),
    caps,
  };
}

/** Batch A7: gen-6 batch A (deploy-evm-treasury-router-v4.ts batchACalls) minus the two calls that would break gen-6. */
export function batchA7Calls(pins: ChainPins, d: { router: string; vault: string; holderDistributor: string }, caps: Caps): PlannedCall[] {
  return batchACalls(pins, d, caps).filter(
    // No old-factory pause here (C11 is in H7), and no CommunityRewardsVault.setRouter: the gen-7 community vault
    // is constructed with the gen-7 router; re-pointing the live one would revert every gen-6 trade.
    (c) => !(c.fn === "setCreatePaused") && !(c.contract === "CommunityRewardsVault" && c.fn === "setRouter"),
  );
}

/**
 * Step 1: the gen-7 fees stack + the gen-7 airdrop distributor. Admin = the Safe on 4663 (deployer only deploys), the
 * deployer on 46630 (`send`: the deployer sends A7 itself, the airdrop pot included).
 */
export async function deployGen7Fees(opts: { admin: string; liveRouter: string; dexFactory: string; weth: string; operator?: string; send: boolean }) {
  const [deployer] = await ethers.getSigners();
  const live = await readLiveFeesStack(opts.liveRouter);
  log(`live router ${opts.liveRouter}: vault ${live.liveVault} pinned to factory ${live.liveVaultPinnedTo} (gen-7 needs its own stack)`);
  const pins: ChainPins = {
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    safe: opts.admin,
    oldRouter: opts.liveRouter,
    oldFactory: live.liveVaultPinnedTo,
    weekly: live.weekly,
    monthly: live.monthly,
    recruiter: live.recruiter,
    community: ethers.ZeroAddress,
    protocol: live.protocol,
    wrappedNative: opts.weth,
    dexKind: 2,
    dexFactory: opts.dexFactory,
    payoutOperator: opts.operator ? ethers.getAddress(opts.operator) : live.operator,
  };
  const { deployBlocks, ...d } = await deployFeesStack(deployer, pins);
  const community = await (await ethers.getContractFactory("CommunityRewardsVault", deployer)).deploy(opts.admin, d.router);
  await community.waitForDeployment();
  const communityAddress = ethers.getAddress(await community.getAddress());
  pins.community = communityAddress;
  log(`TreasuryRouterV4 ${d.router}  CreatorRewardsVaultV2 ${d.vault}  RewardDistributor ${d.holderDistributor}  CommunityRewardsVault ${communityAddress}`);
  const airdropDist = await deployGen7AirdropDistributor(deployer, opts.admin);
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const airdrop = await resolveGen7AirdropSetup({ chainId, mainVault: live.liveCommunity, distributor: airdropDist.address, testnetAdmin: opts.send ? opts.admin : undefined });
  log(`RewardDistributor (gen-7 airdrop) ${airdrop.distributor}: operator ${airdrop.operator} (${airdrop.operatorSource}); cap ${ethers.formatEther(airdrop.cap)} ETH per batch (${airdrop.capSource})`);
  const calls = [...batchA7Calls(pins, d, live.caps), ...(await planGen7AirdropCalls({ chainId, vault: communityAddress, setup: airdrop }))];
  if (opts.send) {
    for (const c of calls) {
      const target = await ethers.getContractAt(c.contract, c.to, deployer);
      await waitTx((target as any)[c.fn](...c.args), `${c.contract}.${c.fn}`);
    }
  }
  const fees: Gen7Fees = {
    admin: opts.admin,
    router: d.router,
    vault: d.vault,
    holderDistributor: d.holderDistributor,
    communityRewardsVault: communityAddress,
    airdropDistributor: airdrop.distributor,
    airdrop,
    reusedVaults: { weekly: live.weekly, monthly: live.monthly, recruiter: live.recruiter, protocol: live.protocol },
    operator: pins.payoutOperator,
    caps: Object.fromEntries(Object.entries(live.caps).map(([k, v]) => [k, v.toString()])),
    liveRouter: opts.liveRouter,
    liveVaultPinnedTo: live.liveVaultPinnedTo,
  };
  return { fees, pins, calls, deployBlocks: { ...deployBlocks, airdropDistributor: airdropDist.block } };
}

/** Everything step 3 needs, per chain. */
export type GenerationInputs = {
  treasuryRouter: string;
  weth: string;
  v3Factory: string;
  positionManager: string;
  swapRouter: string;
  nativeUsdFeed: string;
  graduationOracle: string;
  creatorRegistry: string;
  riskRegistry: string;
  routeAuthority: string;
  owner: string;
  adapterAdmin: string;
  maxOracleAgeSeconds: number;
};

/**
 * Step 3: the gen-7 generation. Every `whenMutable` factory setter is sent by the deployer (it owns the factory
 * until step 5); every call another admin must make comes back in `ownerActions` (written to batch B7).
 */
export async function deployGen7Generation(inp: GenerationInputs) {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = ethers.getAddress(await deployer.getAddress());
  for (const [label, a] of Object.entries({ treasuryRouter: inp.treasuryRouter, weth: inp.weth, v3Factory: inp.v3Factory, positionManager: inp.positionManager, swapRouter: inp.swapRouter, nativeUsdFeed: inp.nativeUsdFeed, graduationOracle: inp.graduationOracle, creatorRegistry: inp.creatorRegistry, riskRegistry: inp.riskRegistry })) {
    await requireCode(label, a);
  }
  // The router must already be wired (batch A7): every trade routes strictly and every create registers on its vault.
  await assertRouterCanServeStrictRouting(inp.treasuryRouter);
  await assertFeeTierSpacing(inp.v3Factory);
  await assertFeedWithinMaxAge(inp.nativeUsdFeed, inp.maxOracleAgeSeconds, "stock adapter oracle age");

  const campaignImpl = await (await ethers.getContractFactory("LaunchCampaignGen7")).deploy();
  await campaignImpl.waitForDeployment();
  const stockImpl = await (await ethers.getContractFactory("RobinhoodStockLaunchCampaignGen7")).deploy();
  await stockImpl.waitForDeployment();
  if ((await (stockImpl as any).isStockCampaignImplementation()) !== true) throw new Error("stock implementation does not report isStockCampaignImplementation()");
  const nativeAdapter = await deployNativeGraduationAdapter(inp.v3Factory, inp.positionManager, inp.weth, inp.adapterAdmin);
  const nativeAdapterAddress = ethers.getAddress(await nativeAdapter.getAddress());
  await assertNativeAdapterMatches(nativeAdapterAddress, inp.v3Factory, inp.positionManager, inp.weth);
  log(`LaunchCampaignGen7 ${await campaignImpl.getAddress()}  RobinhoodStockLaunchCampaignGen7 ${await stockImpl.getAddress()}  native adapter ${nativeAdapterAddress}`);

  // Locker first with admin = the factory's CREATE address; the factory constructor refuses any other (C9).
  const { factory, factoryAddress, lockerAddress } = await deployFactoryWithLocker({
    factoryName: "LaunchFactoryGen7",
    args: [nativeAdapterAddress, inp.treasuryRouter, await campaignImpl.getAddress(), inp.graduationOracle],
    lockerKind: "v3",
    log,
  });
  const stockAdapter = await deployStockGraduationAdapter(inp.v3Factory, inp.positionManager, inp.swapRouter, inp.weth, inp.nativeUsdFeed, inp.maxOracleAgeSeconds, inp.adapterAdmin);
  const stockAdapterAddress = ethers.getAddress(await stockAdapter.getAddress());
  log(`RobinhoodStockGraduationAdapterV2 ${stockAdapterAddress}`);

  const f: any = factory;
  if (!same(await f.feeRecipient(), inp.treasuryRouter) || !same(await f.leagueReceiver(), inp.treasuryRouter)) throw new Error("factory feeRecipient/leagueReceiver are not the gen-7 router");
  if (Number(await f.FACTORY_GENERATION()) !== 7 || Number(await f.CAMPAIGN_GENERATION()) !== 6) throw new Error("not a 7/6 factory");
  if (Number(await f.liquidityKind()) !== 2) throw new Error("factory did not detect the V3 liquidity kind from the native adapter");

  await waitTx(f.setStockGraduationAdapter(stockAdapterAddress), "factory.setStockGraduationAdapter");
  // R5 folded in: setStockCampaignImplementation is whenMutable and the deployer still owns the factory.
  await waitTx(f.setStockCampaignImplementation(await stockImpl.getAddress()), "factory.setStockCampaignImplementation");
  await waitTx(f.setRouteAuthority(inp.routeAuthority), "factory.setRouteAuthority");
  await waitTx(f.setRegistries(inp.creatorRegistry, inp.riskRegistry), "factory.setRegistries");

  const ownerActions: Array<{ to: string; data: string; why: string }> = [];
  for (const [label, adapter] of [["native graduation adapter", nativeAdapter], ["stock graduation adapter", stockAdapter]] as const) {
    if (same(await (adapter as any).admin(), deployerAddress)) await bindAdapterToFactory(adapter, factoryAddress, label);
  }
  const registry = new ethers.Contract(inp.creatorRegistry, ["function owner() view returns (address)", "function launchRecorder(address) view returns (bool)", "function setLaunchRecorder(address,bool)"], deployer);
  if (!(await registry.launchRecorder(factoryAddress)) && same(await registry.owner(), deployerAddress)) {
    await waitTx(registry.setLaunchRecorder(factoryAddress, true), "creatorRegistry.setLaunchRecorder(gen7 factory)");
  }
  const creatorVault = ethers.getAddress(await new ethers.Contract(inp.treasuryRouter, ["function creatorRewardsVault() view returns (address)"], ethers.provider).creatorRewardsVault());
  const createPath = await wireGenerationCreatePath({ factoryAddress, nativeGraduationAdapter: nativeAdapterAddress, creatorVault, senderAddress: deployerAddress, log: (l) => log(l.trim()) });
  ownerActions.push(...createPath.ownerActions);
  const router = new ethers.Contract(inp.treasuryRouter, ["function admin() view returns (address)", "function authorizedLpLocker(address) view returns (bool)", "function setAuthorizedLpLocker(address,bool)", "function setPrimaryLpLocker(address)"], deployer);
  if (same(await router.admin(), deployerAddress) && !(await router.authorizedLpLocker(lockerAddress))) {
    await waitTx(router.setAuthorizedLpLocker(lockerAddress, true), "router.setAuthorizedLpLocker(gen7 locker)");
    await waitTx(router.setPrimaryLpLocker(lockerAddress), "router.setPrimaryLpLocker(gen7 locker)");
  }

  await waitTx(f.setCreatePaused(true), "factory.setCreatePaused(true)");
  if ((await f.createPaused()) !== true || (await f.live()) !== false) throw new Error("factory must land createPaused and not live");

  // The curve the first $50K / $30K coin would get right now (fails here, not at the first create, on a bad oracle).
  const oracle = new ethers.Contract(inp.graduationOracle, ["function nativeTargetForUsd(uint256) view returns (uint256)"], ethers.provider);
  const cfg = await f.config();
  const curves: Record<string, unknown> = {};
  for (const usd of [30_000n, 50_000n]) {
    const mc = BigInt(await oracle.nativeTargetForUsd(usd * 10n ** 18n));
    const [vn, vt] = await f.curveForMarketCap(mc, cfg.totalSupply, cfg.curveBps, cfg.liquidityTokenBps);
    curves[`${usd}`] = { marketCapNative: mc.toString(), virtualNative: vn.toString(), virtualToken: vt.toString() };
  }

  return {
    factoryAddress,
    lockerAddress,
    tokenDeployer: createPath.tokenDeployer,
    campaignImplementation: ethers.getAddress(await campaignImpl.getAddress()),
    stockCampaignImplementation: ethers.getAddress(await stockImpl.getAddress()),
    nativeAdapter: nativeAdapterAddress,
    stockAdapter: stockAdapterAddress,
    creatorVault,
    curves,
    config: { totalSupply: cfg.totalSupply.toString(), curveBps: cfg.curveBps.toString(), liquidityTokenBps: cfg.liquidityTokenBps.toString(), graduationTarget: cfg.graduationTarget.toString() },
    ownerActions,
  };
}

/** The generation record in the shape batchBFromChain / configure-robinhood-stock-routes read. */
export function generationRecordFor(gen: Awaited<ReturnType<typeof deployGen7Generation>>) {
  return {
    deployed: {
      LaunchFactory: gen.factoryAddress, // key name batchBFromChain reads; the contract is LaunchFactoryGen7
      LaunchFactoryGen7: gen.factoryAddress,
      PermanentV3PositionLocker: gen.lockerAddress,
      LaunchTokenDeployer: gen.tokenDeployer,
      LaunchCampaignGen7Implementation: gen.campaignImplementation,
      RobinhoodStockLaunchCampaignGen7Implementation: gen.stockCampaignImplementation,
      RobinhoodV3NativeGraduationAdapterV2: gen.nativeAdapter,
      RobinhoodStockGraduationAdapterV2: gen.stockAdapter,
    },
    creatorVault: gen.creatorVault,
    pendingOwnerActions: gen.ownerActions,
  };
}

/**
 * Batch B7 from chain: batchBFromChain (V4 locker authorization + primary, vault pin, both adapter binds; every
 * recorded owner action covered byte for byte) + the shared CreatorRegistry launch recorder + the stock
 * implementation if the deployer could not set it.
 */
export async function batchB7FromChain(safe: string, fees: { router: string; vault: string }, record: any) {
  const pins: ChainPins = { ...PINS.robinhoodMainnet, safe };
  const { calls } = await batchBFromChain(pins, fees, record);
  const F = ethers.getAddress(record.deployed.LaunchFactoryGen7);
  const reg = new ethers.Contract(record.reused.creatorRegistry, ["function launchRecorder(address) view returns (bool)", "function owner() view returns (address)"], ethers.provider);
  if (!(await reg.launchRecorder(F))) {
    if (!same(await reg.owner(), safe)) throw new Error(`CreatorRegistry ${record.reused.creatorRegistry} is owned by ${await reg.owner()}, not the Safe`);
    calls.push({ contract: "CreatorRegistry", to: record.reused.creatorRegistry, fn: "setLaunchRecorder", args: [F, true], note: "shared registry: cooldown/live counts span gen-6 and gen-7" });
  }
  const factory = await ethers.getContractAt("LaunchFactoryGen7", F);
  if ((await factory.stockCampaignImplementation()) === ethers.ZeroAddress) {
    calls.push({ contract: "LaunchFactoryGen7", to: F, fn: "setStockCampaignImplementation", args: [record.deployed.RobinhoodStockLaunchCampaignGen7Implementation], note: "R5: whenMutable, before any create" });
  }
  return calls;
}

/** Batch H7: open gen-7 and close gen-6 create (C11) in one Safe transaction. */
export function batchH7Calls(gen7Factory: string, gen6Factory: string): PlannedCall[] {
  return [
    { contract: "LaunchFactoryGen7", to: gen7Factory, fn: "enableLive", args: [] },
    { contract: "LaunchFactoryGen7", to: gen7Factory, fn: "setCreatePaused", args: [false] },
    { contract: "LaunchFactory", to: gen6Factory, fn: "setCreatePaused", args: [true], note: "C11: gen-6 coins keep trading and graduating" },
  ];
}

/** Batch Q7: every route of config/robinhood/mainnet-stock-routes.json on the gen-7 stock adapter and vault. */
export async function batchQ7(stockAdapter: string, vault: string) {
  const cfg = JSON.parse(fs.readFileSync(STOCK_ROUTES_CONFIG, "utf8"));
  const adapter = new ethers.Contract(stockAdapter, ADAPTER_ABI, ethers.provider);
  const v = new ethers.Contract(vault, VAULT_ABI, ethers.provider);
  const nowSeconds = (await ethers.provider.getBlock("latest"))!.timestamp;
  return planRoutes({ adapter, vault: v, routes: cfg.routes, policy: cfg.policy, nowSeconds });
}

/**
 * simulateAsAdmin replays each call against current state on its own. `setPrimaryLpLocker` requires the
 * `setAuthorizedLpLocker` right before it in the same batch, so it is left out of the replay (and named in the
 * log); the fork rehearsal executes the whole batch in order.
 */
async function simulateBatch(admin: string, calls: PlannedCall[]) {
  const dependent = (c: PlannedCall, i: number) =>
    c.fn === "setPrimaryLpLocker" && calls.slice(0, i).some((p) => p.fn === "setAuthorizedLpLocker" && same(p.to, c.to) && same(String(p.args[0]), String(c.args[0])));
  const independent = calls.filter((c, i) => !dependent(c, i));
  for (const [i, c] of calls.entries()) if (dependent(c, i)) log(`sim skip ${c.contract}.${c.fn}(${c.args.join(", ")}): needs setAuthorizedLpLocker earlier in this batch`);
  await simulateAsAdmin(admin, independent, (l) => log(l.trim()));
}

function readRecord(file: string) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Step 6 (and every rebuild): A7/B7 with only what is still missing on chain, then Q7 and H7. */
export async function writeMainnetBatches(recordFile: string) {
  const rec = readRecord(recordFile);
  if (!rec?.fees) throw new Error(`${recordFile} has no fees stack; run RH_GEN7_STEP=fees first`);
  const safe = ethers.getAddress(rec.safe);
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const out: Record<string, { file: string; calls: PlannedCall[] } | null> = { A: null, B: null, Q: null, H: null };

  // A7, filtered to what chain state still lacks.
  const router = new ethers.Contract(rec.fees.router, LIVE_ROUTER_ABI, ethers.provider);
  const vault = new ethers.Contract(rec.fees.vault, ["function holderDistributor() view returns (address)", "function operator() view returns (address)", "function limits() view returns (bool,uint256,uint256,uint256,uint256,uint256)"], ethers.provider);
  const dist = new ethers.Contract(rec.fees.holderDistributor, ["function batchOperator() view returns (address)"], ethers.provider);
  const pins: ChainPins = { ...PINS.robinhoodMainnet, safe, oldRouter: rec.fees.liveRouter, oldFactory: rec.fees.liveVaultPinnedTo, ...rec.fees.reusedVaults, community: rec.fees.communityRewardsVault, payoutOperator: rec.fees.operator };
  const caps = Object.fromEntries(Object.entries(rec.fees.caps).map(([k, v]) => [k, BigInt(String(v))])) as unknown as Caps;
  const lim = await vault.limits();
  const done: Record<string, boolean> = {
    setRecruiterRewardsVault: same(await router.recruiterRewardsVault(), pins.recruiter),
    setCommunityRewardsVault: same(await router.communityRewardsVault(), pins.community),
    setProtocolRevenueVault: same(await router.protocolRevenueVault(), pins.protocol),
    setCreatorRewardsVault: same(await router.creatorRewardsVault(), rec.fees.vault),
    setBatchOperator: same(await dist.batchOperator(), rec.fees.vault),
    setHolderDistributorOnce: same(await vault.holderDistributor(), rec.fees.holderDistributor),
    setOperator: same(await vault.operator(), pins.payoutOperator),
    setCaps: BigInt(lim[1]) === caps.maxBuyPerTx && BigInt(lim[2]) === caps.maxBuybackPerCampaignWeek && BigInt(lim[3]) === caps.minBuyInterval && BigInt(lim[4]) === caps.maxImpactBps && BigInt(lim[5]) === caps.maxHolderBatchPerWeek,
  };
  if (!rec.fees.airdrop?.distributor) throw new Error(`${recordFile} has no gen-7 airdrop pot (fees.airdrop); the fees step records it`);
  const aCalls = [
    ...batchA7Calls(pins, { router: rec.fees.router, vault: rec.fees.vault, holderDistributor: rec.fees.holderDistributor }, caps).filter((c) => !done[c.fn]),
    // The gen-7 airdrop pot: wiring + 12 weeks pre-authorized, only what chain state still lacks.
    ...(await planGen7AirdropCalls({ chainId, vault: rec.fees.communityRewardsVault, setup: rec.fees.airdrop })),
  ];
  if (aCalls.length) {
    await simulateAsAdmin(safe, aCalls, (l) => log(l.trim()));
    const file = rehearsalPath(BATCH_FILES.A);
    writeSafeBatch(file, chainId, "MWZ gen7 A7: fees stack wiring", "gen-7 TreasuryRouterV4 vaults (shared weekly/monthly/recruiter/protocol, new community + creator vault), holder distributor, vault operator + caps mirrored from the live gen-6 vault, gen-7 airdrop pot (distributor wiring + weekly pre-authorizations)", aCalls);
    out.A = { file, calls: aCalls };
  }

  if (rec.deployed?.LaunchFactoryGen7) {
    const bCalls = await batchB7FromChain(safe, { router: rec.fees.router, vault: rec.fees.vault }, rec);
    if (bCalls.length) {
      await simulateBatch(safe, bCalls);
      const file = rehearsalPath(BATCH_FILES.B);
      writeSafeBatch(file, chainId, "MWZ gen7 B7: bind", `bind LaunchFactoryGen7 ${rec.deployed.LaunchFactoryGen7}: locker on router V4, vault pin, native + stock adapters, launch recorder`, bCalls);
      out.B = { file, calls: bCalls };
    }
    const q = await batchQ7(rec.deployed.RobinhoodStockGraduationAdapterV2, rec.fees.vault);
    if (q.calls.length) {
      await simulateAsAdmin(safe, q.calls, (l) => log(l.trim()));
      const file = rehearsalPath(BATCH_FILES.Q);
      writeSafeBatch(file, chainId, "MWZ gen7 Q7: Robinhood stock routes", `${q.calls.length} call(s): ${q.results.map((r: any) => r.symbol).join(", ")}`, q.calls);
      out.Q = { file, calls: q.calls };
    }
    const hCalls = batchH7Calls(rec.deployed.LaunchFactoryGen7, rec.reused.gen6Factory);
    const owner = await (await ethers.getContractAt("LaunchFactoryGen7", rec.deployed.LaunchFactoryGen7)).owner();
    // H7 can only be simulated once the factory is the Safe's (step 5); before that, written unsimulated.
    if (same(owner, safe)) await simulateAsAdmin(safe, hCalls, (l) => log(l.trim()));
    else log(`H7 not simulated: LaunchFactoryGen7 owner is ${owner}, not the Safe yet (transfer ownership first)`);
    const file = rehearsalPath(BATCH_FILES.H);
    writeSafeBatch(file, chainId, "MWZ gen7 H7: open gen-7, close gen-6 create (C11)", "LaunchFactoryGen7.enableLive + setCreatePaused(false); gen-6 LaunchFactory.setCreatePaused(true). Execute only after B7, ownership, Q7 and the founder's go.", hCalls);
    out.H = { file, calls: hCalls };
  }
  for (const [k, v] of Object.entries(out)) {
    if (!v) { log(`batch ${k}7: nothing to do on chain`); continue; }
    log(`batch ${k}7 -> ${v.file}`);
    for (const c of v.calls) log(`    ${c.contract}.${c.fn}(${c.args.map((a) => (Array.isArray(a) ? `[${a.join(",")}]` : String(a))).join(", ")}) -> ${c.to}`);
  }
  return out;
}

function appendVerificationEntries(entries: Array<{ name: string; address: string; contract: string; args: string[] }>) {
  const file = path.join(ROOT, "config", "verification", "mainnet-contracts.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  const list: any[] = manifest.chains?.["4663"]?.contracts;
  if (!Array.isArray(list)) throw new Error("verification manifest has no chains.4663.contracts");
  for (const e of entries) if (!list.some((c) => String(c.address).toLowerCase() === e.address.toLowerCase())) list.push(e);
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

function verificationEntries(rec: any) {
  const d = rec.deployed, r = rec.reused, f = rec.fees;
  return [
    { name: "TreasuryRouterV4 (gen-7)", address: f.router, contract: "contracts/TreasuryRouterV4.sol:TreasuryRouterV4", args: [f.admin, f.reusedVaults.weekly, f.reusedVaults.monthly, "3600"] },
    { name: "CreatorRewardsVaultV2 (gen-7)", address: f.vault, contract: "contracts/CreatorRewardsVaultV2.sol:CreatorRewardsVaultV2", args: [f.admin, f.router, r.weth, "2", r.v3Factory, "86400"] },
    { name: "RewardDistributor (gen-7 holders)", address: f.holderDistributor, contract: "contracts/RewardDistributor.sol:RewardDistributor", args: [f.admin] },
    { name: "CommunityRewardsVault (gen-7)", address: f.communityRewardsVault, contract: "contracts/CommunityRewardsVault.sol:CommunityRewardsVault", args: [f.admin, f.router] },
    { name: "RewardDistributor (gen-7 airdrop)", address: f.airdropDistributor, contract: "contracts/RewardDistributor.sol:RewardDistributor", args: [f.admin] },
    ...(d
      ? [
          { name: "LaunchCampaignGen7", address: d.LaunchCampaignGen7Implementation, contract: "contracts/gen7/LaunchCampaignGen7.sol:LaunchCampaignGen7", args: [] },
          { name: "RobinhoodStockLaunchCampaignGen7", address: d.RobinhoodStockLaunchCampaignGen7Implementation, contract: "contracts/gen7/RobinhoodStockLaunchCampaignGen7.sol:RobinhoodStockLaunchCampaignGen7", args: [] },
          { name: "PermanentV3PositionLocker (gen-7)", address: d.PermanentV3PositionLocker, contract: "contracts/PermanentV3PositionLocker.sol:PermanentV3PositionLocker", args: [d.LaunchFactoryGen7] },
          { name: "LaunchFactoryGen7", address: d.LaunchFactoryGen7, contract: "contracts/gen7/LaunchFactoryGen7.sol:LaunchFactoryGen7", args: [d.RobinhoodV3NativeGraduationAdapterV2, f.router, d.LaunchCampaignGen7Implementation, r.graduationOracle, d.PermanentV3PositionLocker] },
          { name: "RobinhoodV3NativeGraduationAdapterV2 (gen-7)", address: d.RobinhoodV3NativeGraduationAdapterV2, contract: "contracts/integrations/RobinhoodV3NativeGraduationAdapterV2.sol:RobinhoodV3NativeGraduationAdapterV2", args: [r.v3Factory, r.positionManager, r.weth, rec.adapterAdmin] },
          { name: "RobinhoodStockGraduationAdapterV2 (gen-7)", address: d.RobinhoodStockGraduationAdapterV2, contract: "contracts/integrations/RobinhoodStockGraduationAdapterV2.sol:RobinhoodStockGraduationAdapterV2", args: [r.v3Factory, r.positionManager, r.swapRouter, r.weth, r.nativeUsdFeed, String(rec.maxOracleAgeSeconds), rec.adapterAdmin] },
          { name: "LaunchTokenDeployer (gen-7)", address: d.LaunchTokenDeployer, contract: "contracts/token/LaunchTokenDeployer.sol:LaunchTokenDeployer", args: [] },
        ]
      : []),
  ];
}

function assertFoundersTerminal() {
  if (isForkRehearsalNetwork()) return;
  if (process.env.CI || !process.stdin.isTTY) throw new Error("Refusing to send on 4663 from a non-interactive shell: this runs only from the founder's terminal.");
}

async function mainnetMain(step: string) {
  const recordFile = rehearsalPath(RECORD_MAINNET);
  const [deployer] = await ethers.getSigners();
  const deployerAddress = ethers.getAddress(await deployer.getAddress());
  if (step === "batches") return { batches: await writeMainnetBatches(recordFile) };
  if (String(process.env.CONFIRM_ROBINHOOD_GEN7 || "").trim() !== PROFILES.robinhoodMainnet.confirm) {
    throw new Error(`Refusing to send on ${network.name}. Set CONFIRM_ROBINHOOD_GEN7=${PROFILES.robinhoodMainnet.confirm}.`);
  }
  assertFoundersTerminal();
  if (!same(deployerAddress, RH_MAINNET.deployer) && !isForkRehearsalNetwork()) throw new Error(`signer ${deployerAddress} is not the recorded deployer ${RH_MAINNET.deployer}`);
  const safe = ethers.getAddress(String(process.env.RH_OWNER || RH_MAINNET.safe));
  if ((await ethers.provider.getCode(safe)) === "0x") throw new Error(`Safe ${safe} has no code on 4663`);
  let rec = readRecord(recordFile);

  if (step === "fees") {
    if (rec?.fees) throw new Error(`${recordFile} already records a gen-7 fees stack; refusing to deploy a second one`);
    const { fees, calls, deployBlocks } = await deployGen7Fees({ admin: safe, liveRouter: RH_MAINNET.gen6Router, dexFactory: RH_MAINNET.v3Factory, weth: RH_MAINNET.weth, operator: process.env.RH_GEN7_VAULT_OPERATOR, send: false });
    rec = { network: network.name, chainId: 4663, safe, deployer: deployerAddress, status: "fees-deployed", fees: { ...fees, deployedAt: new Date().toISOString(), deployBlocks } };
    writeJson(recordFile, rec);
    await simulateAsAdmin(safe, calls, (l) => log(l.trim()));
    writeSafeBatch(rehearsalPath(BATCH_FILES.A), 4663, "MWZ gen7 A7: fees stack wiring", `gen-7 TreasuryRouterV4 vaults, holder distributor, vault operator + caps mirrored from the live gen-6 vault; gen-7 airdrop pot: community vault ${fees.communityRewardsVault} -> airdrop distributor ${fees.airdropDistributor}, operator ${fees.airdrop.operator}, ${calls.filter((c) => c.fn === "authorizeBatch").length} weekly authorizations at ${ethers.formatEther(fees.airdrop.cap)} ETH each`, calls);
    log(`batch A7 -> ${rehearsalPath(BATCH_FILES.A)} (${calls.length} calls). STOP: the Safe executes A7 before RH_GEN7_STEP=generation.`);
    for (const c of calls) log(`    A7 ${c.contract}.${c.fn}(${c.args.map(String).join(", ")}) -> ${c.to}${c.note ? `  # ${c.note}` : ""}`);
    printGen7AirdropEnv(4663, fees.communityRewardsVault, fees.airdropDistributor, log);
    return rec;
  }

  if (step === "generation") {
    if (!rec?.fees) throw new Error(`${recordFile} has no fees stack; RH_GEN7_STEP=fees and batch A7 first`);
    if (rec.deployed) throw new Error(`${recordFile} already records a gen-7 generation`);
    const { routeAuthority } = resolveRouteAuthorityAndOwner(4663n, deployerAddress);
    const adapterAdmin = await resolveAdapterAdmin(4663n, deployerAddress);
    const maxOracleAgeSeconds = maxOracleAgeFor(4663n);
    const reused = { weth: RH_MAINNET.weth, v3Factory: RH_MAINNET.v3Factory, positionManager: RH_MAINNET.positionManager, swapRouter: RH_MAINNET.swapRouter, nativeUsdFeed: RH_MAINNET.nativeUsdFeed, graduationOracle: RH_MAINNET.graduationOracle, creatorRegistry: RH_MAINNET.creatorRegistry, riskRegistry: RH_MAINNET.riskRegistry, nativeSwapAdapter: RH_MAINNET.nativeSwapAdapter, gen6Factory: RH_MAINNET.gen6Factory };
    const gen = await deployGen7Generation({ ...reused, treasuryRouter: rec.fees.router, routeAuthority, owner: safe, adapterAdmin, maxOracleAgeSeconds });
    rec = { ...rec, status: "deployed-paused", deployedAt: new Date().toISOString(), owner: safe, routeAuthority, adapterAdmin, maxOracleAgeSeconds, reused, ...generationRecordFor(gen), curvesAtDeploy: gen.curves, config: gen.config };
    rec.verification = verificationEntries(rec);
    writeJson(recordFile, rec);
    if (!isForkRehearsalNetwork()) appendVerificationEntries(rec.verification);
    const batches = await writeMainnetBatches(recordFile);
    log("STOP. createPaused, not live. Next: Safe executes B7; transfer-evm-ownership-to-safe.ts (factory); RH_GEN7_STEP=batches; Q7; canary go; H7.");
    return { ...rec, batches };
  }
  throw new Error(`RH_GEN7_STEP=${step}: expected fees, generation or batches on 4663`);
}

/**
 * Testnet (46630): everything in one run, the deployer as admin of everything, nothing opened. `recordFile` lets the
 * lifecycle script's local dry run (an in-process fork of 46630) write its record outside deployments/robinhood.
 */
export async function testnetMain(opts: { recordFile?: string; admin?: string } = {}) {
  if ((await ethers.provider.getNetwork()).chainId !== 46630n) throw new Error("testnetMain runs only on chain 46630 (or a local fork of it)");
  if (String(process.env.CONFIRM_ROBINHOOD_GEN7 || "").trim() !== PROFILES.robinhoodTestnet.confirm) {
    throw new Error(`Refusing to send on ${network.name}. Set CONFIRM_ROBINHOOD_GEN7=${PROFILES.robinhoodTestnet.confirm}.`);
  }
  const RECORD_OUT = opts.recordFile ?? RECORD_TESTNET;
  if (fs.existsSync(RECORD_OUT)) throw new Error(`${RECORD_OUT} exists; move it away to cut a new testnet generation`);
  const g6 = JSON.parse(fs.readFileSync(TESTNET_GEN6B_RECORD, "utf8"));
  const [deployer] = await ethers.getSigners();
  const me = ethers.getAddress(await deployer.getAddress());
  // `admin` is only for the lifecycle script's local dry run, where hardhat's account #0 stands in for the deployer.
  if (!same(me, opts.admin ?? g6.admin)) throw new Error(`deployer ${me} is not the gen-6b testnet admin ${opts.admin ?? g6.admin}`);
  const v3 = g6.v3Stack;
  const { fees, calls } = await deployGen7Fees({ admin: me, liveRouter: g6.fees.router, dexFactory: v3.v3Factory, weth: v3.weth, operator: g6.fees.payoutOperator, send: true });
  const { routeAuthority } = resolveRouteAuthorityAndOwner(46630n, me);
  const reused = {
    weth: v3.weth, v3Factory: v3.v3Factory, positionManager: v3.positionManager, swapRouter: v3.swapRouter02,
    nativeUsdFeed: g6.generation.reused.nativeUsdFeed, graduationOracle: g6.generation.reused.graduationOracle,
    creatorRegistry: g6.generation.registries.creatorRegistry, riskRegistry: g6.generation.registries.riskRegistry,
    nativeSwapAdapter: g6.generation.deployed.RobinhoodV3NativeSwapAdapter, gen6Factory: g6.generation.deployed.LaunchFactory,
  };
  const maxOracleAgeSeconds = maxOracleAgeFor(46630n);
  // The testnet ETH/USD feed is the permissionless mock the gen-6 harness refreshes (3600 s max age on 46630).
  await refreshMockFeed(reused.nativeUsdFeed, log);
  const gen = await deployGen7Generation({ ...reused, treasuryRouter: fees.router, routeAuthority, owner: me, adapterAdmin: me, maxOracleAgeSeconds });
  if (gen.ownerActions.length) throw new Error(`testnet left owner actions: ${JSON.stringify(gen.ownerActions)}`);
  const rec = {
    network: network.name, chainId: 46630, kind: "robinhood-testnet-gen7", deployer: me, admin: me, owner: me, status: "deployed-paused",
    deployedAt: new Date().toISOString(), routeAuthority, adapterAdmin: me, maxOracleAgeSeconds, reused, fees: { ...fees, batchA7Sent: calls.map((c) => `${c.contract}.${c.fn}`) },
    ...generationRecordFor(gen), curvesAtDeploy: gen.curves, config: gen.config, supersedesForCreate: { factory: reused.gen6Factory, record: "deployments/robinhood/testnet.gen6b.json" },
    next: ["scripts/test-robinhood-testnet-gen7-lifecycle.ts (opens create, pauses gen-6b create = C11 on testnet)", "stock routes on the testnet stock adapter if a stock coin is to be tested"],
  };
  writeJson(RECORD_OUT, rec);
  printGen7AirdropEnv(46630, fees.communityRewardsVault, fees.airdropDistributor, log);
  log("STOP. testnet gen-7 is createPaused and not live.");
  return rec;
}

export async function main() {
  const profileName = await profileNetworkName();
  const profile = PROFILES[profileName];
  if (!profile) throw new Error(`Unsupported network ${network.name}: robinhoodTestnet (46630), robinhoodMainnet (4663) or robinhoodForkRehearsal`);
  const chainId = (await ethers.provider.getNetwork()).chainId;
  if (chainId !== profile.chainId) throw new Error(`${network.name} expects chain ${profile.chainId}; RPC reports ${chainId}`);
  const step = String(process.env.RH_GEN7_STEP || "").trim();
  log(`network=${network.name} chainId=${chainId} step=${step || "(none)"}`);
  if (chainId === 46630n) {
    if (step !== "all") throw new Error("on 46630 run RH_GEN7_STEP=all");
    return testnetMain();
  }
  return mainnetMain(step);
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
