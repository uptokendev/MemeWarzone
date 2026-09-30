import { expect } from "chai";
import { ethers } from "hardhat";

// C1: TreasuryRouterV4 = V3 with creator 560 bps. Spec docs/evm-launch/spec/C1-C6-fees.md.
const BPS = 10_000n;
const PROFILES = { linked: 0, unlinked: 1, og: 2 } as const;
const TABLE: Record<number, { league: bigint; creator: bigint; recruiter: bigint; airdrop: bigint; squad: bigint; protocol: bigint }> = {
  0: { league: 3750n, creator: 560n, recruiter: 1250n, airdrop: 0n, squad: 250n, protocol: 4190n },
  1: { league: 3750n, creator: 560n, recruiter: 0n, airdrop: 1500n, squad: 0n, protocol: 4190n },
  2: { league: 3750n, creator: 560n, recruiter: 1500n, airdrop: 0n, squad: 250n, protocol: 3940n },
};

function sum(a: any) {
  return a.league + a.creator + a.recruiter + a.airdrop + a.squad + a.protocol;
}

async function deploy() {
  const [admin] = await ethers.getSigners();
  const Receiver = await ethers.getContractFactory("TreasuryRouterV3ReceiverMock");
  const weekly = await Receiver.deploy();
  const monthly = await Receiver.deploy();
  const recruiter = await Receiver.deploy();
  const protocol = await Receiver.deploy();
  const community = await (await ethers.getContractFactory("CommunityRewardsVaultV3Mock")).deploy();
  const v4 = await (await ethers.getContractFactory("TreasuryRouterV4")).deploy(admin.address, await weekly.getAddress(), await monthly.getAddress(), 3600);
  const v3 = await (await ethers.getContractFactory("TreasuryRouterV3")).deploy(admin.address, await weekly.getAddress(), await monthly.getAddress(), 3600);
  return { admin, weekly, monthly, recruiter, protocol, community, v4, v3 };
}

describe("evmgen fees: TreasuryRouterV4 (C1)", function () {
  it("pins CREATOR_TRADE_BPS = 560 and splits 1 native exactly per profile", async function () {
    const { v4 } = await deploy();
    expect(await v4.CREATOR_TRADE_BPS()).to.equal(560n);
    const amount = ethers.parseEther("1");
    for (const profile of [0, 1, 2]) {
      const a = await v4.previewTrade(amount, profile);
      const t = TABLE[profile];
      expect(a.league).to.equal((amount * t.league) / BPS);
      expect(a.creator).to.equal((amount * t.creator) / BPS);
      expect(a.recruiter).to.equal((amount * t.recruiter) / BPS);
      expect(a.airdrop).to.equal((amount * t.airdrop) / BPS);
      expect(a.squad).to.equal((amount * t.squad) / BPS);
      expect(a.protocol).to.equal((amount * t.protocol) / BPS);
      expect(sum(a)).to.equal(amount);
    }
  });

  it("differs from V3 only in creator and protocol, by floor(a*560/1e4) - floor(a*500/1e4); finalize identical", async function () {
    const { v4, v3 } = await deploy();
    let seed = 0x9e3779b97f4a7c15n;
    const amounts = [1n, 17n, 99n, 10_000n, 123_456_789n, ethers.parseEther("0.02"), ethers.parseEther("3.3333"), 2n ** 200n];
    for (let i = 0; i < 40; i++) {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n;
      amounts.push((seed % 10n ** 21n) + 1n);
    }
    for (const amount of amounts) {
      for (const profile of [0, 1, 2]) {
        const a4 = await v4.previewTrade(amount, profile);
        const a3 = await v3.previewTrade(amount, profile);
        const d = (amount * 560n) / BPS - (amount * 500n) / BPS;
        expect(a4.league).to.equal(a3.league);
        expect(a4.recruiter).to.equal(a3.recruiter);
        expect(a4.airdrop).to.equal(a3.airdrop);
        expect(a4.squad).to.equal(a3.squad);
        expect(a4.creator - a3.creator).to.equal(d);
        expect(a3.protocol - a4.protocol).to.equal(d);
        expect(sum(a4)).to.equal(amount); // I1: conserved
        expect(a4.creator).to.equal((amount * 560n) / BPS);
        const f4 = await v4.previewFinalize(amount, profile);
        const f3 = await v3.previewFinalize(amount, profile);
        expect(f4.toString()).to.equal(f3.toString());
      }
    }
  });

  it("routeTrade moves every part to its vault and accrues 5.6% into CreatorRewardsVaultV2", async function () {
    const { admin, weekly, monthly, recruiter, protocol, community, v4 } = await deploy();
    const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
    const v3factory = await (await ethers.getContractFactory("MockUniswapV3FactoryEvmGen")).deploy();
    const vault = await (await ethers.getContractFactory("CreatorRewardsVaultV2")).deploy(
      admin.address, await v4.getAddress(), await weth.getAddress(), 2, await v3factory.getAddress(), 86400,
    );
    const factory = await (await ethers.getContractFactory("MockFactoryEvmGen")).deploy(admin.address);
    await vault.setFactoryOnce(await factory.getAddress());
    await v4.setRecruiterRewardsVault(await recruiter.getAddress());
    await v4.setCommunityRewardsVault(await community.getAddress());
    await v4.setProtocolRevenueVault(await protocol.getAddress());
    await v4.setCreatorRewardsVault(await vault.getAddress());

    // A caller without a choice cannot route (its own call reverts).
    await expect(v4.routeTrade(PROFILES.linked, { value: 1000n })).to.be.revertedWithCustomError(vault, "ChoiceUnset");

    await factory.choose(await vault.getAddress(), admin.address, admin.address, 1, 0);
    for (const profile of [0, 1, 2]) {
      const amount = ethers.parseEther("1.2345");
      const before = {
        weekly: await ethers.provider.getBalance(await weekly.getAddress()),
        monthly: await ethers.provider.getBalance(await monthly.getAddress()),
        recruiter: await ethers.provider.getBalance(await recruiter.getAddress()),
        protocol: await ethers.provider.getBalance(await protocol.getAddress()),
        community: await ethers.provider.getBalance(await community.getAddress()),
        vault: await ethers.provider.getBalance(await vault.getAddress()),
      };
      await v4.routeTrade(profile, { value: amount });
      const p = await v4.previewTrade(amount, profile);
      const league = (await ethers.provider.getBalance(await weekly.getAddress())) - before.weekly + (await ethers.provider.getBalance(await monthly.getAddress())) - before.monthly;
      expect(league).to.equal(p.league);
      expect((await ethers.provider.getBalance(await recruiter.getAddress())) - before.recruiter).to.equal(p.recruiter);
      expect((await ethers.provider.getBalance(await protocol.getAddress())) - before.protocol).to.equal(p.protocol);
      expect((await ethers.provider.getBalance(await community.getAddress())) - before.community).to.equal(p.airdrop + p.squad);
      expect((await ethers.provider.getBalance(await vault.getAddress())) - before.vault).to.equal(p.creator);
    }
    expect(await vault.creatorBalance(admin.address)).to.equal(((ethers.parseEther("1.2345") * 560n) / BPS) * 3n);
    expect(await vault.totalLiabilities()).to.equal(await ethers.provider.getBalance(await vault.getAddress()));
  });
});
