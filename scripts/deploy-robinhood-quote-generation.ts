/**
 * Redeploy the Robinhood generation, reusing the infrastructure that is fine.
 *
 * Robinhood testnet already runs a TreasuryRouterV3 with creatorRewardsVault
 * set and forwarding open, plus the Uniswap V3 mocks, the price feed and the
 * graduation oracle. None of that carries a defect and none of it changed, so
 * it is passed in rather than redeployed.
 *
 * What is redeployed, and why:
 *
 *   LaunchFactory            leagueReceiver was immutable while feeRecipient was
 *                            not, so the first setCoreRouting would have bricked
 *                            every campaign created afterwards. Also brings a
 *                            fresh PermanentV3PositionLocker, which the factory
 *                            deploys itself.
 *   LaunchCampaign           the implementation the factory clones.
 *   StockGraduationAdapter   minted the LP position straight to the locker, and
 *                            NonfungiblePositionManager.mint uses _mint, so
 *                            onERC721Received never fired and every stock
 *                            graduation reverted PositionMissing.
 *   V3NativeSwapAdapter      enforced neither a deadline nor a non-zero
 *                            amountOutMinimum; the deployed one still carries
 *                            the old five-argument signature.
 *   ArenaWarPool + League    the battle system, never deployed anywhere.
 *
 * Everything lands paused. This script never calls enableLive.
 *
 *   CONFIRM_ROBINHOOD_GENERATION=I_UNDERSTAND_TESTNET \
 *     npx hardhat run scripts/deploy-robinhood-quote-generation.ts --network robinhoodTestnet
 */
import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";
import { wireLpLocker } from "./lib/evmLpLockerWiring";

const PROFILES: Record<string, { chainId: bigint; confirm: string; file: string }> = {
  robinhoodTestnet: { chainId: 46630n, confirm: "I_UNDERSTAND_TESTNET", file: "robinhood/testnet.quote-generation.json" },
  robinhoodMainnet: { chainId: 4663n, confirm: "I_UNDERSTAND_MAINNET", file: "robinhood/mainnet.quote-generation.json" },
};

/** Reused on Robinhood testnet; every one verified to have code before use. */
const TESTNET_REUSE = {
  treasuryRouter: "0xEf6572863967623605D866BeaAB6890FF7521278",
  weth: "0x632061cA786f7B585Bbd46A792FDA92B02f70671",
  v3Factory: "0xfdF80819CCaE7103165c2EAd9057BA7Eb2fa8aee",
  positionManager: "0xda0a9Ed9e68D2B468257aBD66465fdD94F4338bb",
  swapRouter: "0xdE9Ec7c679FD260D76A390eEC00FA8ab1E621D2a",
  nativeUsdFeed: "0x896C55A66FD6e310f0e923ea682cBAA06bDf9bc4",
  graduationOracle: "0x35E93D0b0F4A2809264Fa8D9922e2d0D1609C9BA",
  // LaunchFactory's "router" is the V3 graduation adapter, not the raw swap
  // router: it is what reports liquidityKind() == V3_NFT, and without that the
  // factory falls back to V2 and demands a poolFactory() the swap router does
  // not have. This is also the adapter that already mints to itself and
  // safe-transfers into the locker, so it carries no defect and is reused.
  v3GraduationRouter: "0xe69a6a41363a48179beaB9b1E6122885bbFe8C65",
};

const MEME_POOL_FEE_TIER = 3000;
const MAX_ORACLE_AGE_SECONDS = 3600;
const PROTOCOL_FEE_BPS = 200n;
const CONFIG = {
  totalSupply: ethers.parseEther("1000000000"),
  curveBps: 8400n,
  liquidityTokenBps: 1400n,
  basePrice: 1_000_000_000n,
  priceSlope: 850n,
  graduationTarget: ethers.parseEther("10"),
  liquidityBps: 3300n,
};

function pick(envName: string, fallback: string): string {
  const raw = String(process.env[envName] || "").trim() || fallback;
  if (!raw) throw new Error(`${envName} is required on this network`);
  return ethers.getAddress(raw);
}

