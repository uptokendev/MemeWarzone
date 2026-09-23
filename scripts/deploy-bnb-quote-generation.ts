/**
 * Deploy the BNB generation that accepts binding tokens, plus the battle system.
 *
 * Everything lands PAUSED and owned by the Safe. This script never calls
 * enableLive and never unpauses CREATE; going live is a separate, deliberate act
 * through the Safe, after the canary.
 *
 * What it deploys, in the order the wiring requires:
 *
 *   1. LaunchCampaign            native campaign implementation
 *   2. BnbQuoteLaunchCampaign    campaign implementation for non-native quotes
 *   3. BnbBasicLaunchFactory     the factory, which deploys its own locker
 *   4. BnbQuoteGraduationAdapter needs the factory's locker, so it comes after
 *   5. PostGradLeagueTreasuryV2  the war pool's league receiver
 *   6. ArenaWarPoolTreasuryV2    the battle system
 *
 * The treasury router is an input, not a deployment, and the script refuses one
 * that cannot serve these contracts. That check exists because of a real bug:
 * LaunchCampaign takes the unified routing path only when feeRecipient equals
 * leagueReceiver, and the factory stamps every campaign strictFeeRouting: true,
 * so a router without the V3 surface makes every buy and sell revert
 * FeeRoutingFailed on every campaign it ever creates. BNB mainnet's current
 * router (0xe157a6FD…) has no creatorRewardsVault and would do exactly that.
 *
 * Where the treasury router comes from, and a trap to avoid:
 * scripts/deploy-bnb-mainnet-v3-cutover.ts deploys TreasuryRouterV3 with its
 * vaults and emits the Safe transactions that wire them, because the router's
 * admin is the Safe and an EOA cannot call its setters. Run that first and pass
 * the resulting router here. That script ALSO deploys a plain LaunchFactory,
 * which this generation supersedes -- BnbBasicLaunchFactory extends it and adds
 * the quote path. Do not put both factories in front of users; only one can be
 * the active factory.
 *
 *   BSC testnet first, against real Topaz:
 *     CONFIRM_BNB_QUOTE_GENERATION=I_UNDERSTAND_TESTNET \
 *     BNB_TREASURY_ROUTER=0x… BNB_NATIVE_USD_FEED=0x… \
 *       npx hardhat run scripts/deploy-bnb-quote-generation.ts --network bscTestnet
 *
 *   Then mainnet:
 *     CONFIRM_BNB_QUOTE_GENERATION=I_UNDERSTAND_MAINNET \
 *     BNB_TREASURY_ROUTER=0x… BNB_NATIVE_USD_FEED=0x… \
 *       npx hardhat run scripts/deploy-bnb-quote-generation.ts --network bscMainnet
 */
import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";

import { wireLpLocker } from "./lib/evmLpLockerWiring";

type ChainProfile = {
  chainId: bigint;
  confirm: string;
  safe: string;
  topazRouter: string;
  topazQuoteRouter: string;
  graduationOracle: string;
  creatorRegistry: string;
  riskRegistry: string;
  routeAuthority: string;
  deploymentFile: string;
};

