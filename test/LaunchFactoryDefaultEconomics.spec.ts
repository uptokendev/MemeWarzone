import { expect } from "chai";
import { ethers } from "hardhat";
import { deployFactoryWithLocker } from "../scripts/lib/deployFactoryWithLocker";
import { wireEvmGenTestDoubles } from "./helpers/deployFactory";

const MAX_BPS = 10_000n;
const DEFAULT_TOTAL_SUPPLY = ethers.parseEther("1000000000");
// Launch generation (C5 §2): supply-bound curve 70% / 28% liquidity / 2% creator reserve; the Topaz V2
// (BNB) slope is 1080 (Robinhood V3: 850). liquidityBps no longer exists.
const DEFAULT_CURVE_BPS = 7_000n;
const DEFAULT_LIQUIDITY_TOKEN_BPS = 2_800n;
const DEFAULT_CREATOR_BPS = 200n;
const DEFAULT_BASE_PRICE = 1_000_000_000n;
const DEFAULT_PRICE_SLOPE = 1_080n;
const DEFAULT_GRADUATION_TARGET = ethers.parseEther("30000");

const baseReq = () => ({
  name: "DefaultEconomics",
  symbol: "DEF",
  logoURI: "ipfs://default-economics",
  xAccount: "",
  website: "",
  extraLink: "",
  graduationTarget: 0n,
  firstBuyTokens: 0n,
  firstBuyMaxCost: 0n,
  feeChoice: 1,
  feeCreatorPct: 0,
});

function hashCreateRouteRequest(req: ReturnType<typeof baseReq>) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return ethers.keccak256(
    coder.encode(
      ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "uint256", "uint256", "uint256", "uint8", "uint8"],
      [
        ethers.keccak256(ethers.toUtf8Bytes(req.name)),
        ethers.keccak256(ethers.toUtf8Bytes(req.symbol)),
        ethers.keccak256(ethers.toUtf8Bytes(req.logoURI)),
        ethers.keccak256(ethers.toUtf8Bytes(req.xAccount)),
        ethers.keccak256(ethers.toUtf8Bytes(req.website)),
        ethers.keccak256(ethers.toUtf8Bytes(req.extraLink)),
        req.graduationTarget, req.firstBuyTokens ?? 0n, req.firstBuyMaxCost ?? 0n, req.feeChoice ?? 1, req.feeCreatorPct ?? 0,
      ]
    )
  );
}

async function signCreateRoute(
  factory: any,
  creator: string,
  signer: any,
  req: ReturnType<typeof baseReq>,
  tradeProfile: number,
  finalizeProfile: number,
  deadline: bigint
) {
  const { chainId } = await ethers.provider.getNetwork();
  const digest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256", "address", "address", "bytes32", "uint8", "uint8", "uint64"],
      ["MWZ_CREATE_ROUTE_AUTH", chainId, await factory.getAddress(), creator, hashCreateRouteRequest(req), tradeProfile, finalizeProfile, deadline]
    )
  );
  return signer.signMessage(ethers.getBytes(digest));
}

async function latestTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp);
}

async function deployFactoryWithProductionDefaults() {
  const [deployer] = await ethers.getSigners();

  const V2Factory = await ethers.getContractFactory("MockV2Factory");
  const v2factory = await V2Factory.deploy();
  await v2factory.waitForDeployment();

  const Router = await ethers.getContractFactory("MockRouter");
  const router = await Router.deploy(await v2factory.getAddress(), await deployer.getAddress());
  await router.waitForDeployment();

  const PriceFeed = await ethers.getContractFactory("MockUsdPriceFeed");
  const priceFeed = await PriceFeed.deploy(8);
  await priceFeed.waitForDeployment();
  const now = await latestTimestamp();
  await priceFeed.setRoundData(1n, ethers.parseUnits("600", 8), now, now, 1n);

  const GraduationOracle = await ethers.getContractFactory("GraduationOracle");
  const graduationOracle = await GraduationOracle.deploy(await priceFeed.getAddress(), 3600n);
  await graduationOracle.waitForDeployment();

  // Create registers the fee choice on the treasury router's creator vault: generation router/vault doubles.
  const treasuryRouter = await (await ethers.getContractFactory("MockTreasuryRouterEvmGen")).deploy();
  await treasuryRouter.waitForDeployment();
  const creatorVault = await (await ethers.getContractFactory("MockCreatorRewardsVaultEvmGen")).deploy();
  await creatorVault.waitForDeployment();
  await treasuryRouter.setCreatorRewardsVault(await creatorVault.getAddress());

  const Campaign = await ethers.getContractFactory("LaunchCampaign");
  const implementation = await Campaign.deploy();
  await implementation.waitForDeployment();

  const Factory = await ethers.getContractFactory("LaunchFactory");
  const factory = await (await deployFactoryWithLocker({ factoryName: "LaunchFactory", args: [await router.getAddress(),
    await treasuryRouter.getAddress(),
    await implementation.getAddress(),
    await graduationOracle.getAddress()] })).factory;
  await factory.waitForDeployment();
  await wireEvmGenTestDoubles(factory, await router.getAddress(), await treasuryRouter.getAddress());

  return { deployer, factory };
}

