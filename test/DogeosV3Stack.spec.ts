import { expect } from "chai";
import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";
import {
  DOGEOS_TESTNET_WDOGE,
  DOGEOS_V3_FEE_TIER,
  DOGEOS_V3_TICK_SPACING,
  DOGEOS_V3_TOOL_ROOT,
  assertDogeosV3StackTarget,
  deployDogeosV3Stack,
} from "../scripts/lib/dogeosV3Stack";

const SQRT_PRICE_1_1 = 2n ** 96n;
const UNISWAP_ARTIFACT_PROBE = "@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json";

/**
 * ENV: these tests deploy the canonical Uniswap V3 bytecode from the tool's own install
 * (tools/robinhood-testnet-infra, `npm install --no-package-lock` there). Without that install there is
 * nothing to deploy; skip with the reason rather than fail on ENOENT.
 */
function skipWithoutUniswapArtifacts(ctx: Mocha.Context) {
  if (!fs.existsSync(path.join(DOGEOS_V3_TOOL_ROOT, UNISWAP_ARTIFACT_PROBE))) {
    console.log(`    [env] skipped: ${path.join(DOGEOS_V3_TOOL_ROOT, UNISWAP_ARTIFACT_PROBE)} is absent (run npm install in tools/robinhood-testnet-infra)`);
    ctx.skip();
  }
}

/** MockWETH9 is the local WETH9-style stand-in for the official WDOGE (deposit/withdraw/receive). */
async function deployWrappedNativeStandIn() {
  const [deployer] = await ethers.getSigners();
  const W = await ethers.getContractFactory("MockWETH9", deployer);
  const wdoge = await W.deploy();
  await wdoge.waitForDeployment();
  return wdoge;
}

async function deployLocalStack() {
  const [deployer, other] = await ethers.getSigners();
  const wdoge = await deployWrappedNativeStandIn();
  const stack = await deployDogeosV3Stack({
    signer: deployer,
    wrappedNative: await wdoge.getAddress(),
    chainId: 31337,
    allowLocalRehearsal: true,
  });
  const Token = await ethers.getContractFactory("MockERC20", deployer);
  const token = await Token.deploy("Doge Test Meme", "DTM", ethers.parseEther("1000000"), await deployer.getAddress());
  await token.waitForDeployment();
  return { deployer, other, wdoge, stack, token };
}

const FACTORY_ABI = [
  "function feeAmountTickSpacing(uint24) view returns (int24)",
  "function getPool(address,address,uint24) view returns (address)",
];
const BOUND_ABI = ["function factory() view returns (address)", "function WETH9() view returns (address)"];
const DESCRIPTOR_ABI = ["function WETH9() view returns (address)", "function nativeCurrencyLabel() view returns (string)"];
const NPM_ABI = [
  ...BOUND_ABI,
  "function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address pool)",
  "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function balanceOf(address) view returns (uint256)",
];
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
];
const ROUTER_ABI = [
  ...BOUND_ABI,
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
];
const QUOTER_ABI = [
  ...BOUND_ABI,
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

async function expectRejects(promise: Promise<unknown>, message: string) {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error, `expected a rejection containing "${message}"`).to.be.instanceOf(Error);
  expect((error as Error).message).to.contain(message);
}

function sortTokens(a: string, b: string): [string, string] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

