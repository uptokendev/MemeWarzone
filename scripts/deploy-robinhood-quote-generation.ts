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
 *                            fresh PermanentV3PositionLocker, deployed just before
 *                            the factory with admin = the factory address.
 *   LaunchCampaign           the implementation the factory clones.
 *   NativeGraduationAdapterV2 (EVM launch generation, C7.2) the factory's
 *                            router AND its native IGraduationAdapterV2. The old
 *                            RobinhoodUniswapV3GraduationAdapter minted at a
 *                            griefer's price on a pre-initialized pool and had no
 *                            caller check; it is NOT reused. RH_NATIVE_GRADUATION_ADAPTER
 *                            names a pre-deployed one; unset, this script deploys it.
 *   StockGraduationAdapterV2 (C7.1) the old one called quoteExactInputSingle on
 *                            SwapRouter02, which has none, so every stock
 *                            graduation reverted; minima now come from Chainlink.
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
import { deployFactoryWithLocker } from "./lib/deployFactoryWithLocker";
import {
  assertCreatorVaultServesGeneration,
  requireNativeGraduationAdapter,
  VAULT_DEX_UNISWAP_V3,
  wireGenerationCreatePath,
} from "./lib/evmGenerationCreateWiring";

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
};

/** Decision E6: the graduated pool is Uniswap V3 0.30%, tick spacing 60. The adapters pin both. */
const MEME_POOL_FEE_TIER = 3000;
const MEME_POOL_TICK_SPACING = 60n;

/** Refuse a V3 factory whose 0.30% tier is not spacing 60 (the adapters' full-range ticks assume it). */
export async function assertFeeTierSpacing(v3FactoryAddress: string) {
  const v3 = await ethers.getContractAt(["function feeAmountTickSpacing(uint24) view returns (int24)"], v3FactoryAddress);
  const spacing = BigInt(await (v3 as any).feeAmountTickSpacing(MEME_POOL_FEE_TIER));
  if (spacing !== MEME_POOL_TICK_SPACING) {
    throw new Error(`V3 factory ${v3FactoryAddress}: fee ${MEME_POOL_FEE_TIER} has tick spacing ${spacing}, expected ${MEME_POOL_TICK_SPACING}`);
  }
  console.log(`[rh] ok V3 fee ${MEME_POOL_FEE_TIER} -> tick spacing ${spacing}`);
}

/** Deploys RobinhoodV3NativeGraduationAdapterV2 (the factory's router and native IGraduationAdapterV2). */
export async function deployNativeGraduationAdapter(v3Factory: string, positionManager: string, weth: string) {
  const adapter = await (await ethers.getContractFactory("RobinhoodV3NativeGraduationAdapterV2")).deploy(v3Factory, positionManager, weth);
  await adapter.waitForDeployment();
  if ((await (adapter as any).POOL_FEE()) !== BigInt(MEME_POOL_FEE_TIER)) throw new Error("native adapter fee is not 3000");
  return adapter;
}

/** A pre-deployed native adapter must be the V2 one on this chain's V3 stack, or the locker refuses it. */
export async function assertNativeAdapterMatches(adapterAddress: string, v3Factory: string, positionManager: string, weth: string) {
  const a = await ethers.getContractAt("RobinhoodV3NativeGraduationAdapterV2", adapterAddress);
  const same = (x: string, y: string) => ethers.getAddress(x) === ethers.getAddress(y);
  if (
    Number(await (a as any).liquidityKind()) !== 2 ||
    Number(await (a as any).feeTier()) !== MEME_POOL_FEE_TIER ||
    !same(await (a as any).v3Factory(), v3Factory) ||
    !same(await (a as any).positionManager(), positionManager) ||
    !same(await (a as any).WETH(), weth)
  ) {
    throw new Error(`native adapter ${adapterAddress} does not report this chain's V3 stack at fee ${MEME_POOL_FEE_TIER}`);
  }
}

export async function deployStockGraduationAdapter(
  v3Factory: string,
  positionManager: string,
  swapRouter: string,
  weth: string,
  nativeUsdFeed: string,
  maxOracleAgeSeconds: number,
) {
  const adapter = await (await ethers.getContractFactory("RobinhoodStockGraduationAdapterV2")).deploy(
    v3Factory,
    positionManager,
    swapRouter,
    weth,
    nativeUsdFeed,
    maxOracleAgeSeconds,
  );
  await adapter.waitForDeployment();
  if (Number(await (adapter as any).maxOracleAgeSeconds()) !== maxOracleAgeSeconds) throw new Error("stock adapter max oracle age mismatch");
  return adapter;
}

