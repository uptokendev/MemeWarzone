import { expect } from "chai";
import { ethers } from "hardhat";
import fs from "node:fs";
import path from "node:path";
import {
  deployEvmGen7, createCoin, req, E, area, curveFor, curveOf, launchFeeBps, mineAt, setNextTimestamp, buyTokens, buyNative, sellTokens, signTrade, DAY,
} from "./fixtures/evmgen7Core";

describe("evmgen7 core: full native lifecycle with a mock adapter", function () {
  it("create with first buy -> sniper window -> trades -> creator escrow buy -> sold out -> Pending -> graduate -> claims, native conserved", async () => {
    const env = await deployEvmGen7();
    const fb = E(50_000_000);
    const curve0 = curveFor(50_000, 600);
    const fbCost = area(fb, curve0) + (area(fb, curve0) * 200n) / 10000n;
    const { campaign, token } = await createCoin(env, req({ firstBuyTokens: fb, firstBuyMaxCost: fbCost, feeChoice: 3, feeCreatorPct: 60 }), { value: fbCost });
    const curve = await curveOf(campaign);
    const c = await campaign.getAddress();
    const t0 = Number(await campaign.launchAt());
    expect(await token.balanceOf(env.creator.address)).to.eq(fb);

    // sniper at +2 s pays 8706 bps (gen-6: 4840)
    const snipe = E(2_000_000);
    const s0 = await campaign.sold();
    const snipeCost = area(s0 + snipe, curve) - area(s0, curve);
    const a = await signTrade(env.authority, c, env.bob.address, 0, snipe, snipeCost * 2n);
    await setNextTimestamp(t0 + 2);
    await campaign.connect(env.bob).buyExactTokensAuthorized(snipe, snipeCost * 2n, a.profile, a.deadline, a.signature, { value: snipeCost * 2n });
    expect(launchFeeBps(2)).to.eq(8706n);
    expect(await env.evmRouter.lastTradeValue()).to.eq((snipeCost * 8706n) / 10000n);

    await mineAt(t0 + 120);
    await buyNative(env, campaign, env.alice, E(5));
    await sellTokens(env, campaign, token, env.bob, snipe / 2n);
    // creator buys later: escrowed
    const ctx = await buyTokens(env, campaign, env.creator, E(4_000_000));
    const creatorBuyAt = (await ethers.provider.getBlock(ctx.blockNumber!))!.timestamp;
    expect(await token.balanceOf(env.creator.address)).to.eq(fb);
    expect(await campaign.creatorEscrowTotal()).to.eq(E(4_000_000));

    // sold-out buy (gen-6: the buy crossing the USD target)
    await buyNative(env, campaign, env.alice, E(60));
    expect(await campaign.graduationPending()).to.eq(true);
    const g0 = await campaign.getGraduationState();
    const R = g0.graduationBalance;
    expect(R).to.eq(area(await campaign.sold(), curve)); // netRaised == Y(sold) - Y(0) exactly
    expect(await ethers.provider.getBalance(c)).to.eq(R);

    await campaign.connect(env.carol).graduate();
    const protocol = (R * 200n) / 10000n;
    const creatorShare = 0n; // gen-7: no creator graduation share
    const pool = R - protocol - creatorShare;
    expect(await env.evmRouter.finalizeTotal()).to.eq(protocol);
    expect(await env.adapter.lastValue()).to.eq(pool);
    expect(await ethers.provider.getBalance(c)).to.eq(creatorShare);

    // locker: split coin => keyed by campaign, paid to the vault
    const info = await env.locker.poolInfo((await campaign.getGraduationState()).dexPair);
    expect(info.creatorFeeRecipient).to.eq(await env.vault.getAddress());

    // claims: nothing native is owed to the creator in gen-7 (gen-6 claimed 19.8% here)
    await expect(campaign.connect(env.creator).claimCreatorGraduation(env.owner.address, true)).to.be.revertedWithCustomError(campaign, "NothingToClaim");
    expect(await ethers.provider.getBalance(c)).to.eq(0n);
    await mineAt(creatorBuyAt + 30 * DAY);
    await campaign.connect(env.creator).claimCreatorEscrow();
    expect(await token.balanceOf(env.creator.address)).to.eq(fb + E(800_000) + (await campaign.creatorReserve()));
    await mineAt(creatorBuyAt + 58 * DAY);
    await campaign.connect(env.creator).claimCreatorEscrow();
    expect(await token.balanceOf(c)).to.eq(0n);
    // the graduated token moves freely
    await token.connect(env.alice).transfer(env.bob.address, 1n);
  });

  it("a router that re-enters on the trade path and on the finalize path hits the guard", async () => {
    const env = await deployEvmGen7();
    const { campaign } = await createCoin(env);
    await mineAt(Number(await campaign.launchAt()) + 61);
    await env.evmRouter.setReenter(campaign.interface.encodeFunctionData("graduate"));
    await buyTokens(env, campaign, env.alice, E(1_000_000));
    expect(await env.evmRouter.reenterAttempted()).to.eq(true);
    expect(await env.evmRouter.reenterSucceeded()).to.eq(false);
    expect(await env.evmRouter.reenterRevertSelector()).to.eq(campaign.interface.getError("ReentrancyGuardReentrantCall")!.selector);
    await buyNative(env, campaign, env.alice, E(60));
    await env.evmRouter.setReenter(campaign.interface.encodeFunctionData("flushProtocolGraduationFee"));
    await campaign.graduate();
    expect(await env.evmRouter.reenterSucceeded()).to.eq(false);
    expect(await env.evmRouter.reenterRevertSelector()).to.eq(campaign.interface.getError("ReentrancyGuardReentrantCall")!.selector);
  });
});

describe("evmgen7 core: EIP-170 bytecode sizes", function () {
  const LIMIT = 24576;
  const size = (file: string, name: string) => {
    const a = JSON.parse(fs.readFileSync(path.join(process.cwd(), "artifacts", "contracts", file, `${name}.json`), "utf8"));
    return (a.deployedBytecode.length - 2) / 2;
  };
  for (const [file, name] of [
    ["gen7/LaunchCampaignGen7.sol", "LaunchCampaignGen7"],
    ["gen7/BnbQuoteLaunchCampaignGen7.sol", "BnbQuoteLaunchCampaignGen7"],
    ["gen7/RobinhoodStockLaunchCampaignGen7.sol", "RobinhoodStockLaunchCampaignGen7"],
    ["gen7/LaunchFactoryGen7.sol", "LaunchFactoryGen7"],
    ["gen7/BnbBasicLaunchFactoryGen7.sol", "BnbBasicLaunchFactoryGen7"],
    ["token/LaunchTokenDeployer.sol", "LaunchTokenDeployer"],
    ["token/LaunchToken.sol", "LaunchToken"],
  ]) {
    it(`${name} is under ${LIMIT} bytes`, () => {
      const n = size(file, name);
      console.log(`      ${name}: ${n} bytes (${LIMIT - n} spare)`);
      expect(n).to.be.lessThan(LIMIT);
    });
  }
});
