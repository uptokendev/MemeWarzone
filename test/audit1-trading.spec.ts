import { expect } from "chai";
import { ethers, network } from "hardhat";
import {
  deployEvmGen,
  createCoin,
  req,
  E,
  area,
  mineAt,
  buyTokens,
  buyNative,
  sellTokens,
  signTrade,
  signCreate,
  now,
  increaseTime,
  DAY,
  coder,
  type Env,
} from "./fixtures/evmgenCore";
import { deployFactoryWithLocker } from "../scripts/lib/deployFactoryWithLocker";

// Independent audit 1 (trading + create paths). EXPLOIT tests PASS when the bad outcome happens.

async function tradingCoin(env?: Env, r = req()) {
  env = env ?? (await deployEvmGen());
  const { campaign, token } = await createCoin(env, r);
  await mineAt(Number(await campaign.launchAt()) + 61);
  return { env, campaign, token };
}

describe("audit1: trading and create paths", function () {
  // ---------------------------------------------------------------- EXPLOITS

  it("HOLDS: creator renounceOwnership() is refused, so graduate() still pays the creator reserve and the raise is not locked (was EXPLOIT, fixed)", async () => {
    const { env, campaign, token } = await tradingCoin();
    await buyTokens(env, campaign, env.bob, E(10_000_000));
    // The creator tries to 'renounce' (a common memecoin trust signal) before the coin fills: refused.
    await expect(campaign.connect(env.creator).renounceOwnership()).to.be.revertedWithCustomError(campaign, "RenounceDisabled");
    await expect(campaign.connect(env.carol).renounceOwnership()).to.be.revertedWithCustomError(campaign, "OwnableUnauthorizedAccount");
    await expect(campaign.connect(env.creator).transferOwnership(ethers.ZeroAddress)).to.be.revertedWithCustomError(campaign, "OwnableInvalidOwner");
    expect(await campaign.owner()).to.eq(env.creator.address);
    await buyNative(env, campaign, env.alice, E(60)); // crosses the $30k (50 BNB) target -> Pending
    expect(await campaign.graduationPending()).to.eq(true);
    const reserve = await campaign.creatorReserve();
    const before = await token.balanceOf(env.creator.address);
    // Anyone graduates; the reserve goes to the (non-zero) owner, the 19.8% becomes claimable.
    await campaign.connect(env.carol).graduate();
    expect(await campaign.launched()).to.eq(true);
    expect((await token.balanceOf(env.creator.address)) - before).to.eq(reserve);
    expect(await campaign.creatorGraduationBeneficiary()).to.eq(env.creator.address);
  });

  it("EXPLOIT: rotating the router's creatorRewardsVault (e.g. for the next factory generation) freezes buys AND sells of every existing campaign", async () => {
    const [admin, creator, alice, , authority] = await ethers.getSigners();
    const wbnb = await (await ethers.getContractFactory("MockWBNB")).deploy();
    const topazFactory = await (await ethers.getContractFactory("MockTopazFactory")).deploy();
    const topazRouter = await (await ethers.getContractFactory("MockTopazRouter")).deploy(await topazFactory.getAddress(), await wbnb.getAddress());
    const feed = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8);
    const t = await now();
    await feed.setRoundData(1, 600n * 10n ** 8n, t, t, 1);
    const oracle = await (await ethers.getContractFactory("GraduationOracle")).deploy(await feed.getAddress(), 1_000_000_000);
    const Receiver = await ethers.getContractFactory("TreasuryRouterV3ReceiverMock");
    const weekly = await Receiver.deploy();
    const monthly = await Receiver.deploy();
    const recruiter = await Receiver.deploy();
    const protocol = await Receiver.deploy();
    const community = await (await ethers.getContractFactory("CommunityRewardsVaultV3Mock")).deploy();
    const v4 = await (await ethers.getContractFactory("TreasuryRouterV4")).deploy(admin.address, await weekly.getAddress(), await monthly.getAddress(), 3600);
    const Vault = await ethers.getContractFactory("CreatorRewardsVaultV2");
    const vault = await Vault.deploy(admin.address, await v4.getAddress(), await wbnb.getAddress(), 1, await topazFactory.getAddress(), 86400);
    await v4.setRecruiterRewardsVault(await recruiter.getAddress());
    await v4.setCommunityRewardsVault(await community.getAddress());
    await v4.setProtocolRevenueVault(await protocol.getAddress());
    await v4.setCreatorRewardsVault(await vault.getAddress());

    const impl = await (await ethers.getContractFactory("LaunchCampaign")).deploy();
    const tokenDeployer = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const factory = (await deployFactoryWithLocker({
      factoryName: "LaunchFactory",
      args: [await topazRouter.getAddress(), await v4.getAddress(), await impl.getAddress(), await oracle.getAddress()],
    })).factory;
    await vault.setFactoryOnce(await factory.getAddress());
    const adapter = await (await ethers.getContractFactory("MockGraduationAdapterEvmGen")).deploy(await topazFactory.getAddress(), await wbnb.getAddress());
    await adapter.setLocker(await factory.permanentLpLocker());
    await factory.setNativeGraduationAdapter(await adapter.getAddress());
    await factory.setLaunchTokenDeployer(await tokenDeployer.getAddress());
    await factory.setRouteAuthority(authority.address);
    await factory.enableLive();
    const env = { factory, authority, creator } as unknown as Env;

    const { campaign, token } = await createCoin(env, req());
    await mineAt(Number(await campaign.launchAt()) + 61);
    await buyTokens(env, campaign, alice, E(1_000_000));
    expect(await token.balanceOf(alice.address)).to.eq(E(1_000_000));

    // Next generation: a new vault (setFactoryOnce binds one factory per vault), rotated in after the delay.
    const vault2 = await Vault.deploy(admin.address, await v4.getAddress(), await wbnb.getAddress(), 1, await topazFactory.getAddress(), 86400);
    await v4.proposeCreatorRewardsVault(await vault2.getAddress());
    await increaseTime(3601);
    await v4.acceptCreatorRewardsVault();

    // Every fee-bearing trade on the old campaign now reverts inside routeTrade: holders are stuck.
    await expect(sellTokens(env, campaign, token, alice, E(1000))).to.be.revertedWithCustomError(vault2, "ChoiceUnset");
    await expect(buyTokens(env, campaign, alice, E(1000))).to.be.revertedWithCustomError(vault2, "ChoiceUnset");
  });

  it("EXPLOIT (admin power): a campaign paused before it is due can never graduate; the 72h honour window only protects coins already Pending", async () => {
    const { env, campaign, token } = await tradingCoin();
    await buyNative(env, campaign, env.alice, E(40)); // below the 50 BNB target
    await env.factory.setCampaignPauses(await campaign.getAddress(), true, true, true, true);
    // Price moves so the coin is now due (BNB $600 -> $800: target 37.5 BNB < raise).
    const t = await now();
    await env.feed.setRoundData(2, 800n * 10n ** 8n, t, t, 2);
    await increaseTime(365 * DAY);
    const t2 = await now();
    await env.feed.setRoundData(3, 800n * 10n ** 8n, t2, t2, 3);
    await expect(campaign.graduate()).to.be.revertedWithCustomError(campaign, "GraduationPaused");
    await expect(sellTokens(env, campaign, token, env.alice, E(1))).to.be.revertedWithCustomError(campaign, "CampaignPaused");
  });

  it("EXPLOIT (info): dust buys cost 0 wei and pay 0 fee, and still count as a new buyer", async () => {
    const { env, campaign, token } = await tradingCoin();
    await buyTokens(env, campaign, env.bob, E(1000));
    const before = await campaign.buyersCount();
    const q = await campaign.quoteBuyExactTokens(1n);
    expect(q).to.eq(0n);
    const a = await signTrade(env.authority, await campaign.getAddress(), env.carol.address, 0, 1n, 0n);
    await campaign.connect(env.carol).buyExactTokensAuthorized(1n, 0n, a.profile, a.deadline, a.signature, { value: 0 });
    expect(await token.balanceOf(env.carol.address)).to.eq(1n);
    expect(await campaign.buyersCount()).to.eq(before + 1n);
    // The largest free chunk is tiny: ~1e9 base units (1e-9 token) at the base price of 1 gwei/token.
    expect(await campaign.quoteBuyExactTokens(2n * 10n ** 9n)).to.be.gt(0n);
  });

  // ---------------------------------------------------------------- HOLDS

  it("HOLDS: netRaisedWei == area(sold) after mixed buys/sells (incl. first buy), so Insolvent is unreachable", async () => {
    const env = await deployEvmGen();
    const firstBuyTokens = E(20_000_000);
    const r = req({ firstBuyTokens, firstBuyMaxCost: E(100) });
    const { campaign, token } = await createCoin(env, r, { value: E(100) });
    await mineAt(Number(await campaign.launchAt()) + 61);
    let seed = 12345n;
    const rnd = (m: bigint) => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n;
      return (seed % m) + 1n;
    };
    for (let i = 0; i < 25; i++) {
      const who = [env.alice, env.bob, env.carol][i % 3];
      if (i % 3 === 2 && (await token.balanceOf(who.address)) > 0n) {
        const bal = await token.balanceOf(who.address);
        await sellTokens(env, campaign, token, who, (bal * rnd(100n)) / 100n || 1n);
      } else {
        await buyTokens(env, campaign, who, rnd(E(3_000_000)) + 777n);
      }
      expect(await campaign.netRaisedWei()).to.eq(area(await campaign.sold()));
    }
    // Contract balance always covers the raise (fees routed out, nothing else owed pre-graduation).
    expect(await ethers.provider.getBalance(await campaign.getAddress())).to.be.gte(await campaign.netRaisedWei());
  });

  it("HOLDS: a buy-sell round trip never returns more than was paid, and splitting a sell into dust pieces pays the same gross", async () => {
    const { env, campaign, token } = await tradingCoin();
    await buyTokens(env, campaign, env.bob, E(5_000_000));
    const amt = E(1_234_567) + 1n;
    const cost = await campaign.quoteBuyExactTokens(amt);
    await buyTokens(env, campaign, env.alice, amt);
    const soldAfterBuy = await campaign.sold();
    const grossOne = area(soldAfterBuy) - area(soldAfterBuy - amt);
    // pieces
    let got = 0n;
    const pieces = [amt / 3n, amt / 3n, amt - 2n * (amt / 3n)];
    for (const p of pieces) {
      const before = await ethers.provider.getBalance(env.alice.address);
      const tx = await sellTokens(env, campaign, token, env.alice, p);
      const rc = await tx.wait();
      const gas = rc!.gasUsed * rc!.gasPrice;
      got += (await ethers.provider.getBalance(env.alice.address)) - before + gas;
    }
    // `got` includes the approve txs' gas as a (small) loss, so it is an upper bound check only.
    expect(await campaign.sold()).to.eq(soldAfterBuy - amt);
    expect(cost).to.eq(grossOne + (grossOne * 200n) / 10000n); // buy paid gross + 2%
    expect(got).to.be.lt(cost);
    expect(await campaign.netRaisedWei()).to.eq(area(await campaign.sold()));
  });

  it("HOLDS: anti-sniper schedule on a scheduled coin (no trade before launchAt, 5000 at launchAt, 200 at +60s) and the first buy pays the flat 2%", async () => {
    const env = await deployEvmGen();
    const creatorAddr = env.creator.address;
    const launchAt = (await now()) + 3600;
    const r = req({ firstBuyTokens: E(1_000_000), firstBuyMaxCost: E(10) });
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
    const { hashReq } = await import("./fixtures/evmgenCore");
    const dl = (await now()) + 600;
    const payload = ethers.keccak256(
      coder.encode(
        ["string", "uint256", "address", "address", "bytes32", "uint64", "bytes32", "bytes32", "bytes32", "uint64", "uint256", "uint32", "uint32", "uint8", "uint8", "uint64"],
        ["MWZ_CREATE_SCHEDULED_V2_AUTH", chainId, await env.factory.getAddress(), creatorAddr, hashReq(r), launchAt, sreq.draftReferenceHash, sreq.normalizedTickerHash, sreq.metadataHash, 1, 1, 6, 5, 1, 1, dl],
      ),
    );
    const sig = await env.authority.signMessage(ethers.getBytes(payload));
    const routeAuth = { tradeRouteProfile: 1, finalizeRouteProfile: 1, deadline: dl, signature: sig };
    await env.factory.connect(env.creator).createScheduledCampaignAuthorized(sreq, routeAuth, { value: E(10) });
    const info = await env.factory.getCampaign((await env.factory.campaignsCount()) - 1n);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
    const token = await ethers.getContractAt("LaunchToken", info.token);
    expect(await campaign.launchAt()).to.eq(BigInt(launchAt));
    const costNoFee = area(E(1_000_000));
    expect(await token.balanceOf(creatorAddr)).to.eq(E(1_000_000));
    expect(await campaign.netRaisedWei()).to.eq(costNoFee);
    // first-buy quote is the flat base fee even though the view reports 5000 bps before launchAt
    expect(await campaign.currentTradeFeeBps()).to.eq(5000n);
    const next = area(E(2_000_000)) - area(E(1_000_000)); // the quote is from the current `sold`
    expect(await campaign.quoteCreatorFirstBuy(E(1_000_000))).to.eq(next + (next * 200n) / 10000n);
    // Replaying the scheduled authorization fails (nonce + digest).
    await expect(env.factory.connect(env.creator).createScheduledCampaignAuthorized(sreq, routeAuth)).to.be.reverted;
    await expect(buyTokens(env, campaign, env.alice, E(1000))).to.be.revertedWithCustomError(campaign, "TradingNotOpen");
    await mineAt(launchAt);
    expect(await campaign.currentTradeFeeBps()).to.eq(5000n);
    await mineAt(launchAt + 30);
    expect(await campaign.currentTradeFeeBps()).to.eq(2600n);
    await mineAt(launchAt + 60);
    expect(await campaign.currentTradeFeeBps()).to.eq(200n);
  });

  it("HOLDS: creator escrow cannot be claimed early, by others, or escaped by transferring ownership; releases exactly 1/5 per week after 30d", async () => {
    const { env, campaign, token } = await tradingCoin();
    await campaign.connect(env.creator).transferOwnership(env.bob.address);
    await buyTokens(env, campaign, env.creator, E(1_000_000)); // still escrowed: `creator` is immutable
    expect(await token.balanceOf(env.creator.address)).to.eq(0n);
    expect(await campaign.creatorEscrowTotal()).to.eq(E(1_000_000));
    const t0 = await now();
    await expect(campaign.connect(env.creator).claimCreatorEscrow()).to.be.revertedWithCustomError(campaign, "NothingToClaim");
    await expect(campaign.connect(env.bob).claimCreatorEscrow()).to.be.revertedWithCustomError(campaign, "NotCreator");
    await mineAt(t0 + 30 * DAY - 2);
    await expect(campaign.connect(env.creator).claimCreatorEscrow()).to.be.revertedWithCustomError(campaign, "NothingToClaim");
    await network.provider.send("evm_setNextBlockTimestamp", [t0 + 30 * DAY]);
    await campaign.connect(env.creator).claimCreatorEscrow();
    expect(await token.balanceOf(env.creator.address)).to.eq(E(200_000));
    await mineAt(t0 + 58 * DAY);
    await campaign.connect(env.creator).claimCreatorEscrow();
    expect(await token.balanceOf(env.creator.address)).to.eq(E(1_000_000));
    await expect(campaign.connect(env.creator).claimCreatorEscrow()).to.be.revertedWithCustomError(campaign, "NothingToClaim");
  });

  it("HOLDS: trade signatures cannot be replayed, used by another wallet, or used on another campaign", async () => {
    const env = await deployEvmGen();
    const { campaign: c1 } = await createCoin(env, req());
    const { campaign: c2 } = await createCoin(env, req({ symbol: "TWO" }), { from: env.bob });
    await mineAt(Number(await c2.launchAt()) + 61);
    const amt = E(1000);
    const cost = await c1.quoteBuyExactTokens(amt);
    const a = await signTrade(env.authority, await c1.getAddress(), env.alice.address, 0, amt, cost);
    await c1.connect(env.alice).buyExactTokensAuthorized(amt, cost, a.profile, a.deadline, a.signature, { value: cost });
    await expect(c1.connect(env.alice).buyExactTokensAuthorized(amt, cost, a.profile, a.deadline, a.signature, { value: cost })).to.be.revertedWithCustomError(c1, "RouteAuthReplayed");
    await expect(c1.connect(env.carol).buyExactTokensAuthorized(amt, cost, a.profile, a.deadline, a.signature, { value: cost })).to.be.revertedWithCustomError(c1, "BadRouteAuth");
    await expect(c2.connect(env.alice).buyExactTokensAuthorized(amt, cost, a.profile, a.deadline, a.signature, { value: cost })).to.be.revertedWithCustomError(c2, "BadRouteAuth");
    // profile is signed: switching to OG-linked (different fee split) fails
    await expect(c1.connect(env.alice).buyExactTokensAuthorized(amt, cost, 2, a.deadline, a.signature, { value: cost })).to.be.revertedWithCustomError(c1, "BadRouteAuth");
    // a create authorization can not be reused by another creator
    const r = req({ symbol: "X3" });
    const auth = await signCreate(env.authority, await env.factory.getAddress(), env.creator.address, r);
    await expect(env.factory.connect(env.carol).createCampaignAuthorized(r, auth)).to.be.revertedWithCustomError(env.factory, "InvalidRouteAuthorization");
  });

  it("HOLDS: the refund callback cannot re-enter the campaign (sell or graduate), so the crossing buy is atomic", async () => {
    const { env, campaign, token } = await tradingCoin();
    const R = await (await ethers.getContractFactory("Audit1Reenterer")).deploy(await campaign.getAddress());
    const addr = await R.getAddress();
    const amt = E(1_000_000);
    const cost = await campaign.quoteBuyExactTokens(amt);
    const b = await signTrade(env.authority, await campaign.getAddress(), addr, 0, amt, cost);
    await R.buy(amt, cost, b.deadline, b.signature, { value: cost }); // exact value: no refund, no callback
    await R.approveAll();
    const s = await signTrade(env.authority, await campaign.getAddress(), addr, 2, E(10), 0n);
    await R.setMode(1, E(10), s.deadline, s.signature);
    const cost2 = await campaign.quoteBuyExactTokens(amt);
    const b2 = await signTrade(env.authority, await campaign.getAddress(), addr, 0, amt, cost2 + 1n);
    await expect(R.buy(amt, cost2 + 1n, b2.deadline, b2.signature, { value: cost2 + 1n })).to.be.revertedWithCustomError(campaign, "NativeTransferFailed");
    await R.setMode(2, 0, 0, "0x");
    const b3 = await signTrade(env.authority, await campaign.getAddress(), addr, 0, amt, cost2 + 1n);
    await expect(R.buy(amt, cost2 + 1n, b3.deadline, b3.signature, { value: cost2 + 1n })).to.be.revertedWithCustomError(campaign, "NativeTransferFailed");
    expect(await token.balanceOf(addr)).to.eq(amt);
  });

  it("HOLDS: rescueExcessNative cannot touch the creator's graduation share or an escrowed protocol fee", async () => {
    const { env, campaign } = await tradingCoin();
    await buyNative(env, campaign, env.alice, E(60));
    await env.creator.sendTransaction({ to: await campaign.getAddress(), value: E(1) }); // donation
    await campaign.graduate();
    const pending = await campaign.pendingCreatorGraduation();
    expect(pending).to.be.gt(0n);
    const excess = await campaign.excessNativeBalance();
    const bal = await ethers.provider.getBalance(await campaign.getAddress());
    expect(bal - excess).to.eq(pending + (await campaign.pendingProtocolGraduationFee()));
    await expect(campaign.connect(env.creator).rescueExcessNative(env.creator.address, excess + 1n)).to.be.revertedWithCustomError(campaign, "ExcessNativeUnavailable");
    await campaign.connect(env.creator).rescueExcessNative(env.creator.address, excess);
    expect(await ethers.provider.getBalance(await campaign.getAddress())).to.eq(pending + (await campaign.pendingProtocolGraduationFee()));
  });

  it("HOLDS: the creator first buy is once-only, capped at 10% supply and 50% of target, and a create cannot relay it later", async () => {
    const env = await deployEvmGen();
    const tooBig = req({ firstBuyTokens: E(100_000_001), firstBuyMaxCost: E(100) });
    await expect(createCoin(env, tooBig, { value: E(100) })).to.be.reverted;
    const { campaign } = await createCoin(env, req({ firstBuyTokens: E(100_000_000), firstBuyMaxCost: E(100) }), { value: E(100) });
    // 10% of supply costs ~5.5 BNB here, far under 50% of the 50 BNB target; it did not trigger Pending.
    expect(await campaign.graduationPending()).to.eq(false);
    await expect(campaign.connect(env.creator).creatorFirstBuy(1n, { value: 0 })).to.be.revertedWithCustomError(campaign, "OnlyFactory");
    expect(await campaign.creatorEscrowTotal()).to.eq(0n);
  });
});
