import { ethers } from "hardhat";

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
