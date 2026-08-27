import { expect } from "chai";
import { ethers } from "hardhat";

const STAKE = ethers.parseEther("1");

async function deploy() {
  const [owner, resolver, protocol, mwl, charity, alice, bob, donor] = await ethers.getSigners();
  const Factory = await ethers.getContractFactory("ArenaWarPoolTreasury");
  const treasury = await Factory.deploy(
    owner.address,
    resolver.address,
    protocol.address,
    mwl.address,
    charity.address,
  );
  await treasury.waitForDeployment();
  return { treasury, owner, resolver, protocol, mwl, charity, alice, bob, donor };
}

async function signResolve(
  treasury: Awaited<ReturnType<typeof deploy>>["treasury"],
  resolver: Awaited<ReturnType<typeof deploy>>["resolver"],
  poolId: string,
  winnerPayout: string,
  stakeTotal: bigint,
  supportTotal: bigint,
  buyInTotal: bigint,
  deadline: number,
) {
  const network = await ethers.provider.getNetwork();
  return resolver.signTypedData(
    {
      name: "ArenaWarPoolTreasury",
      version: "1",
      chainId: network.chainId,
      verifyingContract: await treasury.getAddress(),
    },
    {
      ResolvePool: [
        { name: "poolId", type: "bytes32" },
        { name: "winnerPayout", type: "address" },
        { name: "stakeTotal", type: "uint256" },
        { name: "supportTotal", type: "uint256" },
        { name: "buyInTotal", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    { poolId, winnerPayout, stakeTotal, supportTotal, buyInTotal, deadline },
  );
}

describe("ArenaWarPoolTreasury", function () {
  it("holds stakes and support, then pull-claims 85/5/10 to winner/protocol/MWL", async () => {
    const { treasury, resolver, protocol, mwl, alice, bob, donor } = await deploy();
    const poolId = ethers.id("battle-1");
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await treasury.openBattlePool(poolId, alice.address, bob.address, STAKE, now + 3600, now + 7200);
    await treasury.connect(alice).depositStake(poolId, { value: STAKE });
    await treasury.connect(bob).depositStake(poolId, { value: STAKE });
    await treasury.connect(donor).donateSupport(poolId, { value: ethers.parseEther("0.4") });

    const prize = STAKE + STAKE + ethers.parseEther("0.4");
    const protocolAmt = (prize * 500n) / 10_000n;
    const mwlAmt = (prize * 1000n) / 10_000n;
    const winnerAmt = prize - protocolAmt - mwlAmt;
    const deadline = now + 10_000;
    const sig = await signResolve(treasury, resolver, poolId, alice.address, STAKE + STAKE, ethers.parseEther("0.4"), 0n, deadline);
    await treasury.resolve(poolId, alice.address, deadline, sig);

    const aliceBefore = await ethers.provider.getBalance(alice.address);
    const tx = await treasury.connect(alice).claimWinner(poolId);
    const receipt = await tx.wait();
    const gas = (receipt?.gasUsed ?? 0n) * (receipt?.gasPrice ?? 0n);
    const aliceAfter = await ethers.provider.getBalance(alice.address);
    expect(aliceAfter - aliceBefore + gas).to.eq(winnerAmt);

    const protocolBefore = await ethers.provider.getBalance(protocol.address);
    await treasury.claimProtocol(poolId);
    expect((await ethers.provider.getBalance(protocol.address)) - protocolBefore).to.eq(protocolAmt);

    const mwlBefore = await ethers.provider.getBalance(mwl.address);
    await treasury.claimMwl(poolId);
    expect((await ethers.provider.getBalance(mwl.address)) - mwlBefore).to.eq(mwlAmt);

    await expect(treasury.connect(donor).claimWinner(poolId)).to.be.revertedWithCustomError(treasury, "NotOwner");
    await expect(treasury.connect(alice).claimWinner(poolId)).to.be.revertedWithCustomError(treasury, "NothingToClaim");
  });

  it("refunds stakes on timeout and never lets supporters claim", async () => {
    const { treasury, alice, bob, donor } = await deploy();
    const poolId = ethers.id("battle-timeout");
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await treasury.openBattlePool(poolId, alice.address, bob.address, STAKE, now + 60, now + 120);
    await treasury.connect(alice).depositStake(poolId, { value: STAKE });
    await treasury.connect(donor).donateSupport(poolId, { value: ethers.parseEther("0.1") });
    await ethers.provider.send("evm_increaseTime", [61]);
    await ethers.provider.send("evm_mine", []);
    const before = await ethers.provider.getBalance(alice.address);
    const tx = await treasury.connect(alice).refundStake(poolId);
    const receipt = await tx.wait();
    const gas = (receipt?.gasUsed ?? 0n) * (receipt?.gasPrice ?? 0n);
    expect((await ethers.provider.getBalance(alice.address)) - before + gas).to.eq(STAKE);
    await expect(treasury.connect(donor).claimWinner(poolId)).to.be.revertedWithCustomError(treasury, "InvalidState");
  });

  it("on a tie sends 85% of the prize to charity, not supporters", async () => {
    const { treasury, resolver, charity, alice, bob, donor } = await deploy();
    const poolId = ethers.id("battle-tie");
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await treasury.openBattlePool(poolId, alice.address, bob.address, STAKE, now + 3600, now + 7200);
    await treasury.connect(alice).depositStake(poolId, { value: STAKE });
    await treasury.connect(bob).depositStake(poolId, { value: STAKE });
    await treasury.connect(donor).donateSupport(poolId, { value: ethers.parseEther("1") });
    const prize = STAKE + STAKE + ethers.parseEther("1");
    const deadline = now + 10_000;
    const sig = await signResolve(treasury, resolver, poolId, ethers.ZeroAddress, STAKE + STAKE, ethers.parseEther("1"), 0n, deadline);
    await treasury.resolve(poolId, ethers.ZeroAddress, deadline, sig);
    const charityAmt = prize - (prize * 500n) / 10_000n - (prize * 1000n) / 10_000n;
    const before = await ethers.provider.getBalance(charity.address);
    await treasury.claimCharity(poolId);
    expect((await ethers.provider.getBalance(charity.address)) - before).to.eq(charityAmt);
    await expect(treasury.connect(alice).claimWinner(poolId)).to.be.revertedWithCustomError(treasury, "NotOwner");
  });

  it("rejects bare native transfers", async () => {
    const { treasury, alice } = await deploy();
    await expect(
      alice.sendTransaction({ to: await treasury.getAddress(), value: STAKE }),
    ).to.be.revertedWithCustomError(treasury, "InvalidAmount");
  });
});