/** setCampaignFactoryOnce on an adapter, then read back factory, locker and the lock. */
export async function bindAdapterToFactory(adapter: any, factoryAddress: string, label: string) {
  const tx = await adapter.setCampaignFactoryOnce(factoryAddress);
  await tx.wait(1);
  const factory = await ethers.getContractAt(["function permanentLpLocker() view returns (address)"], factoryAddress);
  const locker = ethers.getAddress(await (factory as any).permanentLpLocker());
  if (ethers.getAddress(await adapter.campaignFactory()) !== ethers.getAddress(factoryAddress)) throw new Error(`${label}: factory not bound`);
  if (ethers.getAddress(await adapter.permanentPositionLocker()) !== locker) throw new Error(`${label}: locker mismatch`);
  if ((await adapter.campaignFactoryLocked()) !== true) throw new Error(`${label}: factory binding not locked`);
  console.log(`[rh] ok ${label} bound to factory ${factoryAddress}, locker ${locker}`);
}

/** Adds entries to config/verification/mainnet-contracts.json (chain 4663) unless the address is already listed. */
function appendVerificationEntries(chainKey: string, entries: Array<{ name: string; address: string; contract: string; args: string[] }>) {
  const file = path.join(__dirname, "..", "config", "verification", "mainnet-contracts.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  const list: any[] = manifest.chains?.[chainKey]?.contracts;
  if (!Array.isArray(list)) throw new Error(`verification manifest has no chains.${chainKey}.contracts`);
  for (const entry of entries) {
    if (list.some((c) => String(c.address).toLowerCase() === entry.address.toLowerCase())) continue;
    list.push(entry);
  }
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[rh] recorded ${entries.length} adapter(s) in ${file}`);
}
/**
 * How stale a price the stock adapter will still act on. Immutable in the
 * adapter, so it has to be right at deploy.
 *
 * Chainlink's ETH / USD on Robinhood mainnet (0x78F3556b…) is a "low" category
 * feed with an 86,400 s heartbeat: it can legitimately go a day between
 * updates, and was 121 minutes old when checked. The 3600 s the testnet uses
 * (against a mock feed the harness refreshes) would report OracleStale for
 * most of every day there. Mainnet gets 90,000 s -- the heartbeat plus an
 * hour of slack -- and the run refuses a value the live feed already exceeds.
 */
export function maxOracleAgeFor(chainId: bigint): number {
  const override = Number(String(process.env.RH_MAX_ORACLE_AGE_SECONDS || "").trim());
  if (Number.isInteger(override) && override > 0) return override;
  return chainId === 46630n ? 3600 : 90_000;
}

/** Refuse a max age the feed already fails, before it is burned into an immutable. */
export async function assertFeedWithinMaxAge(feedAddress: string, maxAgeSeconds: number, label: string) {
  const feed = await ethers.getContractAt(
    ["function decimals() view returns (uint8)", "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"],
    feedAddress,
  );
  const [, answer, , updatedAt] = await (feed as any).latestRoundData();
  const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  const age = now - BigInt(updatedAt);
  if (answer <= 0n) throw new Error(`${label}: feed ${feedAddress} reports a non-positive answer`);
  if (age > BigInt(maxAgeSeconds)) {
    throw new Error(
      `${label}: feed ${feedAddress} is ${age}s old right now, above the ${maxAgeSeconds}s max age about to be made immutable. ` +
        `Every price read would revert stale. Raise RH_MAX_ORACLE_AGE_SECONDS above the feed's heartbeat.`,
    );
  }
  console.log(`[rh] ok ${label}: feed age ${age}s within max ${maxAgeSeconds}s (decimals ${await (feed as any).decimals()})`);
}
const PROTOCOL_FEE_BPS = 200n;
/**
 * The factory's default graduation target, per chain.
 *
 * LaunchFactory.isGraduationTargetAllowedForChain permits exactly two values
 * on mainnet (DEFAULT 30,000 and DEEP 50,000 USD) and adds TEST (6 USD) on the
 * testnets. The previous default of 10 was allowed nowhere: the acceptance
 * harness never noticed because it passes its own $6 target on every campaign,
 * but a create that leaves the target to the factory reverts
 * UnsupportedGraduationTarget. Verified through the factory's own pure view in
 * test/RobinhoodGenerationConfig.spec.ts, which is where this number is pinned.
 */
export function graduationTargetFor(chainId: bigint): bigint {
  return chainId === 46630n ? ethers.parseEther("6") : ethers.parseEther("30000");
}