describe("LaunchFactory default economics", function () {
  it("pins the production-candidate factory defaults", async () => {
    const { factory } = await deployFactoryWithProductionDefaults();
    const config = await factory.config();

    expect(config.totalSupply).to.eq(DEFAULT_TOTAL_SUPPLY);
    expect(config.curveBps).to.eq(DEFAULT_CURVE_BPS);
    expect(config.liquidityTokenBps).to.eq(DEFAULT_LIQUIDITY_TOKEN_BPS);
    expect(MAX_BPS - config.curveBps - config.liquidityTokenBps).to.eq(DEFAULT_CREATOR_BPS);
    expect(config.basePrice).to.eq(DEFAULT_BASE_PRICE);
    expect(config.priceSlope).to.eq(DEFAULT_PRICE_SLOPE);
    expect(config.graduationTarget).to.eq(DEFAULT_GRADUATION_TARGET);
    expect(config.length).to.eq(6); // {totalSupply, curveBps, liquidityTokenBps, basePrice, priceSlope, graduationTarget}
    expect(await factory.liquidityKind()).to.eq(1n);
    expect(await factory.protocolFeeBps()).to.eq(200n);
    expect(await factory.requireAuthorizedTrading()).to.eq(true);
    expect(await factory.requireRouteAuthorization()).to.eq(true);
  });

  it("campaigns inherit the default split and route-authorization latch", async () => {
    const { deployer, factory } = await deployFactoryWithProductionDefaults();

    await factory.setRouteAuthority(await deployer.getAddress());
    await factory.enableLive();

    const req = baseReq();
    const deadline = (await latestTimestamp()) + 600n;
    const signature = await signCreateRoute(factory, await deployer.getAddress(), deployer, req, 1, 1, deadline);
    await factory.createCampaignAuthorized(req as any, {
      tradeRouteProfile: 1,
      finalizeRouteProfile: 1,
      deadline,
      signature,
    });

    const info = await factory.getCampaign(0n);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);

    expect(await campaign.totalSupply()).to.eq(DEFAULT_TOTAL_SUPPLY);
    expect(await campaign.curveSupply()).to.eq((DEFAULT_TOTAL_SUPPLY * DEFAULT_CURVE_BPS) / MAX_BPS);
    expect(await campaign.liquiditySupply()).to.eq((DEFAULT_TOTAL_SUPPLY * DEFAULT_LIQUIDITY_TOKEN_BPS) / MAX_BPS);
    expect(await campaign.creatorReserve()).to.eq((DEFAULT_TOTAL_SUPPLY * DEFAULT_CREATOR_BPS) / MAX_BPS);
    expect(await campaign.basePrice()).to.eq(DEFAULT_BASE_PRICE);
    expect(await campaign.priceSlope()).to.eq(DEFAULT_PRICE_SLOPE);
    expect(await campaign.graduationTarget()).to.eq(DEFAULT_GRADUATION_TARGET);
    expect(await campaign.requireAuthorizedTrading()).to.eq(true);
    expect(await campaign.owner()).to.eq(await deployer.getAddress());
  });
});
