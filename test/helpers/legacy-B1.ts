import { deployCoreFixture } from "../fixtures/core";

export { signScheduledCreateAuthorization } from "./scheduledCreateAuth";

/**
 * Group B1 replacement for scheduledCreateAuth.deployScheduledCreateFixture.
 *
 * The shared helper deploys a second LaunchFactory against MockPhase1TreasuryRouter and never wires the
 * launch generation's prerequisites (native graduation adapter, LaunchTokenDeployer, a treasury router whose
 * creatorRewardsVault() implements setCampaignChoice), so every create on it reverts
 * NativeGraduationAdapterUnavailable. The core fixture's factory already has all of that on a real
 * TreasuryRouterV3 (routeTrade/routeFinalize strict routing), route authorization and authorized trading off,
 * and live mode on -- exactly what the scheduled-create specs need.
 */
export async function deployScheduledCreateFixture() {
  const core: any = await deployCoreFixture();
  return { ...core, feeRouter: core.treasuryRouter };
}
