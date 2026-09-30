import { expect } from "chai";
import { ethers } from "hardhat";
import { deployEvmGenRh } from "./fixtures/evmgenRh";
import { RH_V3 } from "./helpers/evmgenRhRealV3";
import { createCoin, req as evmReq, mineAt, buyNative } from "./fixtures/evmgenCore";

const FEE = 3000;
const Q96 = 1n << 96n;

async function latestTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp);
}

async function deployTestOracle(price = "1") {
  const PriceFeed = await ethers.getContractFactory("MockUsdPriceFeed");
  const priceFeed = await PriceFeed.deploy(8);
  await priceFeed.waitForDeployment();
  const now = await latestTimestamp();
  await priceFeed.setRoundData(1n, ethers.parseUnits(price, 8), now, now, 1n);

  const GraduationOracle = await ethers.getContractFactory("GraduationOracle");
  const graduationOracle = await GraduationOracle.deploy(await priceFeed.getAddress(), 30 * 24 * 60 * 60);
  await graduationOracle.waitForDeployment();
  return graduationOracle;
}

async function deployDirectCampaign(params: any) {
  const Campaign = await ethers.getContractFactory("LaunchCampaign");
  const impl = await Campaign.deploy();
  await impl.waitForDeployment();

  const implAddr = await impl.getAddress();
  const minimalProxyBytecode =
    "0x3d602d80600a3d3981f3363d3d373d3d3d363d73" +
    implAddr.slice(2).toLowerCase() +
    "5af43d82803e903d91602b57fd5bf3";

  const [deployer] = await ethers.getSigners();
  const txClone = await deployer.sendTransaction({ data: minimalProxyBytecode });
  const receipt = await txClone.wait();
  const campaign = Campaign.attach(receipt!.contractAddress!);
  await campaign.initialize(params);
  return campaign;
}

async function deployV3Stack() {
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
  await factory.configurePeriphery(await positionManager.getAddress(), await swapRouter.getAddress());

  const Adapter = await ethers.getContractFactory("RobinhoodUniswapV3GraduationAdapter");
  const adapter = await Adapter.deploy(
    await factory.getAddress(),
    await positionManager.getAddress(),
    await weth.getAddress(),
    FEE,
  );
  await adapter.waitForDeployment();

  return { weth, factory, positionManager, swapRouter, adapter };
}

describe("Robinhood V3 graduation compatibility", function () {
  // BLOCKED ON claude/evm-rh: no IGraduationAdapterV2 V3 adapter in tree yet.
  // RobinhoodUniswapV3GraduationAdapter does not implement IGraduationAdapterV2 (contracts/interfaces/IGraduationAdapterV2.sol), and the
  // body drives the removed campaign surface (initialize with router/lpReceiver/liquidityBps, CampaignFinalized on the crossing buy).
  // A test double would only re-test the campaign (covered by evmgen-core-graduation / evmgen-core-lifecycle) and the V3 locker
  // (evmgen-fees-locker-v3); the subject here is the real V3 adapter. Rewrite against graduate() when the V2 adapter lands.
  // Was pending ("no V3 IGraduationAdapterV2"). Now: the C5 LaunchCampaign graduates through
  // RobinhoodV3NativeGraduationAdapterV2 into real Uniswap V3 (canonical 4663 bytecode), the factory registers
  // the NFT, a trader swaps through SwapRouter02, and the locker harvests 80/20 without touching principal.
  it("graduates the C5 LaunchCampaign into a permanently locked V3 NFT (RobinhoodV3NativeGraduationAdapterV2) and harvests fees 80/20", async () => {
    const env = await deployEvmGenRh();
    const { campaign, token } = await createCoin(env as any, evmReq({ graduationTarget: ethers.parseEther("30000") }));
    await mineAt(Number(await campaign.launchAt()) + 120);
    for (let i = 0; i < 20 && !(await campaign.graduationPending()); i++) {
      await buyNative(env as any, campaign, env.alice, ethers.parseEther("2"));
    }
    await campaign.connect(env.carol).graduate();
    const state = await campaign.getGraduationState();
    const poolAddress = state.dexPair;
    const info = await env.locker.poolInfo(poolAddress);
    expect(info.registered).to.equal(true);
    expect(await env.adapter.liquidityKind()).to.equal(2n);
    expect(await env.adapter.poolFactory()).to.equal(await env.adapter.getAddress());
    expect(await env.positionManager.ownerOf(info.tokenId)).to.equal(await env.locker.getAddress());
    const positionBefore = await env.positionManager.positions(info.tokenId);

    const trader = env.bob;
    const swapIn = ethers.parseEther("1");
    await env.weth.connect(trader).deposit({ value: swapIn });
    await env.weth.connect(trader).approve(RH_V3.swapRouter02, swapIn);
    const router = await ethers.getContractAt(
      ["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)"],
      RH_V3.swapRouter02,
    );
    await (router.connect(trader) as any).exactInputSingle({
      tokenIn: RH_V3.weth,
      tokenOut: await token.getAddress(),
      fee: FEE,
      recipient: trader.address,
      amountIn: swapIn,
      amountOutMinimum: 1n,
      sqrtPriceLimitX96: 0,
    });
    expect(await token.balanceOf(trader.address)).to.be.greaterThan(0n);

    const creatorBefore = await env.weth.balanceOf(env.creator.address);
    const tx = await env.locker.connect(trader).harvest(poolAddress);
    const rc = await tx.wait();
    const harvested = rc!.logs
      .map((l: any) => { try { return env.locker.interface.parseLog(l); } catch { return null; } })
      .find((x: any) => x?.name === "FeesHarvested" && x.args.token === RH_V3.weth);
    const amount: bigint = harvested!.args.collected;
    const expectedFee = (swapIn * BigInt(FEE)) / 1_000_000n;
    expect(expectedFee - amount).to.be.lte(1n); // the sole in-range position earns the whole 0.30% (V3 rounds down)
    const creatorAmount = (amount * 8_000n) / 10_000n;
    expect((await env.weth.balanceOf(env.creator.address)) - creatorBefore).to.equal(creatorAmount);
    expect(harvested!.args.creatorPaid).to.equal(creatorAmount);
    expect(harvested!.args.protocolRouted).to.equal(amount - creatorAmount);

    const positionAfter = await env.positionManager.positions(info.tokenId);
    expect(positionAfter.liquidity).to.equal(positionBefore.liquidity);
    expect(await env.positionManager.ownerOf(info.tokenId)).to.equal(await env.locker.getAddress());
    expect(await token.balanceOf(await env.adapter.getAddress())).to.equal(0n);
    expect(await env.weth.balanceOf(await env.adapter.getAddress())).to.equal(0n);
    expect(await ethers.provider.getBalance(await env.adapter.getAddress())).to.equal(0n);
    expect(await token.allowance(await campaign.getAddress(), await env.adapter.getAddress())).to.equal(0n);
  });

  it("keeps the V3 compatibility boundary fail-closed", async () => {
    const [owner, other] = await ethers.getSigners();
    const { adapter } = await deployV3Stack();

    expect(await adapter.WETH()).to.not.equal(ethers.ZeroAddress);
    await expect(
      adapter.addLiquidityETH(
        await other.getAddress(),
        true,
        1n,
        1n,
        1n,
        await owner.getAddress(),
        (await latestTimestamp()) + 60n,
        { value: 1n },
      )
    ).to.be.revertedWithCustomError(adapter, "StablePoolUnsupported");
  });
});