const PROFILES: Record<string, ChainProfile> = {
  bscMainnet: {
    chainId: 56n,
    confirm: "I_UNDERSTAND_MAINNET",
    safe: "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7",
    // The factory calls poolFactory(); only the adapter answers it. Passing
    // Topaz's own router here reverts the factory constructor.
    topazRouter: "0x5c3135Dfaad519A9114DEa2E546f0Cd051d0D35a",
    // The quote adapter calls defaultFactory() and weth(); only Topaz's own
    // router answers those. Both resolve to pool factory
    // 0x65E6cD0e… and WBNB 0xbb4CdB9C…, verified on chain.
    topazQuoteRouter: "0x1E98c8226e7d452e1888e3d3d2F929346321c6c3",
    graduationOracle: "0x9D204406d5ECA0f18e48427fDD983A32FdF57C9B",
    creatorRegistry: "0x8194FB3745d027102ce7Da562c7045f28B2f42fD",
    riskRegistry: "0x92b1494CF7b80dA379EB96F59EeE4Ae7F8970597",
    routeAuthority: "0xb989A99823eA96552c3E3198A40CdBF682EDf1aA",
    deploymentFile: "bnb/mainnet.quote-generation.json",
  },
  // The BSC testnet stack that already exists and was re-verified on chain
  // before being pinned here. topazRouter is the Topaz V2 adapter, not Topaz's
  // own router: the factory reads poolFactory() off whatever it is given, and
  // only the adapter answers it. creatorRegistry is deliberately empty -- the
  // one from the previous generation is owned by a key we do not hold, so its
  // setLaunchRecorder can never be called and every create would revert. A
  // fresh one is deployed instead (see supplyOrDeployRegistry).
  bscTestnet: {
    chainId: 97n,
    confirm: "I_UNDERSTAND_TESTNET",
    safe: "",
    // The authoritative BSC testnet Topaz -- deployments/bscTestnet/minimal-topaz.json,
    // 30 bps like mainnet. The other testnet Topaz (router 0xe559d936, pool
    // factory 0xE3434671) charges 100 and cannot graduate. topazRouter is the
    // adapter deployed against this router, because only an adapter answers
    // poolFactory().
    topazRouter: "0x13537C6273dF312067cE775AAf9635c217A931fd",
    topazQuoteRouter: "0xa241AEd1cfE4eC2892d6Cb2274B4BeB6EcD07EaF",
    graduationOracle: "0xc9Ee6b5bAA4c7b6C5fA0995FE29D358C59bC52Cb",
    creatorRegistry: "",
    riskRegistry: "0xb37bFEDb889E33a31Fe23A4CF2e2329C436bcE39",
    routeAuthority: "0x2501cdC18Cf3f4EfA8d08F18ab27e4862212Bde0",
    deploymentFile: "bnb/testnet.quote-generation.json",
  },
  // A throwaway in-process chain, so the script itself can be proven before it
  // runs anywhere real. 31337 is neither BNB chain, so this profile can never
  // reach testnet or mainnet by mistake; every address must be supplied.
  hardhat: {
    chainId: 31337n,
    confirm: "I_UNDERSTAND_REHEARSAL",
    safe: "",
    topazRouter: "",
    topazQuoteRouter: "",
    graduationOracle: "",
    creatorRegistry: "",
    riskRegistry: "",
    routeAuthority: "",
    deploymentFile: "bnb/hardhat.quote-generation.rehearsal.json",
  },
};

// Same curve the live 30bps generation runs.
const CONFIG = {
  totalSupply: ethers.parseEther("1000000000"),
  curveBps: 8400n,
  liquidityTokenBps: 1400n,
  basePrice: 1_000_000_000n,
  priceSlope: 850n,
  graduationTarget: ethers.parseEther("30000"),
  liquidityBps: 3300n,
};
const PROTOCOL_FEE_BPS = 200n;
const MAX_ORACLE_AGE_SECONDS = 3600;
/** PermanentLpLocker.REQUIRED_POOL_FEE_BPS. Graduation reverts against any other tier. */
const REQUIRED_POOL_FEE_BPS = 30;

function envAddress(name: string, fallback: string): string {
  const raw = String(process.env[name] || "").trim() || fallback;
  if (!raw) throw new Error(`${name} is required on this network`);
  return ethers.getAddress(raw);
}

async function requireCode(label: string, address: string) {
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") throw new Error(`${label} has no code at ${address}`);
}

async function waitTx(txPromise: Promise<any> | any, label: string) {
  const tx = await txPromise;
  console.log(`[quote-gen] submitted ${label}: ${tx.hash}`);
  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) throw new Error(`${label} failed`);
  return receipt;
}

/**
 * Read a value back after a transaction, tolerating a node that is behind.
 *
 * BSC's public endpoints load-balance across nodes, so a read issued straight
 * after a confirmed transaction can land on one that has not seen its block
 * yet. That happened on the BSC testnet run: setLaunchRecorder confirmed with
 * status 1 and the very next call still reported false. Treating that as a
 * failure aborts a deployment that in fact succeeded, after all the gas is
 * spent -- much worse than waiting a few seconds.
 */
async function readBack<T>(read: () => Promise<T>, expected: T, label: string, attempts = 8): Promise<T> {
  let value = await read();
  for (let i = 1; i < attempts && String(value).toLowerCase() !== String(expected).toLowerCase(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    console.log(`[quote-gen] ${label} still ${value}; the node may be behind, re-reading (${i}/${attempts - 1})`);
    value = await read();
  }
  eq(label, value, expected);
  return value;
}

function eq(label: string, actual: unknown, expected: unknown) {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`${label}: actual=${actual} expected=${expected}`);
  }
  console.log(`[quote-gen] ok ${label}=${actual}`);
}

