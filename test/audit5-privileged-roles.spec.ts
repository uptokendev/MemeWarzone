/**
 * Audit 5: privileged roles over users' money in the fee stack (TreasuryRouterV4, CreatorRewardsVaultV2,
 * RewardDistributor) and the campaign's live dependencies.
 *
 *   npx hardhat test test/audit5-privileged-roles.spec.ts
 */
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { deployFactoryWithLocker } from "../scripts/lib/deployFactoryWithLocker";

const E = (v: string | number) => ethers.parseEther(String(v));
const coder = ethers.AbiCoder.defaultAbiCoder();

async function now() {
  return Number((await ethers.provider.getBlock("latest"))!.timestamp);
}
async function increase(s: number) {
  await network.provider.send("evm_increaseTime", [s]);
  await network.provider.send("evm_mine");
}

function hashReq(r: any) {
  const k = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));
  return ethers.keccak256(
    coder.encode(
      ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "uint256", "uint256", "uint256", "uint8", "uint8"],
      [k(r.name), k(r.symbol), k(r.logoURI), k(r.xAccount), k(r.website), k(r.extraLink), r.graduationTarget, r.firstBuyTokens, r.firstBuyMaxCost, r.feeChoice, r.feeCreatorPct],
    ),
  );
}

/** Real TreasuryRouterV4 + CreatorRewardsVaultV2 + LaunchFactory (as BnbCreatorFeeGeneration.spec.ts). */
async function realFeeStack() {
  const [safe, creator, buyer] = await ethers.getSigners();
  const wbnb = await (await ethers.getContractFactory("MockWBNB")).deploy();
  const topazFactory = await (await ethers.getContractFactory("MockTopazFactory")).deploy();
  const topazRouter = await (await ethers.getContractFactory("MockTopazRouter")).deploy(await topazFactory.getAddress(), await wbnb.getAddress());
  const feed = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8);
  const t = await now();
  await feed.setRoundData(1n, ethers.parseUnits("1", 8), t, t, 1n);
  const oracle = await (await ethers.getContractFactory("GraduationOracle")).deploy(await feed.getAddress(), 10 ** 9);
  const Receiver = await ethers.getContractFactory("TreasuryRouterV3ReceiverMock");
  const weekly = await Receiver.deploy();
  const monthly = await Receiver.deploy();
  const recruiter = await Receiver.deploy();
  const router = await (await ethers.getContractFactory("TreasuryRouterV4")).deploy(safe.address, await weekly.getAddress(), await monthly.getAddress(), 3600);
  const community = await (await ethers.getContractFactory("CommunityRewardsVaultV3Mock")).deploy();
  const protocol = await (await ethers.getContractFactory("ProtocolRevenueVault")).deploy(safe.address);
  const Vault = await ethers.getContractFactory("CreatorRewardsVaultV2");
  const vault = await Vault.deploy(safe.address, await router.getAddress(), await wbnb.getAddress(), 1, await topazFactory.getAddress(), 86400);
  await router.setRecruiterRewardsVault(await recruiter.getAddress());
  await router.setCommunityRewardsVault(await community.getAddress());
  await router.setProtocolRevenueVault(await protocol.getAddress());
  await router.setCreatorRewardsVault(await vault.getAddress());
  const impl = await (await ethers.getContractFactory("LaunchCampaign")).deploy();
  const factory = (
    await deployFactoryWithLocker({
      factoryName: "LaunchFactory",
      args: [await topazRouter.getAddress(), await router.getAddress(), await impl.getAddress(), await oracle.getAddress()],
    })
  ).factory;
  await vault.setFactoryOnce(await factory.getAddress());
  const adapter = await (await ethers.getContractFactory("MockGraduationAdapterEvmGen")).deploy(await topazFactory.getAddress(), await wbnb.getAddress());
  await adapter.setLocker(await factory.permanentLpLocker());
  await factory.setNativeGraduationAdapter(await adapter.getAddress());
  await factory.setLaunchTokenDeployer(await (await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy()).getAddress());
  await factory.setRouteAuthority(safe.address);
  await factory.setRequireAuthorizedTrading(false);
  await factory.setConfig({ totalSupply: E(1000), curveBps: 5000, liquidityTokenBps: 4000, basePrice: 10n ** 12n, priceSlope: 10n ** 13n, graduationTarget: E(1) });
  await factory.enableLive();

  const req = { name: "A5", symbol: "A5", logoURI: "ipfs://a5", xAccount: "", website: "", extraLink: "", graduationTarget: 0n, firstBuyTokens: 0n, firstBuyMaxCost: 0n, feeChoice: 1, feeCreatorPct: 0 };
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const deadline = (await now()) + 3600;
  const payload = ethers.keccak256(
    coder.encode(["string", "uint256", "address", "address", "bytes32", "uint8", "uint8", "uint64"], ["MWZ_CREATE_ROUTE_AUTH", chainId, await factory.getAddress(), creator.address, hashReq(req), 1, 1, deadline]),
  );
  const signature = await safe.signMessage(ethers.getBytes(payload));
  await factory.connect(creator).createCampaignAuthorized(req, { tradeRouteProfile: 1, finalizeRouteProfile: 1, deadline, signature });
  const info = await factory.getCampaign(0);
  const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
  const token = await ethers.getContractAt("LaunchToken", info.token);
  await increase(120); // past the anti-sniper window
  return { safe, creator, buyer, router, vault, factory, campaign, token, wbnb, topazFactory, Vault };
}

