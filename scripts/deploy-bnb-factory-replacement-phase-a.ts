/**
 * Phase A only: deploy corrected BNB factory + locker, pause CREATE, configure,
 * lock security, transfer ownership to the production Safe.
 *
 * Never enableLive, never unpause CREATE, never write CreatorRegistry or TreasuryRouter.
 * Do not use scripts/deploy-factory-only.ts.
 *
 *   CONFIRM_BNB_FACTORY_REPLACEMENT=I_UNDERSTAND_MAINNET \
 *     npx hardhat run scripts/deploy-bnb-factory-replacement-phase-a.ts --network bscMainnet
 */
import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";
import { refuseBnbFactoryBroadcastIfSourceHeadIsNotLive } from "./lib/bnbLiveGenerationGuard";

const CONFIRM = "I_UNDERSTAND_MAINNET";
const CHAIN_ID = 56n;
const SAFE = "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7";
const ADAPTER = "0x5c3135Dfaad519A9114DEa2E546f0Cd051d0D35a";
const TREASURY = "0xe157a6FDf19CAB61f2ECa048966f137A3240a921";
const IMPL = "0xbe3caF640F77e8436BCAF89730251A00fB01608f";
const ORACLE = "0x9D204406d5ECA0f18e48427fDD983A32FdF57C9B";
const CREATOR_REGISTRY = "0x8194FB3745d027102ce7Da562c7045f28B2f42fD";
const RISK_REGISTRY = "0x92b1494CF7b80dA379EB96F59EeE4Ae7F8970597";
const ROUTE_AUTHORITY = "0xb989A99823eA96552c3E3198A40CdBF682EDf1aA";
const TOPAZ_ROUTER = "0x1E98c8226e7d452e1888e3d3d2F929346321c6c3";
const TOPAZ_FACTORY = "0x65E6cD0eF5D3467030103cf3d433034E570b5784";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const PROD_FACTORY = "0x3068eAE6F8431bFc3c5Faae9c3bBB95F007be59a";
const PROD_LOCKER = "0x64710A4f87aBa3b5ED5B8B25e8ebA4DaC339C998";

const CONFIG = {
  totalSupply: ethers.parseEther("1000000000"),
  curveBps: 8400n,
  liquidityTokenBps: 1400n,
  basePrice: 1_000_000_000n,
  priceSlope: 850n,
  graduationTarget: ethers.parseEther("30000"),
  liquidityBps: 3300n,
};

function requireConfirm() {
  if (String(process.env.CONFIRM_BNB_FACTORY_REPLACEMENT || "").trim() !== CONFIRM) {
    throw new Error(
      `Refusing chain-56 send. Set CONFIRM_BNB_FACTORY_REPLACEMENT=${CONFIRM} to run Phase A.`,
    );
  }
}

async function waitTx(txPromise: Promise<any> | any, label: string) {
  const tx = await txPromise;
  console.log(`[phase-a] submitted ${label}: ${tx.hash}`);
  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) throw new Error(`${label} failed`);
  return receipt;
}

function eq(label: string, actual: unknown, expected: unknown) {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`${label}: actual=${actual} expected=${expected}`);
  }
  console.log(`[phase-a] ok ${label}=${actual}`);
}

