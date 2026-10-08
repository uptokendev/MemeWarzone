import { expect } from "chai";
import { ethers } from "hardhat";
import {
  deployEvmGen7, createCoin, createScheduledCoin, deployViaMockFactory, req, E, area, curveFor, curveOf, signCreate, hashReq, now,
  mineAt, buyTokens, sellTokens, SUPPLY, CURVE,
} from "./fixtures/evmgen7Core";

// Gen-7 C5: the creator first buy is capped at 70% of supply (gen-6: 10%) and has no cost cap (gen-6: <= 50% of
// the native target). Everything else (flat base fee, create-block only, unlocked, not escrowed) is gen-6.
const SEVENTY_PCT = (SUPPLY * 7000n) / 10000n;
const DEFAULT_CURVE = curveFor(50_000, 600); // req() default target at the fixture's $600
const firstBuyCost = (tokens: bigint, c = DEFAULT_CURVE) => {
  const x = area(tokens, c);
  return x + (x * 200n) / 10000n;
};

describe("evmgen7 core C5: creator first buy at create", function () {
  it("exactly 70% at flat 2% in the create block: tokens unlocked to the creator, launchAt untouched, factory holds nothing", async () => {
    const env = await deployEvmGen7();
    const cost = firstBuyCost(SEVENTY_PCT);
    const noFee = area(SEVENTY_PCT, DEFAULT_CURVE);
    const r = req({ firstBuyTokens: SEVENTY_PCT, firstBuyMaxCost: cost });
    const { campaign, token, tx } = await createCoin(env, r, { value: cost });
    const block = await ethers.provider.getBlock(tx.blockNumber!);
    expect(await campaign.launchAt()).to.eq(BigInt(block!.timestamp));
    expect(await token.balanceOf(env.creator.address)).to.eq(SEVENTY_PCT);
    expect(await campaign.creatorEscrowTotal()).to.eq(0n);
    expect(await campaign.creatorBoughtWei()).to.eq(0n);
    expect(await campaign.sold()).to.eq(SEVENTY_PCT);
    expect(await campaign.netRaisedWei()).to.eq(noFee);
    expect(await campaign.graduationPending()).to.eq(false);
    expect(await env.evmRouter.lastTradeValue()).to.eq((noFee * 200n) / 10000n);
    await expect(tx).to.emit(campaign, "CreatorFirstBuy").withArgs(env.creator.address, SEVENTY_PCT, noFee, (noFee * 200n) / 10000n);
    await expect(tx).to.emit(campaign, "TokensPurchased").withArgs(env.creator.address, SEVENTY_PCT, cost);
    expect(await ethers.provider.getBalance(await env.factory.getAddress())).to.eq(0n);
    expect(await ethers.provider.getBalance(await campaign.getAddress())).to.eq(noFee);
    // the fee accrued to the vault for this campaign (choice was set before the buy)
    expect(await env.vault.accrued(await campaign.getAddress())).to.eq((((noFee * 200n) / 10000n) * 560n) / 10000n);
  });

  it("70% + 1 wei reverts FirstBuyTooLarge", async () => {
    const env = await deployEvmGen7();
    const tokens = SEVENTY_PCT + 1n;
    const cost = firstBuyCost(tokens);
    await expect(createCoin(env, req({ firstBuyTokens: tokens, firstBuyMaxCost: cost }), { value: cost })).to.be.revertedWithCustomError(env.impl, "FirstBuyTooLarge");
  });

  it("value without an amount, too little value, and a too-low max cost all revert", async () => {
    const env = await deployEvmGen7();
    await expect(createCoin(env, req(), { value: 1n })).to.be.revertedWithCustomError(env.factory, "FirstBuyValueWithoutAmount");
    const cost = firstBuyCost(E(1_000_000));
    await expect(createCoin(env, req({ firstBuyTokens: E(1_000_000), firstBuyMaxCost: cost }), { value: cost - 1n })).to.be.revertedWithCustomError(env.factory, "InsufficientValue");
    await expect(createCoin(env, req({ firstBuyTokens: E(1_000_000), firstBuyMaxCost: cost - 1n }), { value: cost })).to.be.revertedWithCustomError(env.factory, "FirstBuySlippage");
  });

  it("overpay is refunded to the wei", async () => {
    const env = await deployEvmGen7();
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
    const env = await deployEvmGen7();
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

  // Gen-6: "a first buy that would reach 50% of the native target reverts". Gen-7 has no cost cap; the property
  // it protected (the first buy can never graduate the coin) now rests on 70% < the 85% curve.
  it("REPLACED: no cost cap (a 70% first buy at a $20,000 native price goes through and leaves the coin Trading); an oracle failure fails the create closed", async () => {
    const env = await deployEvmGen7({ nativeUsd: 20_000 }); // gen-6 refused a 10% first buy at this price
    const curve = curveFor(50_000, 20_000);
    const cost = firstBuyCost(SEVENTY_PCT, curve);
    const raise = area(CURVE, curve);
    // 70% costs ~42% of the whole raise: far above gen-6's 50%-of-target-per-10% budget, and accepted.
    expect(Number((area(SEVENTY_PCT, curve) * 10_000n) / raise) / 100).to.be.closeTo(42.14, 0.02);
    const { campaign, token } = await createCoin(env, req({ firstBuyTokens: SEVENTY_PCT, firstBuyMaxCost: cost }), { value: cost });
    expect(await token.balanceOf(env.creator.address)).to.eq(SEVENTY_PCT);
    expect(await campaign.graduationPending()).to.eq(false);
    expect(await campaign.launched()).to.eq(false);
    expect((await campaign.curveSupply()) - (await campaign.sold())).to.eq((SUPPLY * 1500n) / 10000n);

    const t = await now();
    await env.feed.setRoundData(2, 0, t, t, 2);
    await expect(createCoin(env, req({ symbol: "X2" }))).to.be.revertedWithCustomError(env.factory, "OraclePriceUnavailable");
  });

  it("NEW (gen-7 C5 guard): a campaign whose curve is not larger than the 70% first-buy cap cannot be initialized", async () => {
    const env = await deployEvmGen7();
    // 70% curve: a maximal first buy would sell the whole curve out and graduate the coin in the create tx.
    const m = await deployViaMockFactory(env, "LaunchCampaignGen7", { curveBps: 7000, liquidityTokenBps: 2800 });
    await expect(m.create()).to.be.revertedWithCustomError(m.impl, "InvalidCurveBps");
    const ok = await deployViaMockFactory(env, "LaunchCampaignGen7", { curveBps: 7001, liquidityTokenBps: 2799 });
    await ok.create();
  });

  it("an amount changed against the signature reverts InvalidRouteAuthorization", async () => {
    const env = await deployEvmGen7();
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
    const env = await deployEvmGen7();
    const { campaign } = await createCoin(env);
    await expect(campaign.connect(env.creator).creatorFirstBuy(E(1), { value: E(1) })).to.be.revertedWithCustomError(campaign, "OnlyFactory");
  });

  it("scheduled coin: the first buy lands before launchAt, the tokens cannot move and a sell is refused until launch", async () => {
    const env = await deployEvmGen7();
    const tokens = E(10_000_000);
    const cost = firstBuyCost(tokens);
    const r = req({ firstBuyTokens: tokens, firstBuyMaxCost: cost });
    const launchAt = (await now()) + 900;
    const { campaign, token } = await createScheduledCoin(env, r, launchAt, { value: cost, nonce: 1 });
    expect(await token.balanceOf(env.creator.address)).to.eq(tokens);
    expect(await campaign.launchAt()).to.eq(BigInt(launchAt));
    await expect(token.connect(env.creator).transfer(env.alice.address, 1n)).to.be.revertedWithCustomError(token, "TradingNotEnabled");
    await expect(sellTokens(env, campaign, token, env.creator, tokens)).to.be.revertedWithCustomError(campaign, "TradingNotOpen");
    await mineAt(launchAt + 60);
    await sellTokens(env, campaign, token, env.creator, tokens / 2n);
  });

  // Gen-6: "...later creator buys are [counted against the tier cap]" (CreatorBuyCapExceeded). Gen-7 C7 removes the
  // cap: with the registry wired the factory still passes creatorBuyCapWei = 0 and later buys are only escrowed.
  it("REPLACED: the first buy is neither escrowed nor capped; later creator buys are escrowed but not capped, even above the tier cap", async () => {
    const env = await deployEvmGen7();
    const creatorRegistry = await (await ethers.getContractFactory("CreatorRegistry")).deploy();
    await creatorRegistry.setLaunchRecorder(await env.factory.getAddress(), true);
    await env.factory.setRegistries(await creatorRegistry.getAddress(), ethers.ZeroAddress);
    const rules = await creatorRegistry.getCreatorRules(env.creator.address);
    const cap = rules.creatorBuyCapWei;
    expect(cap).to.be.gt(0n);
    const tokens = E(100_000_000);
    const cost = firstBuyCost(tokens);
    const { campaign, token } = await createCoin(env, req({ firstBuyTokens: tokens, firstBuyMaxCost: cost }), { value: cost });
    expect(await token.balanceOf(env.creator.address)).to.eq(tokens);
    expect(await campaign.creatorBoughtWei()).to.eq(0n);
    expect(await campaign.creatorBuyCapWei()).to.eq(0n);
    await mineAt(Number(await campaign.launchAt()) + 61);
    // a later creator buy above the tier cap goes through and is escrowed
    const curve = await curveOf(campaign);
    const s = await campaign.sold();
    let amt = E(1_000_000);
    while (area(s + amt, curve) - area(s, curve) <= cap) amt *= 2n;
    await buyTokens(env, campaign, env.creator, amt);
    expect(await campaign.creatorEscrowTotal()).to.eq(amt);
    expect(await campaign.creatorBoughtWei()).to.be.gt(cap);
    expect(await token.balanceOf(env.creator.address)).to.eq(tokens);
  });
});
