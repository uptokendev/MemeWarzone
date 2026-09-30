import { ethers } from "hardhat";
import { deployFactoryWithLocker } from "../../scripts/lib/deployFactoryWithLocker";

/**
 * Group C legacy-test helpers (EVM launch generation, factory 6 / campaign 5).
 *
 * The generation's create path registers every coin's fee choice on the treasury router's
 * creatorRewardsVault() (setCampaignChoice), so a router without that surface (MockPhase1TreasuryRouter)
 * can no longer sit behind a factory that creates. These are the generation's own test doubles.
 */
export async function deployEvmGenTreasuryDoubles() {
  const router = await (await ethers.getContractFactory("MockTreasuryRouterEvmGen")).deploy();
  await router.waitForDeployment();
  const vault = await (await ethers.getContractFactory("MockCreatorRewardsVaultEvmGen")).deploy();
  await vault.waitForDeployment();
  await (await router.setCreatorRewardsVault(await vault.getAddress())).wait();
  return { router, vault };
}

/**
 * Everything a factory needs before its first create that the legacy fixtures never set: the
 * choice-aware vault bound to the factory, a native graduation adapter and the LaunchTokenDeployer.
 * `nativeAdapter` is whatever the test's subject needs; for create-only tests on a Robinhood (V3)
 * factory the router itself is used, which is the address the factory treats as its own adapter
 * (no locker integration-source grant) and is never called because nothing graduates.
 */
export async function wireFactoryForCreate(factory: any, vault: any, nativeAdapter: string) {
  await (await vault.setFactory(await factory.getAddress())).wait();
  await (await factory.setNativeGraduationAdapter(nativeAdapter)).wait();
  const tokenDeployer = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
  await tokenDeployer.waitForDeployment();
  await (await factory.setLaunchTokenDeployer(await tokenDeployer.getAddress())).wait();
  return { tokenDeployer };
}

/**
 * BNB BASIC (BnbBasicLaunchFactory) stack on the generation's real fee path: Topaz V2 mocks, BNB at $600,
 * TreasuryRouterV4 + CreatorRewardsVaultV2 + ProtocolRevenueVault, the factory-bound PermanentLpLocker
 * authorized on the router. Both graduation adapters are the generation's IGraduationAdapterV2 test double
 * (MockGraduationAdapterEvmGen): the in-tree BnbQuoteGraduationAdapter does not implement IGraduationAdapterV2
 * yet, so the real quote route (RouteDisabled, route-policy minima) is not exercised here.
 */
export async function deployBnbBasicCore() {
  const [owner, creator, buyer, other, authority] = await ethers.getSigners();

  const wbnb = await (await ethers.getContractFactory("MockWBNB")).deploy();
  const topazFactory = await (await ethers.getContractFactory("MockTopazFactory")).deploy();
  const topazRouter = await (await ethers.getContractFactory("MockTopazRouter")).deploy(await topazFactory.getAddress(), await wbnb.getAddress());

  const nativeFeed = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8);
  const t = Number((await ethers.provider.getBlock("latest"))!.timestamp);
  await nativeFeed.setRoundData(1, 600n * 10n ** 8n, t, t, 1);
  const graduationOracle = await (await ethers.getContractFactory("GraduationOracle")).deploy(await nativeFeed.getAddress(), 1_000_000_000);

  const Receiver = await ethers.getContractFactory("TreasuryRouterV3ReceiverMock");
  const weekly = await Receiver.deploy();
  const monthly = await Receiver.deploy();
  const recruiter = await Receiver.deploy();
  const treasuryRouter = await (await ethers.getContractFactory("TreasuryRouterV4")).deploy(owner.address, await weekly.getAddress(), await monthly.getAddress(), 3600);
  const community = await (await ethers.getContractFactory("CommunityRewardsVaultV3Mock")).deploy();
  const protocolVault = await (await ethers.getContractFactory("ProtocolRevenueVault")).deploy(owner.address);
  const creatorVault = await (await ethers.getContractFactory("CreatorRewardsVaultV2")).deploy(
    owner.address,
    await treasuryRouter.getAddress(),
    await wbnb.getAddress(),
    1, // DEX_TOPAZ_V2
    await topazFactory.getAddress(),
    24 * 60 * 60,
  );
  await treasuryRouter.setRecruiterRewardsVault(await recruiter.getAddress());
  await treasuryRouter.setCommunityRewardsVault(await community.getAddress());
  await treasuryRouter.setProtocolRevenueVault(await protocolVault.getAddress());
  await treasuryRouter.setCreatorRewardsVault(await creatorVault.getAddress());

  const nativeImpl = await (await ethers.getContractFactory("LaunchCampaign")).deploy();
  const quoteImpl = await (await ethers.getContractFactory("BnbQuoteLaunchCampaign")).deploy();
  const tokenDeployer = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();

  const factory = (await deployFactoryWithLocker({
    factoryName: "BnbBasicLaunchFactory",
    args: [
      await topazRouter.getAddress(),
      await treasuryRouter.getAddress(),
      await nativeImpl.getAddress(),
      await graduationOracle.getAddress(),
      await quoteImpl.getAddress(),
    ],
  })).factory;
  const locker = await ethers.getContractAt("PermanentLpLocker", await factory.permanentLpLocker());
  await treasuryRouter.setAuthorizedLpLocker(await locker.getAddress(), true);
  await creatorVault.setFactoryOnce(await factory.getAddress());

  const Adapter = await ethers.getContractFactory("MockGraduationAdapterEvmGen");
  const nativeAdapter = await Adapter.deploy(await topazFactory.getAddress(), await wbnb.getAddress());
  await nativeAdapter.setLocker(await locker.getAddress());
  const quoteAdapter = await Adapter.deploy(await topazFactory.getAddress(), await wbnb.getAddress());
  await quoteAdapter.setLocker(await locker.getAddress());

  await factory.setNativeGraduationAdapter(await nativeAdapter.getAddress());
  await factory.setLaunchTokenDeployer(await tokenDeployer.getAddress());
  await factory.setRouteAuthority(authority.address);

  return {
    owner, creator, buyer, other, authority,
    wbnb, topazFactory, topazRouter, nativeFeed, graduationOracle,
    treasuryRouter, protocolVault, creatorVault,
    nativeImpl, quoteImpl, tokenDeployer, factory, locker, nativeAdapter, quoteAdapter,
  };
}
