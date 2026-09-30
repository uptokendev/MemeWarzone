import { expect } from "chai";
import { ethers } from "hardhat";
import { deployEvmGen, createCoin, req, E, area, signCreate, hashReq, now, mineAt, buyTokens, sellTokens, FEE_KEEP } from "./fixtures/evmgenCore";

const TEN_PCT = E(100_000_000);
const firstBuyCost = (tokens: bigint) => {
  const c = area(tokens);
  return c + (c * 200n) / 10000n;
};

describe("evmgen core C3: creator first buy at create", function () {
  it("exactly 10% at flat 2% in the create block: tokens unlocked to the creator, launchAt untouched, factory holds nothing", async () => {
    const env = await deployEvmGen();
    const cost = firstBuyCost(TEN_PCT);
    const r = req({ firstBuyTokens: TEN_PCT, firstBuyMaxCost: cost });
    const { campaign, token, tx } = await createCoin(env, r, { value: cost });
    const block = await ethers.provider.getBlock(tx.blockNumber!);
    expect(await campaign.launchAt()).to.eq(BigInt(block!.timestamp));
    expect(await token.balanceOf(env.creator.address)).to.eq(TEN_PCT);
    expect(await campaign.creatorEscrowTotal()).to.eq(0n);
    expect(await campaign.creatorBoughtWei()).to.eq(0n);
    expect(await campaign.sold()).to.eq(TEN_PCT);
    expect(await campaign.netRaisedWei()).to.eq(area(TEN_PCT));
    expect(await env.evmRouter.lastTradeValue()).to.eq((area(TEN_PCT) * 200n) / 10000n);
    await expect(tx).to.emit(campaign, "CreatorFirstBuy").withArgs(env.creator.address, TEN_PCT, area(TEN_PCT), (area(TEN_PCT) * 200n) / 10000n);
    await expect(tx).to.emit(campaign, "TokensPurchased").withArgs(env.creator.address, TEN_PCT, cost);
    expect(await ethers.provider.getBalance(await env.factory.getAddress())).to.eq(0n);
    expect(await ethers.provider.getBalance(await campaign.getAddress())).to.eq(area(TEN_PCT));
    // the fee accrued to the vault for this campaign (choice was set before the buy)
    expect(await env.vault.accrued(await campaign.getAddress())).to.eq((((area(TEN_PCT) * 200n) / 10000n) * 560n) / 10000n);
  });

  it("10% + 1 wei reverts FirstBuyTooLarge", async () => {
    const env = await deployEvmGen();
    const tokens = TEN_PCT + 1n;
    const cost = firstBuyCost(tokens);
    await expect(createCoin(env, req({ firstBuyTokens: tokens, firstBuyMaxCost: cost }), { value: cost })).to.be.revertedWithCustomError(env.impl, "FirstBuyTooLarge");
  });

  it("value without an amount, too little value, and a too-low max cost all revert", async () => {
    const env = await deployEvmGen();
    await expect(createCoin(env, req(), { value: 1n })).to.be.revertedWithCustomError(env.factory, "FirstBuyValueWithoutAmount");
    const cost = firstBuyCost(E(1_000_000));
    await expect(createCoin(env, req({ firstBuyTokens: E(1_000_000), firstBuyMaxCost: cost }), { value: cost - 1n })).to.be.revertedWithCustomError(env.factory, "InsufficientValue");
    await expect(createCoin(env, req({ firstBuyTokens: E(1_000_000), firstBuyMaxCost: cost - 1n }), { value: cost })).to.be.revertedWithCustomError(env.factory, "FirstBuySlippage");
  });

  it("overpay is refunded to the wei", async () => {
    const env = await deployEvmGen();
    const tokens = E(5_000_000);
    const cost = firstBuyCost(tokens);
    const r = req({ firstBuyTokens: tokens, firstBuyMaxCost: cost * 3n });
    const before = await ethers.provider.getBalance(env.creator.address);
    const { receipt } = await createCoin(env, r, { value: cost * 3n });
    const gas = receipt!.gasUsed * receipt!.gasPrice;
    expect(await ethers.provider.getBalance(env.creator.address)).to.eq(before - cost - gas);
    expect(await ethers.provider.getBalance(await env.factory.getAddress())).to.eq(0n);
  });

  it("a refund receiver that rejects native makes the whole create revert", async () => {
    const env = await deployEvmGen();
    const wallet = await (await ethers.getContractFactory("MockCreatorWalletEvmGen")).deploy();
    const tokens = E(1_000_000);
    const cost = firstBuyCost(tokens);
    const r = req({ firstBuyTokens: tokens, firstBuyMaxCost: cost * 2n });
    const auth = await signCreate(env.authority, await env.factory.getAddress(), await wallet.getAddress(), r);
    const data = env.factory.interface.encodeFunctionData("createCampaignAuthorized", [r, auth]);
    await expect(wallet.execute(await env.factory.getAddress(), cost * 2n, data, { value: cost * 2n })).to.be.revertedWithCustomError(env.factory, "RefundFailed");
    // exact value: no refund needed, so the same wallet can create
    const r2 = req({ firstBuyTokens: tokens, firstBuyMaxCost: cost, symbol: "EGEN2" });
    const auth2 = await signCreate(env.authority, await env.factory.getAddress(), await wallet.getAddress(), r2);
    const data2 = env.factory.interface.encodeFunctionData("createCampaignAuthorized", [r2, auth2]);
    await wallet.execute(await env.factory.getAddress(), cost, data2, { value: cost });
    expect(await env.factory.campaignsCount()).to.eq(1n);
  });

  it("a first buy that would reach 50% of the native target reverts; an oracle failure fails the create closed", async () => {
    const env = await deployEvmGen({ nativeUsd: 20_000 }); // $30K target = 1.5 BNB; 10% costs ~5.5 BNB
    const cost = firstBuyCost(TEN_PCT);
    await expect(createCoin(env, req({ firstBuyTokens: TEN_PCT, firstBuyMaxCost: cost }), { value: cost })).to.be.revertedWithCustomError(env.impl, "FirstBuyTooExpensive");
    // 0.74 BNB (just under 50% of 1.5) passes
    const ok = E(20_000_000); // area ~0.236 BNB
    const okCost = firstBuyCost(ok);
    await createCoin(env, req({ firstBuyTokens: ok, firstBuyMaxCost: okCost }), { value: okCost });

    const t = await now();
    await env.feed.setRoundData(2, 0, t, t, 2);
    await expect(createCoin(env, req({ symbol: "X2" }))).to.be.revertedWithCustomError(env.factory, "OraclePriceUnavailable");
  });

  it("an amount changed against the signature reverts InvalidRouteAuthorization", async () => {
    const env = await deployEvmGen();
    const tokens = E(1_000_000);
    const cost = firstBuyCost(tokens);
    const signed = req({ firstBuyTokens: tokens, firstBuyMaxCost: cost });
    const auth = await signCreate(env.authority, await env.factory.getAddress(), env.creator.address, signed);
    const sent = { ...signed, firstBuyTokens: tokens * 2n, firstBuyMaxCost: cost * 3n };
    await expect(env.factory.connect(env.creator).createCampaignAuthorized(sent, auth, { value: cost * 3n })).to.be.revertedWithCustomError(env.factory, "InvalidRouteAuthorization");
    const sentChoice = { ...signed, feeChoice: 2 };
    await expect(env.factory.connect(env.creator).createCampaignAuthorized(sentChoice, auth, { value: cost })).to.be.revertedWithCustomError(env.factory, "InvalidRouteAuthorization");
    expect(hashReq(signed)).to.not.eq(hashReq(sent));
  });

  it("only the factory can call creatorFirstBuy", async () => {
    const env = await deployEvmGen();
    const { campaign } = await createCoin(env);
    await expect(campaign.connect(env.creator).creatorFirstBuy(E(1), { value: E(1) })).to.be.revertedWithCustomError(campaign, "OnlyFactory");
  });

  it("scheduled coin: the first buy lands before launchAt, the tokens cannot move and a sell is refused until launch", async () => {
    const env = await deployEvmGen();
    const tokens = E(10_000_000);
    const cost = firstBuyCost(tokens);
    const r = req({ firstBuyTokens: tokens, firstBuyMaxCost: cost });
    const t = await now();
    const launchAt = t + 900;
    const sreq = {
      campaign: r,
      launchAt,
      draftReferenceHash: ethers.id("d"),
      normalizedTickerHash: ethers.id("t"),
      metadataHash: ethers.id("m"),
      reservationVersion: 1,
      authorizationNonce: 1,
    };
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const dl = t + 3600;
    const payload = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "uint256", "address", "address", "bytes32", "uint64", "bytes32", "bytes32", "bytes32", "uint64", "uint256", "uint32", "uint32", "uint8", "uint8", "uint64"],
        ["MWZ_CREATE_SCHEDULED_V2_AUTH", chainId, await env.factory.getAddress(), env.creator.address, hashReq(r), launchAt, sreq.draftReferenceHash, sreq.normalizedTickerHash, sreq.metadataHash, 1, 1, 6, 5, 1, 1, dl],
      ),
    );
    const sig = await env.authority.signMessage(ethers.getBytes(payload));
    await env.factory.connect(env.creator).createScheduledCampaignAuthorized(sreq, { tradeRouteProfile: 1, finalizeRouteProfile: 1, deadline: dl, signature: sig }, { value: cost });
    const info = await env.factory.getCampaign(0);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
    const token = await ethers.getContractAt("LaunchToken", info.token);
    expect(await token.balanceOf(env.creator.address)).to.eq(tokens);
    expect(await campaign.launchAt()).to.eq(BigInt(launchAt));
    await expect(token.connect(env.creator).transfer(env.alice.address, 1n)).to.be.revertedWithCustomError(token, "TradingNotEnabled");
    await expect(sellTokens(env, campaign, token, env.creator, tokens)).to.be.revertedWithCustomError(campaign, "TradingNotOpen");
    await mineAt(launchAt + 60);
    await sellTokens(env, campaign, token, env.creator, tokens / 2n);
  });

  it("the first buy is neither escrowed nor counted against the tier cap; later creator buys are", async () => {
    const env = await deployEvmGen();
    const creatorRegistry = await (await ethers.getContractFactory("CreatorRegistry")).deploy();
    await creatorRegistry.setLaunchRecorder(await env.factory.getAddress(), true);
    await env.factory.setRegistries(await creatorRegistry.getAddress(), ethers.ZeroAddress);
    const rules = await creatorRegistry.getCreatorRules(env.creator.address);
    const cap = rules.creatorBuyCapWei;
    expect(cap).to.be.gt(0n);
    const tokens = TEN_PCT; // ~5.5 BNB, far above the default tier cap
    const cost = firstBuyCost(tokens);
    const { campaign, token } = await createCoin(env, req({ firstBuyTokens: tokens, firstBuyMaxCost: cost }), { value: cost });
    expect(await token.balanceOf(env.creator.address)).to.eq(tokens);
    expect(await campaign.creatorBoughtWei()).to.eq(0n);
    await mineAt(Number(await campaign.launchAt()) + 61);
    // a later creator buy above the cap reverts
    const s = await campaign.sold();
    let amt = E(1_000_000);
    while (area(s + amt) - area(s) <= cap) amt *= 2n;
    await expect(buyTokens(env, campaign, env.creator, amt)).to.be.revertedWithCustomError(campaign, "CreatorBuyCapExceeded");
    void FEE_KEEP;
  });
});
