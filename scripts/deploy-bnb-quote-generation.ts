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

type ChainProfile = {
  chainId: bigint;
  confirm: string;
  safe: string;
  topazRouter: string;
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
    topazRouter: "0x1E98c8226e7d452e1888e3d3d2F929346321c6c3",
    graduationOracle: "0x9D204406d5ECA0f18e48427fDD983A32FdF57C9B",
    creatorRegistry: "0x8194FB3745d027102ce7Da562c7045f28B2f42fD",
    riskRegistry: "0x92b1494CF7b80dA379EB96F59EeE4Ae7F8970597",
    routeAuthority: "0xb989A99823eA96552c3E3198A40CdBF682EDf1aA",
    deploymentFile: "bscMainnet.quote-generation.json",
  },
  bscTestnet: {
    chainId: 97n,
    confirm: "I_UNDERSTAND_TESTNET",
    safe: "",
    topazRouter: "",
    graduationOracle: "",
    creatorRegistry: "",
    riskRegistry: "",
    routeAuthority: "",
    deploymentFile: "bscTestnet.quote-generation.json",
  },
  // A throwaway in-process chain, so the script itself can be proven before it
  // runs anywhere real. 31337 is neither BNB chain, so this profile can never
  // reach testnet or mainnet by mistake; every address must be supplied.
  hardhat: {
    chainId: 31337n,
    confirm: "I_UNDERSTAND_REHEARSAL",
    safe: "",
    topazRouter: "",
    graduationOracle: "",
    creatorRegistry: "",
    riskRegistry: "",
    routeAuthority: "",
    deploymentFile: "hardhat.quote-generation.rehearsal.json",
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
  const graduationOracle = envAddress("BNB_GRADUATION_ORACLE", profile.graduationOracle);
  const creatorRegistry = envAddress("BNB_CREATOR_REGISTRY", profile.creatorRegistry);
  const riskRegistry = envAddress("BNB_RISK_REGISTRY", profile.riskRegistry);
  const routeAuthority = envAddress("BNB_ROUTE_AUTHORITY", profile.routeAuthority);
  const treasuryRouter = envAddress("BNB_TREASURY_ROUTER", "");
  const nativeUsdFeed = envAddress("BNB_NATIVE_USD_FEED", "");
  const safe = envAddress("BNB_OWNER_SAFE", profile.safe);

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer signer. Set DEPLOYER_PK or PRIVATE_KEY_DEPLOY.");
  const deployerAddress = ethers.getAddress(await deployer.getAddress());
  if (deployerAddress.toLowerCase() === safe.toLowerCase()) {
    throw new Error("Deployer resolved to the owner Safe; deploy from the EOA.");
  }

  console.log(`[quote-gen] network=${network.name} chainId=${net.chainId}`);
  console.log(`[quote-gen] deployer=${deployerAddress} balance=${ethers.formatEther(await ethers.provider.getBalance(deployerAddress))} BNB`);

  for (const [label, address] of [
    ["topazRouter", topazRouter],
    ["graduationOracle", graduationOracle],
    ["creatorRegistry", creatorRegistry],
    ["riskRegistry", riskRegistry],
    ["treasuryRouter", treasuryRouter],
    ["nativeUsdFeed", nativeUsdFeed],
  ] as const) {
    await requireCode(label, address);
  }
  await assertRouterCanServeStrictRouting(treasuryRouter);

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
    topazRouter,
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
  await waitTx((factory as any).setCreatorRegistry(creatorRegistry), "factory.setCreatorRegistry");
  await waitTx((factory as any).setRiskRegistry(riskRegistry), "factory.setRiskRegistry");
  await waitTx((factory as any).setRouteAuthority(routeAuthority), "factory.setRouteAuthority");
  await waitTx((factory as any).setCreatePaused(true), "factory.setCreatePaused(true)");

  eq("factory.createPaused", await (factory as any).createPaused(), true);
  eq("factory.live", await (factory as any).live(), false);
  eq("warPool.depositsPaused", await (warPool as any).depositsPaused(), true);

  const artifact = {
    network: network.name,
    chainId: Number(net.chainId),
    deployedAt: new Date().toISOString(),
    deployer: deployerAddress,
    owner: safe,
    status: "deployed-paused",
    inputs: { topazRouter, treasuryRouter, graduationOracle, creatorRegistry, riskRegistry, routeAuthority, nativeUsdFeed },
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
    next: [
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
  console.log("[quote-gen] Quote routes, ownership transfer and going live are separate deliberate steps.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
