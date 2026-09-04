import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";

const CHAIN_ID = 56n;
const CONFIRM = "I_UNDERSTAND_BNB_V3_CLEAN_CUTOVER";
const DEFAULT_SAFE = "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7";
const DEFAULT_ROUTE_AUTHORITY = "0xb989A99823eA96552c3E3198A40CdBF682EDf1aA";
const DEFAULT_CURRENT_FACTORY = "0xc378221E57898106079aE4B818a92978e4cd9559";
const DEFAULT_CURRENT_FACTORY_START_BLOCK = 117413737;
const DEFAULT_TOPAZ_ADAPTER = "0x5c3135Dfaad519A9114DEa2E546f0Cd051d0D35a";
const DEFAULT_GRADUATION_ORACLE = "0x9D204406d5ECA0f18e48427fDD983A32FdF57C9B";
const REQUIRED_POOL_FEE_BPS = 30n;
const EXPECTED_FACTORY_GENERATION = 4n;
const EXPECTED_CAMPAIGN_GENERATION = 3n;
const EXPECTED_LIQUIDITY_KIND = 1n;
const TREASURY_UPGRADE_DELAY = 3600;

function requiredAddress(name: string, fallback = ""): string {
  const raw = String(process.env[name] || fallback).trim();
  if (!ethers.isAddress(raw) || raw === ethers.ZeroAddress) {
    throw new Error(`${name} must be a non-zero address; got ${raw || "<empty>"}`);
  }
  return ethers.getAddress(raw);
}

function parseAddressList(name: string): string[] {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      if (!ethers.isAddress(value) || value === ethers.ZeroAddress) {
        throw new Error(`${name} contains invalid address ${value}`);
      }
      return ethers.getAddress(value);
    });
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

async function requireCode(address: string, label: string): Promise<void> {
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") throw new Error(`${label} has no bytecode at ${address}`);
}

function eq(label: string, actual: unknown, expected: unknown): void {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`${label}: actual=${actual} expected=${expected}`);
  }
  console.log(`[bnb-v3-cutover] ok ${label}=${actual}`);
}

function requireConfirm(): void {
  if (String(process.env.CONFIRM_BNB_V3_CLEAN_CUTOVER || "").trim() !== CONFIRM) {
    throw new Error(
      `Refusing chain-56 send. Set CONFIRM_BNB_V3_CLEAN_CUTOVER=${CONFIRM} after reviewing the inventory and disposable campaign allowlist.`,
    );
  }
}

async function assertNoProductionCampaignLiability(
  currentFactoryAddress: string,
  startBlock: number,
  disposableCampaigns: string[],
): Promise<{ campaignCount: number; campaigns: string[] }> {
  const factory = await ethers.getContractAt(
    [
      "function campaignsCount() view returns (uint256)",
      "event CampaignCreated(uint256 indexed id,address indexed campaign,address indexed token,address creator,string name,string symbol,string logoURI,string metadataURI)",
    ],
    currentFactoryAddress,
  );

  const count = Number(await factory.campaignsCount());
  const logs = await factory.queryFilter(factory.filters.CampaignCreated(), startBlock, "latest");
  const campaigns = logs.map((log: any) => ethers.getAddress(log.args.campaign));
  if (campaigns.length !== count) {
    throw new Error(
      `Current factory reports ${count} campaigns but CampaignCreated scan from block ${startBlock} found ${campaigns.length}; refusing cutover.`,
    );
  }

  const allowed = new Set(disposableCampaigns.map((address) => address.toLowerCase()));
  const unknown = campaigns.filter((address) => !allowed.has(address.toLowerCase()));
  if (unknown.length) {
    throw new Error(
      `Production campaign liability is not zero. Unknown current-factory campaign(s): ${unknown.join(", ")}. ` +
        "Only explicitly disposable/test campaigns may be present during the clean cutover.",
    );
  }
  if (allowed.size !== campaigns.length) {
    const observed = new Set(campaigns.map((address) => address.toLowerCase()));
    const stale = disposableCampaigns.filter((address) => !observed.has(address.toLowerCase()));
    if (stale.length) {
      throw new Error(`Disposable campaign allowlist contains address(es) not emitted by the current factory: ${stale.join(", ")}`);
    }
  }

  console.log(`[bnb-v3-cutover] production-liability preflight PASS; current campaigns=${count}, all explicitly disposable/test`);
  return { campaignCount: count, campaigns };
}

