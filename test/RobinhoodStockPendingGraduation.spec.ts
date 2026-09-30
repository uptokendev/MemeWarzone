import { expect } from "chai";
import { ethers } from "hardhat";
import { deployEvmGen, E, mineAt, buyNative, buyTokens, sellTokens } from "./fixtures/evmgenCore";

/**
 * Stock campaigns on the EVM launch generation (C5): the crossing buy only marks Pending and freezes
 * the curve; nothing graduates until someone calls graduate(). The campaign is driven through the
 * stand-in factory (MockLaunchFactoryEvmGen) so the stock binding can be attached the way the real
 * factory does it -- inside create, before any buy -- and then tried again after bonding started.
 */
async function deployStockCampaign(graduationTargetUsd = E(30_000)) {
  const env = await deployEvmGen();
  const mockFactory = await (await ethers.getContractFactory("MockLaunchFactoryEvmGen")).deploy();
  await mockFactory.setRouteAuthority(env.authority.address);
  const router = await (await ethers.getContractFactory("MockTreasuryRouterEvmGen")).deploy();
  const impl = await (await ethers.getContractFactory("RobinhoodStockLaunchCampaign")).deploy();
  const stockAdapter = await (await ethers.getContractFactory("MockGraduationAdapterEvmGen")).deploy(
    await env.topazFactory.getAddress(),
    await env.wbnb.getAddress(),
  );
  const stock = await (await ethers.getContractFactory("MockERC20")).deploy("NVIDIA Stock Token", "NVDA", E(1000), env.owner.address);
  const params = {
    name: "Stock Pending",
    symbol: "SPEND",
    logoURI: "ipfs://stock-pending",
    totalSupply: E(1_000_000_000),
    curveBps: 7000,
    liquidityTokenBps: 2800,
    basePrice: 1_000_000_000n,
    priceSlope: 850n,
    graduationTarget: graduationTargetUsd,
    graduationOracle: await env.oracle.getAddress(),
    protocolFeeBps: 200,
    graduationAdapter: await env.adapter.getAddress(),
    feeRecipient: await router.getAddress(),
    creator: env.creator.address,
    factory: ethers.ZeroAddress,
    riskRegistry: ethers.ZeroAddress,
    tokenDeployer: await env.tokenDeployer.getAddress(),
    creatorBuyCapWei: 0n,
    requireAuthorizedTrading: true,
    tradeRouteProfile: 1,
    finalizeRouteProfile: 1,
  };
  const addr = await mockFactory.create.staticCall(await impl.getAddress(), params);
  await mockFactory.create(await impl.getAddress(), params);
  const campaign = await ethers.getContractAt("RobinhoodStockLaunchCampaign", addr);
  const token = await ethers.getContractAt("LaunchToken", await campaign.token());
  return { env, mockFactory, router, campaign, token, stockAdapter, stock };
}

describe("Robinhood Stock pending graduation lifecycle", function () {
  it("commits the threshold-crossing buy and freezes bonding instead of auto-executing Stock graduation", async () => {
    const { env, mockFactory, router, campaign, token, stockAdapter, stock } = await deployStockCampaign();

    await expect(mockFactory.configure(await campaign.getAddress(), await stock.getAddress(), await stockAdapter.getAddress()))
      .to.emit(campaign, "StockGraduationConfigured")
      .withArgs(await stock.getAddress(), await stockAdapter.getAddress());

    await mineAt(Number(await campaign.launchAt()) + 61);
    // A holder from before the crossing, to prove sells are frozen too.
    await buyTokens(env, campaign, env.bob, E(1_000_000));
    const crossing = await buyNative(env, campaign, env.alice, E(60));
    await expect(crossing).to.emit(campaign, "GraduationPending");

    expect(await campaign.graduationPending()).to.equal(true);
    expect(await campaign.launched()).to.equal(false);
    expect(await campaign.pendingTrigger()).to.equal(0n); // USD target, not sell-out
    expect(await campaign.graduationQuoteToken()).to.equal(await stock.getAddress());
    expect(await campaign.graduationAdapter()).to.equal(await stockAdapter.getAddress());
    const state = await campaign.getGraduationState();
    expect(state.graduationBalance).to.equal(await campaign.netRaisedWei());
    expect(state.graduationBalance).to.be.greaterThan(0n);
    expect(state.dexPair).to.equal(ethers.ZeroAddress);

    // Nothing was executed: no adapter call, no protocol graduation share, no factory notification.
    expect(await stockAdapter.calls()).to.equal(0n);
    expect(await router.finalizeTotal()).to.equal(0n);
    expect(await mockFactory.notifications()).to.equal(0n);
    expect(await token.tradingEnabled()).to.equal(false);

    // Bonding is frozen in both directions; the sold amount cannot move.
    const soldAtPending = await campaign.sold();
    // The quote still answers (the curve is intact); the trade itself is refused.
    expect(await campaign.quoteSellExactTokens(E(1))).to.be.greaterThan(0n);
    await expect(sellTokens(env, campaign, token, env.bob, E(1))).to.be.revertedWithCustomError(campaign, "GraduationIsPending");
    await expect(buyNative(env, campaign, env.carol, E(1))).to.be.revertedWithCustomError(campaign, "GraduationIsPending");
    expect(await campaign.sold()).to.equal(soldAtPending);
  });

  it("does not allow Stock graduation mode to be attached after bonding starts", async () => {
    const { env, mockFactory, campaign, stockAdapter, stock } = await deployStockCampaign();
    await mineAt(Number(await campaign.launchAt()) + 61);
    await buyTokens(env, campaign, env.alice, E(1));

    await expect(mockFactory.configure(await campaign.getAddress(), await stock.getAddress(), await stockAdapter.getAddress()))
      .to.be.revertedWithCustomError(campaign, "StockGraduationConfigLocked");
    expect(await campaign.graduationQuoteToken()).to.equal(ethers.ZeroAddress);

    // Only the factory may ever attach it, bonded or not.
    await expect(campaign.connect(env.alice).configureStockGraduation(await stock.getAddress(), await stockAdapter.getAddress()))
      .to.be.revertedWithCustomError(campaign, "OnlyFactory");
  });
});
