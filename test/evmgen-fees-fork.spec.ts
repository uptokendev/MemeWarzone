import { expect } from "chai";
import { ethers, network } from "hardhat";

// E9 on real DEX code: a harvest on a BSC mainnet fork (real Topaz pool factory, real volatile pool, real WBNB)
// and on a Robinhood mainnet fork (real Uniswap V3 factory, NonfungiblePositionManager, SwapRouter02, WETH9).
// Runs against a local anvil fork (EDR cannot fork a chain it has no hardfork history for via hardhat_reset:
// "Storage overrides are not supported for forked blocks"). Nothing is sent to any live network.
//   anvil --fork-url https://bsc-dataseed.bnbchain.org --chain-id 31337 --port 8545 &
//   EVMGEN_FORK=bsc npx hardhat test test/evmgen-fees-fork.spec.ts --network localhost
//   anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 31337 --port 8545 &
//   EVMGEN_FORK=rh npx hardhat test test/evmgen-fees-fork.spec.ts --network localhost
const FORK = String(process.env.EVMGEN_FORK || "").toLowerCase();
const E18 = 10n ** 18n;

const TOPAZ_FACTORY = "0x65E6cD0eF5D3467030103cf3d433034E570b5784";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const V3_FACTORY = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA";
const NPM = "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3";
const SWAP_ROUTER02 = "0xCaf681a66D020601342297493863E78C959E5cb2";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

async function requireCode(address: string, ctx: Mocha.Context) {
  if ((await ethers.provider.getCode(address)) === "0x") ctx.skip();
}