describe("audit5: privileged roles over user funds", function () {
  it("HOLDS (was EXPLOIT, Safe footgun): TreasuryRouterV4.creatorRewardsVault cannot be rotated, so buys AND sells on existing campaigns keep working", async () => {
    const f = await realFeeStack();
    const amount = E(10);
    const cost = await f.campaign.quoteBuyExactTokens(amount);
    await f.campaign.connect(f.buyer).buyExactTokens(amount, cost, { value: cost });
    expect(await f.token.balanceOf(f.buyer.address)).to.eq(amount);

    // The attack step: a routine-looking admin rotation (e.g. deploying a fixed vault).
    const v2 = await f.Vault.deploy(f.safe.address, await f.router.getAddress(), await f.wbnb.getAddress(), 1, await f.topazFactory.getAddress(), 86400);
    await v2.setFactoryOnce(await f.factory.getAddress());
    // Fix: there is no propose/accept for the creator vault any more, and the direct setter is set-once.
    const rotate = new ethers.Interface(["function proposeCreatorRewardsVault(address)", "function acceptCreatorRewardsVault()"]);
    await expect(f.safe.sendTransaction({ to: await f.router.getAddress(), data: rotate.encodeFunctionData("proposeCreatorRewardsVault", [await v2.getAddress()]) })).to.be.reverted;
    await increase(3601);
    await expect(f.safe.sendTransaction({ to: await f.router.getAddress(), data: rotate.encodeFunctionData("acceptCreatorRewardsVault", []) })).to.be.reverted;
    await expect(f.router.setCreatorRewardsVault(await v2.getAddress())).to.be.revertedWith("already set");
    expect(await f.router.creatorRewardsVault()).to.eq(await f.vault.getAddress());

    // The holder can still exit the curve and buy more.
    await f.token.connect(f.buyer).approve(await f.campaign.getAddress(), amount);
    await f.campaign.connect(f.buyer).sellExactTokens(amount / 2n, 0);
    const small = amount / 10n;
    const cost2 = await f.campaign.quoteBuyExactTokens(small);
    await f.campaign.connect(f.buyer).buyExactTokens(small, cost2, { value: cost2 });
    expect(await f.vault.isKeep(await f.campaign.getAddress())).to.eq(true);
    // The unused vault still refuses a choice from anyone but its factory.
    await expect(v2.setCampaignChoice(await f.campaign.getAddress(), f.creator.address, 1, 0)).to.be.revertedWithCustomError(v2, "OnlyFactory");
  });

  it("EXPLOIT (single EOA key): the vault payout operator proposes a holder root that pays itself; it executes after 24 h unless the Safe vetoes", async () => {
    const [safe, routerEoa, operator, creator] = await ethers.getSigners();
    const wbnb = await (await ethers.getContractFactory("MockWBNB")).deploy();
    const topazFactory = await (await ethers.getContractFactory("MockTopazFactory")).deploy();
    const lockerStandIn = await (await ethers.getContractFactory("AcceptingReceiver")).deploy();
    const vault = await (await ethers.getContractFactory("CreatorRewardsVaultV2")).deploy(safe.address, routerEoa.address, await wbnb.getAddress(), 1, await topazFactory.getAddress(), 86400);
    const factory = await (await ethers.getContractFactory("MockFactoryEvmGen")).deploy(await lockerStandIn.getAddress());
    await vault.setFactoryOnce(await factory.getAddress());
    const campaign = ethers.Wallet.createRandom().address;
    await factory.addCampaign(campaign);
    await factory.choose(await vault.getAddress(), campaign, creator.address, 2 /* Holders */, 0);
    // A week of holder-share trade fees accrues.
    await vault.connect(routerEoa).accrueTradeFee(campaign, { value: E(9) });

    // Safe batch A, exactly as deploy-evm-treasury-router-v4.ts builds it: distributor operator = vault,
    // operator + caps, and 12 weeks of batch ids authorized in advance by id and max amount only (no root).
    const distributor = await (await ethers.getContractFactory("RewardDistributor")).deploy(safe.address);
    await distributor.setBatchOperator(await vault.getAddress());
    await vault.setHolderDistributorOnce(await distributor.getAddress());
    await vault.setOperator(operator.address, false);
    await vault.setCaps(E(1), E(10), 6 * 3600, 50, E(32));
    const batchId = ethers.keccak256(ethers.toUtf8Bytes("mwz-weekly-airdrop:56:2026-10-05:airdrop_holders"));
    const t = await now();
    await distributor.authorizeBatch(batchId, E(32), t, t + 30 * 86400);

    // Operator key: a one-leaf tree paying itself everything.
    const amount = E(9);
    const leaf = ethers.keccak256(ethers.concat([ethers.keccak256(coder.encode(["address", "uint256"], [operator.address, amount]))]));
    await vault.connect(operator).proposeHolderBatch(batchId, leaf, 0, [campaign], [amount]);
    await increase(86400);
    await vault.connect(operator).executeHolderBatch(batchId);
    const before = await ethers.provider.getBalance(operator.address);
    const tx = await distributor.connect(operator).claim(batchId, amount, []);
    const rc = await tx.wait();
    const gas = rc!.gasUsed * rc!.gasPrice;
    expect((await ethers.provider.getBalance(operator.address)) + gas - before).to.eq(amount);
    expect(await vault.holderBalance(campaign)).to.eq(0n);
  });

  it("HOLDS: the vault admin cannot pull liabilities (rescue is excess-only); only the operator path moves holder money", async () => {
    const [safe, routerEoa, , creator] = await ethers.getSigners();
    const wbnb = await (await ethers.getContractFactory("MockWBNB")).deploy();
    const topazFactory = await (await ethers.getContractFactory("MockTopazFactory")).deploy();
    const lockerStandIn = await (await ethers.getContractFactory("AcceptingReceiver")).deploy();
    const vault = await (await ethers.getContractFactory("CreatorRewardsVaultV2")).deploy(safe.address, routerEoa.address, await wbnb.getAddress(), 1, await topazFactory.getAddress(), 86400);
    const factory = await (await ethers.getContractFactory("MockFactoryEvmGen")).deploy(await lockerStandIn.getAddress());
    await vault.setFactoryOnce(await factory.getAddress());
    const campaign = ethers.Wallet.createRandom().address;
    await factory.choose(await vault.getAddress(), campaign, creator.address, 1, 0);
    await vault.connect(routerEoa).accrueTradeFee(campaign, { value: E(3) });
    await expect(vault.rescueExcessNative(safe.address, 1n)).to.be.revertedWithCustomError(vault, "Insufficient");
    await expect(vault.setFactoryOnce(await factory.getAddress())).to.be.revertedWithCustomError(vault, "AlreadySet");
    await expect(vault.connect(routerEoa).setFactoryOnce(await factory.getAddress())).to.be.revertedWithCustomError(vault, "OnlyAdmin");
  });

  it("INFO: the RiskRegistry owner can freeze one holder's exit from the curve indefinitely", async () => {
    const f = await realFeeStack();
    // campaigns snapshot the registry at init; wire one, then create a second coin
    const risk = await (await ethers.getContractFactory("RiskRegistry")).deploy();
    await f.factory.setRegistries(ethers.ZeroAddress, await risk.getAddress());
    const [safe, creator, buyer, other] = await ethers.getSigners();
    const req = { name: "A6", symbol: "A6", logoURI: "ipfs://a6", xAccount: "", website: "", extraLink: "", graduationTarget: 0n, firstBuyTokens: 0n, firstBuyMaxCost: 0n, feeChoice: 1, feeCreatorPct: 0 };
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const deadline = (await now()) + 3600;
    const payload = ethers.keccak256(
      coder.encode(["string", "uint256", "address", "address", "bytes32", "uint8", "uint8", "uint64"], ["MWZ_CREATE_ROUTE_AUTH", chainId, await f.factory.getAddress(), other.address, hashReq(req), 1, 1, deadline]),
    );
    const signature = await safe.signMessage(ethers.getBytes(payload));
    await f.factory.connect(other).createCampaignAuthorized(req, { tradeRouteProfile: 1, finalizeRouteProfile: 1, deadline, signature });
    const c = await ethers.getContractAt("LaunchCampaign", (await f.factory.getCampaign(1)).campaign);
    const tk = await ethers.getContractAt("LaunchToken", (await f.factory.getCampaign(1)).token);
    await increase(120);
    const cost = await c.quoteBuyExactTokens(E(5));
    await c.connect(buyer).buyExactTokens(E(5), cost, { value: cost });
    await risk.setWalletRisk(buyer.address, 9, true);
    await tk.connect(buyer).approve(await c.getAddress(), E(5));
    await expect(c.connect(buyer).sellExactTokens(E(5), 0)).to.be.revertedWithCustomError(risk, "WalletRestricted");
    // and the token cannot be moved to another wallet before graduation
    await expect(tk.connect(buyer).transfer(creator.address, 1n)).to.be.revertedWithCustomError(tk, "TradingNotEnabled");
  });
});