async function requireCode(label: string, address: string) {
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") throw new Error(`${label} has no code at ${address}`);
  console.log(`  reuse ${label.padEnd(18)} ${address}  ${Math.round((code.length - 2) / 2)} B`);
}

async function waitTx(txPromise: Promise<any> | any, label: string) {
  const tx = await txPromise;
  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) throw new Error(`${label} failed`);
  console.log(`[rh] ${label}: ${tx.hash}`);
  return receipt;
}

/** The same refusal the BNB script makes, for the same reason. */
async function assertRouterCanServeStrictRouting(routerAddress: string) {
  const router = await ethers.getContractAt(
    [
      "function creatorRewardsVault() view returns (address)",
      "function recruiterRewardsVault() view returns (address)",
      "function communityRewardsVault() view returns (address)",
      "function protocolRevenueVault() view returns (address)",
      "function forwardingPaused() view returns (bool)",
    ],
    routerAddress,
  );
  for (const name of ["creatorRewardsVault", "recruiterRewardsVault", "communityRewardsVault", "protocolRevenueVault"] as const) {
    let value: string;
    try {
      value = await (router as any)[name]();
    } catch {
      throw new Error(
        `treasury router ${routerAddress} has no ${name}(); campaigns from this factory would revert ` +
          `FeeRoutingFailed on every trade. Deploy TreasuryRouterV3 first.`,
      );
    }
    if (value === ethers.ZeroAddress) throw new Error(`router ${name}() is unset`);
    console.log(`  ok router.${name} = ${value}`);
  }
  if (await (router as any).forwardingPaused()) {
    throw new Error("router forwarding is paused; under strict routing that halts every trade");
  }
}

