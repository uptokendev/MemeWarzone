import { ethers } from "hardhat";
import fs from "node:fs";
import path from "node:path";

const TESTNET_CHAIN_ID = 46630;
const LOCAL_CHAIN_ID = 31337;
const EXPECTED_FEE_TIER = 3000;
const EXPECTED_TICK_SPACING = 60n;

function requireAddress(value: unknown, label: string): string {
  const address = String(value || "").trim();
  if (!ethers.isAddress(address) || address === ethers.ZeroAddress) {
    throw new Error(`${label} is missing or invalid`);
  }
  return address;
}

async function requireCode(address: string, label: string) {
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") throw new Error(`${label} has no deployed bytecode: ${address}`);
}

async function main() {
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const allowLocal = ["1", "true", "yes"].includes(String(process.env.ALLOW_LOCAL_RH_V3_MOCK || "").toLowerCase());
  const expectedChainId = allowLocal && chainId === LOCAL_CHAIN_ID ? LOCAL_CHAIN_ID : TESTNET_CHAIN_ID;
  if (chainId !== expectedChainId) {
    throw new Error(`Robinhood V3 mock verifier is testnet-only. Expected chain ${TESTNET_CHAIN_ID}, got ${chainId}.`);
  }

  const deploymentPath = path.resolve(
    String(process.env.ROBINHOOD_V3_MOCK_DEPLOYMENT || "deployments/robinhood/testnet-v3-mock.json")
  );
  if (!fs.existsSync(deploymentPath)) {
    throw new Error(`Robinhood V3 mock deployment file not found: ${deploymentPath}`);
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  if (Number(deployment?.chainId) !== expectedChainId) {
    throw new Error(`Deployment chainId mismatch: expected ${expectedChainId}, got ${deployment?.chainId}`);
  }
  if (deployment?.productionCompatible !== false) {
    throw new Error("Mock deployment must be explicitly marked productionCompatible=false");
  }
  if (String(deployment?.purpose || "") !== "robinhood-testnet-uniswap-v3-compatible-mock") {
    throw new Error("Unexpected Robinhood V3 mock deployment purpose");
  }
  if (Number(deployment?.feeTier) !== EXPECTED_FEE_TIER) {
    throw new Error(`Unexpected fee tier: ${deployment?.feeTier}`);
  }

  const weth9 = requireAddress(deployment?.contracts?.weth9, "weth9");
  const factoryAddress = requireAddress(deployment?.contracts?.factory, "factory");
  const positionManagerAddress = requireAddress(
    deployment?.contracts?.nonfungiblePositionManager,
    "nonfungiblePositionManager"
  );
  const swapRouterAddress = requireAddress(deployment?.contracts?.swapRouter02, "swapRouter02");
  const adapterAddress = requireAddress(deployment?.contracts?.graduationAdapter, "graduationAdapter");

  await Promise.all([
    requireCode(weth9, "MockWETH9"),
    requireCode(factoryAddress, "MockUniswapV3Factory"),
    requireCode(positionManagerAddress, "MockUniswapV3PositionManager"),
    requireCode(swapRouterAddress, "MockUniswapV3SwapRouter"),
    requireCode(adapterAddress, "RobinhoodUniswapV3GraduationAdapter"),
  ]);

  const factory = await ethers.getContractAt("MockUniswapV3Factory", factoryAddress);
  const positionManager = await ethers.getContractAt("MockUniswapV3PositionManager", positionManagerAddress);
  const swapRouter = await ethers.getContractAt("MockUniswapV3SwapRouter", swapRouterAddress);
  const weth = await ethers.getContractAt("MockWETH9", weth9);
  const adapter = await ethers.getContractAt("RobinhoodUniswapV3GraduationAdapter", adapterAddress);

  const [
    configuredPositionManager,
    configuredSwapRouter,
    spacing,
    managerFactory,
    managerWeth,
    routerFactory,
    routerWeth,
    symbol,
    adapterFactory,
    adapterManager,
    adapterWeth,
    adapterFee,
    adapterPoolFactory,
    liquidityKind,
  ] = await Promise.all([
    factory.positionManager(),
    factory.swapRouter(),
    factory.feeAmountTickSpacing(EXPECTED_FEE_TIER),
    positionManager.factory(),
    positionManager.WETH9(),
    swapRouter.factory(),
    swapRouter.WETH9(),
    weth.symbol(),
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
  if (!same(managerFactory, factoryAddress)) throw new Error("Position manager factory mismatch");
  if (!same(managerWeth, weth9)) throw new Error("Position manager WETH9 mismatch");
  if (!same(routerFactory, factoryAddress)) throw new Error("Swap router factory mismatch");
  if (!same(routerWeth, weth9)) throw new Error("Swap router WETH9 mismatch");
  if (String(symbol) !== "mWETH") throw new Error(`Unexpected mock wrapped-native symbol: ${symbol}`);
  if (!same(adapterFactory, factoryAddress)) throw new Error("Graduation adapter factory mismatch");
  if (!same(adapterManager, positionManagerAddress)) throw new Error("Graduation adapter position manager mismatch");
  if (!same(adapterWeth, weth9)) throw new Error("Graduation adapter WETH mismatch");
  if (Number(adapterFee) !== EXPECTED_FEE_TIER) throw new Error(`Graduation adapter fee mismatch: ${adapterFee}`);
  if (!same(adapterPoolFactory, adapterAddress)) throw new Error("Graduation adapter legacy poolFactory boundary mismatch");
  if (Number(liquidityKind) !== 2) throw new Error(`Graduation adapter liquidity kind mismatch: ${liquidityKind}`);

  console.log("Robinhood V3 mock deployment verified", {
    chainId,
    feeTier: EXPECTED_FEE_TIER,
    weth9,
    factory: factoryAddress,
    nonfungiblePositionManager: positionManagerAddress,
    swapRouter02: swapRouterAddress,
    graduationAdapter: adapterAddress,
    deploymentPath,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