/**
 * Refuse a treasury router that would brick every campaign this factory creates.
 *
 * The campaign calls routeTrade / routeFinalize whenever feeRecipient equals
 * leagueReceiver, which the factory guarantees, and strictFeeRouting means a
 * failed route reverts the trade rather than escrowing it. A router missing any
 * of this does not degrade -- it stops the launchpad.
 */
async function assertRouterCanServeStrictRouting(routerAddress: string) {
  const router = await ethers.getContractAt(
    [
      "function creatorRewardsVault() view returns (address)",
      "function recruiterRewardsVault() view returns (address)",
      "function communityRewardsVault() view returns (address)",
      "function protocolRevenueVault() view returns (address)",
      "function weeklyLeagueVault() view returns (address)",
      "function monthlyLeagueTreasury() view returns (address)",
      "function forwardingPaused() view returns (bool)",
    ],
    routerAddress,
  );

  for (const name of [
    "creatorRewardsVault",
    "recruiterRewardsVault",
    "communityRewardsVault",
    "protocolRevenueVault",
    "weeklyLeagueVault",
    "monthlyLeagueTreasury",
  ] as const) {
    let value: string;
    try {
      value = await (router as any)[name]();
    } catch {
      throw new Error(
        `treasury router ${routerAddress} has no ${name}(). It cannot serve strict unified routing, ` +
          `so every campaign this factory creates would revert FeeRoutingFailed on every trade. ` +
          `Deploy TreasuryRouterV3 and pass it as BNB_TREASURY_ROUTER.`,
      );
    }
    if (value === ethers.ZeroAddress) {
      throw new Error(`treasury router ${name}() is unset; _routeTrade requires it`);
    }
    console.log(`[quote-gen] ok router.${name}=${value}`);
  }

  if (await (router as any).forwardingPaused()) {
    throw new Error(
      "treasury router forwarding is paused. Under strict routing that halts every buy and sell, " +
        "so the generation would deploy into a state where no campaign can trade.",
    );
  }
}

/**
 * A registry address, or a fresh registry when the network has none to reuse.
 *
 * Mainnet profiles pin both registries, so this never deploys there; the
 * explicit guard makes that a rule rather than a coincidence. On a testnet the
 * previous generation's CreatorRegistry is owned by a key nobody here holds,
 * and the factory must be registered on it as a launch recorder or every
 * createCampaign reverts NotLaunchRecorder -- so reusing it is not an option
 * and a fresh one is the only working choice.
 */
async function supplyOrDeployRegistry(
  contractName: "CreatorRegistry" | "RiskRegistry",
  envName: string,
  fallback: string,
  isMainnet: boolean,
): Promise<string> {
  const supplied = String(process.env[envName] || "").trim() || fallback;
  if (supplied) {
    const address = ethers.getAddress(supplied);
    await requireCode(contractName, address);
    console.log(`[quote-gen] ${contractName} = ${address} (reused)`);
    return address;
  }
  if (isMainnet) {
    throw new Error(`${envName} is required on mainnet; this script never deploys a registry there`);
  }
  const deployed = await (await ethers.getContractFactory(contractName)).deploy();
  await deployed.waitForDeployment();
  const address = ethers.getAddress(await deployed.getAddress());
  console.log(`[quote-gen] ${contractName} = ${address} (deployed fresh)`);
  return address;
}

/**
 * Register the factory as a launch recorder, or say who must.
 *
 * LaunchFactory.createCampaign calls creatorRegistry.recordLaunch and
 * graduation calls recordGraduation; both sit behind onlyLaunchRecorder. A
 * factory that is not registered cannot create a single campaign. The registry
 * owner is the Safe on mainnet, so there the call has to come from it and this
 * prints the transaction instead of pretending it is done.
 */
