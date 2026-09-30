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
  firstBuyTokens: 0n,
  firstBuyMaxCost: 0n,
  feeChoice: 1,
  feeCreatorPct: 0,
});

// Launch generation: create refuses a USD target above 95% of what the whole curve raises at the oracle
// price (TargetOutOfRangeAtPrice). The core fixture's tiny curve raises ~1.25 native at $1, so the
// explicit-threshold tests run on the generation's production V2 curve with native at $600
// (full curve ~264.6 native = ~$158.8k).
async function useProductionCurve(fixture: any, graduationTarget = ethers.parseEther("30000")) {
  const { factory, owner, priceFeed } = fixture;
  await factory.connect(owner).setConfig({
    totalSupply: ethers.parseEther("1000000000"),
    curveBps: 7000n,
    liquidityTokenBps: 2800n,
    basePrice: 1_000_000_000n,
    priceSlope: 1080n,
    graduationTarget,
  });
  const block = await ethers.provider.getBlock("latest");
  const now = BigInt(block!.timestamp);
  await priceFeed.setRoundData(2n, ethers.parseUnits("600", 8), now, now, 2n);
}

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
    const fixture = await deployCoreFixture();
    const { factory, creator } = fixture;
    await useProductionCurve(fixture);
    const { chainId } = await ethers.provider.getNetwork();

    expect(chainId).to.eq(31337n);
    expect(await factory.isGraduationTargetAllowed(arbitrary)).to.eq(true);

    await factory.connect(creator).createCampaign(req(arbitrary, "Local Only", "LOCAL") as any);
    const info = await factory.getCampaign(0n);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
    expect(await campaign.graduationTarget()).to.eq(arbitrary);
  });

  it("accepts each approved explicit threshold in the local test environment", async () => {
    const fixture = await deployCoreFixture();
    const { factory, creator } = fixture;
    await useProductionCurve(fixture);
    const approved = [six, fifteenK, thirtyK, fiftyK];

    for (let index = 0; index < approved.length; index += 1) {
      await factory.connect(creator).createCampaign(req(approved[index], `Threshold ${index}`, `T${index}`) as any);
      const info = await factory.getCampaign(BigInt(index));
      const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
      expect(await campaign.graduationTarget()).to.eq(approved[index]);
    }
  });

  it("keeps graduationTarget 0 as the factory-configured default", async () => {
    const fixture = await deployCoreFixture();
    const { factory, creator } = fixture;
    await useProductionCurve(fixture, thirtyK);
    expect((await factory.config()).graduationTarget).to.eq(thirtyK);

    await factory.connect(creator).createCampaign(req(0n, "Default", "DFLT") as any);
    const info = await factory.getCampaign(0n);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
    expect(await campaign.graduationTarget()).to.eq(thirtyK);
  });
});