async function main() {
  const profile = PROFILES[network.name];
  if (!profile) throw new Error(`Unsupported network ${network.name}; expected robinhoodTestnet or robinhoodMainnet`);
  if (String(process.env.CONFIRM_ROBINHOOD_GENERATION || "").trim() !== profile.confirm) {
    throw new Error(`Refusing to send on ${network.name}. Set CONFIRM_ROBINHOOD_GENERATION=${profile.confirm}.`);
  }
  const net = await ethers.provider.getNetwork();
  if (net.chainId !== profile.chainId) {
    throw new Error(`${network.name} expects chain ${profile.chainId}; got ${net.chainId}`);
  }

  const isTestnet = profile.chainId === 46630n;
  const reuse = isTestnet ? TESTNET_REUSE : ({} as typeof TESTNET_REUSE);

  const treasuryRouter = pick("RH_TREASURY_ROUTER", reuse.treasuryRouter ?? "");
  const weth = pick("RH_WETH", reuse.weth ?? "");
  const v3Factory = pick("RH_V3_FACTORY", reuse.v3Factory ?? "");
  const positionManager = pick("RH_POSITION_MANAGER", reuse.positionManager ?? "");
  const swapRouter = pick("RH_SWAP_ROUTER", reuse.swapRouter ?? "");
  const nativeUsdFeed = pick("RH_NATIVE_USD_FEED", reuse.nativeUsdFeed ?? "");
  const graduationOracle = pick("RH_GRADUATION_ORACLE", reuse.graduationOracle ?? "");
  const v3GraduationRouter = pick("RH_V3_GRADUATION_ROUTER", reuse.v3GraduationRouter ?? "");
  const routeAuthority = pick("RH_ROUTE_AUTHORITY", "0x2501cdC18Cf3f4EfA8d08F18ab27e4862212Bde0");

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer signer for this network.");
  const deployerAddress = ethers.getAddress(await deployer.getAddress());
  const owner = pick("RH_OWNER", deployerAddress);

  console.log(`[rh] network=${network.name} chainId=${net.chainId}`);
  console.log(`[rh] deployer=${deployerAddress} balance=${ethers.formatEther(await ethers.provider.getBalance(deployerAddress))}`);
  console.log("[rh] reusing:");
  for (const [label, address] of Object.entries({ treasuryRouter, weth, v3Factory, positionManager, swapRouter, nativeUsdFeed, graduationOracle, v3GraduationRouter })) {
    await requireCode(label, address);
  }
  await assertRouterCanServeStrictRouting(treasuryRouter);

  // --- redeploy ------------------------------------------------------------
  const campaignImpl = await (await ethers.getContractFactory("LaunchCampaign")).deploy();
  await campaignImpl.waitForDeployment();
  console.log(`[rh] LaunchCampaign impl = ${await campaignImpl.getAddress()}`);

  const factory = await (await ethers.getContractFactory("LaunchFactory")).deploy(
    v3GraduationRouter,
    treasuryRouter,
    await campaignImpl.getAddress(),
    graduationOracle,
  );
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  const lockerAddress = await (factory as any).permanentLpLocker();
  console.log(`[rh] LaunchFactory = ${factoryAddress}`);
  console.log(`[rh] PermanentV3PositionLocker = ${lockerAddress}`);

  // The invariant that bricked the previous generation.
  const feeRecipient = await (factory as any).feeRecipient();
  const leagueReceiver = await (factory as any).leagueReceiver();
  if (feeRecipient.toLowerCase() !== leagueReceiver.toLowerCase()) {
    throw new Error(`feeRecipient ${feeRecipient} != leagueReceiver ${leagueReceiver}`);
  }
  console.log(`[rh] ok feeRecipient == leagueReceiver == ${feeRecipient}`);

  const stockAdapter = await (await ethers.getContractFactory("RobinhoodStockTokenGraduationAdapter")).deploy(
    v3Factory,
    positionManager,
    swapRouter,
    weth,
    lockerAddress,
    nativeUsdFeed,
    MEME_POOL_FEE_TIER,
    MAX_ORACLE_AGE_SECONDS,
  );
  await stockAdapter.waitForDeployment();
  console.log(`[rh] RobinhoodStockTokenGraduationAdapter = ${await stockAdapter.getAddress()}`);

  const nativeSwapAdapter = await (await ethers.getContractFactory("RobinhoodV3NativeSwapAdapter")).deploy(swapRouter, weth);
  await nativeSwapAdapter.waitForDeployment();
  console.log(`[rh] RobinhoodV3NativeSwapAdapter = ${await nativeSwapAdapter.getAddress()}`);

  const league = await (await ethers.getContractFactory("PostGradLeagueTreasuryV2")).deploy(deployerAddress, owner, owner);
  await league.waitForDeployment();
  const warPool = await (await ethers.getContractFactory("ArenaWarPoolTreasuryV2")).deploy(
    deployerAddress,
    pick("ARENA_RESOLVER", deployerAddress),
    pick("ARENA_BOOST_QUOTE_SIGNER", deployerAddress),
    pick("ARENA_PROTOCOL_RECEIVER", owner),
    await league.getAddress(),
  );
  await warPool.waitForDeployment();
  console.log(`[rh] PostGradLeagueTreasuryV2 = ${await league.getAddress()}`);
  console.log(`[rh] ArenaWarPoolTreasuryV2 = ${await warPool.getAddress()}`);

  // --- wire, all closed ----------------------------------------------------
  await waitTx((league as any).setSource(await warPool.getAddress(), true), "league.setSource(warPool)");
  await waitTx((warPool as any).setDepositsPaused(true), "warPool.setDepositsPaused(true)");
  await waitTx((factory as any).setStockGraduationAdapter(await stockAdapter.getAddress()), "factory.setStockGraduationAdapter");
  await waitTx((factory as any).setConfig(CONFIG), "factory.setConfig");
  await waitTx((factory as any).setProtocolFee(PROTOCOL_FEE_BPS), "factory.setProtocolFee");
  await waitTx((factory as any).setRouteAuthority(routeAuthority), "factory.setRouteAuthority");

  // The creator gating BNB has and Robinhood did not.
  //
  // LaunchFactory enforces creator cooldown, tier, live-campaign count and
  // wallet-cluster risk through these two registries, and skips all of it when
  // either is the zero address. The first Robinhood generation left both unset,
  // so the same contract that rate-limits creators on BNB let anyone launch
  // anything here. Both chains now gate a create identically.
  //
  // recordLaunch and recordGraduation sit behind onlyLaunchRecorder, so the
  // factory has to be registered or every createCampaign reverts
  // NotLaunchRecorder. Deployed fresh rather than reused: the registry must be
  // owned by a key that can register this factory.
  const creatorRegistry = await (await ethers.getContractFactory("CreatorRegistry")).deploy();
  await creatorRegistry.waitForDeployment();
  const creatorRegistryAddress = ethers.getAddress(await creatorRegistry.getAddress());
  const riskRegistry = await (await ethers.getContractFactory("RiskRegistry")).deploy();
  await riskRegistry.waitForDeployment();
  const riskRegistryAddress = ethers.getAddress(await riskRegistry.getAddress());
  console.log(`[rh] CreatorRegistry = ${creatorRegistryAddress}`);
  console.log(`[rh] RiskRegistry = ${riskRegistryAddress}`);

  await waitTx((factory as any).setRegistries(creatorRegistryAddress, riskRegistryAddress), "factory.setRegistries");
  await waitTx((creatorRegistry as any).setLaunchRecorder(factoryAddress, true), "creatorRegistry.setLaunchRecorder(factory)");
  if ((await (creatorRegistry as any).launchRecorder(factoryAddress)) !== true) {
    throw new Error("the factory is not a launch recorder; every createCampaign would revert");
  }

  // Without this every LP harvest pays the creator and silently strands the
  // protocol's share in the locker. The Robinhood router already served a
  // previous generation, so this is the timelocked path: propose now, accept
  // after upgradeDelay.
  const lpLocker = await wireLpLocker({
    treasuryRouter,
    lockerAddress,
    senderAddress: deployerAddress,
    log: (message) => console.log(`[rh]${message}`),
  });

  await waitTx((factory as any).setCreatePaused(true), "factory.setCreatePaused(true)");

  if ((await (factory as any).createPaused()) !== true) throw new Error("createPaused did not stick");
  if ((await (factory as any).live()) !== false) throw new Error("factory must not be live");
  if ((await (warPool as any).depositsPaused()) !== true) throw new Error("war pool deposits must be paused");

  const artifact = {
    network: network.name,
    chainId: Number(net.chainId),
    deployedAt: new Date().toISOString(),
    deployer: deployerAddress,
    owner,
    status: "deployed-paused",
    reused: { treasuryRouter, weth, v3Factory, positionManager, swapRouter, nativeUsdFeed, graduationOracle, v3GraduationRouter },
    registries: { creatorRegistry: creatorRegistryAddress, riskRegistry: riskRegistryAddress, launchRecorderWired: true },
    lpLockerAuthorized: lpLocker.wired,
    pendingOwnerActions: lpLocker.ownerActions,
    deployed: {
      LaunchFactory: factoryAddress,
      LaunchCampaignImplementation: await campaignImpl.getAddress(),
      PermanentV3PositionLocker: lockerAddress,
      RobinhoodStockTokenGraduationAdapter: await stockAdapter.getAddress(),
      RobinhoodV3NativeSwapAdapter: await nativeSwapAdapter.getAddress(),
      PostGradLeagueTreasuryV2: await league.getAddress(),
      ArenaWarPoolTreasuryV2: await warPool.getAddress(),
    },
    next: [
      "register stock tokens and routes on the adapter",
      "transfer ownership to the Safe (mainnet)",
      "canary, then enableLive + setCreatePaused(false) + setDepositsPaused(false)",
    ],
  };
  const out = path.join(__dirname, "..", "deployments", profile.file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`[rh] wrote ${out}`);
  console.log("[rh] STOP. Everything is paused and nothing is live.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
