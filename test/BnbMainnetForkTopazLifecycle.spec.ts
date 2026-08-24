import { expect } from "chai";
import { ethers, network } from "hardhat";

const PROD_FACTORY = "0x3068eAE6F8431bFc3c5Faae9c3bBB95F007be59a";
const PROD_LOCKER = "0x64710A4f87aBa3b5ED5B8B25e8ebA4DaC339C998";
const CAMPAIGN_IMPL = "0xbe3caF640F77e8436BCAF89730251A00fB01608f";
const ADAPTER = "0x5c3135Dfaad519A9114DEa2E546f0Cd051d0D35a";
const TOPAZ_ROUTER = "0x1E98c8226e7d452e1888e3d3d2F929346321c6c3";
const TOPAZ_FACTORY = "0x65E6cD0eF5D3467030103cf3d433034E570b5784";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const ORACLE = "0x9D204406d5ECA0f18e48427fDD983A32FdF57C9B";
const TREASURY = "0xe157a6FDf19CAB61f2ECa048966f137A3240a921";
const CREATOR_SHARE_BPS = 8000n;
const BPS = 10000n;

const EXEC_ROUTER_ABI = [
  "function defaultFactory() view returns (address)",
  "function weth() view returns (address)",
  "function getAmountsOut(uint256 amountIn,(address from,address dest,bool stable,address factory)[] routes) view returns (uint256[] amounts)",
  "function swapExactETHForTokens(uint256 amountOutMin,(address from,address dest,bool stable,address factory)[] routes,address recipient,uint256 deadline) payable returns (uint256[] amounts)",
  "function swapExactTokensForETH(uint256 amountIn,uint256 amountOutMin,(address from,address dest,bool stable,address factory)[] routes,address recipient,uint256 deadline) returns (uint256[] amounts)",
];

const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function stable() view returns (bool)",
  "function factory() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function claimable0(address) view returns (uint256)",
  "function claimable1(address) view returns (uint256)",
  "function claimFees() external returns (uint256,uint256)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
];

function forkEnabled() {
  return ["1", "true", "yes", "on"].includes(String(process.env.BNB_FORK || "").trim().toLowerCase());
}

async function impersonatedSend(from: string, to: string, data: string) {
  const methods = ["anvil_impersonateAccount", "hardhat_impersonateAccount"];
  let impersonated = false;
  for (const method of methods) {
    try {
      await network.provider.request({ method, params: [from] });
      impersonated = true;
      break;
    } catch {
      /* try next */
    }
  }
  if (!impersonated) throw new Error(`unable to impersonate ${from}`);
  try {
    await network.provider.send("anvil_setBalance", [from, "0x56BC75E2D63100000"]);
  } catch {
    await network.provider.send("hardhat_setBalance", [from, "0x56BC75E2D63100000"]);
  }
  const rpc = new ethers.JsonRpcProvider((network.config as any).url || "http://127.0.0.1:8545", 56);
  const hash = await rpc.send("eth_sendTransaction", [{ from, to, data, gas: "0x7a120" }]);
  await rpc.waitForTransaction(hash);
  return hash;
}

/**
 * BNB mainnet integration fork certification.
 *
 * Proves LaunchCampaign → real Topaz → locker → harvest on a chain-56 fork.
 * Does NOT certify production CREATE/security. Those already passed on live mainnet.
 *
 * Run:
 *   anvil --fork-url <archive-or-blastapi> --chain-id 56 --accounts 2 --port 8545
 *   BNB_FORK=1 npx hardhat test test/BnbMainnetForkTopazLifecycle.spec.ts --network bscMainnetFork
 */
