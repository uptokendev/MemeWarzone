import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ethers } from "hardhat";

const ROBINHOOD_MAINNET_CHAIN_ID = 4663;
const FACTORY_GENERATION = 4n;
const CAMPAIGN_GENERATION = 3n;
const LIQUIDITY_KIND = 2n;
const V3_FEE_TIER = 3000;
const TREASURY_UPGRADE_DELAY = 3600;
const SOURCE_AUTHORITY = "42f00b9c5cc56d9956efa79f1fdb5cfd8edd7566";
const BROADCAST_ACK = "DEPLOY_CHAIN_4663_DARK";
const DEFAULT_MIN_DEPLOYER_BALANCE_WEI = ethers.parseEther("0.02");

const FACTORY_ABI = ["function feeAmountTickSpacing(uint24) view returns (int24)"];
const PERIPHERY_ABI = ["function factory() view returns (address)", "function WETH9() view returns (address)"];
const ORACLE_ABI = [
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function decimals() view returns (uint8)",
];

type TxRecord = { label: string; hash: string; blockNumber: number };
type AddressMap = Record<string, string>;

function requiredAddress(name: string): string {
  const raw = String(process.env[name] || "").trim();
  if (!ethers.isAddress(raw) || raw === ethers.ZeroAddress) {
    throw new Error(`${name} must be a real non-zero production address`);
  }
  return ethers.getAddress(raw);
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

async function requireCode(address: string, label: string): Promise<void> {
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") throw new Error(`${label} has no bytecode at ${address}`);
}

async function verifyPeriphery(address: string, label: string, expectedFactory: string, expectedWeth: string) {
  await requireCode(address, label);
  const contract = new ethers.Contract(address, PERIPHERY_ABI, ethers.provider);
  const [factory, weth] = await Promise.all([contract.factory(), contract.WETH9()]);
  if (!sameAddress(factory, expectedFactory)) throw new Error(`${label} factory mismatch: ${factory}`);
  if (!sameAddress(weth, expectedWeth)) throw new Error(`${label} WETH9 mismatch: ${weth}`);
}

async function verifyOracle(address: string, maxAgeSeconds: number) {
  await requireCode(address, "native/USD oracle");
  const oracle = new ethers.Contract(address, ORACLE_ABI, ethers.provider);
  const [round, decimals] = await Promise.all([oracle.latestRoundData(), oracle.decimals()]);
  const roundId = BigInt(round[0]);
  const answer = BigInt(round[1]);
  const updatedAt = Number(round[3]);
  const answeredInRound = BigInt(round[4]);
  const latest = await ethers.provider.getBlock("latest");
  if (!latest) throw new Error("Unable to read latest Robinhood mainnet block");
  const age = latest.timestamp - updatedAt;
  if (roundId <= 0n || answer <= 0n || answeredInRound < roundId) throw new Error("native/USD oracle round is unhealthy");
  if (updatedAt <= 0 || age < 0 || age > maxAgeSeconds) throw new Error(`native/USD oracle is stale (${age}s)`);
  if (Number(decimals) < 0 || Number(decimals) > 36) throw new Error("native/USD oracle decimals invalid");
  return { updatedAt, ageSeconds: age, decimals: Number(decimals) };
}

async function waitDeployment(label: string, contract: any, txs: TxRecord[]) {
  await contract.waitForDeployment();
  const tx = contract.deploymentTransaction();
  if (!tx) throw new Error(`${label} deployment transaction unavailable`);
  const receipt = await tx.wait();
  if (!receipt) throw new Error(`${label} deployment receipt unavailable`);
  txs.push({ label, hash: tx.hash, blockNumber: Number(receipt.blockNumber) });
  return ethers.getAddress(await contract.getAddress());
}

async function waitTx(label: string, txPromise: Promise<any>, txs: TxRecord[]) {
  const tx = await txPromise;
  const receipt = await tx.wait();
  if (!receipt) throw new Error(`${label} transaction receipt unavailable`);
  txs.push({ label, hash: tx.hash, blockNumber: Number(receipt.blockNumber) });
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function safeRpcLabel(): string {
  const raw = String(process.env.ROBINHOOD_MAINNET_RPC_URL || process.env.ROBINHOOD_MAINNET_RPC || "").trim();
  if (!raw) return "<missing>";
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "configured (non-URL value hidden)";
  }
}

async function main() {
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  if (chainId !== ROBINHOOD_MAINNET_CHAIN_ID) {
    throw new Error(`CHAIN-ID LOCK: expected ${ROBINHOOD_MAINNET_CHAIN_ID}, got ${chainId}. No transactions sent.`);
  }

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No authorized Robinhood mainnet signer is available");
  const deployerAddress = ethers.getAddress(await deployer.getAddress());
  const admin = requiredAddress("ROBINHOOD_MAINNET_ADMIN_ADDRESS");
  const routeAuthority = requiredAddress("ROBINHOOD_MAINNET_ROUTE_AUTHORITY_ADDRESS");
  const weth = requiredAddress("ROBINHOOD_MAINNET_WETH_ADDRESS");
  const v3Factory = requiredAddress("ROBINHOOD_MAINNET_V3_FACTORY_ADDRESS");
  const positionManager = requiredAddress("ROBINHOOD_MAINNET_V3_POSITION_MANAGER_ADDRESS");
  const swapRouter = requiredAddress("ROBINHOOD_MAINNET_V3_SWAP_ROUTER_ADDRESS");
  const nativeUsdOracle = requiredAddress("ROBINHOOD_MAINNET_NATIVE_USD_ORACLE_ADDRESS");

  if (!sameAddress(deployerAddress, admin)) {
    throw new Error(`Production deployer must equal immutable production admin. deployer=${deployerAddress} admin=${admin}`);
  }
  if (sameAddress(routeAuthority, admin)) throw new Error("Production route authority must be distinct from admin");

  const minBalanceRaw = String(process.env.ROBINHOOD_MAINNET_MIN_DEPLOYER_BALANCE_WEI || DEFAULT_MIN_DEPLOYER_BALANCE_WEI).trim();
  const minBalance = BigInt(minBalanceRaw);
  if (minBalance <= 0n) throw new Error("ROBINHOOD_MAINNET_MIN_DEPLOYER_BALANCE_WEI must be positive");
  const deployerBalance = await ethers.provider.getBalance(deployerAddress);
  if (deployerBalance < minBalance) {
    throw new Error(`Deployer balance ${deployerBalance} wei is below required minimum ${minBalance} wei`);
  }

  const maxOracleAge = Number(process.env.ROBINHOOD_STOCK_GRADUATION_MAX_ORACLE_AGE_SECONDS || "900");
  if (!Number.isInteger(maxOracleAge) || maxOracleAge <= 0) throw new Error("ROBINHOOD_STOCK_GRADUATION_MAX_ORACLE_AGE_SECONDS must be positive");

  await Promise.all([
    requireCode(weth, "WETH"),
    requireCode(v3Factory, "V3 factory"),
    verifyPeriphery(positionManager, "position manager", v3Factory, weth),
    verifyPeriphery(swapRouter, "swap router", v3Factory, weth),
  ]);
  const factoryView = new ethers.Contract(v3Factory, FACTORY_ABI, ethers.provider);
  const tickSpacing = Number(await factoryView.feeAmountTickSpacing(V3_FEE_TIER));
  if (tickSpacing <= 0) throw new Error(`V3 factory does not support fee tier ${V3_FEE_TIER}`);
  const oracleEvidence = await verifyOracle(nativeUsdOracle, maxOracleAge);

  console.table({
    DEPLOYER: deployerAddress,
    ADMIN: admin,
    "ROUTE AUTHORITY": routeAuthority,
    WETH: weth,
    "V3 FACTORY": v3Factory,
    "POSITION MANAGER": positionManager,
    "SWAP ROUTER": swapRouter,
    "NATIVE/USD ORACLE": nativeUsdOracle,
    RPC: safeRpcLabel(),
    "CHAIN ID": chainId,
    "DEPLOYER BALANCE": `${deployerBalance} wei`,
  });
  console.log(`[robinhood-mainnet] oracle freshness=${oracleEvidence.ageSeconds}s; preflight PASS`);

  if (String(process.env.ROBINHOOD_MAINNET_BROADCAST || "").trim() !== BROADCAST_ACK) {
    console.log(`[robinhood-mainnet] dry-run only. Set ROBINHOOD_MAINNET_BROADCAST=${BROADCAST_ACK} in the secure operator environment to broadcast.`);
    return;
  }

  const txs: TxRecord[] = [];
  const contracts: AddressMap = {
    v3Factory,
    nonfungiblePositionManager: positionManager,
    v3SwapRouter: swapRouter,
    weth9: weth,
  };

  const NativeAdapter = await ethers.getContractFactory("RobinhoodUniswapV3GraduationAdapter", deployer);
  const nativeAdapter = await NativeAdapter.deploy(v3Factory, positionManager, weth, V3_FEE_TIER);
  contracts.graduationAdapter = await waitDeployment("RobinhoodUniswapV3GraduationAdapter", nativeAdapter, txs);

  const GraduationOracle = await ethers.getContractFactory("GraduationOracle", deployer);
  const graduationOracle = await GraduationOracle.deploy(nativeUsdOracle, maxOracleAge);
  contracts.graduationOracle = await waitDeployment("GraduationOracle", graduationOracle, txs);

  const WeeklyVault = await ethers.getContractFactory("TreasuryVaultV2", deployer);
  const weeklyLeagueVault = await WeeklyVault.deploy(admin, ethers.ZeroAddress, admin);
  contracts.weeklyLeagueVault = await waitDeployment("TreasuryVaultV2", weeklyLeagueVault, txs);

  const Charity = await ethers.getContractFactory("CharityTreasury", deployer);
  const charityTreasury = await Charity.deploy(admin);
  contracts.charityTreasury = await waitDeployment("CharityTreasury", charityTreasury, txs);

  const Monthly = await ethers.getContractFactory("MonthlyLeagueTreasury", deployer);
  const monthlyLeagueTreasury = await Monthly.deploy(admin, admin, contracts.graduationOracle, contracts.charityTreasury, 1_500_000n * 10n ** 18n);
  contracts.monthlyLeagueTreasury = await waitDeployment("MonthlyLeagueTreasury", monthlyLeagueTreasury, txs);

  const Recruiter = await ethers.getContractFactory("RecruiterRewardsVault", deployer);
  const recruiterRewardsVault = await Recruiter.deploy(admin);
  contracts.recruiterRewardsVault = await waitDeployment("RecruiterRewardsVault", recruiterRewardsVault, txs);

  const Protocol = await ethers.getContractFactory("ProtocolRevenueVault", deployer);
  const protocolRevenueVault = await Protocol.deploy(admin);
  contracts.protocolRevenueVault = await waitDeployment("ProtocolRevenueVault", protocolRevenueVault, txs);

  const Treasury = await ethers.getContractFactory("TreasuryRouterV3", deployer);
  const treasuryRouter = await Treasury.deploy(admin, contracts.weeklyLeagueVault, contracts.monthlyLeagueTreasury, TREASURY_UPGRADE_DELAY);
  contracts.treasuryRouterV3 = await waitDeployment("TreasuryRouterV3", treasuryRouter, txs);

  const Community = await ethers.getContractFactory("CommunityRewardsVault", deployer);
  const communityRewardsVault = await Community.deploy(admin, contracts.treasuryRouterV3);
  contracts.communityRewardsVault = await waitDeployment("CommunityRewardsVault", communityRewardsVault, txs);

  const CreatorRewards = await ethers.getContractFactory("CreatorRewardsVault", deployer);
  const creatorRewardsVault = await CreatorRewards.deploy(admin, contracts.treasuryRouterV3);
  contracts.creatorRewardsVault = await waitDeployment("CreatorRewardsVault", creatorRewardsVault, txs);

  await waitTx("TreasuryRouterV3.setRecruiterRewardsVault", treasuryRouter.setRecruiterRewardsVault(contracts.recruiterRewardsVault), txs);
  await waitTx("TreasuryRouterV3.setCommunityRewardsVault", treasuryRouter.setCommunityRewardsVault(contracts.communityRewardsVault), txs);
  await waitTx("TreasuryRouterV3.setProtocolRevenueVault", treasuryRouter.setProtocolRevenueVault(contracts.protocolRevenueVault), txs);
  await waitTx("TreasuryRouterV3.setCreatorRewardsVault", treasuryRouter.setCreatorRewardsVault(contracts.creatorRewardsVault), txs);

  const CreatorRegistry = await ethers.getContractFactory("CreatorRegistry", deployer);
  const creatorRegistry = await CreatorRegistry.deploy();
  contracts.creatorRegistry = await waitDeployment("CreatorRegistry", creatorRegistry, txs);

  const RiskRegistry = await ethers.getContractFactory("RiskRegistry", deployer);
  const riskRegistry = await RiskRegistry.deploy();
  contracts.riskRegistry = await waitDeployment("RiskRegistry", riskRegistry, txs);

  const Campaign = await ethers.getContractFactory("LaunchCampaign", deployer);
  const campaignImplementation = await Campaign.deploy();
  contracts.launchCampaignImplementation = await waitDeployment("LaunchCampaign", campaignImplementation, txs);

  const StockCampaign = await ethers.getContractFactory("RobinhoodStockLaunchCampaign", deployer);
  const stockCampaignImplementation = await StockCampaign.deploy();
  contracts.stockCampaignImplementation = await waitDeployment("RobinhoodStockLaunchCampaign", stockCampaignImplementation, txs);

  const LaunchFactory = await ethers.getContractFactory("LaunchFactory", deployer);
  const launchFactory = await LaunchFactory.deploy(contracts.graduationAdapter, contracts.treasuryRouterV3, contracts.launchCampaignImplementation, contracts.graduationOracle);
  contracts.launchFactory = await waitDeployment("LaunchFactory", launchFactory, txs);
  contracts.permanentV3PositionLocker = ethers.getAddress(await launchFactory.permanentLpLocker());
  await requireCode(contracts.permanentV3PositionLocker, "PermanentV3PositionLocker");

  const StockAdapter = await ethers.getContractFactory("RobinhoodStockTokenGraduationAdapter", deployer);
  const stockAdapter = await StockAdapter.deploy(v3Factory, positionManager, swapRouter, weth, contracts.permanentV3PositionLocker, nativeUsdOracle, V3_FEE_TIER, maxOracleAge);
  contracts.stockGraduationAdapter = await waitDeployment("RobinhoodStockTokenGraduationAdapter", stockAdapter, txs);

  const NativeSwap = await ethers.getContractFactory("RobinhoodV3NativeSwapAdapter", deployer);
  const nativeSwap = await NativeSwap.deploy(swapRouter, weth);
  contracts.v3NativeSwapAdapter = await waitDeployment("RobinhoodV3NativeSwapAdapter", nativeSwap, txs);

  const MultiHop = await ethers.getContractFactory("RobinhoodV3MultiHopSwapAdapter", deployer);
  const multiHop = await MultiHop.deploy(v3Factory, swapRouter, weth);
  contracts.v3MultiHopSwapAdapter = await waitDeployment("RobinhoodV3MultiHopSwapAdapter", multiHop, txs);

  const UpVote = await ethers.getContractFactory("UPVoteTreasury", deployer);
  const upVote = await UpVote.deploy(admin, contracts.protocolRevenueVault);
  contracts.upVoteTreasury = await waitDeployment("UPVoteTreasury", upVote, txs);

  await waitTx("LaunchFactory.setRegistries", launchFactory.setRegistries(contracts.creatorRegistry, contracts.riskRegistry), txs);
  await waitTx("LaunchFactory.setRouteAuthority", launchFactory.setRouteAuthority(routeAuthority), txs);
  await waitTx("LaunchFactory.setRouteProfiles", launchFactory.setRouteProfiles(1, 1), txs);
  await waitTx("LaunchFactory.setProtocolFee", launchFactory.setProtocolFee(200), txs);
  await waitTx("LaunchFactory.setStockCampaignImplementation", launchFactory.setStockCampaignImplementation(contracts.stockCampaignImplementation), txs);
  await waitTx("RobinhoodStockTokenGraduationAdapter.setCampaignFactoryOnce", stockAdapter.setCampaignFactoryOnce(contracts.launchFactory), txs);
  await waitTx("LaunchFactory.setStockGraduationAdapter", launchFactory.setStockGraduationAdapter(contracts.stockGraduationAdapter), txs);
  await waitTx("CreatorRegistry.setLaunchRecorder", creatorRegistry.setLaunchRecorder(contracts.launchFactory, true), txs);
  await waitTx("TreasuryRouterV3.setAuthorizedLpLocker", treasuryRouter.setAuthorizedLpLocker(contracts.permanentV3PositionLocker, true), txs);
  await waitTx("TreasuryRouterV3.setPrimaryLpLocker", treasuryRouter.setPrimaryLpLocker(contracts.permanentV3PositionLocker), txs);
  await waitTx("LaunchFactory.lockSecurityDefaults", launchFactory.lockSecurityDefaults(), txs);
  await waitTx("LaunchFactory.setCreatePaused(true)", launchFactory.setCreatePaused(true), txs);

  const [factoryGeneration, campaignGeneration, liquidityKind, live, createPaused, securityLocked] = await Promise.all([
    launchFactory.FACTORY_GENERATION(), launchFactory.CAMPAIGN_GENERATION(), launchFactory.liquidityKind(),
    launchFactory.live(), launchFactory.createPaused(), launchFactory.securityDefaultsLocked(),
  ]);
  if (factoryGeneration !== FACTORY_GENERATION || campaignGeneration !== CAMPAIGN_GENERATION || liquidityKind !== LIQUIDITY_KIND) {
    throw new Error("Deployed Robinhood generation metadata mismatch");
  }
  if (live !== false || createPaused !== true || securityLocked !== true) throw new Error("Dark deployment invariant failed");
  if (!(await launchFactory.requireRouteAuthorization()) || !(await launchFactory.requireAuthorizedTrading())) {
    throw new Error("Production route/trading authorization invariant failed");
  }
  if (!sameAddress(await launchFactory.owner(), admin)) throw new Error("LaunchFactory owner mismatch");
  if (!sameAddress(await stockAdapter.admin(), admin)) throw new Error("Stock graduation adapter immutable admin mismatch");
  if (!sameAddress(await stockAdapter.campaignFactory(), contracts.launchFactory) || !(await stockAdapter.campaignFactoryLocked())) {
    throw new Error("Stock graduation adapter campaign factory lock mismatch");
  }

  const deploymentBlock = Math.min(...txs.filter((entry) => entry.label.includes("Adapter") || entry.label.includes("Oracle") || entry.label.includes("Vault") || entry.label.includes("Factory") || entry.label.includes("Campaign") || entry.label.includes("Treasury") || entry.label.includes("Registry")).map((entry) => entry.blockNumber));
  const inventoryFile = path.resolve(process.env.ROBINHOOD_MAINNET_INVENTORY_OUT || "deployments/robinhood/mainnet.inventory.generated.json");
  const receiptFile = path.resolve(process.env.ROBINHOOD_MAINNET_RECEIPT_OUT || "deployments/robinhood/mainnet.deployment-receipt.json");
  const inventory = {
    sourceSha: SOURCE_AUTHORITY,
    deploymentBlock,
    admin,
    routeAuthority,
    oracleMaxAgeSeconds: maxOracleAge,
    contracts,
    oracles: { nativeUsdFeed: nativeUsdOracle },
    stock: {
      canonicalRegistryConfigured: false,
      nativeUsdOracleConfigured: true,
      approvedAcquisitionRoutesConfigured: false,
      stockRoutesEnabled: false,
      graduationPolicy: {
        maxOracleAgeSeconds: maxOracleAge,
        maxSwapSlippageBps: 300,
        maxOracleDeviationBps: 300,
        maxPriceImpactBps: 500,
        minimumRouteLiquidityUsd: 25000,
      },
      registry: [],
    },
    deploymentState: { supportEnabled: false, creationEnabled: false, factoryLive: false, createPaused: true },
  };
  writeJson(inventoryFile, inventory);
  writeJson(receiptFile, { chainId, sourceSha: SOURCE_AUTHORITY, deploymentBlock, deployer: deployerAddress, admin, routeAuthority, contracts, transactions: txs, privateKeysRecorded: false, factoryLive: false, createPaused: true });

  const canaryInventory = String(process.env.ROBINHOOD_MAINNET_CANARY_INVENTORY || "").trim();
  if (canaryInventory) {
    const candidateOut = path.resolve(process.env.ROBINHOOD_MAINNET_CANDIDATE_OUT || "deployments/robinhood/mainnet.candidate.json");
    execFileSync(process.execPath, [path.resolve("scripts/prepare-robinhood-production-manifest.mjs"), path.resolve(canaryInventory), candidateOut, SOURCE_AUTHORITY], { stdio: "inherit", env: process.env });
    console.log(`[robinhood-mainnet] candidate manifest generated: ${candidateOut}`);
  } else {
    console.log("[robinhood-mainnet] deployment is dark. Candidate manifest intentionally not generated until ONE live canary route inventory is supplied.");
  }

  console.log(`[robinhood-mainnet] dark deployment PASS; inventory=${inventoryFile}; receipt=${receiptFile}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