async function events(contract: any, rc: any, name: string) {
  return rc.logs
    .map((l: any) => {
      try {
        return contract.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .filter((e: any) => e && e.name === name);
}

// Gas the sellMemeForPaired frame actually used inside the harvest (callTracer on the local fork), and the
// harvest's own gasUsed. The locker's MIN_SALE_GAS guard must cover the frame with margin (see C1-C6-fees.md).
async function saleGas(locker: any, rc: any) {
  const trace: any = await ethers.provider.send("debug_traceTransaction", [rc.hash, { tracer: "callTracer" }]);
  const selector = locker.interface.getFunction("sellMemeForPaired")!.selector;
  const lockerAddr = (await locker.getAddress()).toLowerCase();
  const found: any[] = [];
  const walk = (c: any) => {
    if (String(c.to).toLowerCase() === lockerAddr && String(c.input).startsWith(selector)) found.push(c);
    for (const k of c.calls || []) walk(k);
  };
  walk(trace);
  expect(found.length).to.equal(1);
  expect(found[0].error).to.equal(undefined);
  return { sale: BigInt(found[0].gasUsed), harvest: rc.gasUsed as bigint };
}

async function localRouter(owner: any) {
  const Receiver = await ethers.getContractFactory("TreasuryRouterV3ReceiverMock");
  const weekly = await Receiver.deploy();
  const monthly = await Receiver.deploy();
  const protocolVault = await Receiver.deploy();
  const router = await (await ethers.getContractFactory("TreasuryRouterV4")).deploy(owner.address, await weekly.getAddress(), await monthly.getAddress(), 3600);
  await (await router.setProtocolRevenueVault(await protocolVault.getAddress())).wait();
  return { router, protocolVault };
}

(FORK ? describe : describe.skip)("evmgen fees: E9 harvest on mainnet forks", function () {
  this.timeout(900_000);

  it("BSC fork, real Topaz: MEME-side fees sold in the pool, creator and protocol paid WBNB only, split exact", async function () {
    if (FORK !== "bsc") this.skip();
    await requireCode(TOPAZ_FACTORY, this);
    const [owner, creator, recipient, campaign, trader] = await ethers.getSigners();
    const meme = await (await ethers.getContractFactory("MockERC20")).deploy("Meme", "MEME", 10n ** 30n, owner.address);
    const wbnb = await ethers.getContractAt(["function deposit() payable", "function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], WBNB);
    const factory = await ethers.getContractAt(["function createPool(address,address,bool) returns (address)", "function getPool(address,address,bool) view returns (address)", "function getFee(address,bool) view returns (uint256)"], TOPAZ_FACTORY);
    await (await factory.createPool(await meme.getAddress(), WBNB, false)).wait();
    const poolAddr = await factory.getPool(await meme.getAddress(), WBNB, false);
    expect(poolAddr).to.not.equal(ethers.ZeroAddress);
    expect(await factory.getFee(poolAddr, false)).to.equal(30n);
    const pool = await ethers.getContractAt(
      [
        "function mint(address) returns (uint256)",
        "function token0() view returns (address)",
        "function getReserves() view returns (uint256,uint256,uint256)",
        "function getAmountOut(uint256,address) view returns (uint256)",
        "function swap(uint256,uint256,address,bytes)",
        "function balanceOf(address) view returns (uint256)",
        "function sync()",
      ],
      poolAddr,
    );
    const { router, protocolVault } = await localRouter(owner);
    const locker = await (await ethers.getContractFactory("PermanentLpLocker")).deploy(owner.address);
    await (await locker.configureRevenue(await router.getAddress(), TOPAZ_FACTORY)).wait();
    await (await router.setAuthorizedLpLocker(await locker.getAddress(), true)).wait();

    // Graduation-sized pool: 20M MEME / 20 WBNB, all LP to the locker.
    await (await wbnb.deposit({ value: 60n * E18 })).wait();
    await (await meme.transfer(poolAddr, 20_000_000n * E18)).wait();
    await (await wbnb.transfer(poolAddr, 20n * E18)).wait();
    await (await pool.mint(await locker.getAddress())).wait();
    const lp = await pool.balanceOf(await locker.getAddress());
    await (await locker.registerGraduatedPool(campaign.address, creator.address, recipient.address, poolAddr, await meme.getAddress(), WBNB, lp)).wait();

    // Real trading: the pool charges 0.30% on the input side; the locker is the only LP.
    await (await meme.transfer(trader.address, 2_000_000n * E18)).wait();
    await (await wbnb.connect(trader).deposit({ value: 20n * E18 })).wait();
    const memeIs0 = (await pool.token0()).toLowerCase() === (await meme.getAddress()).toLowerCase();
    async function swapIn(tokenIn: any, amount: bigint) {
      const out = await pool.getAmountOut(amount, await tokenIn.getAddress());
      await (await tokenIn.connect(trader).transfer(poolAddr, amount)).wait();
      const inIs0 = (await tokenIn.getAddress()).toLowerCase() === (await pool.token0()).toLowerCase();
      await (await pool.connect(trader).swap(inIs0 ? 0n : out, inIs0 ? out : 0n, trader.address, "0x")).wait();
    }
    for (let i = 0; i < 4; i++) {
      await swapIn(meme, 500_000n * E18);
      await swapIn(wbnb, 1n * E18);
    }

    // Audit fix F3: the locker sells only with the pair's TWAP (Topaz `quote`, one closed 30 min window) within
    // 1% of spot. Age the pool past two windows so the last closed one reflects the settled price.
    for (let w = 0; w < 2; w++) {
      await ethers.provider.send("evm_increaseTime", [1801]);
      await ethers.provider.send("evm_mine", []);
      await (await pool.sync()).wait();
    }
    const [r0b, r1b] = await pool.getReserves();
    const memeReserveBefore = memeIs0 ? r0b : r1b;
    const rc = await (await locker.connect(trader).harvest(poolAddr)).wait();
    const sold = (await events(locker, rc, "MemeFeesSold"))[0].args;
    const harvested = (await events(locker, rc, "FeesHarvested"))[0].args;
    expect(harvested.token).to.equal(WBNB);
    const gas = await saleGas(locker, rc);
    const minSaleGas = await locker.MIN_SALE_GAS();
    // The guard must leave the sale (63/64 of it, EIP-150) at least 2x what a real Topaz sale costs.
    expect(gas.sale * 2n).to.be.lte((minSaleGas * 63n) / 64n);
    console.log(`      BSC fork gas: sellMemeForPaired frame ${gas.sale}, whole harvest ${gas.harvest}, MIN_SALE_GAS ${minSaleGas}`);
    // MEME fees: 0.3% of 2M = 6000 MEME (minus the pool's own rounding); all within one harvest's 0.25% cap (50k).
    expect(sold.memeSold).to.be.gt(5_900n * E18);
    expect(sold.memeCarried).to.equal(0n);
    expect(sold.memeSold).to.be.lte((memeReserveBefore * 50n) / 20000n);
    const creatorPaid = await wbnb.balanceOf(recipient.address);
    const protocolPaid = await wbnb.balanceOf(await protocolVault.getAddress());
    expect(creatorPaid).to.equal((harvested.collected * 8000n) / 10000n);
    expect(protocolPaid).to.equal(harvested.collected - creatorPaid);
    expect(harvested.collected).to.be.gt(sold.pairedOut); // WBNB-side fees + proceeds
    expect(await meme.balanceOf(recipient.address)).to.equal(0n);
    expect(await meme.balanceOf(await protocolVault.getAddress())).to.equal(0n);
    expect(await meme.balanceOf(await locker.getAddress())).to.equal(0n);
    expect(await wbnb.balanceOf(await locker.getAddress())).to.equal(0n);
    expect(await pool.balanceOf(await locker.getAddress())).to.equal(lp); // principal untouched
    console.log(`      BSC fork: MEME sold ${ethers.formatEther(sold.memeSold)} -> WBNB ${ethers.formatEther(sold.pairedOut)}; creator ${ethers.formatEther(creatorPaid)} / protocol ${ethers.formatEther(protocolPaid)} WBNB`);
  });

  it("Robinhood fork, real Uniswap V3: MEME-side fees sold in the pool within 0.5%, WETH split exact", async function () {
    if (FORK !== "rh") this.skip();
    await requireCode(V3_FACTORY, this);
    const [owner, creator, recipient, campaign, trader] = await ethers.getSigners();
    const meme = await (await ethers.getContractFactory("MockERC20")).deploy("Meme", "MEME", 10n ** 30n, owner.address);
    const weth = await ethers.getContractAt(["function deposit() payable", "function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], WETH);
    const npm = await ethers.getContractAt(
      [
        "function createAndInitializePoolIfNecessary(address,address,uint24,uint160) payable returns (address)",
        "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
      ],
      NPM,
    );
    const memeAddr = await meme.getAddress();
    const memeIs0 = memeAddr.toLowerCase() < WETH.toLowerCase();
    const [t0, t1] = memeIs0 ? [memeAddr, WETH] : [WETH, memeAddr];
    // 20M MEME : 20 WETH -> price 1e-6 WETH per MEME
    const a0 = memeIs0 ? 20_000_000n * E18 : 20n * E18;
    const a1 = memeIs0 ? 20n * E18 : 20_000_000n * E18;
    const sqrt = (n: bigint) => {
      let x = n, y = (x + 1n) / 2n;
      while (y < x) { x = y; y = (x + n / x) / 2n; }
      return x;
    };
    const sqrtP = sqrt((a1 << 192n) / a0);
    await (await npm.createAndInitializePoolIfNecessary(t0, t1, 3000, sqrtP)).wait();
    const v3f = await ethers.getContractAt(["function getPool(address,address,uint24) view returns (address)"], V3_FACTORY);
    const poolAddr = await v3f.getPool(t0, t1, 3000);
    const integration = await (await ethers.getContractFactory("MockV3IntegrationEvmGen")).deploy(V3_FACTORY, NPM, WETH);
    await network.provider.send("hardhat_setBalance", [owner.address, "0x" + (10n ** 22n).toString(16)]);
    await (await weth.deposit({ value: 40n * E18 })).wait();
    await (await meme.approve(NPM, ethers.MaxUint256)).wait();
    await (await weth.approve(NPM, ethers.MaxUint256)).wait();
    const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600;
    const minted = await npm.mint.staticCall({ token0: t0, token1: t1, fee: 3000, tickLower: -887220, tickUpper: 887220, amount0Desired: a0, amount1Desired: a1, amount0Min: 0, amount1Min: 0, recipient: await integration.getAddress(), deadline });
    await (await npm.mint({ token0: t0, token1: t1, fee: 3000, tickLower: -887220, tickUpper: 887220, amount0Desired: a0, amount1Desired: a1, amount0Min: 0, amount1Min: 0, recipient: await integration.getAddress(), deadline })).wait();

    const { router, protocolVault } = await localRouter(owner);
    const locker = await (await ethers.getContractFactory("PermanentV3PositionLocker")).deploy(owner.address);
    await (await locker.configureRevenue(await router.getAddress(), await integration.getAddress())).wait();
    await (await router.setAuthorizedLpLocker(await locker.getAddress(), true)).wait();
    await (await integration.deliver(await locker.getAddress(), minted.tokenId)).wait();
    await (await locker.registerGraduatedPool(campaign.address, creator.address, recipient.address, poolAddr, memeAddr, WETH, 0n)).wait();

    const swapRouter = await ethers.getContractAt(
      ["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)"],
      SWAP_ROUTER02,
    );
    await (await meme.transfer(trader.address, 2_000_000n * E18)).wait();
    await network.provider.send("hardhat_setBalance", [trader.address, "0x" + (10n ** 22n).toString(16)]);
    await (await weth.connect(trader).deposit({ value: 10n * E18 })).wait();
    await (await meme.connect(trader).approve(SWAP_ROUTER02, ethers.MaxUint256)).wait();
    await (await weth.connect(trader).approve(SWAP_ROUTER02, ethers.MaxUint256)).wait();
    for (let i = 0; i < 4; i++) {
      await (await swapRouter.connect(trader).exactInputSingle({ tokenIn: memeAddr, tokenOut: WETH, fee: 3000, recipient: trader.address, amountIn: 500_000n * E18, amountOutMinimum: 0, sqrtPriceLimitX96: 0 })).wait();
      await (await swapRouter.connect(trader).exactInputSingle({ tokenIn: WETH, tokenOut: memeAddr, fee: 3000, recipient: trader.address, amountIn: 1n * E18, amountOutMinimum: 0, sqrtPriceLimitX96: 0 })).wait();
    }
    const pool = await ethers.getContractAt(["function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)"], poolAddr);
    const [sp0] = await pool.slot0();
    const rc = await (await locker.connect(trader).harvest(poolAddr)).wait();
    const [sp1] = await pool.slot0();
    const sold = (await events(locker, rc, "MemeFeesSold"))[0].args;
    const harvested = (await events(locker, rc, "FeesHarvested"))[0].args;
    expect(harvested.token).to.equal(WETH);
    const gas = await saleGas(locker, rc);
    const minSaleGas = await locker.MIN_SALE_GAS();
    expect(gas.sale * 2n).to.be.lte((minSaleGas * 63n) / 64n);
    console.log(`      RH fork gas: sellMemeForPaired frame ${gas.sale}, whole harvest ${gas.harvest}, MIN_SALE_GAS ${minSaleGas}`);
    expect(sold.memeSold).to.be.gt(5_900n * E18);
    expect(sold.memeSold + sold.memeCarried).to.be.gte(5_900n * E18);
    // Price of MEME moved by at most 0.5% in the sale.
    const moveMicro = memeIs0 ? ((sp0 * sp0 - sp1 * sp1) * 1_000_000n) / (sp0 * sp0) : ((sp1 * sp1 - sp0 * sp0) * 1_000_000n) / (sp1 * sp1);
    expect(moveMicro).to.be.lte(5_000n);
    const creatorPaid = await weth.balanceOf(recipient.address);
    const protocolPaid = await weth.balanceOf(await protocolVault.getAddress());
    expect(creatorPaid).to.equal((harvested.collected * 8000n) / 10000n);
    expect(protocolPaid).to.equal(harvested.collected - creatorPaid);
    expect(await meme.balanceOf(recipient.address)).to.equal(0n);
    expect(await meme.balanceOf(await locker.getAddress())).to.equal(sold.memeCarried);
    expect(await weth.balanceOf(await locker.getAddress())).to.equal(0n);
    console.log(`      RH fork: MEME sold ${ethers.formatEther(sold.memeSold)} (carried ${ethers.formatEther(sold.memeCarried)}) -> WETH ${ethers.formatEther(sold.pairedOut)}; creator ${ethers.formatEther(creatorPaid)} / protocol ${ethers.formatEther(protocolPaid)} WETH; price move ${Number(moveMicro) / 10000}%`);
  });
});
