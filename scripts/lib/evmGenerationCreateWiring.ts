import { ethers } from "hardhat";

/**
 * The create-time wiring every EVM launch-generation factory needs, shared by
 * scripts/deploy-bnb-quote-generation.ts and scripts/deploy-robinhood-quote-generation.ts.
 *
 * LaunchFactory._createCampaign refuses to create (NativeGraduationAdapterUnavailable) until both
 * `nativeGraduationAdapter` and `launchTokenDeployer` are set, and it registers every coin's fee
 * choice on the treasury router's creatorRewardsVault() via setCampaignChoice, which only answers
 * the factory the vault was pinned to (setFactoryOnce). The two factory setters are `whenMutable`
 * (zero campaigns), so they must land before the first create; the vault pin can land exactly once.
 * A factory deployed without all three cannot create a single campaign.
 *
 * Every call is sent when the deploying key can send it and returned as an owner action otherwise
 * (on mainnet the vault admin is the Safe; the factory owner is the Safe after the ownership handover),
 * so the printed batch names what is still missing instead of pretending it is done.
 */

export type OwnerAction = { to: string; data: string; why: string };

/** CreatorRewardsVaultV2.DEX_TOPAZ_V2 / DEX_UNISWAP_V3. */
export const VAULT_DEX_TOPAZ_V2 = 1n;
export const VAULT_DEX_UNISWAP_V3 = 2n;

const VAULT_ABI = [
  "function setCampaignChoice(address campaign, address creator, uint8 choice, uint8 creatorPct)",
  "function isKeep(address campaign) view returns (bool)",
  "function factory() view returns (address)",
  "function router() view returns (address)",
  "function admin() view returns (address)",
  "function dexKind() view returns (uint8)",
  "function setFactoryOnce(address factory_)",
];

const FACTORY_ABI = [
  "function owner() view returns (address)",
  "function campaignsCount() view returns (uint256)",
  "function nativeGraduationAdapter() view returns (address)",
  "function launchTokenDeployer() view returns (address)",
  "function setNativeGraduationAdapter(address newAdapter)",
  "function setLaunchTokenDeployer(address deployer)",
];

const REPLACE_WITH = "Deploy TreasuryRouterV4 with a CreatorRewardsVaultV2 as its creatorRewardsVault() and pass that router.";

/**
 * The address a generation factory will use as its native graduation adapter (an IGraduationAdapterV2).
 * Required: there is no default, because a factory without one cannot create, and the setter locks at
 * the first campaign. Checked for code before anything is deployed.
 */
export async function requireNativeGraduationAdapter(envName: string): Promise<string> {
  const raw = String(process.env[envName] || "").trim();
  if (!raw) {
    throw new Error(
      `${envName} is required: the generation's native graduation adapter (IGraduationAdapterV2). ` +
        `Without it LaunchFactory.createCampaign reverts NativeGraduationAdapterUnavailable, and the setter ` +
        `locks at the first campaign. Deploy the adapter first and pass its address.`,
    );
  }
  const address = ethers.getAddress(raw);
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") throw new Error(`${envName} ${address} has no code`);
  return address;
}

/**
 * Refuse a treasury router whose creator vault cannot take the generation's fee choice.
 *
 * The generation factory calls creatorRewardsVault().setCampaignChoice inside every create, and the
 * router's accrueTradeFee(campaign) reverts ChoiceUnset for a campaign without one. A router that has
 * creatorRewardsVault() but points it at the first-generation CreatorRewardsVault (no choice surface,
 * e.g. the BNB mainnet TreasuryRouterV3 0xe635AA43…) passes a presence check and then reverts every
 * create. The probes below are all views that exist on CreatorRewardsVaultV2 and not on the first
 * vault: isKeep(address), factory(), router(), dexKind(). Then the three ways a V2 vault still bricks
 * the generation: it pays a different router (accrueTradeFee is onlyRouter), it is pinned to another
 * factory already (setFactoryOnce cannot be repeated, so setCampaignChoice would revert OnlyFactory
 * forever), or it swaps on the other chain's DEX.
 */
export async function assertCreatorVaultServesGeneration(
  routerAddress: string,
  options: { dexKind: bigint; expectedFactory?: string; log?: (line: string) => void },
): Promise<string> {
  const router = await ethers.getContractAt(["function creatorRewardsVault() view returns (address)"], routerAddress);
  let vaultAddress: string;
  try {
    vaultAddress = await (router as any).creatorRewardsVault();
  } catch {
    throw new Error(`treasury router ${routerAddress} has no creatorRewardsVault(). ${REPLACE_WITH}`);
  }
  if (vaultAddress === ethers.ZeroAddress) {
    throw new Error(`treasury router ${routerAddress} creatorRewardsVault() is unset. ${REPLACE_WITH}`);
  }
  const code = await ethers.provider.getCode(vaultAddress);
  if (!code || code === "0x") throw new Error(`creator vault ${vaultAddress} has no code. ${REPLACE_WITH}`);

  const vault = await ethers.getContractAt(VAULT_ABI, vaultAddress);
  let pinnedFactory: string;
  let vaultRouter: string;
  let dexKind: bigint;
  try {
    await (vault as any).isKeep(ethers.ZeroAddress);
    pinnedFactory = await (vault as any).factory();
    vaultRouter = await (vault as any).router();
    dexKind = BigInt(await (vault as any).dexKind());
  } catch {
    throw new Error(
      `creator vault ${vaultAddress} behind router ${routerAddress} is not a CreatorRewardsVaultV2 ` +
        `(no isKeep/factory/router/dexKind): it cannot take setCampaignChoice, so every create would revert. ${REPLACE_WITH}`,
    );
  }
  if (vaultRouter.toLowerCase() !== routerAddress.toLowerCase()) {
    throw new Error(
      `creator vault ${vaultAddress} pays router ${vaultRouter}, not ${routerAddress}; accrueTradeFee is onlyRouter, ` +
        `so every trade would revert. ${REPLACE_WITH}`,
    );
  }
  if (dexKind !== options.dexKind) {
    throw new Error(`creator vault ${vaultAddress} dexKind()=${dexKind}, this chain needs ${options.dexKind}`);
  }
  const expected = options.expectedFactory?.toLowerCase();
  if (pinnedFactory !== ethers.ZeroAddress && pinnedFactory.toLowerCase() !== expected) {
    throw new Error(
      `creator vault ${vaultAddress} is already pinned to factory ${pinnedFactory} (setFactoryOnce); ` +
        `setCampaignChoice would revert OnlyFactory for any other factory, so this one could never create. ${REPLACE_WITH}`,
    );
  }
  options.log?.(` ok router.creatorRewardsVault=${vaultAddress} (CreatorRewardsVaultV2, dexKind ${dexKind}, factory ${pinnedFactory})`);
  return vaultAddress;
}

