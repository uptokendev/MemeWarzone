import { expect } from "chai";
import { ethers } from "hardhat";
import type { LaunchCampaign, LaunchFactory, LaunchToken } from "../typechain-types";
import { deployRoutedLaunchFactory } from "./helpers/deployRouting";

function request(overrides: Record<string, unknown> = {}) {
  return {
    name: "Meme Launch",
    symbol: "MLA",
    logoURI: "ipfs://logo",
    xAccount: "",
    website: "",
    extraLink: "",
    basePrice: 0,
    priceSlope: 0,
    graduationTarget: 0,
    firstBuyTokens: 0n,
    firstBuyMaxCost: 0n,
    feeChoice: 1,
    feeCreatorPct: 0,
    lpReceiver: ethers.ZeroAddress,
    ...overrides,
  };
}

describe("Launchpad end-to-end", function () {
  async function createCampaign(factory: LaunchFactory, creator: any, overrides: Record<string, unknown> = {}) {
    await factory.connect(creator).createCampaign(request(overrides) as any);
    const info = await factory.getCampaign((await factory.campaignsCount()) - 1n);
    const campaign = (await ethers.getContractAt("LaunchCampaign", info.campaign)) as unknown as LaunchCampaign;
    const token = (await ethers.getContractAt("LaunchToken", info.token)) as unknown as LaunchToken;
    return { info, campaign, token };
  }

  it("deploys factory with default config and creates a campaign with correct params", async () => {
    const [owner, creator] = await ethers.getSigners();
    const { factory } = await deployRoutedLaunchFactory(owner);

    // EVM launch generation defaults (C5 §2): 1e27 supply, 70% curve / 28% liquidity / 2% creator
    // reserve, base 1e9, slope 1080 on a Topaz V2 router (850 on Uniswap V3), $30k target.
    const cfg = await factory.config();
    expect(cfg.totalSupply).to.equal(ethers.parseUnits("1000000000", 18));
    expect(cfg.curveBps).to.equal(7000n);
    expect(cfg.liquidityTokenBps).to.equal(2800n);
    expect(cfg.basePrice).to.equal(1_000_000_000n);
    expect(cfg.priceSlope).to.equal(1080n);
    expect(cfg.graduationTarget).to.equal(ethers.parseEther("30000"));
    expect(await factory.FACTORY_GENERATION()).to.equal(6n);

    // The fixture oracle reads $1/native; the $30k default is above what the curve raises at $1
    // (TargetOutOfRangeAtPrice), so price native at $600 like the generation's own fixture.
    const oracle = await ethers.getContractAt("GraduationOracle", await factory.graduationOracle());
    const feed = await ethers.getContractAt("MockUsdPriceFeed", await oracle.priceFeed());
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await feed.setRoundData(2n, 600n * 10n ** 8n, now, now, 2n);

    await factory.enableLive();
    const { info, campaign, token } = await createCampaign(factory, creator);

    expect(info.creator).to.equal(creator.address);
    expect(info.name).to.equal("Meme Launch");
    expect(info.symbol).to.equal("MLA");
    expect(info.logoURI).to.equal("ipfs://logo");
    expect(await campaign.graduationAdapter()).to.equal(await factory.nativeGraduationAdapter());
    expect(await campaign.graduationAdapter()).to.not.equal(ethers.ZeroAddress);
    expect(await campaign.graduationQuoteToken()).to.equal(ethers.ZeroAddress);
    expect(await campaign.feeRecipient()).to.equal(await factory.feeRecipient());
    expect(await campaign.graduationTarget()).to.equal(cfg.graduationTarget);
    expect(await campaign.owner()).to.equal(creator.address);
    expect(await campaign.totalSupply()).to.equal(cfg.totalSupply);
    expect(await campaign.curveSupply()).to.equal((cfg.totalSupply * cfg.curveBps) / 10_000n);
    expect(await campaign.liquiditySupply()).to.equal((cfg.totalSupply * cfg.liquidityTokenBps) / 10_000n);
    expect(await campaign.creatorReserve()).to.equal(cfg.totalSupply - (await campaign.curveSupply()) - (await campaign.liquiditySupply()));
    expect(await token.name()).to.equal("Meme Launch");
    expect(await token.symbol()).to.equal("MLA");
  });
});