describe("BNB mainnet fork: corrected locker vs real Topaz", function () {
  it("create → bond → graduate into 30-bps Topaz → 80/20 harvest → LP principal unchanged", async function () {
    if (!forkEnabled()) this.skip();
    this.timeout(600_000);

    expect(Number((await ethers.provider.getNetwork()).chainId)).to.equal(56);

    const adapter = new ethers.Contract(
      ADAPTER,
      ["function topazRouter() view returns (address)", "function poolFactory() view returns (address)", "function WETH() view returns (address)"],
      ethers.provider,
    );
    expect(await adapter.topazRouter()).to.equal(TOPAZ_ROUTER);
    expect(await adapter.poolFactory()).to.equal(TOPAZ_FACTORY);
    expect(await adapter.WETH()).to.equal(WBNB);

    const topazFactory = new ethers.Contract(TOPAZ_FACTORY, ["function getFee(address,bool) view returns (uint256)"], ethers.provider);
    expect(await topazFactory.getFee(ethers.ZeroAddress, false)).to.equal(30n);

    const prodLocker = new ethers.Contract(
      PROD_LOCKER,
      ["function REQUIRED_POOL_FEE_BPS() view returns (uint16)", "function CREATOR_FEE_BPS() view returns (uint16)", "function PROTOCOL_FEE_BPS() view returns (uint16)"],
      ethers.provider,
    );
    expect(await prodLocker.REQUIRED_POOL_FEE_BPS()).to.equal(30n);
    expect(await prodLocker.CREATOR_FEE_BPS()).to.equal(6667n);
    expect(await prodLocker.PROTOCOL_FEE_BPS()).to.equal(3333n);

    const [deployer] = await ethers.getSigners();
    await network.provider.send("hardhat_setBalance", [await deployer.getAddress(), "0x56BC75E2D63100000"]);

    const Factory = await ethers.getContractFactory("LaunchFactory");
    const factory = await Factory.deploy(ADAPTER, TREASURY, CAMPAIGN_IMPL, ORACLE);
    await factory.waitForDeployment();
    const lockerAddr = await factory.permanentLpLocker();
    const locker = await ethers.getContractAt("PermanentLpLocker", lockerAddr);

    expect(await factory.campaignImplementation()).to.equal(CAMPAIGN_IMPL);
    expect(await factory.router()).to.equal(ADAPTER);
    expect(await locker.REQUIRED_POOL_FEE_BPS()).to.equal(30n);
    expect(await locker.CREATOR_FEE_BPS()).to.equal(8000n);
    expect(await locker.PROTOCOL_FEE_BPS()).to.equal(2000n);
    expect(lockerAddr.toLowerCase()).to.not.equal(PROD_LOCKER.toLowerCase());
    expect((await factory.getAddress()).toLowerCase()).to.not.equal(PROD_FACTORY.toLowerCase());

    const cfg = await factory.config();
    await factory.setConfig({
      totalSupply: cfg.totalSupply,
      curveBps: cfg.curveBps,
      liquidityTokenBps: cfg.liquidityTokenBps,
      basePrice: cfg.basePrice,
      priceSlope: cfg.priceSlope,
      graduationTarget: ethers.parseEther("15000"),
      liquidityBps: cfg.liquidityBps,
    });
    // FORK HARNESS ONLY. Isolates LaunchCampaign → Topaz → locker → harvest.
    // The final mainnet factory MUST keep production security:
    // requireRouteAuthorization=true, requireAuthorizedTrading=true, securityDefaultsLocked=true.
    // This disable is not evidence for shipping an unlocked factory.
    await factory.setRequireRouteAuthorization(false);
    await factory.setRequireAuthorizedTrading(false);
    await factory.enableLive();

    const treasury = new ethers.Contract(
      TREASURY,
      [
        "function admin() view returns (address)",
        "function protocolRevenueVault() view returns (address)",
        "function permanentLpLocker() view returns (address)",
        "function setAuthorizedLpLocker(address locker, bool allowed)",
      ],
      ethers.provider,
    );
    const authorizeData = treasury.interface.encodeFunctionData("setAuthorizedLpLocker", [lockerAddr, true]);
    await impersonatedSend(await treasury.admin(), TREASURY, authorizeData);
    expect(await treasury.permanentLpLocker()).to.equal(PROD_LOCKER);

    const createTx = await factory.createCampaign({
      name: "ForkSmoke",
      symbol: "FSK",
      logoURI: "ipfs://fork-smoke",
      xAccount: "",
      website: "",
      extraLink: "",
      graduationTarget: ethers.parseEther("15000"),
    });
    await createTx.wait();
    const created = await factory.getCampaign(0n);
    const campaign = await ethers.getContractAt("LaunchCampaign", created.campaign);
    const token = await ethers.getContractAt("LaunchToken", created.token);

    const target = await campaign.graduationNativeTarget();
    expect(target).to.be.gt(ethers.parseEther("1"));
    let remaining = target - (await campaign.netRaisedWei()) + ethers.parseEther("0.05");
    while (!(await campaign.launched()) && remaining > 0n) {
      const chunk = remaining > ethers.parseEther("5") ? ethers.parseEther("5") : remaining;
      const quote = await campaign.quoteBuyExactBnb(chunk);
      if (quote.tokensOut === 0n) break;
      await campaign.buyExactBnb(0n, { value: chunk });
      remaining = (await campaign.launched()) ? 0n : target - (await campaign.netRaisedWei()) + ethers.parseEther("0.02");
    }
    if (!(await campaign.launched())) {
      await campaign.graduateIfEligible(0n, 0n);
    }
    expect(await campaign.launched()).to.equal(true);

    const state = await campaign.getGraduationState();
    const poolAddr = state.dexPair ?? state[0];
    expect(poolAddr).to.not.equal(ethers.ZeroAddress);
    const pool = new ethers.Contract(poolAddr, POOL_ABI, ethers.provider);
    expect(await pool.stable()).to.equal(false);
    expect(await pool.factory()).to.equal(TOPAZ_FACTORY);
    expect(await topazFactory.getFee(poolAddr, false)).to.equal(30n);
    const token0 = await pool.token0();
    const token1 = await pool.token1();
    const hasWbnb = token0.toLowerCase() === WBNB.toLowerCase() || token1.toLowerCase() === WBNB.toLowerCase();
    const hasToken = token0.toLowerCase() === created.token.toLowerCase() || token1.toLowerCase() === created.token.toLowerCase();
    expect(hasWbnb).to.equal(true);
    expect(hasToken).to.equal(true);

    const lpLocked = await pool.balanceOf(lockerAddr);
    expect(lpLocked).to.equal(await locker.lockedBalance(poolAddr));
    expect(lpLocked).to.equal(state.graduatedLiquidityLp ?? state[5]);
    expect(lpLocked).to.be.gt(0n);
    const info = await locker.poolInfo(poolAddr);
    expect(info.registered).to.equal(true);
    expect(info.creatorFeeBps).to.equal(8000n);
    expect(info.protocolFeeBps).to.equal(2000n);

    await expect(campaign.buyExactBnb(0n, { value: 1n })).to.be.revertedWithCustomError(campaign, "Finalized");

    const buyer = deployer;
    const router = new ethers.Contract(TOPAZ_ROUTER, EXEC_ROUTER_ABI, buyer);
    const buyRoute = [{ from: WBNB, dest: created.token, stable: false, factory: TOPAZ_FACTORY }];
    const sellRoute = [{ from: created.token, dest: WBNB, stable: false, factory: TOPAZ_FACTORY }];
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 3600n;
    const buyIn = ethers.parseEther("0.02");
    const buyOut = await router.getAmountsOut(buyIn, buyRoute);
    const swapGas = { gasLimit: 3_000_000n };
    const buyTx = await router.swapExactETHForTokens((buyOut[buyOut.length - 1] * 90n) / 100n, buyRoute, await buyer.getAddress(), deadline, {
      value: buyIn,
      ...swapGas,
    });
    expect((buyTx.to || "").toLowerCase()).to.equal(TOPAZ_ROUTER.toLowerCase());
    await buyTx.wait();

    const tokenContract = new ethers.Contract(created.token, ERC20_ABI, buyer);
    const tokenBal = BigInt(await tokenContract.balanceOf(await buyer.getAddress()));
    const sellAmt = tokenBal / 5n;
    expect(sellAmt).to.be.gt(0n);
    const approveTx = await tokenContract.approve(TOPAZ_ROUTER, ethers.MaxUint256);
    await approveTx.wait();
    const sellOut = await router.getAmountsOut(sellAmt, sellRoute);
    const minOut = (sellOut[sellOut.length - 1] * 90n) / 100n;
    let sellTx;
    try {
      sellTx = await router.swapExactTokensForETH(sellAmt, minOut, sellRoute, await buyer.getAddress(), deadline, swapGas);
      await sellTx.wait();
    } catch (firstSellError) {
      const feeRouter = new ethers.Contract(
        TOPAZ_ROUTER,
        [
          "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn,uint256 amountOutMin,(address from,address dest,bool stable,address factory)[] routes,address recipient,uint256 deadline)",
        ],
        buyer,
      );
      try {
        sellTx = await feeRouter.swapExactTokensForETHSupportingFeeOnTransferTokens(
          sellAmt,
          minOut,
          sellRoute,
          await buyer.getAddress(),
          deadline,
          swapGas,
        );
        await sellTx.wait();
      } catch (secondSellError) {
        console.log("sellAmt", sellAmt.toString(), "allowance", (await tokenContract.allowance(await buyer.getAddress(), TOPAZ_ROUTER)).toString());
        console.log("first", (firstSellError as any)?.shortMessage || firstSellError);
        console.log("second", (secondSellError as any)?.shortMessage || secondSellError);
        throw secondSellError;
      }
    }
    expect((sellTx!.to || "").toLowerCase()).to.equal(TOPAZ_ROUTER.toLowerCase());

    let claimable0 = 0n;
    let claimable1 = 0n;
    try {
      claimable0 = await pool.claimable0(lockerAddr);
      claimable1 = await pool.claimable1(lockerAddr);
    } catch {
      claimable0 = 0n;
      claimable1 = 0n;
    }
    if (claimable0 + claimable1 === 0n) {
      const extra = await router.swapExactETHForTokens(1n, buyRoute, await buyer.getAddress(), deadline + 100n, {
        value: ethers.parseEther("0.05"),
        ...swapGas,
      });
      await extra.wait();
      try {
        claimable0 = await pool.claimable0(lockerAddr);
        claimable1 = await pool.claimable1(lockerAddr);
      } catch {
        /* harvest still exercises claimFees */
      }
    }

    const wbnb = new ethers.Contract(WBNB, ERC20_ABI, ethers.provider);
    const protocolVault = await treasury.protocolRevenueVault();
    const creator = created.creator;
    const tokenIs0 = token0.toLowerCase() === created.token.toLowerCase();
    const claimedToken = tokenIs0 ? claimable0 : claimable1;
    const claimedWbnb = tokenIs0 ? claimable1 : claimable0;
    const creatorTokenBefore = BigInt(await token.balanceOf(creator));
    const creatorWbnbBefore = BigInt(await wbnb.balanceOf(creator));
    const protocolTokenBefore = BigInt(await token.balanceOf(protocolVault));
    const protocolWbnbBefore = BigInt(await wbnb.balanceOf(protocolVault));
    const lpBeforeHarvest = await pool.balanceOf(lockerAddr);

    await locker.harvest(poolAddr, { gasLimit: 3_000_000n });

    const lpAfterHarvest = await pool.balanceOf(lockerAddr);
    expect(lpAfterHarvest).to.equal(lpBeforeHarvest);
    expect(await locker.lockedBalance(poolAddr)).to.equal(lpBeforeHarvest);

    if (claimedToken + claimedWbnb > 0n) {
      const creatorTokenReceived = BigInt(await token.balanceOf(creator)) - creatorTokenBefore;
      const creatorWbnbReceived = BigInt(await wbnb.balanceOf(creator)) - creatorWbnbBefore;
      const protocolTokenReceived = BigInt(await token.balanceOf(protocolVault)) - protocolTokenBefore;
      const protocolWbnbReceived = BigInt(await wbnb.balanceOf(protocolVault)) - protocolWbnbBefore;
      expect(creatorTokenReceived).to.equal((claimedToken * CREATOR_SHARE_BPS) / BPS);
      expect(protocolTokenReceived).to.equal(claimedToken - creatorTokenReceived);
      expect(creatorWbnbReceived).to.equal((claimedWbnb * CREATOR_SHARE_BPS) / BPS);
      expect(protocolWbnbReceived).to.equal(claimedWbnb - creatorWbnbReceived);
    } else {
      const creatorTokenReceived = BigInt(await token.balanceOf(creator)) - creatorTokenBefore;
      const creatorWbnbReceived = BigInt(await wbnb.balanceOf(creator)) - creatorWbnbBefore;
      const protocolTokenReceived = BigInt(await token.balanceOf(protocolVault)) - protocolTokenBefore;
      const protocolWbnbReceived = BigInt(await wbnb.balanceOf(protocolVault)) - protocolWbnbBefore;
      const total =
        creatorTokenReceived + creatorWbnbReceived + protocolTokenReceived + protocolWbnbReceived;
      expect(total).to.be.gt(0n);
      if (creatorTokenReceived + protocolTokenReceived > 0n) {
        expect(creatorTokenReceived).to.equal(((creatorTokenReceived + protocolTokenReceived) * CREATOR_SHARE_BPS) / BPS);
      }
      if (creatorWbnbReceived + protocolWbnbReceived > 0n) {
        expect(creatorWbnbReceived).to.equal(((creatorWbnbReceived + protocolWbnbReceived) * CREATOR_SHARE_BPS) / BPS);
      }
    }
  });
});
