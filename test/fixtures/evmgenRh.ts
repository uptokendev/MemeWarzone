/**
 * The Robinhood (V3) launch generation on the plain hardhat network: real Uniswap V3 bytecode at the
 * canonical 4663 addresses (test/helpers/evmgenRhRealV3.ts), the real C5 LaunchFactory/LaunchCampaign,
 * RobinhoodV3NativeGraduationAdapterV2 as the factory's router and native IGraduationAdapterV2, and the
 * factory's pre-deployed PermanentV3PositionLocker. Router/vault are the core doubles.
 */
import { ethers } from "hardhat";
import { deployFactoryWithLocker } from "../../scripts/lib/deployFactoryWithLocker";
import { installRealV3, RH_V3 } from "../helpers/evmgenRhRealV3";
import { now } from "./evmgenCore";

export async function deployEvmGenRh(opts: { ethUsd?: number } = {}) {
  const [owner, creator, alice, bob, authority, carol] = await ethers.getSigners();
  const v3 = await installRealV3();

  const feed = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8);
  const t = await now();
  await feed.setRoundData(1, BigInt(opts.ethUsd ?? 2694) * 10n ** 8n, t, t, 1);
  const oracle = await (await ethers.getContractFactory("GraduationOracle")).deploy(await feed.getAddress(), 1_000_000_000);

  const evmRouter = await (await ethers.getContractFactory("MockTreasuryRouterEvmGen")).deploy();
  const vault = await (await ethers.getContractFactory("MockCreatorRewardsVaultEvmGen")).deploy();
  await evmRouter.setCreatorRewardsVault(await vault.getAddress());

  const impl = await (await ethers.getContractFactory("LaunchCampaign")).deploy();
  const tokenDeployer = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
  const adapter = await (await ethers.getContractFactory("RobinhoodV3NativeGraduationAdapterV2")).deploy(
    RH_V3.v3Factory,
    RH_V3.positionManager,
    RH_V3.weth,
  );
  const { factory } = await deployFactoryWithLocker({
    factoryName: "LaunchFactory",
    args: [await adapter.getAddress(), await evmRouter.getAddress(), await impl.getAddress(), await oracle.getAddress()],
    lockerKind: "v3",
  });
  await vault.setFactory(await factory.getAddress());
  await factory.setNativeGraduationAdapter(await adapter.getAddress());
  await factory.setLaunchTokenDeployer(await tokenDeployer.getAddress());
  await factory.setRouteAuthority(await authority.getAddress());
  await factory.enableLive();
  await adapter.setCampaignFactoryOnce(await factory.getAddress());
  const locker = await ethers.getContractAt("PermanentV3PositionLocker", await factory.permanentLpLocker());

  return { owner, creator, alice, bob, carol, authority, feed, oracle, evmRouter, vault, impl, tokenDeployer, factory, adapter, locker, ...v3 };
}
