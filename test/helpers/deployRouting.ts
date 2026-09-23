import { ethers } from "hardhat";
import { deployLaunchFactory } from "./deployFactory";

export async function deployMockDexRouter(wrappedAddress: string) {
  const TopazFactory = await ethers.getContractFactory("MockTopazFactory");
  const v2factory = await TopazFactory.deploy();
  await v2factory.waitForDeployment();

  const DexRouter = await ethers.getContractFactory("MockTopazRouter");
  const dexRouter = await DexRouter.deploy(await v2factory.getAddress(), wrappedAddress);
  await dexRouter.waitForDeployment();

  return { v2factory, dexRouter };
}

export async function deployConfiguredTreasuryRouter(adminAddress: string) {
  const AcceptingReceiver = await ethers.getContractFactory("AcceptingReceiver");
  const leagueVault = await AcceptingReceiver.deploy();
  const recruiterVault = await AcceptingReceiver.deploy();
  const protocolVault = await AcceptingReceiver.deploy();
  await Promise.all([
    leagueVault.waitForDeployment(),
    recruiterVault.waitForDeployment(),
    protocolVault.waitForDeployment(),
  ]);

  const TreasuryRouter = await ethers.getContractFactory("TreasuryRouter");
  const treasuryRouter = await TreasuryRouter.deploy(adminAddress, await leagueVault.getAddress(), 3600);
  await treasuryRouter.waitForDeployment();

  const CommunityRewardsVault = await ethers.getContractFactory("CommunityRewardsVault");
  const communityVault = await CommunityRewardsVault.deploy(adminAddress, await treasuryRouter.getAddress());
  await communityVault.waitForDeployment();

  await treasuryRouter.setRecruiterRewardsVault(await recruiterVault.getAddress());
  await treasuryRouter.setCommunityRewardsVault(await communityVault.getAddress());
  await treasuryRouter.setProtocolRevenueVault(await protocolVault.getAddress());

  return { treasuryRouter, leagueVault, recruiterVault, protocolVault, communityVault };
}

/**
 * The same wiring, but on TreasuryRouterV3.
 *
 * Kept separate from deployConfiguredTreasuryRouter because that one is the
 * subject of the V1 router specs, not just plumbing for them -- switching it
 * would silently stop testing V1. Campaign and factory fixtures need V3:
 * LaunchFactory stamps every campaign with strictFeeRouting: true and points
 * both feeRecipient and leagueReceiver at this router, so the campaign takes
 * the unified path and calls routeTrade / routeFinalize, which only V3 has.
 * Against V1 those calls revert with no reason at all.
 */
export async function deployConfiguredTreasuryRouterV3(adminAddress: string) {
  const AcceptingReceiver = await ethers.getContractFactory("AcceptingReceiver");
  const leagueVault = await AcceptingReceiver.deploy();
  const monthlyVault = await AcceptingReceiver.deploy();
  const recruiterVault = await AcceptingReceiver.deploy();
  const protocolVault = await AcceptingReceiver.deploy();
  await Promise.all([
    leagueVault.waitForDeployment(),
    monthlyVault.waitForDeployment(),
    recruiterVault.waitForDeployment(),
    protocolVault.waitForDeployment(),
  ]);

  const TreasuryRouter = await ethers.getContractFactory("TreasuryRouterV3");
  const treasuryRouter = await TreasuryRouter.deploy(
    adminAddress,
    await leagueVault.getAddress(),
    await monthlyVault.getAddress(),
    3600
  );
  await treasuryRouter.waitForDeployment();

  const CommunityRewardsVault = await ethers.getContractFactory("CommunityRewardsVault");
  const communityVault = await CommunityRewardsVault.deploy(adminAddress, await treasuryRouter.getAddress());
  await communityVault.waitForDeployment();

  // The real vault, not a bare receiver: _routeTrade calls accrueTradeFee on it,
  // so anything that merely accepts value reverts the whole buy.
  const CreatorRewardsVault = await ethers.getContractFactory("CreatorRewardsVault");
  const creatorVault = await CreatorRewardsVault.deploy(adminAddress, await treasuryRouter.getAddress());
  await creatorVault.waitForDeployment();

  await treasuryRouter.setRecruiterRewardsVault(await recruiterVault.getAddress());
  await treasuryRouter.setCommunityRewardsVault(await communityVault.getAddress());
  await treasuryRouter.setProtocolRevenueVault(await protocolVault.getAddress());
  await treasuryRouter.setCreatorRewardsVault(await creatorVault.getAddress());

  return { treasuryRouter, leagueVault, monthlyVault, creatorVault, recruiterVault, protocolVault, communityVault };
}

export async function deployRoutedLaunchFactory(admin: any) {
  const { dexRouter, v2factory } = await deployMockDexRouter(await admin.getAddress());
  const routing = await deployConfiguredTreasuryRouterV3(await admin.getAddress());
  const { factory, campaignImplementation } = await deployLaunchFactory(
    await dexRouter.getAddress(),
    await routing.treasuryRouter.getAddress()
  );

  // Older routing and safety fixtures isolate trade behavior through direct calls.
  // Production defaults remain authorization-gated in LaunchFactory itself.
  await factory.connect(admin).setRequireRouteAuthorization(false);
  await factory.connect(admin).setRequireAuthorizedTrading(false);

  return { dexRouter, v2factory, ...routing, factory, campaignImplementation };
}
