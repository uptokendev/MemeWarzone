import { expect } from "chai";
import { ethers, network } from "hardhat";
import { batchACalls, batchBCalls, deployFeesStack, holderBatchId, holderWeekCalls, nextEpochEnds, PINS, readCaps } from "../scripts/deploy-evm-treasury-router-v4";
import { buildBatch } from "../scripts/make-safe-batch";

// Rehearses scripts/deploy-evm-treasury-router-v4.ts on a throwaway chain: the deployer deploys, the Safe
// executes batch A and batch B exactly as generated, and the end state is the one spec C1 requires.
async function asSafe(safe: string, txs: Array<{ to: string; data: string; value: string }>) {
  await network.provider.send("hardhat_impersonateAccount", [safe]);
  await network.provider.send("hardhat_setBalance", [safe, "0x56BC75E2D63100000"]);
  const signer = await ethers.getSigner(safe);
  for (const tx of txs) await (await signer.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value) })).wait();
  await network.provider.send("hardhat_stopImpersonatingAccount", [safe]);
}

describe("evmgen fees: deploy script + Safe batches (rehearsal)", function () {
  it("pins match the mainnet read of 2026-09-30 and the holder batch id is the runner's", async function () {
    expect(PINS.bscMainnet.chainId).to.equal(56);
    expect(PINS.robinhoodMainnet.chainId).to.equal(4663);
    expect(PINS.bscMainnet.dexKind).to.equal(1);
    expect(PINS.robinhoodMainnet.dexKind).to.equal(2);
    expect(holderBatchId(56, "2026-10-05")).to.equal(ethers.keccak256(ethers.toUtf8Bytes("mwz-weekly-airdrop:56:2026-10-05:airdrop_holders")));
    const ends = nextEpochEnds(Date.parse("2026-09-30T12:00:00Z") / 1000, 2);
    expect(new Date(ends[0] * 1000).toISOString()).to.equal("2026-10-05T00:00:00.000Z");
    expect(() => readCaps(true)).to.throw(/required/);
  });

  it("deploys, then batch A and batch B executed by the Safe leave everything wired", async function () {
    const [deployer, operatorLike] = await ethers.getSigners();
    const safe = ethers.Wallet.createRandom().address;
    const Receiver = await ethers.getContractFactory("TreasuryRouterV3ReceiverMock");
    const weekly = await Receiver.deploy();
    const monthly = await Receiver.deploy();
    const recruiter = await Receiver.deploy();
    const protocol = await Receiver.deploy();
    const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
    const topazFactory = await (await ethers.getContractFactory("MockTopazFactory")).deploy();
    const oldRouter = await (await ethers.getContractFactory("TreasuryRouterV3")).deploy(safe, await weekly.getAddress(), await monthly.getAddress(), 3600);
    const community = await (await ethers.getContractFactory("CommunityRewardsVault")).deploy(safe, await oldRouter.getAddress());
    const oldFactory = await (await ethers.getContractFactory("MockOldFactoryEvmGen")).deploy(safe);
    const pins = {
      ...PINS.bscMainnet,
      safe,
      oldRouter: await oldRouter.getAddress(),
      oldFactory: await oldFactory.getAddress(),
      weekly: await weekly.getAddress(),
      monthly: await monthly.getAddress(),
      recruiter: await recruiter.getAddress(),
      community: await community.getAddress(),
      protocol: await protocol.getAddress(),
      wrappedNative: await weth.getAddress(),
      dexFactory: await topazFactory.getAddress(),
      payoutOperator: operatorLike.address,
    };
    const d = await deployFeesStack(deployer, pins);
    const router = await ethers.getContractAt("TreasuryRouterV4", d.router);
    const vault = await ethers.getContractAt("CreatorRewardsVaultV2", d.vault);
    const dist = await ethers.getContractAt("RewardDistributor", d.holderDistributor);
    expect(await router.admin()).to.equal(safe);
    expect(await vault.admin()).to.equal(safe);
    expect(await dist.owner()).to.equal(safe);
    // The deployer holds no role on anything it deployed.
    await expect(router.setCreatorRewardsVault(d.vault)).to.be.revertedWith("not admin");
    await expect(vault.setOperator(deployer.address, false)).to.be.revertedWithCustomError(vault, "OnlyAdmin");

    // The old V3 router as it is on mainnet: fully wired, serving the community vault.
    const iface = oldRouter.interface;
    await asSafe(safe, [
      { to: pins.oldRouter, data: iface.encodeFunctionData("setRecruiterRewardsVault", [pins.recruiter]), value: "0" },
      { to: pins.oldRouter, data: iface.encodeFunctionData("setCommunityRewardsVault", [pins.community]), value: "0" },
      { to: pins.oldRouter, data: iface.encodeFunctionData("setProtocolRevenueVault", [pins.protocol]), value: "0" },
    ]);
    await oldRouter.routeFinalize(1, { value: 1000n }); // unlinked finalize reaches depositAirdrop today

    const caps = readCaps(false);
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    const a = buildBatch(56, "A", "A", batchACalls(pins, d, caps, now) as any);
    expect(a.transactions.length).to.equal(10); // audit fix F5: no holder batch id is pre-authorized
    await asSafe(safe, a.transactions);
    expect(await oldFactory.createPaused()).to.equal(true);
    expect(await router.recruiterRewardsVault()).to.equal(pins.recruiter);
    expect(await router.communityRewardsVault()).to.equal(pins.community);
    expect(await router.protocolRevenueVault()).to.equal(pins.protocol);
    expect(await router.creatorRewardsVault()).to.equal(d.vault);
    expect(await community.router()).to.equal(d.router);
    expect(await dist.batchOperator()).to.equal(d.vault);
    expect(await vault.holderDistributor()).to.equal(d.holderDistributor);
    expect(await vault.operator()).to.equal(operatorLike.address);
    expect(await vault.maxImpactBps()).to.equal(50n);
    const firstEnd = nextEpochEnds(now, 1)[0];
    const firstId = holderBatchId(56, new Date((firstEnd - 7 * 86400) * 1000).toISOString().slice(0, 10));
    expect((await dist.batchAuthorization(firstId)).authorized).to.equal(false);

    // The new factory and its locker (core builder); here a stand-in factory pointing at a real locker.
    const locker = await (await ethers.getContractFactory("PermanentLpLocker")).deploy(deployer.address);
    const factory = await (await ethers.getContractFactory("MockFactoryEvmGen")).deploy(await locker.getAddress());
    const quote = await (await ethers.getContractFactory("MockERC20")).deploy("Q", "Q", 1n, deployer.address);
    const routePair = await (await ethers.getContractFactory("MockTopazPairEvmGen")).deploy();
    await topazFactory.setPool(await quote.getAddress(), await weth.getAddress(), false, await routePair.getAddress());
    const b = buildBatch(56, "B", "B", batchBCalls(d, await factory.getAddress(), await locker.getAddress(), [{ quote: await quote.getAddress(), feeTier: 0 }]) as any);
    await asSafe(safe, b.transactions);
    expect(await router.authorizedLpLocker(await locker.getAddress())).to.equal(true);
    expect(await router.permanentLpLocker()).to.equal(await locker.getAddress());
    expect(await vault.factory()).to.equal(await factory.getAddress());
    expect(await vault.locker()).to.equal(await locker.getAddress());
    expect(await vault.quoteRoutePool(await quote.getAddress())).to.equal(await routePair.getAddress());

    // Weekly holder flow (batch H): a holders coin accrues, the operator proposes, the Safe approves the exact
    // root + total and authorizes the id, and the batch executes after the veto window.
    const campaign = await (await ethers.getContractFactory("MockCampaignEvmGen")).deploy(d.router, 10n ** 20n);
    await factory.addCampaign(await campaign.getAddress());
    await factory.choose(d.vault, await campaign.getAddress(), deployer.address, 2 /* Holders */, 0);
    await campaign.payFee(1, { value: 10n ** 18n });
    const c = await campaign.getAddress();
    const total = await vault.holderBalance(c);
    const root = ethers.keccak256("0x1234");
    await vault.connect(operatorLike).proposeHolderBatch(firstId, root, 0, [c], [total]);
    await expect(vault.connect(operatorLike).executeHolderBatch(firstId)).to.be.revertedWithCustomError(vault, "NotApproved");
    expect(() => holderWeekCalls(d, { batchId: firstId, root, total: caps.holderBatchAuthorizationMax + 1n }, caps, now)).to.throw(/above/);
    const tNow = (await ethers.provider.getBlock("latest"))!.timestamp;
    const h = buildBatch(56, "H", "H", holderWeekCalls(d, { batchId: firstId, root, total }, caps, tNow) as any);
    await asSafe(safe, h.transactions);
    expect((await dist.batchAuthorization(firstId)).maxAmount).to.equal(total);
    await network.provider.send("evm_increaseTime", [86400]);
    await network.provider.send("evm_mine");
    await vault.connect(operatorLike).executeHolderBatch(firstId);
    expect((await dist.batches(firstId)).totalFunded).to.equal(total);

    // After cutover the old router's unlinked routes revert (the community vault now answers only V4), which
    // is why batch A pauses the old factory first.
    await expect(oldRouter.routeFinalize(1, { value: 1000n })).to.be.revertedWith("airdrop route failed");
  });
});