async function main() {
  refuseBnbFactoryBroadcastIfSourceHeadIsNotLive();
  requireConfirm();

  if (network.name !== "bscMainnet") {
    throw new Error(`Phase A is bscMainnet only; got network ${network.name}`);
  }

  const net = await ethers.provider.getNetwork();
  if (net.chainId !== CHAIN_ID) {
    throw new Error(`Phase A is chain 56 only; got ${net.chainId}`);
  }

  const signers = await ethers.getSigners();
  if (!signers.length) {
    throw new Error("No deployer signer. Set DEPLOYER_PK or PRIVATE_KEY_DEPLOY.");
  }
  const deployer = signers[0];
  const deployerAddress = ethers.getAddress(await deployer.getAddress());
  if (deployerAddress.toLowerCase() === SAFE.toLowerCase()) {
    throw new Error("Deployer resolved to the production Safe; Phase A must use the EOA.");
  }

  const balance = await ethers.provider.getBalance(deployerAddress);
  const fee = await ethers.provider.getFeeData();
  const gasPrice = fee.gasPrice ?? ethers.parseUnits("1", "gwei");
  const gasBudget = 12_000_000n;
  const required = gasBudget * gasPrice;
  console.log(`[phase-a] network=${network.name} chainId=${net.chainId}`);
  console.log(`[phase-a] deployer=${deployerAddress}`);
  console.log(`[phase-a] deployerBalance=${ethers.formatEther(balance)} BNB`);
  console.log(`[phase-a] gasPrice=${ethers.formatUnits(gasPrice, "gwei")} gwei required≈${ethers.formatEther(required)} BNB`);
  if (balance < required) {
    throw new Error(
      `Deployer BNB balance too low: have ${ethers.formatEther(balance)}, need about ${ethers.formatEther(required)} at current gas`,
    );
  }

  for (const [label, address] of [
    ["adapter", ADAPTER],
    ["treasury", TREASURY],
    ["implementation", IMPL],
    ["oracle", ORACLE],
    ["creatorRegistry", CREATOR_REGISTRY],
    ["riskRegistry", RISK_REGISTRY],
    ["oldFactory", PROD_FACTORY],
    ["oldLocker", PROD_LOCKER],
  ] as const) {
    const code = await ethers.provider.getCode(address);
    if (!code || code === "0x") throw new Error(`${label} has no code at ${address}`);
  }

  const adapter = await ethers.getContractAt(
    [
      "function topazRouter() view returns (address)",
      "function poolFactory() view returns (address)",
      "function WETH() view returns (address)",
    ],
    ADAPTER,
  );
  eq("adapter.topazRouter", await adapter.topazRouter(), TOPAZ_ROUTER);
  eq("adapter.poolFactory", await adapter.poolFactory(), TOPAZ_FACTORY);
  eq("adapter.WETH", await adapter.WETH(), WBNB);

  const Factory = await ethers.getContractFactory("LaunchFactory", deployer);
  const factory = await Factory.deploy(ADAPTER, TREASURY, IMPL, ORACLE);
  const deploymentTx = factory.deploymentTransaction();
  if (!deploymentTx) throw new Error("Deployment transaction missing");
  const deploymentReceipt = await deploymentTx.wait(2);
  if (!deploymentReceipt || deploymentReceipt.status !== 1) throw new Error("LaunchFactory deployment failed");

  const newFactory = ethers.getAddress(await factory.getAddress());
  const newLocker = ethers.getAddress(await factory.permanentLpLocker());
  const deployBlock = Number(deploymentReceipt.blockNumber);
  console.log(`[phase-a] newFactory=${newFactory}`);
  console.log(`[phase-a] newLocker=${newLocker}`);
  console.log(`[phase-a] deployBlock=${deployBlock} tx=${deploymentTx.hash}`);

  const locker = await ethers.getContractAt("PermanentLpLocker", newLocker);
  eq("locker.REQUIRED_POOL_FEE_BPS", Number(await locker.REQUIRED_POOL_FEE_BPS()), 30);
  eq("locker.CREATOR_FEE_BPS", Number(await locker.CREATOR_FEE_BPS()), 8000);
  eq("locker.PROTOCOL_FEE_BPS", Number(await locker.PROTOCOL_FEE_BPS()), 2000);
  eq("locker.admin", await locker.admin(), newFactory);
  if (newLocker.toLowerCase() === PROD_LOCKER.toLowerCase()) {
    throw new Error("New locker address unexpectedly matches production locker");
  }

  await waitTx(factory.setCreatePaused(true), "setCreatePaused(true)");
  eq("createPaused", await factory.createPaused(), true);

  await waitTx(factory.setRegistries(CREATOR_REGISTRY, RISK_REGISTRY), "setRegistries");
  await waitTx(factory.setRouteAuthority(ROUTE_AUTHORITY), "setRouteAuthority");
  await waitTx(factory.setRouteProfiles(1, 1), "setRouteProfiles(1,1)");
  if ((await factory.protocolFeeBps()) !== 200n) {
    await waitTx(factory.setProtocolFee(200), "setProtocolFee(200)");
  }
  await waitTx(factory.setConfig(CONFIG), "setConfig");
  await waitTx(factory.setLaunchProtectionConfig(0, 0, 0), "setLaunchProtectionConfig(0,0,0)");

  eq("requireRouteAuthorization", await factory.requireRouteAuthorization(), true);
  eq("requireAuthorizedTrading", await factory.requireAuthorizedTrading(), true);
  if (!(await factory.requireRouteAuthorization()) || !(await factory.requireAuthorizedTrading())) {
    throw new Error("Refusing to lock or transfer a factory with auth flags off");
  }

  await waitTx(factory.lockSecurityDefaults(), "lockSecurityDefaults");
  eq("securityDefaultsLocked", await factory.securityDefaultsLocked(), true);
  eq("live", await factory.live(), false);
  eq("globalPaused", await factory.globalPaused(), false);
  eq("campaignsCount", (await factory.campaignsCount()).toString(), "0");
  eq("campaignImplementation", await factory.campaignImplementation(), IMPL);
  eq("router", await factory.router(), ADAPTER);
  eq("graduationOracle", await factory.graduationOracle(), ORACLE);
  eq("creatorRegistry", await factory.creatorRegistry(), CREATOR_REGISTRY);
  eq("riskRegistry", await factory.riskRegistry(), RISK_REGISTRY);
  eq("feeRecipient", await factory.feeRecipient(), TREASURY);
  eq("leagueReceiver", await factory.leagueReceiver(), TREASURY);
  eq("routeAuthority", await factory.routeAuthority(), ROUTE_AUTHORITY);
  eq("protocolFeeBps", (await factory.protocolFeeBps()).toString(), "200");
  eq("tradeRouteProfile", Number(await factory.tradeRouteProfile()), 1);
  eq("finalizeRouteProfile", Number(await factory.finalizeRouteProfile()), 1);
  const protection = await factory.launchProtectionConfig();
  eq("launchProtection.blocks_", protection.blocks_.toString(), "0");
  eq("launchProtection.maxBuyWei", protection.maxBuyWei.toString(), "0");
  eq("launchProtection.maxWalletWei", protection.maxWalletWei.toString(), "0");
  const cfg = await factory.config();
  eq("config.totalSupply", cfg.totalSupply.toString(), CONFIG.totalSupply.toString());
  eq("config.curveBps", cfg.curveBps.toString(), CONFIG.curveBps.toString());
  eq("config.liquidityTokenBps", cfg.liquidityTokenBps.toString(), CONFIG.liquidityTokenBps.toString());
  eq("config.basePrice", cfg.basePrice.toString(), CONFIG.basePrice.toString());
  eq("config.priceSlope", cfg.priceSlope.toString(), CONFIG.priceSlope.toString());
  eq("config.graduationTarget", cfg.graduationTarget.toString(), CONFIG.graduationTarget.toString());
  eq("config.liquidityBps", cfg.liquidityBps.toString(), CONFIG.liquidityBps.toString());
  eq("no $6 on chain 56", await factory.isGraduationTargetAllowedForChain(56, ethers.parseEther("6")), false);

  await waitTx(factory.transferOwnership(SAFE), `transferOwnership(${SAFE})`);
  eq("owner", await factory.owner(), SAFE);

  await expectStaticRevert(factory.enableLive.staticCall(), "enableLive as EOA after handoff");
  await expectStaticRevert(factory.setCreatePaused.staticCall(false), "setCreatePaused(false) as EOA after handoff");

  const registryIface = new ethers.Interface(["function setLaunchRecorder(address recorder, bool allowed)"]);
  const treasuryIface = new ethers.Interface([
    "function setAuthorizedLpLocker(address locker, bool allowed)",
    "function setPrimaryLpLocker(address newLocker)",
  ]);
  const factoryIface = new ethers.Interface(["function enableLive()", "function setCreatePaused(bool paused)"]);

  const safeTxs = [
    {
      to: CREATOR_REGISTRY,
      data: registryIface.encodeFunctionData("setLaunchRecorder", [newFactory, true]),
      description: "CreatorRegistry.setLaunchRecorder(newFactory, true)",
    },
    {
      to: TREASURY,
      data: treasuryIface.encodeFunctionData("setAuthorizedLpLocker", [newLocker, true]),
      description: "TreasuryRouterV2.setAuthorizedLpLocker(newLocker, true)",
    },
    {
      to: TREASURY,
      data: treasuryIface.encodeFunctionData("setPrimaryLpLocker", [newLocker]),
      description: "TreasuryRouterV2.setPrimaryLpLocker(newLocker); keep 0x6471 authorized",
    },
    {
      to: newFactory,
      data: factoryIface.encodeFunctionData("enableLive"),
      description: "LaunchFactory.enableLive() — only after verifier PASS with live==false",
    },
    {
      to: newFactory,
      data: factoryIface.encodeFunctionData("setCreatePaused", [false]),
      description: "LAST: LaunchFactory.setCreatePaused(false) — only after frontend/API/indexer switch",
    },
  ];

  const artifact = {
    network: network.name,
    chainId: 56,
    phase: "A",
    deployedAt: new Date().toISOString(),
    deployer: deployerAddress,
    newFactory,
    newLocker,
    deployBlock,
    deployTx: deploymentTx.hash,
    owner: SAFE,
    createPaused: true,
    live: false,
    securityDefaultsLocked: true,
    oldFactory: PROD_FACTORY,
    oldLocker: PROD_LOCKER,
    constructor: { adapter: ADAPTER, treasury: TREASURY, implementation: IMPL, oracle: ORACLE },
    safeTxs,
    notes: [
      "Phase A only. CREATE remains paused. live remains false.",
      "Do not update frontend/API/indexer until Safe wiring + enableLive verifier PASS.",
      "Keep old factory 0x3068 supported.",
    ],
  };
  const out = path.join(__dirname, "..", "deployments", "bscMainnet.factory-30bps-80-20.phase-a.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`[phase-a] wrote ${out}`);
  console.log("[phase-a] STOP. Phase B is Safe-only. Do not enableLive from the EOA.");
  console.log("[phase-a] Next:");
  console.log(`  REPLACEMENT_FACTORY=${newFactory} npx hardhat run scripts/verify-bnb-factory-replacement.ts`);
  console.log("  (recorder/primary checks FAIL until Safe steps 14-15; owner/pause/lock/config must PASS)");
  for (const tx of safeTxs) {
    console.log(`[phase-b] ${tx.description}`);
    console.log(`          to=${tx.to}`);
    console.log(`          data=${tx.data}`);
  }
}

async function expectStaticRevert(call: Promise<unknown>, label: string) {
  try {
    await call;
    throw new Error(`${label} unexpectedly succeeded`);
  } catch (error: any) {
    const message = String(error?.shortMessage || error?.message || error);
    if (message.includes("unexpectedly succeeded")) throw error;
    console.log(`[phase-a] ok ${label} reverted`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