describe("DogeOS canonical Uniswap V3 stack (WDOGE)", function () {
  it("refuses 31337 without the rehearsal flag, and sends no transaction", async function () {
    const [deployer] = await ethers.getSigners();
    const wdoge = await deployWrappedNativeStandIn();
    const nonceBefore = await ethers.provider.getTransactionCount(await deployer.getAddress());
    await expectRejects(
      deployDogeosV3Stack({ signer: deployer, wrappedNative: await wdoge.getAddress(), chainId: 31337 }),
      "refusing chain 31337",
    );
    await expectRejects(
      deployDogeosV3Stack({ signer: deployer, wrappedNative: await wdoge.getAddress(), chainId: 31337, allowLocalRehearsal: false }),
      "refusing chain 31337",
    );
    expect(await ethers.provider.getTransactionCount(await deployer.getAddress())).to.equal(nonceBefore);
  });

  it("refuses every other chain, even with the rehearsal flag", function () {
    for (const chainId of [1, 56, 97, 101, 4663, 46630]) {
      expect(() => assertDogeosV3StackTarget({ chainId, wrappedNative: DOGEOS_TESTNET_WDOGE, allowLocalRehearsal: true })).to.throw(
        `refusing chain ${chainId}`,
      );
    }
  });

  it("on 6281971 accepts only the official WDOGE as the wrapped native", function () {
    expect(() => assertDogeosV3StackTarget({ chainId: 6281971, wrappedNative: DOGEOS_TESTNET_WDOGE })).to.not.throw();
    expect(() =>
      assertDogeosV3StackTarget({ chainId: 6281971, wrappedNative: DOGEOS_TESTNET_WDOGE.toLowerCase() }),
    ).to.not.throw();
    expect(() =>
      assertDogeosV3StackTarget({ chainId: 6281971, wrappedNative: "0x0000000000000000000000000000000000000001" }),
    ).to.throw("official WDOGE");
    expect(() => assertDogeosV3StackTarget({ chainId: 31337, wrappedNative: ethers.ZeroAddress, allowLocalRehearsal: true })).to.throw(
      "wrappedNative",
    );
  });

  it("refuses a chainId argument that differs from the signer's connected network", async function () {
    const [deployer] = await ethers.getSigners();
    const nonceBefore = await ethers.provider.getTransactionCount(await deployer.getAddress());
    await expectRejects(
      deployDogeosV3Stack({ signer: deployer, wrappedNative: DOGEOS_TESTNET_WDOGE, chainId: 6281971 }),
      "connected to chain 31337",
    );
    expect(await ethers.provider.getTransactionCount(await deployer.getAddress())).to.equal(nonceBefore);
  });

  it("deploys factory, descriptor, position manager, SwapRouter02 and QuoterV2 bound to the wrapped native", async function () {
    skipWithoutUniswapArtifacts(this);
    const { wdoge, stack } = await deployLocalStack();
    const w = await wdoge.getAddress();

    for (const key of ["v3Factory", "nftDescriptor", "tokenDescriptor", "positionManager", "swapRouter02", "quoterV2"] as const) {
      expect(ethers.isAddress(stack[key]), key).to.equal(true);
      expect(await ethers.provider.getCode(stack[key]), key).to.not.equal("0x");
      expect(stack.deployments[key].address).to.equal(stack[key]);
      expect(stack.deployments[key].runtimeCodeHash).to.equal(ethers.keccak256(await ethers.provider.getCode(stack[key])));
    }
    expect(stack.chainId).to.equal(31337);
    expect(stack.wrappedNative).to.equal(w);
    expect(stack.feeTier).to.equal(DOGEOS_V3_FEE_TIER);
    expect(stack.tickSpacing).to.equal(DOGEOS_V3_TICK_SPACING);
    expect(stack.sourceIdentities).to.deep.equal({
      v3Core: "@uniswap/v3-core@1.0.1",
      v3Periphery: "@uniswap/v3-periphery@1.4.4",
      swapRouterContracts: "@uniswap/swap-router-contracts@1.3.1",
    });

    const factory = new ethers.Contract(stack.v3Factory, FACTORY_ABI, ethers.provider);
    expect(await factory.feeAmountTickSpacing(3000)).to.equal(60n);

    const descriptor = new ethers.Contract(stack.tokenDescriptor, DESCRIPTOR_ABI, ethers.provider);
    expect(await descriptor.WETH9()).to.equal(w);
    expect(await descriptor.nativeCurrencyLabel()).to.equal("DOGE");

    for (const key of ["positionManager", "swapRouter02", "quoterV2"] as const) {
      const bound = new ethers.Contract(stack[key], BOUND_ABI, ethers.provider);
      expect(await bound.factory(), key).to.equal(stack.v3Factory);
      expect(await bound.WETH9(), key).to.equal(w);
    }
  });

  it("creates and initializes a real V3 pool whose slot0() is readable", async function () {
    skipWithoutUniswapArtifacts(this);
    const { wdoge, stack, token } = await deployLocalStack();
    const [token0, token1] = sortTokens(await token.getAddress(), await wdoge.getAddress());
    const npm = new ethers.Contract(stack.positionManager, NPM_ABI, (await ethers.getSigners())[0]);
    await (await npm.createAndInitializePoolIfNecessary(token0, token1, 3000, SQRT_PRICE_1_1)).wait();

    const factory = new ethers.Contract(stack.v3Factory, FACTORY_ABI, ethers.provider);
    const poolAddress = await factory.getPool(token0, token1, 3000);
    expect(poolAddress).to.not.equal(ethers.ZeroAddress);
    const pool = new ethers.Contract(poolAddress, POOL_ABI, ethers.provider);
    const slot0 = await pool.slot0();
    expect(slot0.sqrtPriceX96).to.equal(SQRT_PRICE_1_1);
    expect(slot0.tick).to.equal(0n);
    expect(slot0.unlocked).to.equal(true);
    expect(await pool.fee()).to.equal(3000n);
    expect(await pool.tickSpacing()).to.equal(60n);
  });

  it("swaps native DOGE (wrapped by the stand-in) through SwapRouter02 exactInputSingle, matching the QuoterV2 quote", async function () {
    skipWithoutUniswapArtifacts(this);
    const { deployer, other, wdoge, stack, token } = await deployLocalStack();
    const w = await wdoge.getAddress();
    const t = await token.getAddress();
    const [token0, token1] = sortTokens(t, w);

    const npm = new ethers.Contract(stack.positionManager, NPM_ABI, deployer);
    await (await wdoge.deposit({ value: ethers.parseEther("100") })).wait();
    await (await wdoge.approve(stack.positionManager, ethers.MaxUint256)).wait();
    await (await token.approve(stack.positionManager, ethers.MaxUint256)).wait();
    await (await npm.createAndInitializePoolIfNecessary(token0, token1, 3000, SQRT_PRICE_1_1)).wait();
    const block = await ethers.provider.getBlock("latest");
    await (
      await npm.mint({
        token0,
        token1,
        fee: 3000,
        tickLower: -887220,
        tickUpper: 887220,
        amount0Desired: ethers.parseEther("50"),
        amount1Desired: ethers.parseEther("50"),
        amount0Min: 0,
        amount1Min: 0,
        recipient: await deployer.getAddress(),
        deadline: Number(block!.timestamp) + 3600,
      })
    ).wait();
    expect(await npm.balanceOf(await deployer.getAddress())).to.equal(1n);

    const amountIn = ethers.parseEther("1");
    const quoter = new ethers.Contract(stack.quoterV2, QUOTER_ABI, ethers.provider);
    const quote = await quoter.quoteExactInputSingle.staticCall({
      tokenIn: w,
      tokenOut: t,
      amountIn,
      fee: 3000,
      sqrtPriceLimitX96: 0,
    });
    expect(quote.amountOut).to.be.greaterThan(0n);

    const factory = new ethers.Contract(stack.v3Factory, FACTORY_ABI, ethers.provider);
    const poolAddress = await factory.getPool(token0, token1, 3000);
    const poolWBefore = await wdoge.balanceOf(poolAddress);
    const recipient = await other.getAddress();
    const tokenBefore = await token.balanceOf(recipient);
    const nativeBefore = await ethers.provider.getBalance(await deployer.getAddress());

    const router = new ethers.Contract(stack.swapRouter02, ROUTER_ABI, deployer);
    const receipt = await (
      await router.exactInputSingle(
        { tokenIn: w, tokenOut: t, fee: 3000, recipient, amountIn, amountOutMinimum: quote.amountOut, sqrtPriceLimitX96: 0 },
        { value: amountIn },
      )
    ).wait();

    const gasCost: bigint = BigInt(receipt!.gasUsed) * BigInt(receipt!.gasPrice);
    expect(await ethers.provider.getBalance(await deployer.getAddress())).to.equal(nativeBefore - amountIn - gasCost);
    expect(await wdoge.balanceOf(poolAddress)).to.equal(poolWBefore + amountIn);
    expect(await token.balanceOf(recipient)).to.equal(tokenBefore + quote.amountOut);
    expect(await ethers.provider.getBalance(stack.swapRouter02)).to.equal(0n);
    expect(await wdoge.balanceOf(stack.swapRouter02)).to.equal(0n);
  });
});