async function readBackAddress(read: () => Promise<string>, expected: string, label: string, attempts = 8) {
  let value = await read();
  for (let i = 1; i < attempts && value.toLowerCase() !== expected.toLowerCase(); i++) {
    // Public BSC endpoints load-balance; a read right after a confirmed tx can hit a node a block behind.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    value = await read();
  }
  if (value.toLowerCase() !== expected.toLowerCase()) throw new Error(`${label}: actual=${value} expected=${expected}`);
}

async function send(txPromise: Promise<any>, label: string, log: (line: string) => void) {
  const tx = await txPromise;
  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) throw new Error(`${label} failed`);
  log(` submitted ${label}: ${tx.hash}`);
}

/**
 * Deploy the LaunchTokenDeployer and bind it, the native graduation adapter and the creator vault's
 * factory pin. Call before the first campaign (the factory setters are whenMutable).
 */
export async function wireGenerationCreatePath(options: {
  factoryAddress: string;
  nativeGraduationAdapter: string;
  creatorVault: string;
  senderAddress: string;
  log?: (line: string) => void;
}): Promise<{ tokenDeployer: string; wired: boolean; ownerActions: OwnerAction[] }> {
  const log = options.log ?? (() => {});
  const sender = options.senderAddress.toLowerCase();
  const factory = await ethers.getContractAt(FACTORY_ABI, options.factoryAddress);
  const vault = await ethers.getContractAt(VAULT_ABI, options.creatorVault);
  const ownerActions: OwnerAction[] = [];

  if ((await (factory as any).campaignsCount()) !== 0n) {
    throw new Error(`factory ${options.factoryAddress} already has campaigns; its create wiring is locked (whenMutable)`);
  }

  // No owner, no configuration: deploying it is permissionless, so the deployer always does it.
  const deployed = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
  await deployed.waitForDeployment();
  const tokenDeployer = ethers.getAddress(await deployed.getAddress());
  log(` LaunchTokenDeployer=${tokenDeployer}`);

  const factoryOwner = String(await (factory as any).owner()).toLowerCase();
  const factorySteps: Array<[string, string, () => Promise<string>, string]> = [
    ["setNativeGraduationAdapter", options.nativeGraduationAdapter, () => (factory as any).nativeGraduationAdapter(),
      "setNativeGraduationAdapter(adapter); create reverts NativeGraduationAdapterUnavailable without it; whenMutable"],
    ["setLaunchTokenDeployer", tokenDeployer, () => (factory as any).launchTokenDeployer(),
      "setLaunchTokenDeployer(deployer); create reverts NativeGraduationAdapterUnavailable without it; whenMutable"],
  ];
  for (const [fn, value, read, why] of factorySteps) {
    if ((await read()).toLowerCase() === value.toLowerCase()) {
      log(` ok factory.${fn} already ${value}`);
      continue;
    }
    if (factoryOwner === sender) {
      await send((factory as any)[fn](value), `factory.${fn}`, log);
      await readBackAddress(read, value, `factory.${fn}`);
      log(` ok factory.${fn}=${value}`);
    } else {
      const data = (factory as any).interface.encodeFunctionData(fn, [value]);
      ownerActions.push({ to: ethers.getAddress(options.factoryAddress), data, why });
      log(` PENDING owner ${factoryOwner}: factory.${fn}(${value})  to=${options.factoryAddress} data=${data}`);
    }
  }

  const pinned = String(await (vault as any).factory());
  if (pinned.toLowerCase() === options.factoryAddress.toLowerCase()) {
    log(" ok creatorVault.factory already this factory");
  } else if (pinned !== ethers.ZeroAddress) {
    throw new Error(`creator vault ${options.creatorVault} is pinned to ${pinned}; this factory can never create`);
  } else if (String(await (vault as any).admin()).toLowerCase() === sender) {
    await send((vault as any).setFactoryOnce(options.factoryAddress), "creatorVault.setFactoryOnce(factory)", log);
    await readBackAddress(() => (vault as any).factory(), options.factoryAddress, "creatorVault.factory");
    log(` ok creatorVault.factory=${options.factoryAddress}`);
  } else {
    const data = (vault as any).interface.encodeFunctionData("setFactoryOnce", [options.factoryAddress]);
    const why = "setFactoryOnce(factory); create reverts OnlyFactory at setCampaignChoice without it; can be set once";
    ownerActions.push({ to: ethers.getAddress(options.creatorVault), data, why });
    log(` PENDING vault admin ${await (vault as any).admin()}: creatorVault.setFactoryOnce(${options.factoryAddress})  to=${options.creatorVault} data=${data}`);
  }

  return { tokenDeployer, wired: ownerActions.length === 0, ownerActions };
}
