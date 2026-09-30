/**
 * BNB (56) graduation adapters on a fork of BSC mainnet, against real Topaz.
 * Spec: docs/evm-launch/spec/C7-bnb-adapters.md section 8.
 *
 *   BNB_FORK=1 npx hardhat test test/evmgen-bnb-adapters.fork.spec.ts --network hardhat
 *
 * Read-only against the live chain: the fork runs in-process; nothing is sent to BSC.
 * Skipped under the default config (no fork).
 */
import { expect } from "chai";
import { ethers, network } from "hardhat";

const TOPAZ = {
  factory: "0x65E6cD0eF5D3467030103cf3d433034E570b5784",
  router: "0x1E98c8226e7d452e1888e3d3d2F929346321c6c3",
  wbnb: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  implementation: "0xdC942D8e37cC20BCf9aD1Fe0111eE6c5908f3678",
  safe: "0xF407739E81574A3C9A3195bCb85eE694C94e540c",
  usdt: "0x55d398326f99059fF775485246999027B3197955",
  usdtFeed: "0x501e21126486424567f40D490856094D72986E41",
  usdtPool: "0xe030E94879204403dB8eAA73251667551446ae01",
  bnbUsd: "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE",
};

const FORKED = network.name === "hardhat" && Boolean((network.config as any).forking?.url) && network.config.chainId === 56;
const d = FORKED ? describe : describe.skip;

const WAD = 10n ** 18n;
const SUPPLY = 10n ** 27n;

