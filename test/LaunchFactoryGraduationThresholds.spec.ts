import { expect } from "chai";
import { ethers } from "hardhat";
import { deployCoreFixture } from "./fixtures/core";

const req = (graduationTarget: bigint, name = "Threshold", symbol = "THR") => ({
  name,
  symbol,
  logoURI: "ipfs://logo",
  xAccount: "",
  website: "",
  extraLink: "",
  graduationTarget,
});

describe("LaunchFactory graduation threshold policy", function () {
  const six = ethers.parseEther("6");
  const fifteenK = ethers.parseEther("15000");
  const thirtyK = ethers.parseEther("30000");
  const fiftyK = ethers.parseEther("50000");
  const arbitrary = ethers.parseEther("12345");

  it("allows only 15k, 30k and 50k on BNB mainnet", async () => {
    const { factory } = await deployCoreFixture();

    expect(await factory.isGraduationTargetAllowedForChain(56, fifteenK)).to.eq(true);
    expect(await factory.isGraduationTargetAllowedForChain(56, thirtyK)).to.eq(true);
    expect(await factory.isGraduationTargetAllowedForChain(56, fiftyK)).to.eq(true);
    expect(await factory.isGraduationTargetAllowedForChain(56, six)).to.eq(false);
    expect(await factory.isGraduationTargetAllowedForChain(56, arbitrary)).to.eq(false);
  });

  it("also allows the $6 testing threshold on BNB and Robinhood testnets", async () => {
    const { factory } = await deployCoreFixture();

    for (const chainId of [97, 46630]) {
      expect(await factory.isGraduationTargetAllowedForChain(chainId, six)).to.eq(true);
      expect(await factory.isGraduationTargetAllowedForChain(chainId, fifteenK)).to.eq(true);
      expect(await factory.isGraduationTargetAllowedForChain(chainId, thirtyK)).to.eq(true);
      expect(await factory.isGraduationTargetAllowedForChain(chainId, fiftyK)).to.eq(true);
      expect(await factory.isGraduationTargetAllowedForChain(chainId, arbitrary)).to.eq(false);
    }
  });

  it("keeps unsupported targets rejected by the production chain policies", async () => {
    const { factory } = await deployCoreFixture();

    expect(await factory.isGraduationTargetAllowedForChain(56, arbitrary)).to.eq(false);
    expect(await factory.isGraduationTargetAllowedForChain(97, arbitrary)).to.eq(false);
    expect(await factory.isGraduationTargetAllowedForChain(4663, arbitrary)).to.eq(false);
    expect(await factory.isGraduationTargetAllowedForChain(46630, arbitrary)).to.eq(false);
    expect(await factory.isGraduationTargetAllowedForChain(56, six)).to.eq(false);
    expect(await factory.isGraduationTargetAllowedForChain(4663, six)).to.eq(false);
  });

  it("allows legacy fast-test targets only on the local Hardhat chain", async () => {
    const { factory, creator } = await deployCoreFixture();
    const { chainId } = await ethers.provider.getNetwork();

    expect(chainId).to.eq(31337n);
    expect(await factory.isGraduationTargetAllowed(arbitrary)).to.eq(true);

    await factory.connect(creator).createCampaign(req(arbitrary, "Local Only", "LOCAL") as any);
    const info = await factory.getCampaign(0n);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
    expect(await campaign.graduationTarget()).to.eq(arbitrary);
  });

  it("accepts each approved explicit threshold in the local test environment", async () => {
    const { factory, creator } = await deployCoreFixture();
    const approved = [six, fifteenK, thirtyK, fiftyK];

    for (let index = 0; index < approved.length; index += 1) {
      await factory.connect(creator).createCampaign(req(approved[index], `Threshold ${index}`, `T${index}`) as any);
      const info = await factory.getCampaign(BigInt(index));
      const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
      expect(await campaign.graduationTarget()).to.eq(approved[index]);
    }
  });

  it("keeps graduationTarget 0 as the factory-configured default", async () => {
    const { factory, owner, creator } = await deployCoreFixture();
    const current = await factory.config();

    await factory.connect(owner).setConfig({
      totalSupply: current.totalSupply,
      curveBps: current.curveBps,
      liquidityTokenBps: current.liquidityTokenBps,
      basePrice: current.basePrice,
      priceSlope: current.priceSlope,
      graduationTarget: thirtyK,
      liquidityBps: current.liquidityBps,
    });

    await factory.connect(creator).createCampaign(req(0n, "Default", "DFLT") as any);
    const info = await factory.getCampaign(0n);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
    expect(await campaign.graduationTarget()).to.eq(thirtyK);
  });
});
