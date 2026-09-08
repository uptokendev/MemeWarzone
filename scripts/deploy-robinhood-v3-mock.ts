import { ethers } from "hardhat";
import fs from "node:fs";
import path from "node:path";

const FEE_TIER = 3000;
const EXPECTED_TICK_SPACING = 60n;

async function requireCode(address: string, label: string) {
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") throw new Error(`${label} deployment has no bytecode: ${address}`);
}

async function main() {
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const allowLocal = ["1", "true", "yes"].includes(String(process.env.ALLOW_LOCAL_RH_V3_MOCK || "").toLowerCase());
  if (chainId !== 46630 && !(allowLocal && chainId === 31337)) {
    throw new Error(`Robinhood V3 mock deployment is testnet-only. Expected chain 46630, got ${chainId}.`);
  }

  const [deployer] = await ethers.getSigners();
  console.log("Deploying Robinhood V3 staging DEX", {
    chainId,
    deployer: await deployer.getAddress(),
  });

  const WETH = await ethers.getContractFactory("MockWETH9");
  const weth = await WETH.deploy();
  await weth.waitForDeployment();

  const Factory = await ethers.getContractFactory("MockUniswapV3Factory");
  const factory = await Factory.deploy();
  await factory.waitForDeployment();

  const PositionManager = await ethers.getContractFactory("MockUniswapV3PositionManager");
  const positionManager = await PositionManager.deploy(await factory.getAddress(), await weth.getAddress());
  await positionManager.waitForDeployment();

  const SwapRouter = await ethers.getContractFactory("MockUniswapV3SwapRouter");
  const swapRouter = await SwapRouter.deploy(await factory.getAddress(), await weth.getAddress());
  await swapRouter.waitForDeployment();

  await (await factory.configurePeriphery(await positionManager.getAddress(), await swapRouter.getAddress())).wait();

  const Adapter = await ethers.getContractFactory("RobinhoodUniswapV3GraduationAdapter");
  const adapter = await Adapter.deploy(
    await factory.getAddress(),
    await positionManager.getAddress(),
    await weth.getAddress(),
    FEE_TIER,
  );
  await adapter.waitForDeployment();

  const weth9 = await weth.getAddress();
  const factoryAddress = await factory.getAddress();
  const positionManagerAddress = await positionManager.getAddress();
  const swapRouterAddress = await swapRouter.getAddress();
  const adapterAddress = await adapter.getAddress();

  await Promise.all([
    requireCode(weth9, "MockWETH9"),
    requireCode(factoryAddress, "MockUniswapV3Factory"),
    requireCode(positionManagerAddress, "MockUniswapV3PositionManager"),
    requireCode(swapRouterAddress, "MockUniswapV3SwapRouter"),
    requireCode(adapterAddress, "RobinhoodUniswapV3GraduationAdapter"),
  ]);

  const [
    configuredPositionManager,
    configuredSwapRouter,
    spacing,
    managerFactory,
    managerWeth,
    routerFactory,
    routerWeth,
    adapterFactory,
    adapterManager,
    adapterWeth,
    adapterFee,
    adapterPoolFactory,
    liquidityKind,
  ] = await Promise.all([
    factory.positionManager(),
    factory.swapRouter(),
    factory.feeAmountTickSpacing(FEE_TIER),
    positionManager.factory(),
    positionManager.WETH9(),
    swapRouter.factory(),
    swapRouter.WETH9(),
    adapter.v3Factory(),
    adapter.positionManager(),
    adapter.WETH(),
    adapter.feeTier(),
    adapter.poolFactory(),
    adapter.liquidityKind(),
  ]);

  const same = (a: string, b: string) => String(a).toLowerCase() === String(b).toLowerCase();
  if (!same(configuredPositionManager, positionManagerAddress)) throw new Error("Factory positionManager wiring mismatch");
  if (!same(configuredSwapRouter, swapRouterAddress)) throw new Error("Factory swapRouter wiring mismatch");
  if (BigInt(spacing) !== EXPECTED_TICK_SPACING) throw new Error(`Unexpected 0.30% tick spacing: ${spacing}`);
  if (!same(managerFactory, factoryAddress) || !same(routerFactory, factoryAddress)) throw new Error("Periphery factory mismatch");
  if (!same(managerWeth, weth9) || !same(routerWeth, weth9)) throw new Error("Periphery WETH9 mismatch");
  if (!same(adapterFactory, factoryAddress)) throw new Error("Graduation adapter factory mismatch");
  if (!same(adapterManager, positionManagerAddress)) throw new Error("Graduation adapter position manager mismatch");
  if (!same(adapterWeth, weth9)) throw new Error("Graduation adapter WETH mismatch");
  if (Number(adapterFee) !== FEE_TIER) throw new Error(`Graduation adapter fee mismatch: ${adapterFee}`);
  if (!same(adapterPoolFactory, adapterAddress)) throw new Error("Graduation adapter legacy poolFactory boundary mismatch");
  if (Number(liquidityKind) !== 2) throw new Error(`Graduation adapter liquidity kind mismatch: ${liquidityKind}`);

  const deployment = {
    schemaVersion: 1,
    purpose: "robinhood-testnet-uniswap-v3-compatible-mock",
    chainId,
    feeTier: FEE_TIER,
    contracts: {
      weth9,
      factory: factoryAddress,
      nonfungiblePositionManager: positionManagerAddress,
      swapRouter02: swapRouterAddress,
      graduationAdapter: adapterAddress,
    },
    productionCompatible: false,
    note: "Staging-only deterministic V3 interface harness. Never promote these addresses to production.",
  };

  console.log("Robinhood V3 staging DEX self-verification passed");
  console.log(JSON.stringify(deployment, null, 2));

  const explicitOut = String(process.env.ROBINHOOD_V3_MOCK_DEPLOYMENT_OUT || "").trim();
  const out = explicitOut
    ? path.resolve(explicitOut)
    : chainId === 46630
      ? path.resolve("deployments/robinhood/testnet-v3-mock.json")
      : "";
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(deployment, null, 2)}\n`);
    console.log(`Wrote ${out}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