export function configFor(chainId: bigint) {
  return {
    totalSupply: ethers.parseEther("1000000000"),
    curveBps: 7000n,
    liquidityTokenBps: 2800n,
    basePrice: 1_000_000_000n,
    priceSlope: 850n,
    graduationTarget: graduationTargetFor(chainId),
    liquidityBps: 3300n,
  };
}

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
export async function assertRouterCanServeStrictRouting(routerAddress: string) {
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
          `FeeRoutingFailed on every trade. Deploy TreasuryRouterV4 (with a CreatorRewardsVaultV2) first.`,
      );
    }
    if (value === ethers.ZeroAddress) throw new Error(`router ${name}() is unset`);
    console.log(`  ok router.${name} = ${value}`);
  }
  if (await (router as any).forwardingPaused()) {
    throw new Error("router forwarding is paused; under strict routing that halts every trade");
  }
  // Presence is not enough: the vault behind creatorRewardsVault() must take the generation's fee choice.
  await assertCreatorVaultServesGeneration(routerAddress, {
    dexKind: VAULT_DEX_UNISWAP_V3,
    log: (line) => console.log(`  ${line.trim()}`),
  });
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
  const routeAuthority = pick("RH_ROUTE_AUTHORITY", "0x2501cdC18Cf3f4EfA8d08F18ab27e4862212Bde0");

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer signer for this network.");
  const deployerAddress = ethers.getAddress(await deployer.getAddress());
  const owner = pick("RH_OWNER", deployerAddress);

  console.log(`[rh] network=${network.name} chainId=${net.chainId}`);
  console.log(`[rh] deployer=${deployerAddress} balance=${ethers.formatEther(await ethers.provider.getBalance(deployerAddress))}`);
  console.log("[rh] reusing:");
  for (const [label, address] of Object.entries({ treasuryRouter, weth, v3Factory, positionManager, swapRouter, nativeUsdFeed, graduationOracle })) {
    await requireCode(label, address);
  }
  await assertRouterCanServeStrictRouting(treasuryRouter);
  // The generation's V3 native graduation adapter (IGraduationAdapterV2). Required: without it, or the
  // LaunchTokenDeployer, create reverts NativeGraduationAdapterUnavailable, and both setters lock at the
  // first campaign. On this V3 factory the setter also authorizes the adapter on the position locker, which
  // reverts unless the adapter reports the locker's liquidityKind/v3Factory/positionManager/WETH/feeTier.
  // It is also the factory's router (liquidityKind V3 and the locker's integration source), so the
  // old RobinhoodUniswapV3GraduationAdapter is not reused anywhere (C7 section 8).
  await assertFeeTierSpacing(v3Factory);
  const nativeAdapterDeployed = !String(process.env.RH_NATIVE_GRADUATION_ADAPTER || "").trim();
  const nativeGraduationAdapter = nativeAdapterDeployed
    ? await (await deployNativeGraduationAdapter(v3Factory, positionManager, weth)).getAddress()
    : await requireNativeGraduationAdapter("RH_NATIVE_GRADUATION_ADAPTER");
  await assertNativeAdapterMatches(nativeGraduationAdapter, v3Factory, positionManager, weth);
  const v3GraduationRouter = nativeGraduationAdapter;
  console.log(`[rh] nativeGraduationAdapter = ${nativeGraduationAdapter}${nativeAdapterDeployed ? " (deployed now)" : ""}`);
  const MAX_ORACLE_AGE_SECONDS = maxOracleAgeFor(net.chainId);
  await assertFeedWithinMaxAge(nativeUsdFeed, MAX_ORACLE_AGE_SECONDS, "stock adapter oracle age");

  // --- redeploy ------------------------------------------------------------
  const campaignImpl = await (await ethers.getContractFactory("LaunchCampaign")).deploy();
  await campaignImpl.waitForDeployment();
  console.log(`[rh] LaunchCampaign impl = ${await campaignImpl.getAddress()}`);

  // Locker first with admin = the factory's CREATE address; the factory constructor refuses any other.
  const { factory, factoryAddress, lockerAddress } = await deployFactoryWithLocker({
    factoryName: "LaunchFactory",
    args: [v3GraduationRouter, treasuryRouter, await campaignImpl.getAddress(), graduationOracle],
    lockerKind: "v3",
    log: (line) => console.log(`[rh] ${line}`),
  });

  // The invariant that bricked the previous generation.
  const feeRecipient = await (factory as any).feeRecipient();
  const leagueReceiver = await (factory as any).leagueReceiver();
  if (feeRecipient.toLowerCase() !== leagueReceiver.toLowerCase()) {
    throw new Error(`feeRecipient ${feeRecipient} != leagueReceiver ${leagueReceiver}`);
  }
  console.log(`[rh] ok feeRecipient == leagueReceiver == ${feeRecipient}`);

  // Both V2 adapters serve only campaigns of the factory they are bound to, and read the locker from it.
  const nativeAdapter = await ethers.getContractAt("RobinhoodV3NativeGraduationAdapterV2", nativeGraduationAdapter);
  const adapterBindActions: string[] = [];
  if (ethers.getAddress(await (nativeAdapter as any).admin()) === deployerAddress) {
    await bindAdapterToFactory(nativeAdapter, factoryAddress, "native graduation adapter");
  } else {
    adapterBindActions.push(`native adapter admin: setCampaignFactoryOnce(${factoryAddress}) on ${nativeGraduationAdapter}`);
  }

  const stockAdapter = await deployStockGraduationAdapter(v3Factory, positionManager, swapRouter, weth, nativeUsdFeed, MAX_ORACLE_AGE_SECONDS);
  console.log(`[rh] RobinhoodStockGraduationAdapterV2 = ${await stockAdapter.getAddress()}`);
  // Bound in-script (the previous generation left this to configure-robinhood-stock-routes.ts and
  // shipped with campaignFactory() == 0). Routes are configured separately, per stock.
  await bindAdapterToFactory(stockAdapter, factoryAddress, "stock graduation adapter");

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
  const CONFIG = configFor(net.chainId);
  if (!(await (factory as any).isGraduationTargetAllowedForChain(net.chainId, CONFIG.graduationTarget))) {
    throw new Error(`config graduationTarget ${CONFIG.graduationTarget} is not an allowed target on chain ${net.chainId}; every default create would revert`);
  }
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

  // Native adapter + token deployer (whenMutable) and the creator vault pinned to this factory
  // (setCampaignChoice is onlyFactory). Sent when the deployer can; owner actions otherwise.
  const creatorVault = await (await ethers.getContractAt(
    ["function creatorRewardsVault() view returns (address)"],
    treasuryRouter,
  ) as any).creatorRewardsVault();
  const createPath = await wireGenerationCreatePath({
    factoryAddress,
    nativeGraduationAdapter,
    creatorVault,
    senderAddress: deployerAddress,
    log: (line) => console.log(`[rh]${line}`),
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
    reused: { treasuryRouter, weth, v3Factory, positionManager, swapRouter, nativeUsdFeed, graduationOracle },
    registries: { creatorRegistry: creatorRegistryAddress, riskRegistry: riskRegistryAddress, launchRecorderWired: true },
    lpLockerAuthorized: lpLocker.wired,
    createPathWired: createPath.wired,
    nativeGraduationAdapter,
    creatorVault,
    pendingOwnerActions: [...createPath.ownerActions, ...lpLocker.ownerActions],
    deployed: {
      LaunchFactory: factoryAddress,
      LaunchTokenDeployer: createPath.tokenDeployer,
      LaunchCampaignImplementation: await campaignImpl.getAddress(),
      PermanentV3PositionLocker: lockerAddress,
      RobinhoodV3NativeGraduationAdapterV2: nativeGraduationAdapter,
      RobinhoodStockGraduationAdapterV2: await stockAdapter.getAddress(),
      RobinhoodV3NativeSwapAdapter: await nativeSwapAdapter.getAddress(),
      PostGradLeagueTreasuryV2: await league.getAddress(),
      ArenaWarPoolTreasuryV2: await warPool.getAddress(),
    },
    adapterBindActions,
    next: [
      ...adapterBindActions,
      ...(createPath.wired ? [] : ["the create-path owner actions (native adapter, token deployer, vault pin) -- CREATE is dead until they land, and before the first campaign"]),
      "register stock tokens and routes on the adapter",
      "transfer ownership to the Safe (mainnet)",
      "canary, then enableLive + setCreatePaused(false) + setDepositsPaused(false)",
    ],
  };
  (artifact as any).verification = [
    {
      name: "RobinhoodV3NativeGraduationAdapterV2",
      address: nativeGraduationAdapter,
      contract: "contracts/integrations/RobinhoodV3NativeGraduationAdapterV2.sol:RobinhoodV3NativeGraduationAdapterV2",
      args: [v3Factory, positionManager, weth],
    },
    {
      name: "RobinhoodStockGraduationAdapterV2",
      address: await stockAdapter.getAddress(),
      contract: "contracts/integrations/RobinhoodStockGraduationAdapterV2.sol:RobinhoodStockGraduationAdapterV2",
      args: [v3Factory, positionManager, swapRouter, weth, nativeUsdFeed, String(MAX_ORACLE_AGE_SECONDS)],
    },
  ];
  if (profile.chainId === 4663n) appendVerificationEntries("4663", (artifact as any).verification);
  const out = path.join(__dirname, "..", "deployments", profile.file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`[rh] wrote ${out}`);
  console.log("[rh] STOP. Everything is paused and nothing is live.");
  if (!createPath.wired) {
    console.log("[rh] WARNING: the create path is not wired. CREATE reverts until the pending owner actions execute.");
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