async function wireLaunchRecorder(
  creatorRegistry: string,
  factoryAddress: string,
  deployerAddress: string,
): Promise<{ wired: boolean; ownerAction?: { to: string; data: string } }> {
  const registry = await ethers.getContractAt(
    [
      "function owner() view returns (address)",
      "function launchRecorder(address) view returns (bool)",
      "function setLaunchRecorder(address recorder, bool allowed)",
    ],
    creatorRegistry,
  );

  if (await (registry as any).launchRecorder(factoryAddress)) {
    console.log("[quote-gen] ok creatorRegistry.launchRecorder[factory]=true (already set)");
    return { wired: true };
  }

  const owner = ethers.getAddress(await (registry as any).owner());
  if (owner.toLowerCase() !== deployerAddress.toLowerCase()) {
    const data = (registry as any).interface.encodeFunctionData("setLaunchRecorder", [factoryAddress, true]);
    console.log(`\n[quote-gen] creatorRegistry owner is ${owner}, not the deployer.`);
    console.log("[quote-gen] CREATE WILL REVERT NotLaunchRecorder until the owner sends:");
    console.log(`  to=${creatorRegistry}`);
    console.log(`  data=${data}   # setLaunchRecorder(${factoryAddress}, true)\n`);
    return { wired: false, ownerAction: { to: creatorRegistry, data } };
  }

  await waitTx((registry as any).setLaunchRecorder(factoryAddress, true), "creatorRegistry.setLaunchRecorder(factory)");
  await readBack(() => (registry as any).launchRecorder(factoryAddress), true, "creatorRegistry.launchRecorder[factory]");
  return { wired: true };
}

/**
 * Prove each Topaz address answers what its own consumer will call.
 *
 * There are two, and they are not interchangeable. LaunchFactory's constructor
 * calls poolFactory() on the router it is given, and only the TopazRouterAdapter
 * answers that. BnbQuoteGraduationAdapter's constructor calls defaultFactory()
 * and weth(), and only Topaz's own router answers those. Verified on chain: on
 * BNB mainnet the adapter 0x5c3135Df… reverts defaultFactory() and the router
 * 0x1E98c822… reverts poolFactory(); BSC testnet is the same shape.
 *
 * Swapping them reverts a constructor, which is a wasted deployment rather than
 * a disaster -- but they must also agree on the pool factory and the wrapped
 * native, and that failure is the quiet one: the graduation would build its
 * pool on a different Topaz than the one the campaign trades against.
 */
export async function assertTopazRoutersFit(topazRouter: string, topazQuoteRouter: string) {
  const factorySide = await ethers.getContractAt(
    ["function poolFactory() view returns (address)", "function WETH() view returns (address)"],
    topazRouter,
  );
  const quoteSide = await ethers.getContractAt(
    ["function defaultFactory() view returns (address)", "function weth() view returns (address)"],
    topazQuoteRouter,
  );

  let poolFactory: string;
  try {
    poolFactory = await (factorySide as any).poolFactory();
  } catch {
    throw new Error(
      `BNB_TOPAZ_ROUTER ${topazRouter} has no poolFactory(). LaunchFactory's constructor calls it, so the ` +
        `factory deployment would revert. Pass the TopazRouterAdapter, not Topaz's own router.`,
    );
  }

  let defaultFactory: string;
  let wrapped: string;
  try {
    defaultFactory = await (quoteSide as any).defaultFactory();
    wrapped = await (quoteSide as any).weth();
  } catch {
    throw new Error(
      `BNB_TOPAZ_QUOTE_ROUTER ${topazQuoteRouter} has no defaultFactory()/weth(). ` +
        `BnbQuoteGraduationAdapter's constructor calls both, so the adapter deployment would revert. ` +
        `Pass Topaz's own router, not the TopazRouterAdapter.`,
    );
  }

  if (poolFactory.toLowerCase() !== defaultFactory.toLowerCase()) {
    throw new Error(
      `the two Topaz routers disagree on the pool factory: ${topazRouter} says ${poolFactory}, ` +
        `${topazQuoteRouter} says ${defaultFactory}. A graduation would build its pool on a different ` +
        `Topaz than the campaign trades against.`,
    );
  }
  await requireCode("topazPoolFactory", poolFactory);

  const factoryWrapped = await (factorySide as any).WETH();
  if (factoryWrapped.toLowerCase() !== wrapped.toLowerCase()) {
    throw new Error(
      `the two Topaz routers disagree on the wrapped native: ${factoryWrapped} vs ${wrapped}`,
    );
  }
  console.log(`[quote-gen] ok topaz poolFactory=${poolFactory} wrapped=${wrapped} (both routers agree)`);

  // The fee the locker will not bend on.
  //
  // PermanentLpLocker.REQUIRED_POOL_FEE_BPS is 30 and lockPosition reverts when
  // the configured factory reports anything else, so a Topaz on any other fee
  // tier gives a generation that creates and trades perfectly well and then
  // fails closed at graduation -- after a campaign has already sold out, which
  // is the worst moment to find out.
  //
  // BSC testnet has two Topaz deployments and they are not the same: the one
  // the older records point at charges 100 bps, and the authoritative manifest's
  // charges 30, like BNB mainnet. Nothing distinguished them by address.
  const feeProbe = await ethers.getContractAt(
    ["function getFee(address,bool) view returns (uint256)"],
    poolFactory,
  );
  let volatileFeeBps: bigint;
  try {
    volatileFeeBps = await (feeProbe as any).getFee(ethers.ZeroAddress, false);
  } catch {
    throw new Error(`topaz pool factory ${poolFactory} has no getFee(address,bool); the locker reads it on every graduation`);
  }
  if (volatileFeeBps !== BigInt(REQUIRED_POOL_FEE_BPS)) {
    throw new Error(
      `topaz pool factory ${poolFactory} charges ${volatileFeeBps} bps on volatile pools, but ` +
        `PermanentLpLocker.REQUIRED_POOL_FEE_BPS is ${REQUIRED_POOL_FEE_BPS}. Every graduation would revert ` +
        `once the campaign had already closed. Point BNB_TOPAZ_ROUTER and BNB_TOPAZ_QUOTE_ROUTER at a ${REQUIRED_POOL_FEE_BPS} bps Topaz.`,
    );
  }
  console.log(`[quote-gen] ok topaz volatile fee = ${volatileFeeBps} bps (the locker requires ${REQUIRED_POOL_FEE_BPS})`);
}

