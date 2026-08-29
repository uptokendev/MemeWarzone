import fs from "fs";
import path from "path";
import { ethers, network } from "hardhat";

function mustEnv(name: string, fallback?: string): string {
  const v = (process.env[name] ?? fallback ?? "").trim();
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

function numEnv(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function bigintEnv(name: string, fallback?: bigint): bigint | undefined {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  return BigInt(raw);
}

function decimalUnitsEnv(name: string, decimals = 18): bigint | undefined {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return undefined;
  const value = ethers.parseUnits(raw, decimals);
  if (value <= 0n) throw new Error(`Invalid ${name}: expected a positive decimal value`);
  return value;
}

function boolEnv(name: string, fallback = false): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function isLocalNetwork(): boolean {
  return network.name === "hardhat" || network.name === "localhost";
}

function isBscMainnet(): boolean {
  return network.name === "bscMainnet";
}

function routeProfileEnv(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 2) {
    throw new Error(`Invalid ${name}: expected 0, 1, or 2`);
  }
  return n;
}

function writeDeployment(networkName: string, data: unknown) {
  const outDir = path.join(__dirname, "..", "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${networkName}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

async function hasContractCode(address: string): Promise<boolean> {
  return (await ethers.provider.getCode(address)) !== "0x";
}

async function requireContractCode(address: string, label: string) {
  if (!(await hasContractCode(address))) throw new Error(`${label} ${address} has no contract code on ${network.name}.`);
}

async function resolveMockWrappedNative(): Promise<string> {
  const configured = (process.env.MOCK_TOPAZ_WRAPPED ?? process.env.MOCK_ROUTER_WRAPPED ?? "").trim();
  if (configured) return configured;

  const WBNB = await ethers.getContractFactory("MockWBNB");
  const wbnb = await WBNB.deploy();
  await wbnb.waitForDeployment();
  const wrapped = await wbnb.getAddress();
  console.log("MockWBNB:", wrapped);
  return wrapped;
}

async function deployMockTopazRouter(_deployerAddress: string): Promise<string> {
  console.warn("[deploy] Deploying MockTopazFactory + MockTopazRouter for local/testing use.");
  const wrapped = await resolveMockWrappedNative();

  const TopazFactory = await ethers.getContractFactory("MockTopazFactory");
  const topazFactory = await TopazFactory.deploy();
  await topazFactory.waitForDeployment();

  const Router = await ethers.getContractFactory("MockTopazRouter");
  const mockRouter = await Router.deploy(await topazFactory.getAddress(), wrapped);
  await mockRouter.waitForDeployment();

  const routerAddress = await mockRouter.getAddress();
  console.log("MockTopazFactory:", await topazFactory.getAddress());
  console.log("MockTopazRouter:", routerAddress);
  return routerAddress;
}

async function resolveRouterAddress(deployerAddress: string): Promise<string> {
  const deployMock = boolEnv("DEPLOY_MOCK_TOPAZ_ROUTER", boolEnv("DEPLOY_MOCK_ROUTER", false));
  if (deployMock) {
    return deployMockTopazRouter(deployerAddress);
  }

  const explicitRouter = (
    process.env.TOPAZ_ROUTER ??
    process.env.TOPAZ_V2_ROUTER ??
    process.env.ROUTER_ADDRESS ??
    process.env.PANCAKE_ROUTER ??
    process.env.PANCAKE_V2_ROUTER ??
    ""
  ).trim();
  if (explicitRouter) {
    if (await hasContractCode(explicitRouter)) return explicitRouter;
    if (isLocalNetwork()) {
      console.warn(
        `[deploy] Configured Topaz router ${explicitRouter} has no code on ${network.name}; using local mock router for rehearsal.`
      );
      return deployMockTopazRouter(deployerAddress);
    }
    await requireContractCode(explicitRouter, "Configured Topaz router");
  }

  if (isLocalNetwork()) {
    console.warn(`[deploy] No Topaz router configured on ${network.name}; using local mock router for rehearsal.`);
    return deployMockTopazRouter(deployerAddress);
  }

  throw new Error(
    "Missing Topaz router address. Set TOPAZ_ROUTER, TOPAZ_V2_ROUTER, or ROUTER_ADDRESS. Legacy PANCAKE_ROUTER/PANCAKE_V2_ROUTER are still accepted as aliases. For local testing only, set DEPLOY_MOCK_TOPAZ_ROUTER=true."
  );
}

async function readAddressGetter(address: string, getter: string): Promise<string | null> {
  const contract = new ethers.Contract(address, [`function ${getter}() view returns (address)`], ethers.provider);
  try {
    const value = await contract[getter]();
    return value && value !== ethers.ZeroAddress && (await hasContractCode(value)) ? value : null;
  } catch {
    return null;
  }
}

async function resolveLaunchRouter(topazRouterAddress: string) {
  const productionFactory = await readAddressGetter(topazRouterAddress, "defaultFactory");
  const productionWrapped = await readAddressGetter(topazRouterAddress, "weth");
  if (productionFactory && productionWrapped) {
    const Adapter = await ethers.getContractFactory("TopazRouterAdapter");
    const adapter = await Adapter.deploy(topazRouterAddress);
    await adapter.waitForDeployment();
    const adapterAddress = await adapter.getAddress();
    console.log("TopazRouterAdapter:", adapterAddress);
    return { launchRouterAddress: adapterAddress, topazRouterAdapter: adapterAddress, productionTopazRouter: topazRouterAddress };
  }

  const legacyFactory = await readAddressGetter(topazRouterAddress, "poolFactory");
  const legacyWrapped = await readAddressGetter(topazRouterAddress, "WETH");
  if (!legacyFactory || !legacyWrapped) {
    throw new Error(`Configured Topaz router ${topazRouterAddress} must expose either defaultFactory()/weth() or poolFactory()/WETH().`);
  }
  return { launchRouterAddress: topazRouterAddress, topazRouterAdapter: null as string | null, productionTopazRouter: topazRouterAddress };
}

async function deployLocalMockPriceFeed(): Promise<string> {
  console.warn("[deploy] Deploying MockUsdPriceFeed for local/testing use.");
  const mockPrice = process.env.MOCK_NATIVE_USD_PRICE ?? "600";
  const PriceFeed = await ethers.getContractFactory("MockUsdPriceFeed");
  const priceFeed = await PriceFeed.deploy(8);
  await priceFeed.waitForDeployment();
  const block = await ethers.provider.getBlock("latest");
  const timestamp = BigInt(block!.timestamp);
  await priceFeed.setRoundData(1n, ethers.parseUnits(mockPrice, 8), timestamp, timestamp, 1n);
  const feedAddress = await priceFeed.getAddress();
  console.log("MockUsdPriceFeed:", feedAddress, "price:", mockPrice);
  return feedAddress;
}

async function resolveGraduationOracle(): Promise<{ oracleAddress: string; priceFeedAddress: string | null; maxPriceAge: number | null }> {
  const explicitOracle = (process.env.GRADUATION_ORACLE_ADDRESS ?? "").trim();
  if (explicitOracle) {
    if (await hasContractCode(explicitOracle)) {
      return { oracleAddress: explicitOracle, priceFeedAddress: null, maxPriceAge: null };
    }
    if (!isLocalNetwork()) {
      await requireContractCode(explicitOracle, "Configured GraduationOracle");
    }
    console.warn(
      `[deploy] Configured GraduationOracle ${explicitOracle} has no code on ${network.name}; deploying local oracle for rehearsal.`
    );
  }

  let priceFeedAddress = (
    process.env.BNB_USD_PRICE_FEED ??
    process.env.NATIVE_USD_PRICE_FEED ??
    process.env.GRADUATION_PRICE_FEED ??
    ""
  ).trim();

  if (priceFeedAddress && !(await hasContractCode(priceFeedAddress))) {
    if (!isLocalNetwork()) {
      await requireContractCode(priceFeedAddress, "Configured native/USD price feed");
    }
    console.warn(
      `[deploy] Configured native/USD price feed ${priceFeedAddress} has no code on ${network.name}; using local mock feed for rehearsal.`
    );
    priceFeedAddress = "";
  }

  if (!priceFeedAddress && (isLocalNetwork() || boolEnv("DEPLOY_MOCK_PRICE_FEED", false))) {
    priceFeedAddress = await deployLocalMockPriceFeed();
  }

  if (!priceFeedAddress) {
    throw new Error(
      "Missing graduation oracle configuration. Set GRADUATION_ORACLE_ADDRESS or BNB_USD_PRICE_FEED/NATIVE_USD_PRICE_FEED. For local testing only, set DEPLOY_MOCK_PRICE_FEED=true."
    );
  }

  await requireContractCode(priceFeedAddress, "Configured native/USD price feed");
  const maxPriceAge = numEnv("GRADUATION_ORACLE_MAX_PRICE_AGE_SECONDS", 3600);
  const GraduationOracle = await ethers.getContractFactory("GraduationOracle");
  const oracle = await GraduationOracle.deploy(priceFeedAddress, maxPriceAge);
  await oracle.waitForDeployment();
  const oracleAddress = await oracle.getAddress();
  console.log("GraduationOracle:", oracleAddress);
  console.log("Graduation price feed:", priceFeedAddress);
  console.log("Graduation max price age:", maxPriceAge);
  return { oracleAddress, priceFeedAddress, maxPriceAge };
}

async function resolveCharityTreasury(treasurySafe: string): Promise<{ address: string; deployed: boolean }> {
  const configured = (process.env.CHARITY_TREASURY ?? process.env.CHARITY_TREASURY_ADDRESS ?? "").trim();
  if (configured) {
    await requireContractCode(configured, "Configured charity treasury");
    return { address: configured, deployed: false };
  }

  const Charity = await ethers.getContractFactory("CharityTreasury");
  const charity = await Charity.deploy(treasurySafe);
  await charity.waitForDeployment();
  const charityAddress = await charity.getAddress();
  console.log("CharityTreasury:", charityAddress);
  return { address: charityAddress, deployed: true };
}

async function resolveMonthlyLeagueTreasury(
  treasurySafe: string,
  rootPoster: string,
  oracleAddress: string,
  charityTreasuryAddress: string
): Promise<{ address: string; deployed: boolean; capUsd: bigint }> {
  const configured = (process.env.MONTHLY_LEAGUE_TREASURY ?? process.env.MONTHLY_LEAGUE_TREASURY_ADDRESS ?? "").trim();
  const monthlyCapUsd = bigintEnv("MONTHLY_LEAGUE_CAP_USD", 0n) ?? 0n;
  if (configured) {
    await requireContractCode(configured, "Configured monthly league treasury");
    return { address: configured, deployed: false, capUsd: monthlyCapUsd };
  }

  const Monthly = await ethers.getContractFactory("MonthlyLeagueTreasury");
  const monthlyTreasury = await Monthly.deploy(treasurySafe, rootPoster, oracleAddress, charityTreasuryAddress, monthlyCapUsd);
  await monthlyTreasury.waitForDeployment();
  const monthlyTreasuryAddress = await monthlyTreasury.getAddress();
  console.log("MonthlyLeagueTreasury:", monthlyTreasuryAddress);
  return { address: monthlyTreasuryAddress, deployed: true, capUsd: monthlyCapUsd };
}

export async function deployProtocol() {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  const net = await ethers.provider.getNetwork();
  const deploymentStartBlock = await ethers.provider.getBlockNumber();

  if (isBscMainnet() && net.chainId !== 56n) {
    throw new Error(`bscMainnet must resolve chain ID 56, got ${net.chainId.toString()}`);
  }

  const productionTopazRouterAddress = await resolveRouterAddress(deployerAddress);
  const launchRouter = await resolveLaunchRouter(productionTopazRouterAddress);
  const routerAddress = launchRouter.launchRouterAddress;
  const graduationOracleConfig = await resolveGraduationOracle();
  const treasurySafe = isBscMainnet()
    ? mustEnv("TREASURY_SAFE")
    : mustEnv("TREASURY_SAFE", process.env.FEE_RECIPIENT ?? deployerAddress);
  const upgradeDelaySeconds = numEnv("UPGRADE_DELAY_SECONDS", 2 * 24 * 60 * 60);
  const protocolFeeBps = BigInt(numEnv("PROTOCOL_FEE_BPS", 200));
  const graduationTargetUsd = decimalUnitsEnv("GRADUATION_TARGET_USD");
  const operator = String(process.env.LEAGUE_PAYOUT_OPERATOR ?? ethers.ZeroAddress).trim();
  const rootPoster = String(process.env.LEAGUE_ROOT_POSTER ?? ethers.ZeroAddress).trim();

  const payoutMaxPerTx = bigintEnv("LEAGUE_PAYOUT_MAX_PER_TX");
  const payoutDailyCap = bigintEnv("LEAGUE_PAYOUT_DAILY_CAP");
  const claimMaxPerTx = bigintEnv("LEAGUE_CLAIM_MAX_PER_TX");
  const claimMaxEpochTotal = bigintEnv("LEAGUE_CLAIM_MAX_EPOCH_TOTAL");
  const enableLeaguePayouts = boolEnv("ENABLE_LEAGUE_PAYOUTS", false);
  const enableLeagueClaims = boolEnv("ENABLE_LEAGUE_CLAIMS", false);
  const recruiterPayoutOperator = String(process.env.RECRUITER_PAYOUT_OPERATOR ?? ethers.ZeroAddress).trim();
  const recruiterPayoutMaxPerTx = bigintEnv("RECRUITER_PAYOUT_MAX_PER_TX");
  const recruiterPayoutDailyCap = bigintEnv("RECRUITER_PAYOUT_DAILY_CAP");
  const enableRecruiterPayouts = boolEnv("ENABLE_RECRUITER_PAYOUTS", false);
  const tradeRouteProfile = routeProfileEnv("PHASE1_TRADE_ROUTE_PROFILE", 1);
  const finalizeRouteProfile = routeProfileEnv("PHASE1_FINALIZE_ROUTE_PROFILE", 1);
  const routeAuthority = String(process.env.ROUTE_AUTHORITY_ADDRESS ?? "").trim();
  const useTreasuryRouterV2 = boolEnv("DEPLOY_TREASURY_ROUTER_V2", boolEnv("USE_TREASURY_ROUTER_V2", false));
  const weeklyLeagueBps = 3000;
  const monthlyLeagueBps = 7000;
  const treasuryRouterLabel = useTreasuryRouterV2 ? "TreasuryRouterV2" : "TreasuryRouter";

  if (isBscMainnet()) {
    if (!useTreasuryRouterV2) throw new Error("bscMainnet requires TreasuryRouterV2");
    if (!routeAuthority || routeAuthority === ethers.ZeroAddress) throw new Error("bscMainnet requires ROUTE_AUTHORITY_ADDRESS");
    if (graduationTargetUsd === undefined) throw new Error("bscMainnet requires an explicit GRADUATION_TARGET_USD");
    if ((bigintEnv("MONTHLY_LEAGUE_CAP_USD") ?? 0n) <= 0n) throw new Error("bscMainnet requires MONTHLY_LEAGUE_CAP_USD");
    if (enableLeaguePayouts || enableLeagueClaims || enableRecruiterPayouts) {
      throw new Error("Reward and payout lanes must remain paused during the initial bscMainnet deployment");
    }
  }

  console.log(`Network: ${network.name}`);
  console.log(`Chain ID: ${net.chainId.toString()}`);
  console.log(`Deployment start block: ${deploymentStartBlock}`);
  console.log(`Deployer: ${deployerAddress}`);
  console.log("Topaz production router:", productionTopazRouterAddress);
  console.log("Launch router:", routerAddress);
  console.log("GraduationOracle:", graduationOracleConfig.oracleAddress);
  console.log("Treasury Safe:", treasurySafe);
  console.log("Upgrade delay (seconds):", upgradeDelaySeconds);
  console.log("Protocol fee bps:", protocolFeeBps.toString());
  console.log(
    "Graduation target USD:",
    graduationTargetUsd === undefined ? "factory default" : ethers.formatUnits(graduationTargetUsd, 18),
  );
  console.log("League payout operator:", operator);
  console.log("League root poster:", rootPoster);
  console.log("League payout max/tx:", payoutMaxPerTx?.toString() ?? "unset");
  console.log("League payout daily cap:", payoutDailyCap?.toString() ?? "unset");
  console.log("League claim max/tx:", claimMaxPerTx?.toString() ?? "unset");
  console.log("League claim max epoch total:", claimMaxEpochTotal?.toString() ?? "unset");
  console.log("Enable league payouts:", enableLeaguePayouts);
  console.log("Enable league claims:", enableLeagueClaims);
  console.log("Recruiter payout operator:", recruiterPayoutOperator);
  console.log("Recruiter payout max/tx:", recruiterPayoutMaxPerTx?.toString() ?? "unset");
  console.log("Recruiter payout daily cap:", recruiterPayoutDailyCap?.toString() ?? "unset");
  console.log("Enable recruiter payouts:", enableRecruiterPayouts);
  console.log("Factory trade route profile:", tradeRouteProfile);
  console.log("Factory finalize route profile:", finalizeRouteProfile);
  console.log("Route authority:", routeAuthority || "unset");
  console.log("Deploy TreasuryRouterV2:", useTreasuryRouterV2);

  const canAdminConfigure = treasurySafe.toLowerCase() === deployerAddress.toLowerCase();
  console.log("Can configure admin-owned routing immediately:", canAdminConfigure);
  const postDeployActions: string[] = [];

  const Vault = await ethers.getContractFactory("TreasuryVaultV2");
  const vault = await Vault.deploy(treasurySafe, operator, rootPoster);
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();
  console.log("LeagueTreasury (TreasuryVaultV2):", vaultAddress);

  if (payoutMaxPerTx !== undefined || payoutDailyCap !== undefined) {
    const tx = await vault.setCaps(payoutMaxPerTx ?? 0n, payoutDailyCap ?? 0n);
    await tx.wait();
    console.log("Configured payout caps");
  }

  if (claimMaxPerTx !== undefined || claimMaxEpochTotal !== undefined) {
    const tx = await vault.setClaimCaps(claimMaxPerTx ?? 0n, claimMaxEpochTotal ?? 0n);
    await tx.wait();
    console.log("Configured claim caps");
  }

  if (enableLeaguePayouts) {
    const tx = await vault.setPayoutsPaused(false);
    await tx.wait();
    console.log("Unpaused operator payout lane");
  }

  if (enableLeagueClaims) {
    const tx = await vault.setClaimsPaused(false);
    await tx.wait();
    console.log("Unpaused Merkle claim lane");
  }

  const charityTreasury = useTreasuryRouterV2
    ? await resolveCharityTreasury(treasurySafe)
    : { address: null as string | null, deployed: false };
  const charityTreasuryAddress = charityTreasury.address;
  const monthlyLeagueTreasury = useTreasuryRouterV2
    ? await resolveMonthlyLeagueTreasury(treasurySafe, rootPoster, graduationOracleConfig.oracleAddress, charityTreasuryAddress!)
    : { address: null as string | null, deployed: false, capUsd: 0n };
  const monthlyLeagueTreasuryAddress = monthlyLeagueTreasury.address;

  const Router = await ethers.getContractFactory(treasuryRouterLabel);
  const leagueRouter = useTreasuryRouterV2
    ? await Router.deploy(treasurySafe, vaultAddress, monthlyLeagueTreasuryAddress, upgradeDelaySeconds)
    : await Router.deploy(treasurySafe, vaultAddress, upgradeDelaySeconds);
  await leagueRouter.waitForDeployment();
  const leagueRouterAddress = await leagueRouter.getAddress();
  console.log(`${treasuryRouterLabel}:`, leagueRouterAddress);
  if (useTreasuryRouterV2) {
    console.log("Weekly/monthly league split:", `${weeklyLeagueBps}/${monthlyLeagueBps}`);
  }

  const RecruiterVault = await ethers.getContractFactory("RecruiterRewardsVault");
  const recruiterVault = await RecruiterVault.deploy(treasurySafe);
  await recruiterVault.waitForDeployment();
  const recruiterVaultAddress = await recruiterVault.getAddress();
  console.log("RecruiterRewardsVault:", recruiterVaultAddress);

  if (canAdminConfigure) {
    if (recruiterPayoutOperator !== ethers.ZeroAddress && (await recruiterVault.operator()).toLowerCase() !== recruiterPayoutOperator.toLowerCase()) {
      const tx = await recruiterVault.setOperator(recruiterPayoutOperator);
      await tx.wait();
      console.log("Recruiter payout operator set:", recruiterPayoutOperator);
    }

    if (recruiterPayoutMaxPerTx !== undefined || recruiterPayoutDailyCap !== undefined) {
      const tx = await recruiterVault.setPayoutCaps(recruiterPayoutMaxPerTx ?? 0n, recruiterPayoutDailyCap ?? 0n);
      await tx.wait();
      console.log("Configured recruiter payout caps");
    }

    if (enableRecruiterPayouts) {
      const tx = await recruiterVault.setPayoutsPaused(false);
      await tx.wait();
      console.log("Unpaused recruiter operator payout lane");
    }
  } else {
    if (recruiterPayoutOperator !== ethers.ZeroAddress) {
      postDeployActions.push(`RecruiterRewardsVault.setOperator(${recruiterPayoutOperator})`);
    }
    if (recruiterPayoutMaxPerTx !== undefined || recruiterPayoutDailyCap !== undefined) {
      postDeployActions.push(`RecruiterRewardsVault.setPayoutCaps(${recruiterPayoutMaxPerTx ?? 0n}, ${recruiterPayoutDailyCap ?? 0n})`);
    }
    if (enableRecruiterPayouts) {
      postDeployActions.push("RecruiterRewardsVault.setPayoutsPaused(false)");
    }
  }

  const CommunityVault = await ethers.getContractFactory("CommunityRewardsVault");
  const communityVault = await CommunityVault.deploy(
    treasurySafe,
    canAdminConfigure ? leagueRouterAddress : ethers.ZeroAddress
  );
  await communityVault.waitForDeployment();
  const communityVaultAddress = await communityVault.getAddress();
  console.log("CommunityRewardsVault:", communityVaultAddress);

  const ProtocolVault = await ethers.getContractFactory("ProtocolRevenueVault");
  const protocolVault = await ProtocolVault.deploy(treasurySafe);
  await protocolVault.waitForDeployment();
  const protocolVaultAddress = await protocolVault.getAddress();
  console.log("ProtocolRevenueVault:", protocolVaultAddress);

  if (canAdminConfigure) {
    let tx = await leagueRouter.setRecruiterRewardsVault(recruiterVaultAddress);
    await tx.wait();
    console.log("Router recruiter vault set:", recruiterVaultAddress);

    tx = await leagueRouter.setCommunityRewardsVault(communityVaultAddress);
    await tx.wait();
    console.log("Router community vault set:", communityVaultAddress);

    tx = await leagueRouter.setProtocolRevenueVault(protocolVaultAddress);
    await tx.wait();
    console.log("Router protocol vault set:", protocolVaultAddress);
  } else {
    postDeployActions.push(`${treasuryRouterLabel}.setRecruiterRewardsVault(${recruiterVaultAddress})`);
    postDeployActions.push(`${treasuryRouterLabel}.setCommunityRewardsVault(${communityVaultAddress})`);
    postDeployActions.push(`${treasuryRouterLabel}.setProtocolRevenueVault(${protocolVaultAddress})`);
    postDeployActions.push(`CommunityRewardsVault.setRouter(${leagueRouterAddress})`);
    console.warn("[deploy] Treasury safe differs from deployer; router/community admin wiring left for multisig execution.");
  }

  const CreatorRegistryFactory = await ethers.getContractFactory("CreatorRegistry");
  const creatorRegistry = await CreatorRegistryFactory.deploy();
  await creatorRegistry.waitForDeployment();
  const creatorRegistryAddress = await creatorRegistry.getAddress();
  console.log("CreatorRegistry:", creatorRegistryAddress);

  const RiskRegistryFactory = await ethers.getContractFactory("RiskRegistry");
  const riskRegistry = await RiskRegistryFactory.deploy();
  await riskRegistry.waitForDeployment();
  const riskRegistryAddress = await riskRegistry.getAddress();
  console.log("RiskRegistry:", riskRegistryAddress);

  const Campaign = await ethers.getContractFactory("LaunchCampaign");
  const campaignImplementation = await Campaign.deploy();
  await campaignImplementation.waitForDeployment();
  const campaignImplementationAddress = await campaignImplementation.getAddress();
  console.log("LaunchCampaign implementation:", campaignImplementationAddress);

  const Factory = await ethers.getContractFactory("LaunchFactory");
  const factory = await Factory.deploy(
    routerAddress,
    leagueRouterAddress,
    campaignImplementationAddress,
    graduationOracleConfig.oracleAddress
  );
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  const permanentLpLockerAddress = await factory.permanentLpLocker();
  console.log("LaunchFactory:", factoryAddress);
  console.log("PermanentLpLocker:", permanentLpLockerAddress);

  if (graduationTargetUsd !== undefined) {
    const currentConfig = await factory.config();
    const tx = await factory.setConfig({
      totalSupply: currentConfig.totalSupply,
      curveBps: currentConfig.curveBps,
      liquidityTokenBps: currentConfig.liquidityTokenBps,
      basePrice: currentConfig.basePrice,
      priceSlope: currentConfig.priceSlope,
      graduationTarget: graduationTargetUsd,
      liquidityBps: currentConfig.liquidityBps,
    });
    await tx.wait();
    console.log("Factory graduation target USD set:", ethers.formatUnits(graduationTargetUsd, 18));
  }

  if (useTreasuryRouterV2) {
    if (canAdminConfigure) {
      let tx = await leagueRouter.setAuthorizedLpLocker(permanentLpLockerAddress, true);
      await tx.wait();
      console.log("Router authorized LP locker:", permanentLpLockerAddress);

      tx = await leagueRouter.setPrimaryLpLocker(permanentLpLockerAddress);
      await tx.wait();
      console.log("Router primary LP locker set:", permanentLpLockerAddress);
    } else {
      postDeployActions.push(`${treasuryRouterLabel}.setAuthorizedLpLocker(${permanentLpLockerAddress}, true)`);
      postDeployActions.push(`${treasuryRouterLabel}.setPrimaryLpLocker(${permanentLpLockerAddress})`);
    }
  }

  let registryTx = await creatorRegistry.setLaunchRecorder(factoryAddress, true);
  await registryTx.wait();
  console.log("CreatorRegistry launch recorder set:", factoryAddress);

  registryTx = await factory.setRegistries(creatorRegistryAddress, riskRegistryAddress);
  await registryTx.wait();
  console.log("Factory registries set:", { creatorRegistry: creatorRegistryAddress, riskRegistry: riskRegistryAddress });

  if (treasurySafe.toLowerCase() !== deployerAddress.toLowerCase()) {
    registryTx = await creatorRegistry.transferOwnership(treasurySafe);
    await registryTx.wait();
    registryTx = await riskRegistry.transferOwnership(treasurySafe);
    await registryTx.wait();
    console.log("Registry ownership transferred to treasury safe:", treasurySafe);
  }

  if ((await factory.tradeRouteProfile()) !== BigInt(tradeRouteProfile) || (await factory.finalizeRouteProfile()) !== BigInt(finalizeRouteProfile)) {
    const tx = await factory.setRouteProfiles(tradeRouteProfile, finalizeRouteProfile);
    await tx.wait();
    console.log("Factory route profiles set:", { tradeRouteProfile, finalizeRouteProfile });
  }

  if (routeAuthority && (await factory.routeAuthority()).toLowerCase() !== routeAuthority.toLowerCase()) {
    const tx = await factory.setRouteAuthority(routeAuthority);
    await tx.wait();
    console.log("Factory route authority set:", routeAuthority);
  }

  if ((await factory.protocolFeeBps()) !== protocolFeeBps) {
    const tx = await factory.setProtocolFee(protocolFeeBps);
    await tx.wait();
    console.log("ProtocolFeeBps set:", protocolFeeBps.toString());
  }

  if (treasurySafe.toLowerCase() !== deployerAddress.toLowerCase() && (await factory.owner()).toLowerCase() === deployerAddress.toLowerCase()) {
    const tx = await factory.transferOwnership(treasurySafe);
    await tx.wait();
    console.log("LaunchFactory ownership transferred to treasury safe:", treasurySafe);
  }

  const factoryOwner = await factory.owner();
  const creatorRegistryOwner = await creatorRegistry.owner();
  const riskRegistryOwner = await riskRegistry.owner();
  const ownersOnSafe =
    factoryOwner.toLowerCase() === treasurySafe.toLowerCase() &&
    creatorRegistryOwner.toLowerCase() === treasurySafe.toLowerCase() &&
    riskRegistryOwner.toLowerCase() === treasurySafe.toLowerCase();
  const distinctSafe = treasurySafe.toLowerCase() !== deployerAddress.toLowerCase();
  let deployerFactoryHandoffVerified = !distinctSafe;
  if (distinctSafe) {
    let stillCallable = false;
    try {
      await factory.setProtocolFee(protocolFeeBps);
      stillCallable = true;
    } catch {
      stillCallable = false;
    }
    deployerFactoryHandoffVerified = !stillCallable;
    console.log("Deployer factory handoff verified:", deployerFactoryHandoffVerified);
  }

  let authorityStatus: "accepted" | "incomplete" | "local" = "incomplete";
  if (isLocalNetwork()) {
    authorityStatus = distinctSafe && ownersOnSafe && deployerFactoryHandoffVerified ? "accepted" : "local";
  } else if (distinctSafe && ownersOnSafe && deployerFactoryHandoffVerified) {
    authorityStatus = "accepted";
  } else {
    authorityStatus = "incomplete";
  }

  const UPVoteTreasury = await ethers.getContractFactory("UPVoteTreasury");
  const voteTreasury = await UPVoteTreasury.deploy(treasurySafe, treasurySafe);
  await voteTreasury.waitForDeployment();
  const voteTreasuryAddress = await voteTreasury.getAddress();
  console.log("UPVoteTreasury:", voteTreasuryAddress);

  const deployment = {
    network: network.name,
    chainId: Number(net.chainId),
    deploymentBlock: deploymentStartBlock,
    deployer: deployerAddress,
    router: routerAddress,
    topazRouter: routerAddress,
    productionTopazRouter: productionTopazRouterAddress,
    topazRouterAdapter: launchRouter.topazRouterAdapter,
    creatorRegistry: creatorRegistryAddress,
    riskRegistry: riskRegistryAddress,
    permanentLpLocker: permanentLpLockerAddress,
    graduationOracle: graduationOracleConfig.oracleAddress,
    graduationPriceFeed: graduationOracleConfig.priceFeedAddress,
    graduationMaxPriceAge: graduationOracleConfig.maxPriceAge,
    treasurySafe,
    treasuryRouterVersion: useTreasuryRouterV2 ? "v2" : "v1",
    weeklyLeagueVault: vaultAddress,
    monthlyLeagueTreasury: monthlyLeagueTreasuryAddress,
    monthlyLeagueTreasuryDeployed: monthlyLeagueTreasury.deployed,
    monthlyLeagueCapUsd: useTreasuryRouterV2 ? monthlyLeagueTreasury.capUsd.toString() : null,
    charityTreasury: charityTreasuryAddress,
    charityTreasuryDeployed: charityTreasury.deployed,
    weeklyLeagueBps: useTreasuryRouterV2 ? weeklyLeagueBps : null,
    monthlyLeagueBps: useTreasuryRouterV2 ? monthlyLeagueBps : null,
    upgradeDelaySeconds,
    protocolFeeBps: protocolFeeBps.toString(),
    graduationTargetUsd: (graduationTargetUsd ?? (await factory.config()).graduationTarget).toString(),
    leaguePayoutOperator: operator,
    leagueRootPoster: rootPoster,
    leaguePayoutMaxPerTx: payoutMaxPerTx?.toString() ?? null,
    leaguePayoutDailyCap: payoutDailyCap?.toString() ?? null,
    leagueClaimMaxPerTx: claimMaxPerTx?.toString() ?? null,
    leagueClaimMaxEpochTotal: claimMaxEpochTotal?.toString() ?? null,
    enableLeaguePayouts,
    enableLeagueClaims,
    recruiterPayoutOperator,
    recruiterPayoutMaxPerTx: recruiterPayoutMaxPerTx?.toString() ?? null,
    recruiterPayoutDailyCap: recruiterPayoutDailyCap?.toString() ?? null,
    enableRecruiterPayouts,
    canAdminConfigure,
    authority: {
      status: authorityStatus,
      expectedSafe: treasurySafe,
      factoryOwner,
      creatorRegistryOwner,
      riskRegistryOwner,
      deployerFactoryHandoffVerified,
      githubMainProtection: "manual",
    },
    contracts: {
      LeagueTreasury: vaultAddress,
      TreasuryVaultV2: vaultAddress,
      TreasuryRouter: leagueRouterAddress,
      ...(useTreasuryRouterV2
        ? {
            TreasuryRouterV2: leagueRouterAddress,
            WeeklyLeagueVault: vaultAddress,
            MonthlyLeagueTreasury: monthlyLeagueTreasuryAddress,
            CharityTreasury: charityTreasuryAddress,
          }
        : {}),
      RecruiterRewardsVault: recruiterVaultAddress,
      CommunityRewardsVault: communityVaultAddress,
      ProtocolRevenueVault: protocolVaultAddress,
      CreatorRegistry: creatorRegistryAddress,
      RiskRegistry: riskRegistryAddress,
      GraduationOracle: graduationOracleConfig.oracleAddress,
      TopazRouterAdapter: launchRouter.topazRouterAdapter,
      LaunchCampaignImplementation: campaignImplementationAddress,
      LaunchFactory: factoryAddress,
      PermanentLpLocker: permanentLpLockerAddress,
      UPVoteTreasury: voteTreasuryAddress,
    },
    routing: {
      activeLeagueVault: vaultAddress,
      weeklyLeagueVault: vaultAddress,
      monthlyLeagueTreasury: monthlyLeagueTreasuryAddress,
      monthlyLeagueCapUsd: useTreasuryRouterV2 ? monthlyLeagueTreasury.capUsd.toString() : null,
      charityTreasury: charityTreasuryAddress,
      weeklyLeagueBps: useTreasuryRouterV2 ? weeklyLeagueBps : null,
      monthlyLeagueBps: useTreasuryRouterV2 ? monthlyLeagueBps : null,
      recruiterRewardsVault: canAdminConfigure ? recruiterVaultAddress : null,
      recruiterPayoutOperator: recruiterPayoutOperator !== ethers.ZeroAddress ? recruiterPayoutOperator : null,
      recruiterPayoutMaxPerTx: recruiterPayoutMaxPerTx?.toString() ?? null,
      recruiterPayoutDailyCap: recruiterPayoutDailyCap?.toString() ?? null,
      recruiterPayoutsEnabled: canAdminConfigure ? enableRecruiterPayouts : null,
      communityRewardsVault: canAdminConfigure ? communityVaultAddress : null,
      protocolRevenueVault: canAdminConfigure ? protocolVaultAddress : null,
      factoryFeeRecipient: leagueRouterAddress,
      factoryTradeRouteProfile: tradeRouteProfile,
      factoryFinalizeRouteProfile: finalizeRouteProfile,
      factoryRouteAuthority: routeAuthority || null,
      campaignImplementation: campaignImplementationAddress,
      graduationOracle: graduationOracleConfig.oracleAddress,
      topazRouter: routerAddress,
      productionTopazRouter: productionTopazRouterAddress,
      topazRouterAdapter: launchRouter.topazRouterAdapter,
      permanentLpLocker: permanentLpLockerAddress,
      permanentLpLockerAuthorized: useTreasuryRouterV2 ? canAdminConfigure : null,
      unifiedRouterModeActive: true,
    },
    security: {
      creatorRegistry: creatorRegistryAddress,
      riskRegistry: riskRegistryAddress,
      factoryLaunchRecorderEnabled: true,
      registryOwner: creatorRegistryOwner,
      factoryOwner,
      riskRegistryOwner,
      authorityStatus,
    },
    postDeployActions,
  };

  const file = writeDeployment(network.name, deployment);
  console.log("\nSaved deployment:", file);
  console.log("Authority status:", authorityStatus);
  console.log("LaunchFactory owner:", factoryOwner);
  console.log("CreatorRegistry owner:", creatorRegistryOwner);
  console.log("RiskRegistry owner:", riskRegistryOwner);
  if (!isLocalNetwork() && authorityStatus !== "accepted") {
    throw new Error(
      `Non-local deployment is incomplete: LaunchFactory/CreatorRegistry/RiskRegistry must be owned by TREASURY_SAFE (${treasurySafe}). factory.owner=${factoryOwner} creatorRegistry.owner=${creatorRegistryOwner} riskRegistry.owner=${riskRegistryOwner}. Manifest marked incomplete and must not be treated as accepted.`
    );
  }
  console.log("\nCanonical deploy path: hardhat run scripts/deploy.ts --network <network>");
  console.log("\nFrontend env:");
  console.log(`VITE_FACTORY_ADDRESS_${deployment.chainId}=${factoryAddress}`);
  console.log(`VITE_VOTE_TREASURY_ADDRESS_${deployment.chainId}=${voteTreasuryAddress}`);
  console.log(`VITE_TREASURY_ROUTER_ADDRESS_${deployment.chainId}=${leagueRouterAddress}`);
  console.log(`VITE_COMMUNITY_REWARDS_VAULT_ADDRESS_${deployment.chainId}=${communityVaultAddress}`);
  console.log(`VITE_RECRUITER_REWARDS_VAULT_ADDRESS_${deployment.chainId}=${recruiterVaultAddress}`);
  console.log(`VITE_PROTOCOL_REVENUE_VAULT_ADDRESS_${deployment.chainId}=${protocolVaultAddress}`);
  console.log(`VITE_CREATOR_REGISTRY_ADDRESS_${deployment.chainId}=${creatorRegistryAddress}`);
  console.log(`VITE_RISK_REGISTRY_ADDRESS_${deployment.chainId}=${riskRegistryAddress}`);
  console.log(`VITE_GRADUATION_ORACLE_ADDRESS_${deployment.chainId}=${graduationOracleConfig.oracleAddress}`);
  console.log(`VITE_TOPAZ_ROUTER_ADDRESS_${deployment.chainId}=${routerAddress}`);
  console.log(`VITE_TOPAZ_PRODUCTION_ROUTER_ADDRESS_${deployment.chainId}=${productionTopazRouterAddress}`);
  console.log(`VITE_PERMANENT_LP_LOCKER_ADDRESS_${deployment.chainId}=${permanentLpLockerAddress}`);
  console.log(`VITE_CAMPAIGN_IMPLEMENTATION_ADDRESS_${deployment.chainId}=${campaignImplementationAddress}`);
  console.log("\nPhase 1 routing topology:");
  console.log(`- LaunchFactory feeRecipient -> ${treasuryRouterLabel} (unified mode trigger):`, leagueRouterAddress);
  console.log("- LaunchCampaign implementation for clones:", campaignImplementationAddress);
  console.log("- GraduationOracle for USD threshold:", graduationOracleConfig.oracleAddress);
  console.log("- CreatorRegistry for tier/cooldown/live-count enforcement:", creatorRegistryAddress);
  console.log("- RiskRegistry for wallet/cluster enforcement:", riskRegistryAddress);
  console.log("- Launch router for campaign graduation:", routerAddress);
  console.log("- Topaz production router:", productionTopazRouterAddress);
  console.log("- Permanent LP locker:", permanentLpLockerAddress);
  console.log("- Factory route profiles: trade=", tradeRouteProfile, "finalize=", finalizeRouteProfile);
  console.log("- Factory route authority:", routeAuthority || "(not set)");
  if (useTreasuryRouterV2) {
    console.log(
      "- League trade slice -> TreasuryRouterV2 -> weekly/monthly league treasuries:",
      leagueRouterAddress,
      "->",
      vaultAddress,
      "/",
      monthlyLeagueTreasuryAddress,
      `(${weeklyLeagueBps}/${monthlyLeagueBps})`
    );
    console.log("- Monthly league cap oracle:", graduationOracleConfig.oracleAddress);
    console.log("- Monthly league overflow charity treasury:", charityTreasuryAddress);
    console.log("- LP locker revenue routes accepted from authorized PermanentLpLocker:", permanentLpLockerAddress);
  } else {
    console.log("- League trade slice -> TreasuryRouter -> LeagueTreasury:", leagueRouterAddress, "->", vaultAddress);
  }
  console.log("- Recruiter-directed slices -> RecruiterRewardsVault:", recruiterVaultAddress);
  console.log("- Community slices -> CommunityRewardsVault:", communityVaultAddress);
  console.log("- Residual protocol share -> ProtocolRevenueVault:", protocolVaultAddress);
  console.log("- Legacy protocol treasury safe remains admin/operator for vault control:", treasurySafe);
  console.log("- League vault lanes start paused by default and only activate if caps + role envs are configured.");
  if (postDeployActions.length) {
    console.log("\nPending multisig/admin actions:");
    for (const action of postDeployActions) console.log(`- ${action}`);
  }

  return deployment;
}