async function writeJson(file: string, value: unknown): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  console.log(`[bnb-v3-cutover] wrote ${file}`);
}

async function main(): Promise<void> {
  requireConfirm();
  if (network.name !== "bscMainnet") throw new Error(`This deployer is bscMainnet only; got ${network.name}`);
  const net = await ethers.provider.getNetwork();
  if (net.chainId !== CHAIN_ID) throw new Error(`Expected chain 56, got ${net.chainId}`);

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer signer. Set the dedicated BNB mainnet deployer key.");
  const deployerAddress = ethers.getAddress(await deployer.getAddress());

  const safe = requiredAddress("BNB_V3_SAFE", DEFAULT_SAFE);
  const routeAuthority = requiredAddress("BNB_V3_ROUTE_AUTHORITY", DEFAULT_ROUTE_AUTHORITY);
  const currentFactoryAddress = requiredAddress("BNB_V3_CURRENT_FACTORY", DEFAULT_CURRENT_FACTORY);
  const topazAdapterAddress = requiredAddress("BNB_V3_TOPAZ_ADAPTER", DEFAULT_TOPAZ_ADAPTER);
  const graduationOracle = requiredAddress("BNB_V3_GRADUATION_ORACLE", DEFAULT_GRADUATION_ORACLE);
  const weeklyLeagueVault = requiredAddress("BNB_V3_WEEKLY_LEAGUE_VAULT");
  const monthlyLeagueTreasury = requiredAddress("BNB_V3_MONTHLY_LEAGUE_TREASURY");
  const recruiterRewardsVault = requiredAddress("BNB_V3_RECRUITER_REWARDS_VAULT");
  const protocolRevenueVault = requiredAddress("BNB_V3_PROTOCOL_REVENUE_VAULT");
  const creatorRegistry = requiredAddress("BNB_V3_CREATOR_REGISTRY");
  const riskRegistry = requiredAddress("BNB_V3_RISK_REGISTRY");
  const disposableCampaigns = parseAddressList("BNB_CUTOVER_DISPOSABLE_CAMPAIGNS");
  const currentFactoryStartBlock = Number(
    String(process.env.BNB_V3_CURRENT_FACTORY_START_BLOCK || DEFAULT_CURRENT_FACTORY_START_BLOCK).trim(),
  );
  if (!Number.isSafeInteger(currentFactoryStartBlock) || currentFactoryStartBlock <= 0) {
    throw new Error("BNB_V3_CURRENT_FACTORY_START_BLOCK must be a positive integer");
  }
  if (sameAddress(deployerAddress, safe)) throw new Error("EOA deployer must not equal the production Safe");
  if (sameAddress(routeAuthority, safe)) throw new Error("Route authority must remain separate from the production Safe/admin");

  const requiredContracts: Array<[string, string]> = [
    ["production Safe", safe],
    ["current factory", currentFactoryAddress],
    ["Topaz adapter", topazAdapterAddress],
    ["graduation oracle", graduationOracle],
    ["weekly league vault", weeklyLeagueVault],
    ["monthly league treasury", monthlyLeagueTreasury],
    ["recruiter rewards vault", recruiterRewardsVault],
    ["protocol revenue vault", protocolRevenueVault],
    ["creator registry", creatorRegistry],
    ["risk registry", riskRegistry],
  ];
  for (const [label, address] of requiredContracts) await requireCode(address, label);

  const currentFactory = await ethers.getContractAt("LaunchFactory", currentFactoryAddress, deployer);
  eq("currentFactory.owner", await currentFactory.owner(), safe);
  const currentConfig = await currentFactory.config();
  const currentProtocolFeeBps = await currentFactory.protocolFeeBps();
  const currentTradeRouteProfile = await currentFactory.tradeRouteProfile();
  const currentFinalizeRouteProfile = await currentFactory.finalizeRouteProfile();
  const currentProtection = await currentFactory.launchProtectionConfig();

  const liability = await assertNoProductionCampaignLiability(
    currentFactoryAddress,
    currentFactoryStartBlock,
    disposableCampaigns,
  );

  const adapter = await ethers.getContractAt(
    [
      "function topazRouter() view returns (address)",
      "function poolFactory() view returns (address)",
      "function WETH() view returns (address)",
    ],
    topazAdapterAddress,
  );
  const topazRouter = ethers.getAddress(await adapter.topazRouter());
  const topazFactory = ethers.getAddress(await adapter.poolFactory());
  const wbnb = ethers.getAddress(await adapter.WETH());
  for (const [label, address] of [
    ["Topaz router", topazRouter],
    ["Topaz factory", topazFactory],
    ["WBNB", wbnb],
  ] as const) await requireCode(address, label);
  const topaz = new ethers.Contract(topazFactory, ["function getFee(address,bool) view returns (uint256)"], ethers.provider);
  const liveTopazFeeBps = BigInt(await topaz.getFee(ethers.ZeroAddress, false));
  if (liveTopazFeeBps !== REQUIRED_POOL_FEE_BPS) {
    throw new Error(`Production Topaz factory fee is ${liveTopazFeeBps} bps; required ${REQUIRED_POOL_FEE_BPS}`);
  }

  const balance = await ethers.provider.getBalance(deployerAddress);
  if (balance === 0n) throw new Error("BNB deployer has zero BNB");
  console.log("[bnb-v3-cutover] preflight", {
    chainId: net.chainId.toString(),
    deployer: deployerAddress,
    deployerBalanceBnb: ethers.formatEther(balance),
    safe,
    routeAuthority,
    currentFactory: currentFactoryAddress,
    disposableCampaigns: liability.campaigns,
    liveTopazFeeBps: liveTopazFeeBps.toString(),
  });

  const Treasury = await ethers.getContractFactory("TreasuryRouterV3", deployer);
  const treasuryRouter = await Treasury.deploy(safe, weeklyLeagueVault, monthlyLeagueTreasury, TREASURY_UPGRADE_DELAY);
  await treasuryRouter.waitForDeployment();
  const treasuryRouterAddress = ethers.getAddress(await treasuryRouter.getAddress());
  eq("TreasuryRouterV3.admin", await treasuryRouter.admin(), safe);

  const Community = await ethers.getContractFactory("CommunityRewardsVault", deployer);
  const communityRewardsVault = await Community.deploy(safe, treasuryRouterAddress);
  await communityRewardsVault.waitForDeployment();
  const communityRewardsVaultAddress = ethers.getAddress(await communityRewardsVault.getAddress());

  const Creator = await ethers.getContractFactory("CreatorRewardsVault", deployer);
  const creatorRewardsVault = await Creator.deploy(safe, treasuryRouterAddress);
  await creatorRewardsVault.waitForDeployment();
  const creatorRewardsVaultAddress = ethers.getAddress(await creatorRewardsVault.getAddress());

  const Campaign = await ethers.getContractFactory("LaunchCampaign", deployer);
  const campaignImplementation = await Campaign.deploy();
  await campaignImplementation.waitForDeployment();
  const campaignImplementationAddress = ethers.getAddress(await campaignImplementation.getAddress());

  const Factory = await ethers.getContractFactory("LaunchFactory", deployer);
  const launchFactory = await Factory.deploy(
    topazAdapterAddress,
    treasuryRouterAddress,
    campaignImplementationAddress,
    graduationOracle,
  );
  const deploymentTx = launchFactory.deploymentTransaction();
  if (!deploymentTx) throw new Error("LaunchFactory deployment transaction missing");
  const deploymentReceipt = await deploymentTx.wait(2);
  if (!deploymentReceipt || deploymentReceipt.status !== 1) throw new Error("LaunchFactory deployment failed");
  const launchFactoryAddress = ethers.getAddress(await launchFactory.getAddress());
  const lockerAddress = ethers.getAddress(await launchFactory.permanentLpLocker());
  const locker = await ethers.getContractAt("PermanentLpLocker", lockerAddress);

  await (await launchFactory.setCreatePaused(true)).wait();
  await (await launchFactory.setRegistries(creatorRegistry, riskRegistry)).wait();
  await (await launchFactory.setRouteAuthority(routeAuthority)).wait();
  await (await launchFactory.setRouteProfiles(currentTradeRouteProfile, currentFinalizeRouteProfile)).wait();
  if ((await launchFactory.protocolFeeBps()) !== currentProtocolFeeBps) {
    await (await launchFactory.setProtocolFee(currentProtocolFeeBps)).wait();
  }
  await (
    await launchFactory.setConfig({
      totalSupply: currentConfig.totalSupply,
      curveBps: currentConfig.curveBps,
      liquidityTokenBps: currentConfig.liquidityTokenBps,
      basePrice: currentConfig.basePrice,
      priceSlope: currentConfig.priceSlope,
      graduationTarget: currentConfig.graduationTarget,
      liquidityBps: currentConfig.liquidityBps,
    })
  ).wait();
  await (
    await launchFactory.setLaunchProtectionConfig(
      currentProtection.blocks_,
      currentProtection.maxBuyWei,
      currentProtection.maxWalletWei,
    )
  ).wait();
  await (await launchFactory.lockSecurityDefaults()).wait();

  eq("factoryGeneration", await launchFactory.FACTORY_GENERATION(), EXPECTED_FACTORY_GENERATION);
  eq("campaignGeneration", await launchFactory.CAMPAIGN_GENERATION(), EXPECTED_CAMPAIGN_GENERATION);
  eq("liquidityKind", await launchFactory.liquidityKind(), EXPECTED_LIQUIDITY_KIND);
  eq("factory.live", await launchFactory.live(), false);
  eq("factory.createPaused", await launchFactory.createPaused(), true);
  eq("factory.securityDefaultsLocked", await launchFactory.securityDefaultsLocked(), true);
  eq("factory.requireRouteAuthorization", await launchFactory.requireRouteAuthorization(), true);
  eq("factory.requireAuthorizedTrading", await launchFactory.requireAuthorizedTrading(), true);
  eq("factory.routeAuthority", await launchFactory.routeAuthority(), routeAuthority);
  eq("factory.feeRecipient", await launchFactory.feeRecipient(), treasuryRouterAddress);
  eq("factory.campaignImplementation", await launchFactory.campaignImplementation(), campaignImplementationAddress);
  eq("locker.REQUIRED_POOL_FEE_BPS", await locker.REQUIRED_POOL_FEE_BPS(), REQUIRED_POOL_FEE_BPS);
  eq("locker.CREATOR_FEE_BPS", await locker.CREATOR_FEE_BPS(), 8000n);
  eq("locker.PROTOCOL_FEE_BPS", await locker.PROTOCOL_FEE_BPS(), 2000n);
  eq("locker.admin", await locker.admin(), launchFactoryAddress);
  eq("CreatorRewardsVault.router", await creatorRewardsVault.router(), treasuryRouterAddress);
  eq("CommunityRewardsVault.router", await communityRewardsVault.router(), treasuryRouterAddress);

  const standard = await treasuryRouter.previewTrade(10_000n, 0);
  const og = await treasuryRouter.previewTrade(10_000n, 2);
  const unlinked = await treasuryRouter.previewTrade(10_000n, 1);
  const finalize = await treasuryRouter.previewFinalize(10_000n, 1);
  eq("standard.creator", standard.creator, 500n);
  eq("standard.recruiter", standard.recruiter, 1250n);
  eq("og.creator", og.creator, 500n);
  eq("og.recruiter", og.recruiter, 1500n);
  eq("unlinked.creator", unlinked.creator, 500n);
  eq("unlinked.airdrop", unlinked.airdrop, 1500n);
  eq("finalize.creator", finalize.creator, 0n);

  await (await launchFactory.transferOwnership(safe)).wait();
  eq("factory.owner", await launchFactory.owner(), safe);

  const routerIface = new ethers.Interface([
    "function setRecruiterRewardsVault(address newVault)",
    "function setCommunityRewardsVault(address newVault)",
    "function setProtocolRevenueVault(address newVault)",
    "function setCreatorRewardsVault(address newVault)",
    "function setAuthorizedLpLocker(address locker,bool allowed)",
    "function setPrimaryLpLocker(address newLocker)",
  ]);
  const registryIface = new ethers.Interface(["function setLaunchRecorder(address recorder,bool allowed)"]);
  const factoryIface = new ethers.Interface([
    "function enableLive()",
    "function setCreatePaused(bool paused)",
  ]);

  const wireTransactions = [
    [treasuryRouterAddress, routerIface.encodeFunctionData("setRecruiterRewardsVault", [recruiterRewardsVault]), "TreasuryRouterV3: recruiter vault"],
    [treasuryRouterAddress, routerIface.encodeFunctionData("setCommunityRewardsVault", [communityRewardsVaultAddress]), "TreasuryRouterV3: community vault"],
    [treasuryRouterAddress, routerIface.encodeFunctionData("setProtocolRevenueVault", [protocolRevenueVault]), "TreasuryRouterV3: protocol vault"],
    [treasuryRouterAddress, routerIface.encodeFunctionData("setCreatorRewardsVault", [creatorRewardsVaultAddress]), "TreasuryRouterV3: creator vault"],
    [treasuryRouterAddress, routerIface.encodeFunctionData("setAuthorizedLpLocker", [lockerAddress, true]), "TreasuryRouterV3: authorize sole new locker"],
    [treasuryRouterAddress, routerIface.encodeFunctionData("setPrimaryLpLocker", [lockerAddress]), "TreasuryRouterV3: set sole primary locker"],
    [creatorRegistry, registryIface.encodeFunctionData("setLaunchRecorder", [launchFactoryAddress, true]), "CreatorRegistry: authorize gen-4 factory"],
  ].map(([to, data, description]) => ({ to, value: "0", data, description }));

  const activateTransactions = [
    {
      to: launchFactoryAddress,
      value: "0",
      data: factoryIface.encodeFunctionData("enableLive"),
      description: "Enable gen-4 BNB factory only after V3 wiring verifier passes",
    },
    {
      to: currentFactoryAddress,
      value: "0",
      data: factoryIface.encodeFunctionData("setCreatePaused", [true]),
      description: "Disable CREATE on old gen-3/2 factory; disposable test campaigns remain historical only",
    },
  ];
  const unpauseTransactions = [
    {
      to: launchFactoryAddress,
      value: "0",
      data: factoryIface.encodeFunctionData("setCreatePaused", [false]),
      description: "LAST: enable CREATE on gen-4/3 after frontend/API/indexer point exclusively at the new factory",
    },
  ];

  const outDir = path.join(process.cwd(), "deployments", "bnb", "v3-cutover");
  const sourceSha = String(process.env.GITHUB_SHA || process.env.SOURCE_SHA || "").trim() || null;
  const manifest = {
    schemaVersion: 1,
    kind: "bnb-mainnet-v3-clean-cutover-candidate",
    chainId: 56,
    network: network.name,
    sourceSha,
    deployedAt: new Date().toISOString(),
    deploymentBlock: Number(deploymentReceipt.blockNumber),
    deployTx: deploymentTx.hash,
    factoryGeneration: Number(EXPECTED_FACTORY_GENERATION),
    campaignGeneration: Number(EXPECTED_CAMPAIGN_GENERATION),
    liquidityKind: Number(EXPECTED_LIQUIDITY_KIND),
    requiredPoolFeeBps: Number(REQUIRED_POOL_FEE_BPS),
    lockerCreatorFeeBps: 8000,
    lockerProtocolFeeBps: 2000,
    admin: safe,
    routeAuthority,
    currentFactory: currentFactoryAddress,
    currentFactoryStartBlock,
    productionLiability: {
      accepted: true,
      campaignCount: liability.campaignCount,
      explicitlyDisposableCampaigns: liability.campaigns,
      unknownCampaigns: [],
    },
    topaz: { adapter: topazAdapterAddress, router: topazRouter, factory: topazFactory, wbnb, feeBps: Number(liveTopazFeeBps) },
    receivers: { weeklyLeagueVault, monthlyLeagueTreasury, recruiterRewardsVault, protocolRevenueVault },
    contracts: {
      treasuryRouterV3: treasuryRouterAddress,
      communityRewardsVault: communityRewardsVaultAddress,
      creatorRewardsVault: creatorRewardsVaultAddress,
      launchCampaignImplementation: campaignImplementationAddress,
      launchFactory: launchFactoryAddress,
      permanentLpLocker: lockerAddress,
      graduationOracle,
      creatorRegistry,
      riskRegistry,
    },
    state: {
      live: false,
      createPaused: true,
      securityDefaultsLocked: true,
      v3WiringExecuted: false,
      appSwitched: false,
      accepted: false,
    },
  };

  await writeJson(path.join(outDir, "candidate.json"), manifest);
  await writeJson(path.join(outDir, "01-wire.safe-batch.json"), { chainId: 56, safe, transactions: wireTransactions });
  await writeJson(path.join(outDir, "02-activate-and-retire-old-create.safe-batch.json"), { chainId: 56, safe, transactions: activateTransactions });
  await writeJson(path.join(outDir, "03-unpause-create.safe-batch.json"), { chainId: 56, safe, transactions: unpauseTransactions });

  console.log("[bnb-v3-cutover] candidate deployed DARK. Do not execute activation batches until independent verification passes.", {
    treasuryRouterV3: treasuryRouterAddress,
    creatorRewardsVault: creatorRewardsVaultAddress,
    communityRewardsVault: communityRewardsVaultAddress,
    campaignImplementation: campaignImplementationAddress,
    launchFactory: launchFactoryAddress,
    permanentLpLocker: lockerAddress,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