async function main() {
  const profile = PROFILES[network.name];
  if (!profile) {
    throw new Error(`Unsupported network ${network.name}; expected bscTestnet or bscMainnet`);
  }
  if (String(process.env.CONFIRM_BNB_QUOTE_GENERATION || "").trim() !== profile.confirm) {
    throw new Error(
      `Refusing to send on ${network.name}. Set CONFIRM_BNB_QUOTE_GENERATION=${profile.confirm}.`,
    );
  }

  const net = await ethers.provider.getNetwork();
  if (net.chainId !== profile.chainId) {
    throw new Error(`${network.name} expects chain ${profile.chainId}; got ${net.chainId}`);
  }

  const topazRouter = envAddress("BNB_TOPAZ_ROUTER", profile.topazRouter);
  const topazQuoteRouter = envAddress("BNB_TOPAZ_QUOTE_ROUTER", profile.topazQuoteRouter);
  const graduationOracle = envAddress("BNB_GRADUATION_ORACLE", profile.graduationOracle);
  const routeAuthority = envAddress("BNB_ROUTE_AUTHORITY", profile.routeAuthority);
  const treasuryRouter = envAddress("BNB_TREASURY_ROUTER", "");
  const nativeUsdFeed = envAddress("BNB_NATIVE_USD_FEED", "");
  // On mainnet the owner is the Safe and must be supplied. On a testnet there is
  // no Safe to be owner of -- the Robinhood testnet generation deployed with the
  // deployer as owner for exactly this reason, and the canary needs a key that
  // can actually sign. So the testnet default is the deployer, and the guard
  // below that forbids it stays where it belongs: on mainnet.

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer signer. Set DEPLOYER_PK or PRIVATE_KEY_DEPLOY.");
  const deployerAddress = ethers.getAddress(await deployer.getAddress());
  const isMainnetChain = profile.confirm === "I_UNDERSTAND_MAINNET";
  const safe = envAddress("BNB_OWNER_SAFE", profile.safe || (isMainnetChain ? "" : deployerAddress));
  if (isMainnetChain && deployerAddress.toLowerCase() === safe.toLowerCase()) {
    throw new Error("Deployer resolved to the owner Safe; deploy from the EOA.");
  }
  console.log(`[quote-gen] owner=${safe}${safe.toLowerCase() === deployerAddress.toLowerCase() ? " (the deployer: testnet only)" : ""}`);

  console.log(`[quote-gen] network=${network.name} chainId=${net.chainId}`);
  console.log(`[quote-gen] deployer=${deployerAddress} balance=${ethers.formatEther(await ethers.provider.getBalance(deployerAddress))} BNB`);

  for (const [label, address] of [
    ["topazRouter", topazRouter],
    ["topazQuoteRouter", topazQuoteRouter],
    ["graduationOracle", graduationOracle],
    ["treasuryRouter", treasuryRouter],
    ["nativeUsdFeed", nativeUsdFeed],
  ] as const) {
    await requireCode(label, address);
  }
  await assertTopazRoutersFit(topazRouter, topazQuoteRouter);
  await assertRouterCanServeStrictRouting(treasuryRouter);

  // After the read-only guards, so a rejected router never costs a deployment.
  const creatorRegistry = await supplyOrDeployRegistry("CreatorRegistry", "BNB_CREATOR_REGISTRY", profile.creatorRegistry, isMainnetChain);
  const riskRegistry = await supplyOrDeployRegistry("RiskRegistry", "BNB_RISK_REGISTRY", profile.riskRegistry, isMainnetChain);


  // --- implementations -----------------------------------------------------
  const nativeImpl = await (await ethers.getContractFactory("LaunchCampaign")).deploy();
  await nativeImpl.waitForDeployment();
  console.log(`[quote-gen] LaunchCampaign impl=${await nativeImpl.getAddress()}`);

  const quoteImpl = await (await ethers.getContractFactory("BnbQuoteLaunchCampaign")).deploy();
  await quoteImpl.waitForDeployment();
  const quoteImplAddress = await quoteImpl.getAddress();
  console.log(`[quote-gen] BnbQuoteLaunchCampaign impl=${quoteImplAddress}`);
  if (!(await (quoteImpl as any).isBnbQuoteCampaignImplementation())) {
    throw new Error("quote implementation does not self-identify; the factory constructor would reject it");
  }

  // --- factory, which deploys its own permanent locker ---------------------
  const factory = await (await ethers.getContractFactory("BnbBasicLaunchFactory")).deploy(
    topazRouter,
    treasuryRouter,
    await nativeImpl.getAddress(),
    graduationOracle,
    quoteImplAddress,
  );
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  const lockerAddress = await (factory as any).permanentLpLocker();
  console.log(`[quote-gen] BnbBasicLaunchFactory=${factoryAddress}`);
  console.log(`[quote-gen] PermanentLpLocker=${lockerAddress}`);

  // The invariant whose absence bricked the previous generation.
  eq("factory.feeRecipient", await (factory as any).feeRecipient(), treasuryRouter);
  eq("factory.leagueReceiver", await (factory as any).leagueReceiver(), treasuryRouter);

  // --- quote graduation adapter, which needs the factory's locker ----------
  const adapter = await (await ethers.getContractFactory("BnbQuoteGraduationAdapter")).deploy(
    topazQuoteRouter,
    lockerAddress,
    nativeUsdFeed,
    MAX_ORACLE_AGE_SECONDS,
  );
  await adapter.waitForDeployment();
  const adapterAddress = await adapter.getAddress();
  console.log(`[quote-gen] BnbQuoteGraduationAdapter=${adapterAddress}`);

  await waitTx((adapter as any).setCampaignFactoryOnce(factoryAddress), "adapter.setCampaignFactoryOnce");
  await waitTx((factory as any).setBnbQuoteGraduationAdapter(adapterAddress), "factory.setBnbQuoteGraduationAdapter");

  // --- battle system -------------------------------------------------------
  const league = await (await ethers.getContractFactory("PostGradLeagueTreasuryV2")).deploy(
    deployerAddress,
    safe,
    safe,
  );
  await league.waitForDeployment();
  const leagueAddress = await league.getAddress();
  console.log(`[quote-gen] PostGradLeagueTreasuryV2=${leagueAddress}`);

  const warPool = await (await ethers.getContractFactory("ArenaWarPoolTreasuryV2")).deploy(
    deployerAddress,
    envAddress("ARENA_RESOLVER", deployerAddress),
    envAddress("ARENA_BOOST_QUOTE_SIGNER", deployerAddress),
    envAddress("ARENA_PROTOCOL_RECEIVER", safe),
    leagueAddress,
  );
  await warPool.waitForDeployment();
  const warPoolAddress = await warPool.getAddress();
  console.log(`[quote-gen] ArenaWarPoolTreasuryV2=${warPoolAddress}`);

  await waitTx((league as any).setSource(warPoolAddress, true), "league.setSource(warPool)");
  // Deposits closed until the canary says otherwise.
  await waitTx((warPool as any).setDepositsPaused(true), "warPool.setDepositsPaused(true)");

  // --- factory configuration, all while CREATE stays closed ----------------
  await waitTx((factory as any).setConfig(CONFIG), "factory.setConfig");
  await waitTx((factory as any).setProtocolFee(PROTOCOL_FEE_BPS), "factory.setProtocolFee");
  // One setter takes both. There is no setCreatorRegistry/setRiskRegistry pair.
  await waitTx((factory as any).setRegistries(creatorRegistry, riskRegistry), "factory.setRegistries");
  await readBack(() => (factory as any).creatorRegistry(), creatorRegistry, "factory.creatorRegistry");
  await readBack(() => (factory as any).riskRegistry(), riskRegistry, "factory.riskRegistry");

  // Without this the factory can create nothing at all.
  const recorder = await wireLaunchRecorder(creatorRegistry, factoryAddress, deployerAddress);

  // Without this every LP harvest silently strands the protocol's 20%.
  const lpLocker = await wireLpLocker({
    treasuryRouter,
    lockerAddress,
    senderAddress: deployerAddress,
    log: (message) => console.log(`[quote-gen]${message}`),
  });
  await waitTx((factory as any).setRouteAuthority(routeAuthority), "factory.setRouteAuthority");
  await waitTx((factory as any).setCreatePaused(true), "factory.setCreatePaused(true)");

  await readBack(() => (factory as any).createPaused(), true, "factory.createPaused");
  eq("factory.live", await (factory as any).live(), false);
  await readBack(() => (warPool as any).depositsPaused(), true, "warPool.depositsPaused");

  const artifact = {
    network: network.name,
    chainId: Number(net.chainId),
    deployedAt: new Date().toISOString(),
    deployer: deployerAddress,
    owner: safe,
    status: "deployed-paused",
    inputs: { topazRouter, topazQuoteRouter, treasuryRouter, graduationOracle, creatorRegistry, riskRegistry, routeAuthority, nativeUsdFeed },
    contracts: {
      BnbBasicLaunchFactory: factoryAddress,
      PermanentLpLocker: lockerAddress,
      LaunchCampaignImplementation: await nativeImpl.getAddress(),
      BnbQuoteLaunchCampaign: quoteImplAddress,
      BnbQuoteGraduationAdapter: adapterAddress,
      PostGradLeagueTreasuryV2: leagueAddress,
      ArenaWarPoolTreasuryV2: warPoolAddress,
    },
    config: Object.fromEntries(Object.entries(CONFIG).map(([k, v]) => [k, v.toString()])),
    protocolFeeBps: PROTOCOL_FEE_BPS.toString(),
    launchRecorderWired: recorder.wired,
    lpLockerAuthorized: lpLocker.wired,
    pendingOwnerActions: [
      ...(recorder.ownerAction ? [{ ...recorder.ownerAction, why: "setLaunchRecorder(factory, true); CREATE reverts NotLaunchRecorder without it" }] : []),
      ...lpLocker.ownerActions,
    ],
    next: [
      ...(recorder.wired ? [] : ["creatorRegistry.setLaunchRecorder(factory, true) from the registry owner -- CREATE is dead until this lands"]),
      ...(lpLocker.wired ? [] : ["treasuryRouter.setAuthorizedLpLocker(locker, true) -- the protocol's 20% of every LP harvest strands until this lands"]),
      "configureQuoteRoute on the adapter for each approved quote token",
      "transfer factory, locker, league and war pool ownership to the Safe",
      "run the canary, then enableLive + setCreatePaused(false) + setDepositsPaused(false) from the Safe",
    ],
  };

  const out = path.join(__dirname, "..", "deployments", profile.deploymentFile);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`[quote-gen] wrote ${out}`);
  console.log("[quote-gen] STOP. Everything is paused and nothing is live.");
  if (!recorder.wired) {
    console.log("[quote-gen] WARNING: the factory is not a launch recorder. CREATE reverts until the owner call above executes.");
  }
  if (!lpLocker.wired) {
    console.log("[quote-gen] WARNING: the locker is not authorized on the treasury router. Harvests will pay the creator and strand the protocol share.");
  }
  console.log("[quote-gen] Quote routes, ownership transfer and going live are separate deliberate steps.");
}

// Only when run as a script. The guards above are imported by
// test/BnbQuoteGenerationDeploy.spec.ts, and importing must not deploy anything.
if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