const FACTORY_ABI = [
  "function getPool(address,address,bool) view returns (address)",
  "function createPool(address,address,bool) returns (address)",
  "function isPool(address) view returns (bool)",
  "function implementation() view returns (address)",
  "function getFee(address,bool) view returns (uint256)",
  "function isPaused() view returns (bool)",
  "function setPauseState(bool)",
  "function setCustomFee(address,uint256)",
];
const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function stable() view returns (bool)",
  "function factory() view returns (address)",
  "function getReserves() view returns (uint256,uint256,uint256)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function mint(address) returns (uint256)",
  "function sync()",
  "function skim(address)",
  "function claimFees() returns (uint256,uint256)",
];
const ROUTER_ABI = [
  "function defaultFactory() view returns (address)",
  "function weth() view returns (address)",
  "function getAmountsOut(uint256,(address from,address to,bool stable,address factory)[]) view returns (uint256[])",
  "function swapExactETHForTokens(uint256,(address from,address to,bool stable,address factory)[],address,uint256) payable returns (uint256[])",
  "function swapExactTokensForETH(uint256,uint256,(address from,address to,bool stable,address factory)[],address,uint256) returns (uint256[])",
  "function addLiquidityETH(address,bool,uint256,uint256,uint256,address,uint256) payable returns (uint256,uint256,uint256)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];
const WBNB_ABI = [...ERC20_ABI, "function deposit() payable", "function withdraw(uint256)"];

const gas: Record<string, bigint> = {};

async function impersonate(addr: string) {
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
  await network.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
  return ethers.getSigner(addr);
}

d("evmgen-bnb: BNB Topaz graduation adapters on a BSC mainnet fork", function () {
  this.timeout(600_000);

  let deployer: any;
  let grief: any;
  let native: any;
  let quoteAdapter: any;
  let locker: any;
  let factory: any;
  let topazFactory: any;
  let topazRouter: any;
  let wbnb: any;
  let usdt: any;
  let treasury: any;
  let base: string;
  const N = WAD; // 1 BNB native
  const P = 10n ** 11n;
  const Mt = (N * WAD) / P;
  const Mmax = 2n * Mt;
  const quoteNative = WAD / 100n; // 0.01 BNB into the thin USDT pool

  async function snapshot(): Promise<string> {
    return network.provider.send("evm_snapshot", []);
  }
  async function restore(id: string) {
    await network.provider.send("evm_revert", [id]);
  }

  async function newCampaign(salt: string) {
    const campaign = await (await ethers.getContractFactory("MockEvmGenRhCampaign")).deploy();
    await campaign.init(ethers.id(salt), SUPPLY);
    await factory.setCampaign(await campaign.getAddress(), true);
    await network.provider.send("hardhat_setBalance", [await campaign.getAddress(), "0x56BC75E2D63100000"]);
    return campaign;
  }

  async function graduateNative(campaign: any, value = N) {
    const tx = await campaign.graduate(await native.getAddress(), ethers.ZeroAddress, Mt, Mmax, P, value);
    const rec = await tx.wait();
    return { res: await campaign.lastResult(), gasUsed: rec!.gasUsed as bigint };
  }

  async function graduateQuote(campaign: any, value = quoteNative) {
    const tx = await campaign.graduate(await quoteAdapter.getAddress(), TOPAZ.usdt, Mt, Mmax, 1n, value);
    const rec = await tx.wait();
    return { res: await campaign.lastResult(), gasUsed: rec!.gasUsed as bigint };
  }

  async function register(campaign: any, res: any, paired: string) {
    await locker.registerGraduatedPool(
      await campaign.getAddress(),
      deployer.address,
      deployer.address,
      res.pool,
      await campaign.token(),
      paired,
      res.liquidity,
    );
  }

  async function fundPaired(paired: string, amount: bigint) {
    if (paired.toLowerCase() === TOPAZ.wbnb.toLowerCase()) {
      await wbnb.deposit({ value: amount });
      return;
    }
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 3600n;
    await topazRouter.swapExactETHForTokens(
      0,
      [{ from: TOPAZ.wbnb, to: paired, stable: false, factory: TOPAZ.factory }],
      deployer.address,
      deadline,
      { value: amount },
    );
  }

  async function postGradRoundtrip(res: any, token: string, paired: string) {
    const meme = await ethers.getContractAt(["function tradingEnabled() view returns (bool)", ...ERC20_ABI], token);
    expect(await meme.tradingEnabled()).to.equal(true);
    const pool = await ethers.getContractAt(
      [
        ...POOL_ABI,
        "function getAmountOut(uint256,address) view returns (uint256)",
        "function swap(uint256,uint256,address,bytes)",
      ],
      res.pool,
    );
    const [r0, r1] = await pool.getReserves();
    expect(r0).to.be.gt(0n);
    expect(r1).to.be.gt(0n);
    const token0 = await pool.token0();
    const pairedIs0 = token0.toLowerCase() === paired.toLowerCase();
    const pairedReserve = pairedIs0 ? r0 : r1;
    const buyIn = pairedReserve / 1000n;
    const buyInClamped = buyIn === 0n ? 1n : buyIn > WAD / 100n ? WAD / 100n : buyIn;

    await fundPaired(paired, buyInClamped);
    const pairedTok = await ethers.getContractAt(ERC20_ABI, paired);
    const have = await pairedTok.balanceOf(deployer.address);
    const use = have < buyInClamped ? have : buyInClamped;
    expect(use).to.be.gt(0n);
    const memeOut = await pool.getAmountOut(use, paired);
    expect(memeOut).to.be.gt(0n);
    await pairedTok.transfer(res.pool, use);
    const memeIs0 = token0.toLowerCase() === token.toLowerCase();
    await pool.swap(memeIs0 ? memeOut : 0n, memeIs0 ? 0n : memeOut, deployer.address, "0x");
    const held = await meme.balanceOf(deployer.address);
    expect(held).to.be.gt(0n);

    const sellOut = await pool.getAmountOut(held, token);
    await meme.transfer(res.pool, held);
    await pool.swap(memeIs0 ? 0n : sellOut, memeIs0 ? sellOut : 0n, deployer.address, "0x");
  }

  async function harvestSplit(res: any, paired: string) {
    const pool = await ethers.getContractAt(POOL_ABI, res.pool);
    const lpBefore = await pool.balanceOf(await locker.getAddress());
    // Generate a fee by trading, then harvest. Thin smoke: if claimable is 0 the split is 0/0.
    const creatorBefore = await (await ethers.getContractAt(ERC20_ABI, paired)).balanceOf(deployer.address);
    const protoBefore = await (await ethers.getContractAt(ERC20_ABI, paired)).balanceOf(await treasury.getAddress());
    await locker.harvest(res.pool);
    const creatorAfter = await (await ethers.getContractAt(ERC20_ABI, paired)).balanceOf(deployer.address);
    const protoAfter = await (await ethers.getContractAt(ERC20_ABI, paired)).balanceOf(await treasury.getAddress());
    const creatorGain = creatorAfter - creatorBefore;
    const protoGain = protoAfter - protoBefore;
    const total = creatorGain + protoGain;
    if (total > 0n) {
      const expectedCreator = (total * 8000n) / 10000n;
      const delta = creatorGain > expectedCreator ? creatorGain - expectedCreator : expectedCreator - creatorGain;
      expect(delta).to.be.lte(10_000n);
    }
    expect(await pool.balanceOf(await locker.getAddress())).to.equal(lpBefore);
  }

  before(async () => {
    [deployer, grief] = await ethers.getSigners();
    await network.provider.send("evm_mine", []);

    topazFactory = await ethers.getContractAt(FACTORY_ABI, TOPAZ.factory);
    topazRouter = await ethers.getContractAt(ROUTER_ABI, TOPAZ.router);
    wbnb = await ethers.getContractAt(WBNB_ABI, TOPAZ.wbnb);
    usdt = await ethers.getContractAt(ERC20_ABI, TOPAZ.usdt);

    expect(await topazFactory.implementation()).to.equal(ethers.getAddress(TOPAZ.implementation));
    expect(await topazFactory.getFee(ethers.ZeroAddress, false)).to.equal(30n);
    expect(await topazRouter.defaultFactory()).to.equal(ethers.getAddress(TOPAZ.factory));
    expect(await topazRouter.weth()).to.equal(ethers.getAddress(TOPAZ.wbnb));

    treasury = await (await ethers.getContractFactory("MockPhase1TreasuryRouter")).deploy();
    locker = await (await ethers.getContractFactory("PermanentLpLocker")).deploy(deployer.address);
    await locker.configureRevenue(await treasury.getAddress(), TOPAZ.factory);
    factory = await (await ethers.getContractFactory("MockEvmGenRhFactory")).deploy(await locker.getAddress());

    native = await (await ethers.getContractFactory("BnbNativeGraduationAdapter")).deploy(TOPAZ.factory, TOPAZ.wbnb, await locker.getAddress());
    quoteAdapter = await (await ethers.getContractFactory("BnbQuoteGraduationAdapter")).deploy(TOPAZ.router, await locker.getAddress(), TOPAZ.bnbUsd, 86_400);
    await native.setCampaignFactoryOnce(await factory.getAddress());
    await quoteAdapter.setCampaignFactoryOnce(await factory.getAddress());
    await quoteAdapter.configureQuoteRoute(TOPAZ.usdt, {
      oracleFeed: TOPAZ.usdtFeed,
      acquisitionPool: TOPAZ.usdtPool,
      minimumRouteLiquidityUsdWad: WAD, // real USDT pool is ~$1.2k, below the $50k floor
      maxSwapSlippageBps: 3000,
      maxOracleDeviationBps: 5000,
      maxPriceImpactBps: 5000,
      maxGraduationPriceDeviationBps: 5000,
      enabled: true,
    });

    base = await snapshot();
  });

  beforeEach(async () => {
    await restore(base);
    base = await snapshot();
  });

  after(() => {
    console.log("\n      graduation gas (campaign.graduate tx gasUsed):");
    for (const [k, v] of Object.entries(gas)) console.log(`        ${k}: ${v}`);
  });

  it("1. no pool (baseline), native and quote: locker registers, buy/sell, harvest 80/20", async function () {
    const cN = await newCampaign("base-native");
    const n = await graduateNative(cN);
    gas["native baseline"] = n.gasUsed;
    expect(n.res.repaired).to.equal(false);
    expect(n.res.pairedUsed).to.equal(N);
    expect(n.res.memeUsed).to.be.gte(Mt);
    expect(n.res.memeUsed).to.be.lte(Mmax);
    expect(n.res.startPriceWad).to.be.gte(P);
    expect(await wbnb.balanceOf(await native.getAddress())).to.equal(0n);
    await register(cN, n.res, TOPAZ.wbnb);
    await postGradRoundtrip(n.res, await cN.token(), TOPAZ.wbnb);
    await harvestSplit(n.res, TOPAZ.wbnb);

    const cQ = await newCampaign("base-quote");
    const q = await graduateQuote(cQ);
    gas["quote baseline"] = q.gasUsed;
    expect(q.res.repaired).to.equal(false);
    expect(q.res.pairedUsed).to.be.gt(0n);
    expect(q.res.memeUsed).to.be.gte(Mt);
    await register(cQ, q.res, TOPAZ.usdt);
    await postGradRoundtrip(q.res, await cQ.token(), TOPAZ.usdt);
    await harvestSplit(q.res, TOPAZ.usdt);
  });

  it("2. griefer createPool only, native and quote", async function () {
    const cN = await newCampaign("grief-create-native");
    await topazFactory.createPool(await cN.token(), TOPAZ.wbnb, false);
    const n = await graduateNative(cN);
    expect(n.res.repaired).to.equal(true);
    expect(n.res.donationFound).to.equal(0n);
    await register(cN, n.res, TOPAZ.wbnb);

    const cQ = await newCampaign("grief-create-quote");
    await topazFactory.createPool(await cQ.token(), TOPAZ.usdt, false);
    const q = await graduateQuote(cQ);
    expect(q.res.repaired).to.equal(true);
    await register(cQ, q.res, TOPAZ.usdt);
  });

  it("3. createPool + donation, no sync", async function () {
    const cN = await newCampaign("grief-unsynced-native");
    await topazFactory.createPool(await cN.token(), TOPAZ.wbnb, false);
    const pool = await topazFactory.getPool(await cN.token(), TOPAZ.wbnb, false);
    await wbnb.deposit({ value: 10n ** 15n });
    await wbnb.transfer(pool, 10n ** 15n);
    const n = await graduateNative(cN);
    expect(n.res.donationFound).to.equal(10n ** 15n);
    expect(n.res.startPriceWad).to.be.gte(P);
    await register(cN, n.res, TOPAZ.wbnb);

    const cQ = await newCampaign("grief-unsynced-quote");
    await topazFactory.createPool(await cQ.token(), TOPAZ.usdt, false);
    const qPool = await topazFactory.getPool(await cQ.token(), TOPAZ.usdt, false);
    // Pull a little USDT via the real acquisition pool so we can donate it.
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 3600n;
    await topazRouter.swapExactETHForTokens(
      0,
      [{ from: TOPAZ.wbnb, to: TOPAZ.usdt, stable: false, factory: TOPAZ.factory }],
      deployer.address,
      deadline,
      { value: WAD / 1000n },
    );
    const donated = (await usdt.balanceOf(deployer.address)) / 2n;
    if (donated > 0n) await usdt.transfer(qPool, donated);
    const q = await graduateQuote(cQ);
    expect(q.res.donationFound).to.equal(donated);
    await register(cQ, q.res, TOPAZ.usdt);
  });

  it("4. createPool + donation + sync (reserves (0, X)): today's code reverts; the adapter succeeds", async function () {
    const cN = await newCampaign("grief-synced-native");
    await topazFactory.createPool(await cN.token(), TOPAZ.wbnb, false);
    const pool = await topazFactory.getPool(await cN.token(), TOPAZ.wbnb, false);
    await wbnb.deposit({ value: 1n });
    await wbnb.transfer(pool, 1n);
    await (await ethers.getContractAt(POOL_ABI, pool)).sync();
    const n = await graduateNative(cN);
    gas["native synced-donation"] = n.gasUsed;
    expect(n.res.repaired).to.equal(true);
    expect(n.res.donationFound).to.equal(1n);
    expect(n.res.pairedUsed).to.equal(N);
    await register(cN, n.res, TOPAZ.wbnb);
    await postGradRoundtrip(n.res, await cN.token(), TOPAZ.wbnb);

    const cQ = await newCampaign("grief-synced-quote");
    await topazFactory.createPool(await cQ.token(), TOPAZ.usdt, false);
    const qPool = await topazFactory.getPool(await cQ.token(), TOPAZ.usdt, false);
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 3600n;
    await topazRouter.swapExactETHForTokens(
      0,
      [{ from: TOPAZ.wbnb, to: TOPAZ.usdt, stable: false, factory: TOPAZ.factory }],
      deployer.address,
      deadline,
      { value: WAD / 1000n },
    );
    const donated = await usdt.balanceOf(deployer.address);
    if (donated > 0n) await usdt.transfer(qPool, donated);
    await (await ethers.getContractAt(POOL_ABI, qPool)).sync();
    const q = await graduateQuote(cQ);
    gas["quote synced-donation"] = q.gasUsed;
    expect(q.res.repaired).to.equal(true);
    await register(cQ, q.res, TOPAZ.usdt);
  });

  it("5. donation large enough to hit Mmax: price above target, never below", async function () {
    const cN = await newCampaign("cap-native");
    await topazFactory.createPool(await cN.token(), TOPAZ.wbnb, false);
    const pool = await topazFactory.getPool(await cN.token(), TOPAZ.wbnb, false);
    // bx > N*(Mmax-Mt)/Mt = N when Mmax = 2 Mt, so donate 2 N
    await wbnb.deposit({ value: N * 3n });
    await wbnb.transfer(pool, N * 3n);
    await (await ethers.getContractAt(POOL_ABI, pool)).sync();
    const tightMax = Mt; // cap binds immediately with any donation
    const tx = await cN.graduate(await native.getAddress(), ethers.ZeroAddress, Mt, tightMax, P, N);
    await tx.wait();
    const res = await cN.lastResult();
    expect(res.memeUsed).to.equal(tightMax);
    expect(res.startPriceWad).to.be.gt(P);
    await register(cN, res, TOPAZ.wbnb);
  });

  it("6. front-run skim between donation and graduation", async function () {
    const cN = await newCampaign("skim-native");
    await topazFactory.createPool(await cN.token(), TOPAZ.wbnb, false);
    const pool = await topazFactory.getPool(await cN.token(), TOPAZ.wbnb, false);
    await wbnb.deposit({ value: 10n ** 16n });
    await wbnb.transfer(pool, 10n ** 16n);
    // Topaz skim transfers both tokens. The MEME side is 0, but LaunchToken still
    // reverts TradingNotEnabled on a zero transfer from the pool (from != campaign).
    // A griefer therefore cannot skim the donation before graduation; it stays and is absorbed.
    const P = await ethers.getContractAt(POOL_ABI, pool);
    await expect(P.skim(grief.address)).to.be.revertedWithCustomError(
      await ethers.getContractAt("LaunchToken", await cN.token()),
      "TradingNotEnabled",
    );
    const n = await graduateNative(cN);
    expect(n.res.donationFound).to.equal(10n ** 16n);
    expect(n.res.memeUsed).to.be.gte(Mt);
    await register(cN, n.res, TOPAZ.wbnb);
  });

  it("7. griefer cannot get MEME into the pool: transfer, transferFrom, router addLiquidity, contract buy", async function () {
    const cN = await newCampaign("i1-native");
    const token = await ethers.getContractAt("LaunchToken", await cN.token());
    await cN.giveMeme(grief.address, WAD);
    const griefBot = await (await ethers.getContractFactory("MockEvmGenBnbGrief")).deploy();
    await cN.giveMeme(await griefBot.getAddress(), WAD);
    await topazFactory.createPool(await token.getAddress(), TOPAZ.wbnb, false);
    const pool = await topazFactory.getPool(await token.getAddress(), TOPAZ.wbnb, false);

    await expect(token.connect(grief).transfer(pool, WAD)).to.be.revertedWithCustomError(token, "TradingNotEnabled");
    await token.connect(grief).approve(await griefBot.getAddress(), WAD);
    await expect(griefBot.tryApproveAndTransferFrom(await token.getAddress(), grief.address, pool, WAD)).to.be.revertedWithCustomError(token, "TradingNotEnabled");
    await expect(griefBot.tryTransfer(await token.getAddress(), pool, WAD)).to.be.revertedWithCustomError(token, "TradingNotEnabled");

    await token.connect(grief).approve(TOPAZ.router, WAD);
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 3600n;
    await expect(
      topazRouter.connect(grief).addLiquidityETH(await token.getAddress(), false, WAD, 0, 0, grief.address, deadline, { value: WAD / 1000n }),
    ).to.be.reverted;

    expect(await token.balanceOf(pool)).to.equal(0n);
  });

  it("8. factory paused: native mint still works; quote acquisition reverts until unpause", async function () {
    const safe = await impersonate(TOPAZ.safe);
    const factoryAsSafe = topazFactory.connect(safe);
    await (await factoryAsSafe.setPauseState(true)).wait();

    const cN = await newCampaign("pause-native");
    const n = await graduateNative(cN);
    expect(n.res.pool).to.not.equal(ethers.ZeroAddress);
    await register(cN, n.res, TOPAZ.wbnb);

    const cQ = await newCampaign("pause-quote");
    await expect(graduateQuote(cQ)).to.be.reverted;

    await (await factoryAsSafe.setPauseState(false)).wait();
    const q = await graduateQuote(cQ);
    expect(q.res.pool).to.not.equal(ethers.ZeroAddress);
    await register(cQ, q.res, TOPAZ.usdt);
  });

  it("9. setCustomFee(pool, 25) before graduation: adapter succeeds, locker records the actual fee (E13)", async function () {
    const cN = await newCampaign("custom-fee");
    await topazFactory.createPool(await cN.token(), TOPAZ.wbnb, false);
    const pool = await topazFactory.getPool(await cN.token(), TOPAZ.wbnb, false);
    const safe = await impersonate(TOPAZ.safe);
    await (await topazFactory.connect(safe).setCustomFee(pool, 25)).wait();
    expect(await topazFactory.getFee(pool, false)).to.equal(25n);

    const n = await graduateNative(cN);
    expect(n.res.pool).to.equal(ethers.getAddress(pool));
    await register(cN, n.res, TOPAZ.wbnb);
    const info = await locker.poolInfo(pool);
    expect(info.registered).to.equal(true);
    expect(info.poolFeeBps).to.equal(25n);
  });

  it("11. gas: create+mint vs today's router addLiquidityETH on a clean pair, same fork block", async function () {
    const throwaway = await (await ethers.getContractFactory("MockERC20")).deploy("Throw", "THR", 10n ** 27n, deployer.address);
    await throwaway.approve(TOPAZ.router, Mt);
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 3600n;
    const tx = await topazRouter.addLiquidityETH(
      await throwaway.getAddress(),
      false,
      Mt,
      0,
      0,
      deployer.address,
      deadline,
      { value: N },
    );
    const rec = await tx.wait();
    gas["today router addLiquidityETH"] = rec!.gasUsed as bigint;
    expect(gas["native baseline"]).to.be.gt(0n);
    expect(gas["native synced-donation"]).to.be.gt(0n);
  });
});
