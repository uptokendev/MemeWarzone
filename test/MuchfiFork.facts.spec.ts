// t30: on-chain facts about MuchFi (DogeOS Chikyū 6281971) pinned against the real bytecode on a fork.
//
//   npx hardhat --config hardhat.dogeos-testnet-fork.config.ts test test/MuchfiFork.facts.spec.ts
//
// MuchFi publishes no source, so a fork is the only place these can be proven. Everything here runs on the
// in-process fork with hardhat's local funded accounts; nothing is sent to Chikyū. Under any other config the
// suite skips (skipUnlessChikyuFork).
import { expect } from "chai";
import { ethers } from "hardhat";
import type { Contract, Signer, TransactionReceipt } from "ethers";
import slot0Fixture from "./fixtures/muchfiSlot0.json";
import swapFixture from "./fixtures/muchfiSwapLog.json";
import {
  MAX_SQRT_RATIO,
  MIN_SQRT_RATIO,
  MUCHFI,
  MUCHFI_FACTORY_ABI,
  MUCHFI_FEE,
  MUCHFI_MAX_TICK,
  MUCHFI_MIN_TICK,
  MUCHFI_NPM_ABI,
  MUCHFI_POOL_ABI,
  MUCHFI_SMART_ROUTER_ABI,
  MUCHFI_TICK_SPACING,
  MUCHFI_PERIPHERY_ABI,
  WDOGE_ABI,
  computeMuchfiPoolAddress,
  skipUnlessChikyuFork,
} from "./helpers/muchfiFork";

const E18 = 10n ** 18n;
const Q96 = 2n ** 96n;
// slot0().feeProtocol on MuchFi pools: 3200 | 3200 << 16, i.e. 32% of LP fees per side (denominator 10000).
const MUCHFI_FEE_PROTOCOL = 3200n | (3200n << 16n);
const UNISWAP_V3_SWAP_TOPIC0 = ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)");

