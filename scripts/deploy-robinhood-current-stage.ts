import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ethers, network } from "hardhat";

const CHAIN_ID = 46630;
const FEE_TIER = 3000;
const TEST_GRADUATION_TARGET_USD = ethers.parseEther("6");
const DEFAULT_ORACLE_MAX_AGE = 900;
const DEFAULT_MIN_BALANCE_WEI = 50_000_000_000_000_000n;
const TREASURY_UPGRADE_DELAY = 3600;
const MANIFEST_PATH = path.resolve("deployments/robinhood/testnet.staged.json");

function required(name: string): string {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function runtimeHash(address: string): Promise<string> {
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") throw new Error(`runtime bytecode missing at ${address}`);
  return ethers.keccak256(code);
}

async function waitDeployment(contract: any, name: string) {
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  const tx = contract.deploymentTransaction();
  if (!tx) throw new Error(`${name} deployment transaction missing`);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`${name} deployment failed`);
  return { address, txHash: tx.hash, blockNumber: receipt.blockNumber, runtimeCodeHash: await runtimeHash(address) };
}

async function waitTx(name: string, promise: Promise<any>) {
  const tx = await promise;
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`${name} failed`);
  return { name, txHash: tx.hash, blockNumber: receipt.blockNumber };
}

async function main() {
  const authority = await Function("specifier", "return import(specifier)")(
    pathToFileURL(path.join(__dirname, "robinhoodCurrentStageAuthority.mjs")).href,
  );
  const freeze = await Function("specifier", "return import(specifier)")(
    pathToFileURL(path.join(__dirname, "robinhoodTestnetFreeze.mjs")).href,
  );

  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  if (chainId !== CHAIN_ID || network.name !== "robinhoodTestnet") {
    throw new Error(`current staging executor requires robinhoodTestnet / ${CHAIN_ID}; got ${network.name} / ${chainId}`);
  }

  const rpcUrl = required("ROBINHOOD_TESTNET_RPC_URL");
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("explicit Robinhood staging deployer signer is required");
  const deployerAddress = await deployer.getAddress();
  const balance = await ethers.provider.getBalance(deployerAddress);
  const admin = required("ROBINHOOD_TESTNET_ADMIN");
  const routeAuthority = required("ROBINHOOD_ROUTE_AUTHORITY_ADDRESS");
  const weth = required("ROBINHOOD_WETH_ADDRESS_46630");
  const v3Factory = required("ROBINHOOD_V3_FACTORY_ADDRESS_46630");
  const positionManager = required("ROBINHOOD_V3_POSITION_MANAGER_ADDRESS_46630");
  const swapRouter = required("ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_46630");
  const nativeUsdOracle = required("ROBINHOOD_NATIVE_USD_ORACLE_ADDRESS_46630");
  const minimumBalanceWei = process.env.ROBINHOOD_TESTNET_MIN_DEPLOYER_BALANCE_WEI || DEFAULT_MIN_BALANCE_WEI.toString();

  const frozen = freeze.loadRobinhoodTestnetFreeze();
  const historicalAddresses = frozen
    ? [frozen.factory, ...Object.values(frozen.contracts || {})].filter(Boolean)
    : [];
  const operator = authority.validateOperatorBoundary({
    chainId,
    rpcUrl,
    deployer: deployerAddress,
    admin,
    routeAuthority,
    weth,
    v3Factory,
    positionManager,
    swapRouter,
    nativeUsdOracle,
    deployerBalanceWei: balance,
    minimumBalanceWei,
    broadcastToken: process.env.ROBINHOOD_TESTNET_BROADCAST,
    historicalAddresses,
  });

  const requiredInfrastructure = { weth, v3Factory, positionManager, swapRouter, nativeUsdOracle };
  const infraCodeHashes: Record<string, string> = {};
  for (const [name, address] of Object.entries(requiredInfrastructure)) {
    const code = await ethers.provider.getCode(address);
    authority.requireRuntimeCode(name, code);
    infraCodeHashes[name] = ethers.keccak256(code);
  }

  const factoryRead = new ethers.Contract(v3Factory, [
    "function feeAmountTickSpacing(uint24) view returns (int24)",
  ], ethers.provider);
  const positionRead = new ethers.Contract(positionManager, [
    "function factory() view returns (address)",
    "function WETH9() view returns (address)",
  ], ethers.provider);
  const routerRead = new ethers.Contract(swapRouter, [
    "function factory() view returns (address)",
    "function WETH9() view returns (address)",
  ], ethers.provider);
  const oracleRead = new ethers.Contract(nativeUsdOracle, [
    "function decimals() view returns (uint8)",
    "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  ], ethers.provider);

  const spacing = BigInt(await factoryRead.feeAmountTickSpacing(FEE_TIER));
  if (spacing <= 0n) throw new Error(`V3 factory does not support fee tier ${FEE_TIER}`);
  authority.requireBoundAddress("position manager factory", await positionRead.factory(), v3Factory);
  authority.requireBoundAddress("position manager WETH", await positionRead.WETH9(), weth);
  authority.requireBoundAddress("swap router factory", await routerRead.factory(), v3Factory);
  authority.requireBoundAddress("swap router WETH", await routerRead.WETH9(), weth);

  const oracleDecimals = Number(await oracleRead.decimals());
  if (oracleDecimals < 1 || oracleDecimals > 18) throw new Error(`native/USD oracle decimals unsupported: ${oracleDecimals}`);
  const round = await oracleRead.latestRoundData();
  if (BigInt(round[1]) <= 0n || BigInt(round[3]) <= 0n || BigInt(round[4]) < BigInt(round[0])) throw new Error("native/USD oracle round is invalid");
  const latestBlock = await ethers.provider.getBlock("latest");
  const maxOracleAge = Number(process.env.ROBINHOOD_NATIVE_USD_MAX_ORACLE_AGE_SECONDS || DEFAULT_ORACLE_MAX_AGE);
  if (!latestBlock || latestBlock.timestamp - Number(round[3]) > maxOracleAge) throw new Error("native/USD oracle is stale");

  console.log(JSON.stringify({
    mode: operator.broadcast ? "broadcast" : "dry-run",
    chainId,
    network: network.name,
    deployer: deployerAddress,
    deployerBalanceWei: balance.toString(),
    admin: operator.admin,
    routeAuthority: operator.routeAuthority,
    externalInfrastructure: requiredInfrastructure,
    infrastructureRuntimeCodeHashes: infraCodeHashes,
    frozen5CFactoryPreserved: frozen?.factory || null,
    manifestPath: MANIFEST_PATH,
  }, null, 2));

  if (!operator.broadcast) {
    console.log(`[robinhood-current-stage] preflight PASS. No transactions sent. To broadcast set ROBINHOOD_TESTNET_BROADCAST=${authority.BROADCAST_TOKEN}`);
    return;
  }

  if (fs.existsSync(MANIFEST_PATH)) throw new Error(`${MANIFEST_PATH} already exists; refusing to overwrite deployment authority`);

  const deployment: Record<string, any> = {};
  const wiringTransactions: any[] = [];

  const GraduationOracle = await ethers.getContractFactory("GraduationOracle", deployer);
  const graduationOracle = await GraduationOracle.deploy(nativeUsdOracle, maxOracleAge);
  deployment.graduationOracle = await waitDeployment(graduationOracle, "graduationOracle");

  const WeeklyVault = await ethers.getContractFactory("TreasuryVaultV2", deployer);
  const weeklyLeagueVault = await WeeklyVault.deploy(admin, ethers.ZeroAddress, admin);
  deployment.weeklyLeagueVault = await waitDeployment(weeklyLeagueVault, "weeklyLeagueVault");

  const Charity = await ethers.getContractFactory("CharityTreasury", deployer);
  const charityTreasury = await Charity.deploy(admin);
  deployment.charityTreasury = await waitDeployment(charityTreasury, "charityTreasury");

  const Monthly = await ethers.getContractFactory("MonthlyLeagueTreasury", deployer);
  const monthlyLeagueTreasury = await Monthly.deploy(
    admin,
    admin,
    deployment.graduationOracle.address,
    deployment.charityTreasury.address,
    1_500_000n * 10n ** 18n,
  );
  deployment.monthlyLeagueTreasury = await waitDeployment(monthlyLeagueTreasury, "monthlyLeagueTreasury");

  const Recruiter = await ethers.getContractFactory("RecruiterRewardsVault", deployer);
  const recruiterRewardsVault = await Recruiter.deploy(admin);
  deployment.recruiterRewardsVault = await waitDeployment(recruiterRewardsVault, "recruiterRewardsVault");

  const Protocol = await ethers.getContractFactory("ProtocolRevenueVault", deployer);
  const protocolRevenueVault = await Protocol.deploy(admin);
  deployment.protocolRevenueVault = await waitDeployment(protocolRevenueVault, "protocolRevenueVault");

  const Treasury = await ethers.getContractFactory("TreasuryRouterV3", deployer);
  const treasuryRouter = await Treasury.deploy(
    admin,
    deployment.weeklyLeagueVault.address,
    deployment.monthlyLeagueTreasury.address,
    TREASURY_UPGRADE_DELAY,
  );
  deployment.treasuryRouterV3 = await waitDeployment(treasuryRouter, "treasuryRouterV3");

  const Community = await ethers.getContractFactory("CommunityRewardsVault", deployer);
  const communityRewardsVault = await Community.deploy(admin, deployment.treasuryRouterV3.address);
  deployment.communityRewardsVault = await waitDeployment(communityRewardsVault, "communityRewardsVault");

  const CreatorRewards = await ethers.getContractFactory("CreatorRewardsVault", deployer);
  const creatorRewardsVault = await CreatorRewards.deploy(admin, deployment.treasuryRouterV3.address);
  deployment.creatorRewardsVault = await waitDeployment(creatorRewardsVault, "creatorRewardsVault");

  wiringTransactions.push(await waitTx("treasury.setRecruiterRewardsVault", treasuryRouter.setRecruiterRewardsVault(deployment.recruiterRewardsVault.address)));
  wiringTransactions.push(await waitTx("treasury.setCommunityRewardsVault", treasuryRouter.setCommunityRewardsVault(deployment.communityRewardsVault.address)));
  wiringTransactions.push(await waitTx("treasury.setProtocolRevenueVault", treasuryRouter.setProtocolRevenueVault(deployment.protocolRevenueVault.address)));
  wiringTransactions.push(await waitTx("treasury.setCreatorRewardsVault", treasuryRouter.setCreatorRewardsVault(deployment.creatorRewardsVault.address)));

  const standard = await treasuryRouter.previewTrade(10_000n, 0);
  const unlinked = await treasuryRouter.previewTrade(10_000n, 1);
  const og = await treasuryRouter.previewTrade(10_000n, 2);
  const expected = [
    [3750n, 500n, 1250n, 0n, 250n, 4250n],
    [3750n, 500n, 0n, 1500n, 0n, 4250n],
    [3750n, 500n, 1500n, 0n, 250n, 4000n],
  ];
  for (const [label, actual, want] of [["standard", standard, expected[0]], ["unlinked", unlinked, expected[1]], ["og", og, expected[2]]] as const) {
    for (let i = 0; i < 6; i += 1) if (BigInt(actual[i]) !== want[i]) throw new Error(`${label} TreasuryRouterV3 economics mismatch at index ${i}`);
  }
  authority.requireBoundAddress("treasury admin", await treasuryRouter.admin(), admin);
  if (await treasuryRouter.anyLpLockerAuthorized()) throw new Error("fresh staged TreasuryRouterV3 unexpectedly has LP locker authority");
  if ((await treasuryRouter.permanentLpLocker()) !== ethers.ZeroAddress) throw new Error("fresh staged TreasuryRouterV3 unexpectedly has a primary LP locker");

  const Adapter = await ethers.getContractFactory("RobinhoodUniswapV3GraduationAdapter", deployer);
  const adapter = await Adapter.deploy(v3Factory, positionManager, weth, FEE_TIER);
  deployment.graduationAdapter = await waitDeployment(adapter, "graduationAdapter");

  const Campaign = await ethers.getContractFactory("LaunchCampaign", deployer);
  const campaign = await Campaign.deploy();
  deployment.campaignImplementation = await waitDeployment(campaign, "campaignImplementation");

  const CreatorRegistry = await ethers.getContractFactory("CreatorRegistry", deployer);
  const creatorRegistry = await CreatorRegistry.deploy();
  deployment.creatorRegistry = await waitDeployment(creatorRegistry, "creatorRegistry");

  const RiskRegistry = await ethers.getContractFactory("RiskRegistry", deployer);
  const riskRegistry = await RiskRegistry.deploy();
  deployment.riskRegistry = await waitDeployment(riskRegistry, "riskRegistry");

  const Factory = await ethers.getContractFactory("LaunchFactory", deployer);
  const launchFactory = await Factory.deploy(
    deployment.graduationAdapter.address,
    deployment.treasuryRouterV3.address,
    deployment.campaignImplementation.address,
    deployment.graduationOracle.address,
  );
  deployment.launchFactory = await waitDeployment(launchFactory, "launchFactory");
  const lockerAddress = await launchFactory.permanentLpLocker();
  deployment.permanentV3PositionLocker = {
    address: lockerAddress,
    txHash: deployment.launchFactory.txHash,
    blockNumber: deployment.launchFactory.blockNumber,
    runtimeCodeHash: await runtimeHash(lockerAddress),
  };

  for (const [name, evidence] of Object.entries(deployment)) {
    if (historicalAddresses.some((address: any) => authority.sameAddress(address, evidence.address))) {
      throw new Error(`${name} unexpectedly resolves to a frozen historical 5B/5C address`);
    }
  }

  const locker = await ethers.getContractAt("PermanentV3PositionLocker", lockerAddress, deployer);
  authority.requireBoundAddress("locker V3 factory", await locker.v3Factory(), v3Factory);
  authority.requireBoundAddress("locker position manager", await locker.positionManager(), positionManager);
  authority.requireBoundAddress("locker WETH", await locker.wrappedNative(), weth);
  authority.requireBoundAddress("locker integration source", await locker.integrationSource(), deployment.graduationAdapter.address);

  const config = await launchFactory.config();
  wiringTransactions.push(await waitTx("factory.setConfig", launchFactory.setConfig({
    totalSupply: config.totalSupply,
    curveBps: config.curveBps,
    liquidityTokenBps: config.liquidityTokenBps,
    basePrice: config.basePrice,
    priceSlope: config.priceSlope,
    graduationTarget: TEST_GRADUATION_TARGET_USD,
    liquidityBps: config.liquidityBps,
  })));
  wiringTransactions.push(await waitTx("factory.setRegistries", launchFactory.setRegistries(deployment.creatorRegistry.address, deployment.riskRegistry.address)));
  wiringTransactions.push(await waitTx("factory.setRouteAuthority", launchFactory.setRouteAuthority(routeAuthority)));
  wiringTransactions.push(await waitTx("factory.setRouteProfiles", launchFactory.setRouteProfiles(1, 1)));
  wiringTransactions.push(await waitTx("creatorRegistry.setLaunchRecorder", creatorRegistry.setLaunchRecorder(deployment.launchFactory.address, true)));
  wiringTransactions.push(await waitTx("treasury.setAuthorizedLpLocker", treasuryRouter.setAuthorizedLpLocker(lockerAddress, true)));
  wiringTransactions.push(await waitTx("treasury.setPrimaryLpLocker", treasuryRouter.setPrimaryLpLocker(lockerAddress)));
  wiringTransactions.push(await waitTx("factory.lockSecurityDefaults", launchFactory.lockSecurityDefaults()));
  if (!(await launchFactory.createPaused())) wiringTransactions.push(await waitTx("factory.setCreatePaused", launchFactory.setCreatePaused(true)));

  if (Number(await launchFactory.FACTORY_GENERATION()) !== authority.CURRENT_FACTORY_GENERATION) throw new Error("factory generation mismatch after deployment");
  if (Number(await launchFactory.CAMPAIGN_GENERATION()) !== authority.CURRENT_CAMPAIGN_GENERATION) throw new Error("campaign generation mismatch after deployment");
  if (Number(await launchFactory.liquidityKind()) !== authority.CURRENT_LIQUIDITY_KIND) throw new Error("liquidity kind mismatch after deployment");
  if (await launchFactory.live()) throw new Error("fresh staging factory must remain live=false");
  if (!(await launchFactory.createPaused())) throw new Error("fresh staging factory must remain createPaused=true");
  if (!(await launchFactory.securityDefaultsLocked())) throw new Error("security defaults must be locked");
  if (!(await launchFactory.requireAuthorizedTrading()) || !(await launchFactory.requireRouteAuthorization())) throw new Error("route/trading authorization must remain required");
  if (!(await creatorRegistry.launchRecorder(deployment.launchFactory.address))) throw new Error("CreatorRegistry launch recorder wiring failed");
  if (!(await treasuryRouter.authorizedLpLocker(lockerAddress))) throw new Error("TreasuryRouterV3 locker authorization failed");
  authority.requireBoundAddress("treasury primary locker", await treasuryRouter.permanentLpLocker(), lockerAddress);

  const manifest = authority.buildCurrentStageManifest({
    operator: { ...operator, rpcUrl, broadcastToken: authority.BROADCAST_TOKEN, deployerBalanceWei: balance, historicalAddresses },
    deployedAt: new Date().toISOString(),
    deployment,
    wiringTransactions,
    factoryLive: false,
    createPaused: true,
    securityDefaultsLocked: true,
  });
  manifest.infrastructureRuntimeCodeHashes = infraCodeHashes;
  manifest.contractRuntimeCodeHashes = Object.fromEntries(
    Object.entries(deployment).map(([name, evidence]) => [name, evidence.runtimeCodeHash]),
  );
  authority.validateCurrentStageManifest(manifest);
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  console.log(`[robinhood-current-stage] deployment complete; manifest=${MANIFEST_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