describe("MuchFi on a Chikyū fork: pinned facts (t30)", function () {
  let deployer: Signer;
  let deployerAddress: string;
  let factory: Contract;
  let npm: Contract;
  let wdoge: Contract;
  let token: Contract;
  let tokenAddress: string;
  let poolAddress: string;
  let pool: Contract;
  let tokenIsToken0: boolean;

  async function deadline(): Promise<number> {
    const block = await ethers.provider.getBlock("latest");
    return Number(block!.timestamp) + 3600;
  }

  before(async function () {
    skipUnlessChikyuFork(this);
    [deployer] = await ethers.getSigners();
    deployerAddress = await deployer.getAddress();
    factory = new ethers.Contract(MUCHFI.FACTORY, MUCHFI_FACTORY_ABI, deployer);
    npm = new ethers.Contract(MUCHFI.NPM, MUCHFI_NPM_ABI, deployer);
    wdoge = new ethers.Contract(MUCHFI.WDOGE, WDOGE_ABI, deployer);

    // A fresh test ERC-20 that exists only on this fork, paired with the official WDOGE at the 1% tier.
    token = (await (await ethers.getContractFactory("MockERC20"))
      .connect(deployer)
      .deploy("MuchFi Fork Test Token", "MFFT", 1_000_000n * E18, deployerAddress)) as unknown as Contract;
    await token.waitForDeployment();
    tokenAddress = await token.getAddress();
    await (await wdoge.deposit({ value: 200n * E18 })).wait();

    tokenIsToken0 = BigInt(tokenAddress) < BigInt(MUCHFI.WDOGE);
    const [token0, token1] = tokenIsToken0 ? [tokenAddress, MUCHFI.WDOGE] : [MUCHFI.WDOGE, tokenAddress];
    expect(await factory.getPool(token0, token1, MUCHFI_FEE)).to.equal(ethers.ZeroAddress);
    await (await npm.createAndInitializePoolIfNecessary(token0, token1, MUCHFI_FEE, Q96)).wait();
    poolAddress = await factory.getPool(token0, token1, MUCHFI_FEE);
    pool = new ethers.Contract(poolAddress, MUCHFI_POOL_ABI, deployer);

    // Full-range liquidity through the NPM (it implements muchfiV3MintCallback for us).
    await (await token.approve(MUCHFI.NPM, ethers.MaxUint256)).wait();
    await (await wdoge.approve(MUCHFI.NPM, ethers.MaxUint256)).wait();
    await (
      await npm.mint({
        token0,
        token1,
        fee: MUCHFI_FEE,
        tickLower: MUCHFI_MIN_TICK,
        tickUpper: MUCHFI_MAX_TICK,
        amount0Desired: 100n * E18,
        amount1Desired: 100n * E18,
        amount0Min: 0,
        amount1Min: 0,
        recipient: deployerAddress,
        deadline: await deadline(),
      })
    ).wait();
    expect(await pool.liquidity()).to.be.greaterThan(0n);
  });

  it("factory: fee 10000 has tick spacing 200 and fee 3000 is not enabled (0)", async function () {
    expect(await factory.feeAmountTickSpacing(MUCHFI_FEE)).to.equal(BigInt(MUCHFI_TICK_SPACING));
    expect(await factory.feeAmountTickSpacing(3000)).to.equal(0n);
  });

  it("NPM, SmartRouter, SwapRouter and QuoterV2 all use the official WDOGE, the MuchFi factory and its PoolDeployer", async function () {
    // frontend/src/lib/robinhoodV3Trade.ts rejects a route whose router/quoter factory() differs from the pool's.
    for (const [name, address] of Object.entries({
      NPM: MUCHFI.NPM,
      SmartRouter: MUCHFI.SMART_ROUTER,
      SwapRouter: MUCHFI.SWAP_ROUTER,
      QuoterV2: MUCHFI.QUOTER_V2,
    })) {
      const c = new ethers.Contract(address, MUCHFI_PERIPHERY_ABI, ethers.provider);
      expect(await c.WETH9(), `${name}.WETH9()`).to.equal(MUCHFI.WDOGE);
      expect(await c.factory(), `${name}.factory()`).to.equal(MUCHFI.FACTORY);
      expect(await c.deployer(), `${name}.deployer()`).to.equal(MUCHFI.POOL_DEPLOYER);
    }
    expect(await factory.poolDeployer()).to.equal(MUCHFI.POOL_DEPLOYER);
  });

  it("recorded slot0 fixture of a real MuchFi 1% pool matches that pool on the fork and decodes feeProtocol as uint32", async function () {
    const slot0Iface = new ethers.Interface([slot0Fixture.slot0Abi]);
    expect(slot0Fixture.pool.factory).to.equal(MUCHFI.FACTORY);
    expect(slot0Fixture.pool.fee).to.equal(MUCHFI_FEE);
    expect(slot0Fixture.pool.tickSpacing).to.equal(MUCHFI_TICK_SPACING);
    expect(slot0Fixture.pool.address).to.equal(
      computeMuchfiPoolAddress(slot0Fixture.pool.token0, slot0Fixture.pool.token1, slot0Fixture.pool.fee),
    );
    // The same eth_call on the fork against the real pool. Not replayed at the recorded block: this hardhat
    // (2.28.2) hands EDR `hardforks` where it reads `hardforkActivationOverrides`, so any pre-fork-block call
    // fails with "No known hardfork for execution on historical block". Price fields move with trading, so
    // only the layout and the fields that do not move with swaps are compared.
    const live = await ethers.provider.call({ to: slot0Fixture.call.to, data: slot0Fixture.call.data });
    expect(ethers.dataLength(live)).to.equal(7 * 32);
    expect(ethers.dataLength(slot0Fixture.rawReturn)).to.equal(7 * 32);
    const liveDecoded = slot0Iface.decodeFunctionResult("slot0", live);
    expect(Number(liveDecoded.feeProtocol)).to.equal(slot0Fixture.decoded.feeProtocol);
    expect(liveDecoded.unlocked).to.equal(slot0Fixture.decoded.unlocked);

    const decoded = slot0Iface.decodeFunctionResult("slot0", slot0Fixture.rawReturn);
    expect(decoded.sqrtPriceX96.toString()).to.equal(slot0Fixture.decoded.sqrtPriceX96);
    expect(Number(decoded.tick)).to.equal(slot0Fixture.decoded.tick);
    expect(Number(decoded.observationIndex)).to.equal(slot0Fixture.decoded.observationIndex);
    expect(Number(decoded.observationCardinality)).to.equal(slot0Fixture.decoded.observationCardinality);
    expect(Number(decoded.observationCardinalityNext)).to.equal(slot0Fixture.decoded.observationCardinalityNext);
    expect(decoded.unlocked).to.equal(slot0Fixture.decoded.unlocked);
    expect(decoded.feeProtocol).to.equal(MUCHFI_FEE_PROTOCOL);
    expect(Number(decoded.feeProtocol)).to.equal(slot0Fixture.decoded.feeProtocol);
    expect(Number(decoded.feeProtocol & 0xffffn)).to.equal(slot0Fixture.decoded.feeProtocolToken0);
    expect(Number(decoded.feeProtocol >> 16n)).to.equal(slot0Fixture.decoded.feeProtocolToken1);
    const words = ethers.AbiCoder.defaultAbiCoder().decode(Array(7).fill("uint256"), slot0Fixture.rawReturn);
    expect(words[5]).to.be.greaterThan(255n); // a uint8 feeProtocol cannot hold it
  });

  it("a 1% pool created through the NPM sits at the PoolDeployer CREATE2 address with fee 10000 / spacing 200", async function () {
    expect(poolAddress).to.not.equal(ethers.ZeroAddress);
    expect(poolAddress).to.equal(computeMuchfiPoolAddress(tokenAddress, MUCHFI.WDOGE, MUCHFI_FEE));
    expect(await pool.factory()).to.equal(MUCHFI.FACTORY);
    expect(await pool.fee()).to.equal(BigInt(MUCHFI_FEE));
    expect(await pool.tickSpacing()).to.equal(BigInt(MUCHFI_TICK_SPACING));
  });

  it("slot0().feeProtocol is a uint32 (209718400 = 32% per side) and a Solidity uint8 decode reverts", async function () {
    const raw = await ethers.provider.call({ to: poolAddress, data: pool.interface.encodeFunctionData("slot0") });
    const words = ethers.AbiCoder.defaultAbiCoder().decode(Array(7).fill("uint256"), raw);
    expect(words[5]).to.equal(MUCHFI_FEE_PROTOCOL);
    expect(words[5]).to.be.greaterThan(255n); // does not fit a uint8
    expect((await pool.slot0()).feeProtocol).to.equal(MUCHFI_FEE_PROTOCOL);

    const probe = await (await ethers.getContractFactory("MuchfiForkSlot0Probe")).deploy();
    await probe.waitForDeployment();
    expect(await probe.feeProtocolAsUint32(poolAddress)).to.equal(MUCHFI_FEE_PROTOCOL);
    // Our originals declare slot0 with `uint8 feeProtocol`; Solidity's return-data decoder rejects 209718400.
    await expect(probe.feeProtocolAsUint8(poolAddress)).to.be.revertedWithoutReason();
  });

  async function deployCaller(name: string, amountIn: bigint): Promise<Contract> {
    const caller = (await (await ethers.getContractFactory(name)).deploy(poolAddress)) as unknown as Contract;
    await caller.waitForDeployment();
    await (await token.transfer(await caller.getAddress(), amountIn)).wait();
    return caller;
  }

  async function directSwap(caller: Contract, amountIn: bigint) {
    const zeroForOne = tokenIsToken0; // sell the test token for WDOGE
    return caller.swapExactIn(zeroForOne, amountIn, zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n);
  }

  it("direct pool.swap: a caller with only uniswapV3SwapCallback reverts, one with muchfiV3SwapCallback succeeds", async function () {
    const amountIn = E18;
    const uniswapCaller = await deployCaller("MuchfiForkUniswapCallbackCaller", amountIn);
    const muchfiCaller = await deployCaller("MuchfiForkMuchfiCallbackCaller", amountIn);

    // The pool calls muchfiV3SwapCallback on msg.sender; the caller has no such function and no fallback,
    // so the call reverts with empty data (not the pool's "IIA" underpayment reason).
    await expect(directSwap(uniswapCaller, amountIn)).to.be.revertedWithoutReason();
    expect(await token.balanceOf(await uniswapCaller.getAddress())).to.equal(amountIn);

    const wdogeBefore = await wdoge.balanceOf(deployerAddress);
    await expect(directSwap(muchfiCaller, amountIn)).to.not.be.reverted;
    expect(await token.balanceOf(await muchfiCaller.getAddress())).to.equal(0n);
    expect(await wdoge.balanceOf(deployerAddress)).to.be.greaterThan(wdogeBefore);
  });

  it("pool Swap event: PancakeV3 shape (with protocol fees), topic0 matches the recorded fixture for t19", async function () {
    // The fixture itself: a real Chikyū log from a MuchFi pool, decoded with the recorded ABI.
    const fixtureIface = new ethers.Interface([swapFixture.eventAbi]);
    expect(swapFixture.topic0).to.equal(ethers.id(swapFixture.eventSignature));
    expect(swapFixture.topic0).to.not.equal(UNISWAP_V3_SWAP_TOPIC0);
    expect(swapFixture.pool.factory).to.equal(MUCHFI.FACTORY);
    expect(swapFixture.log.topics[0]).to.equal(swapFixture.topic0);
    const fixtureDecoded = fixtureIface.parseLog({ topics: swapFixture.log.topics, data: swapFixture.log.data })!;
    for (const key of Object.keys(swapFixture.decoded) as (keyof typeof swapFixture.decoded)[]) {
      expect(String(fixtureDecoded.args[key]), `fixture.decoded.${key}`).to.equal(String(swapFixture.decoded[key]));
    }

    // A swap on the fork against the real pool bytecode emits the same event.
    const amountIn = E18;
    const caller = await deployCaller("MuchfiForkMuchfiCallbackCaller", amountIn);
    const receipt = (await (await directSwap(caller, amountIn)).wait()) as TransactionReceipt;
    const poolLogs = receipt.logs.filter((l) => l.address.toLowerCase() === poolAddress.toLowerCase());
    expect(poolLogs).to.have.length(1);
    const log = poolLogs[0];
    expect(log.topics[0]).to.equal(swapFixture.topic0);
    expect(log.topics[0]).to.not.equal(UNISWAP_V3_SWAP_TOPIC0);

    const decoded = fixtureIface.parseLog({ topics: [...log.topics], data: log.data })!;
    expect(decoded.args.sender).to.equal(await caller.getAddress());
    expect(decoded.args.recipient).to.equal(deployerAddress);
    const tokenDelta = tokenIsToken0 ? decoded.args.amount0 : decoded.args.amount1;
    const wdogeDelta = tokenIsToken0 ? decoded.args.amount1 : decoded.args.amount0;
    expect(tokenDelta).to.equal(amountIn);
    expect(wdogeDelta).to.be.lessThan(0n);
    // Protocol fee per swap = 32% of the 1% LP fee on the input side; nothing on the output side.
    const protocolIn = tokenIsToken0 ? decoded.args.protocolFeesToken0 : decoded.args.protocolFeesToken1;
    const protocolOut = tokenIsToken0 ? decoded.args.protocolFeesToken1 : decoded.args.protocolFeesToken0;
    const expectedProtocolFee = (amountIn * BigInt(MUCHFI_FEE) * 3200n) / (1_000_000n * 10_000n);
    expect(protocolIn).to.be.closeTo(expectedProtocolFee, 1_000_000n);
    expect(protocolOut).to.equal(0n);
  });

  it("SmartRouter exactInputSingle (no-deadline struct) swaps native DOGE via WDOGE", async function () {
    const smartRouter = new ethers.Contract(MUCHFI.SMART_ROUTER, MUCHFI_SMART_ROUTER_ABI, deployer);
    const amountIn = E18;
    const tokenBefore = await token.balanceOf(deployerAddress);
    const wdogeBefore = await wdoge.balanceOf(deployerAddress);
    const nativeBefore = await ethers.provider.getBalance(deployerAddress);

    const tx = await smartRouter.exactInputSingle(
      {
        tokenIn: MUCHFI.WDOGE,
        tokenOut: tokenAddress,
        fee: MUCHFI_FEE,
        recipient: deployerAddress,
        amountIn,
        amountOutMinimum: 1n,
        sqrtPriceLimitX96: 0n,
      },
      { value: amountIn },
    );
    const receipt = (await tx.wait()) as TransactionReceipt;
    const gasCost = receipt.gasUsed * receipt.gasPrice;

    expect(await token.balanceOf(deployerAddress)).to.be.greaterThan(tokenBefore);
    expect(await wdoge.balanceOf(deployerAddress)).to.equal(wdogeBefore); // native in, wrapped by the router
    expect(await ethers.provider.getBalance(deployerAddress)).to.equal(nativeBefore - amountIn - gasCost);
    expect(await ethers.provider.getBalance(MUCHFI.SMART_ROUTER)).to.equal(0n);
  });
});
