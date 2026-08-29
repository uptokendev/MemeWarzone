import { expect } from "chai";
import { ethers } from "hardhat";

const PRODUCTION_CONFIG = {
  totalSupply: ethers.parseEther("1000000000"),
  curveBps: 8400n,
  liquidityTokenBps: 1400n,
  basePrice: 1_000_000_000n,
  priceSlope: 850n,
  graduationTarget: ethers.parseEther("30000"),
  liquidityBps: 3300n,
};

const campaignReq = {
  name: "ReplacementSeq",
  symbol: "RSQ",
  logoURI: "ipfs://replacement-seq",
  xAccount: "",
  website: "",
  extraLink: "",
  graduationTarget: 0n,
};

function hashCampaignRequest(req: typeof campaignReq) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return ethers.keccak256(
    coder.encode(
      ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "uint256"],
      [
        ethers.keccak256(ethers.toUtf8Bytes(req.name)),
        ethers.keccak256(ethers.toUtf8Bytes(req.symbol)),
        ethers.keccak256(ethers.toUtf8Bytes(req.logoURI)),
        ethers.keccak256(ethers.toUtf8Bytes(req.xAccount)),
        ethers.keccak256(ethers.toUtf8Bytes(req.website)),
        ethers.keccak256(ethers.toUtf8Bytes(req.extraLink)),
        req.graduationTarget,
      ],
    ),
  );
}

async function signCreateRoute(factory: any, creator: string, signer: any, deadline: bigint) {
  const { chainId } = await ethers.provider.getNetwork();
  const digest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256", "address", "address", "bytes32", "uint8", "uint8", "uint64"],
      ["MWZ_CREATE_ROUTE_AUTH", chainId, await factory.getAddress(), creator, hashCampaignRequest(campaignReq), 1, 1, deadline],
    ),
  );
  return signer.signMessage(ethers.getBytes(digest));
}

describe("BNB factory replacement security sequence", function () {
  it("pauses, locks, hands off to Safe, and keeps CREATE closed after enableLive", async function () {
    const [deployer, safe, routeAuthority, creator, weeklyVault, monthlyVault] = await ethers.getSigners();

    const TopazFactory = await ethers.getContractFactory("MockTopazFactory");
    const topazFactory = await TopazFactory.deploy();
    await topazFactory.waitForDeployment();

    const Router = await ethers.getContractFactory("MockTopazRouter");
    const router = await Router.deploy(await topazFactory.getAddress(), await deployer.getAddress());
    await router.waitForDeployment();

    const PriceFeed = await ethers.getContractFactory("MockUsdPriceFeed");
    const priceFeed = await PriceFeed.deploy(8);
    await priceFeed.waitForDeployment();
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    await priceFeed.setRoundData(1n, ethers.parseUnits("690", 8), now, now, 1n);

    const GraduationOracle = await ethers.getContractFactory("GraduationOracle");
    const oracle = await GraduationOracle.deploy(await priceFeed.getAddress(), 3600n);
    await oracle.waitForDeployment();

    const Campaign = await ethers.getContractFactory("LaunchCampaign");
    const implementation = await Campaign.deploy();
    await implementation.waitForDeployment();

    const CreatorRegistry = await ethers.getContractFactory("CreatorRegistry");
    const creatorRegistry = await CreatorRegistry.connect(safe).deploy();
    await creatorRegistry.waitForDeployment();
    expect(await creatorRegistry.owner()).to.equal(await safe.getAddress());

    const RiskRegistry = await ethers.getContractFactory("RiskRegistry");
    const riskRegistry = await RiskRegistry.connect(safe).deploy();
    await riskRegistry.waitForDeployment();

    const TreasuryRouterV2 = await ethers.getContractFactory("TreasuryRouterV2");
    const treasury = await TreasuryRouterV2.deploy(
      await safe.getAddress(),
      await weeklyVault.getAddress(),
      await monthlyVault.getAddress(),
      3600n,
    );
    await treasury.waitForDeployment();
    expect(await treasury.admin()).to.equal(await safe.getAddress());

    const OldLocker = await ethers.getContractFactory("PermanentLpLocker");
    const oldLocker = await OldLocker.deploy(await safe.getAddress());
    await oldLocker.waitForDeployment();
    await treasury.connect(safe).setAuthorizedLpLocker(await oldLocker.getAddress(), true);
    await treasury.connect(safe).setPrimaryLpLocker(await oldLocker.getAddress());
    expect(await treasury.permanentLpLocker()).to.equal(await oldLocker.getAddress());
    expect(await treasury.authorizedLpLocker(await oldLocker.getAddress())).to.equal(true);

    const Factory = await ethers.getContractFactory("LaunchFactory");
    const factory = await Factory.connect(deployer).deploy(
      await router.getAddress(),
      await treasury.getAddress(),
      await implementation.getAddress(),
      await oracle.getAddress(),
    );
    await factory.waitForDeployment();
    const locker = await ethers.getContractAt("PermanentLpLocker", await factory.permanentLpLocker());

    expect(await factory.owner()).to.equal(await deployer.getAddress());
    expect(await factory.live()).to.equal(false);
    expect(await factory.createPaused()).to.equal(false);
    expect(await factory.requireRouteAuthorization()).to.equal(true);
    expect(await factory.requireAuthorizedTrading()).to.equal(true);
    expect(await factory.securityDefaultsLocked()).to.equal(false);

    await factory.connect(deployer).setCreatePaused(true);
    expect(await factory.createPaused()).to.equal(true);

    await factory.connect(deployer).setRegistries(await creatorRegistry.getAddress(), await riskRegistry.getAddress());
    await factory.connect(deployer).setRouteAuthority(await routeAuthority.getAddress());
    await factory.connect(deployer).setRouteProfiles(1, 1);
    await factory.connect(deployer).setProtocolFee(200);
    await factory.connect(deployer).setConfig(PRODUCTION_CONFIG);
    await factory.connect(deployer).setLaunchProtectionConfig(0, 0, 0);

    const protection = await factory.launchProtectionConfig();
    expect(protection.blocks_).to.equal(0n);
    expect(protection.maxBuyWei).to.equal(0n);
    expect(protection.maxWalletWei).to.equal(0n);
    expect(await factory.requireRouteAuthorization()).to.equal(true);
    expect(await factory.requireAuthorizedTrading()).to.equal(true);

    await expect(factory.connect(deployer).lockSecurityDefaults()).to.emit(factory, "SecurityDefaultsLockedEnabled");
    expect(await factory.securityDefaultsLocked()).to.equal(true);
    await expect(factory.connect(deployer).setRequireRouteAuthorization(false)).to.be.revertedWithCustomError(
      factory,
      "SecurityDefaultsLocked",
    );
    await expect(factory.connect(deployer).setRequireAuthorizedTrading(false)).to.be.revertedWithCustomError(
      factory,
      "SecurityDefaultsLocked",
    );

    expect(await locker.REQUIRED_POOL_FEE_BPS()).to.equal(30n);
    expect(await locker.CREATOR_FEE_BPS()).to.equal(8000n);
    expect(await locker.PROTOCOL_FEE_BPS()).to.equal(2000n);
    expect(await locker.admin()).to.equal(await factory.getAddress());
    expect(await factory.isGraduationTargetAllowedForChain(56, ethers.parseEther("6"))).to.equal(false);
    expect(await factory.isGraduationTargetAllowedForChain(56, ethers.parseEther("30000"))).to.equal(true);
    expect(await factory.live()).to.equal(false);
    expect(await factory.createPaused()).to.equal(true);
    expect(await factory.campaignsCount()).to.equal(0n);

    await factory.connect(deployer).transferOwnership(await safe.getAddress());
    expect(await factory.owner()).to.equal(await safe.getAddress());
    await expect(factory.connect(deployer).setCreatePaused(false)).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
    await expect(factory.connect(deployer).enableLive()).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
    await expect(factory.connect(deployer).setConfig(PRODUCTION_CONFIG)).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
    await expect(creatorRegistry.connect(deployer).setLaunchRecorder(await factory.getAddress(), true)).to.be.revertedWithCustomError(
      creatorRegistry,
      "OwnableUnauthorizedAccount",
    );
    await expect(treasury.connect(deployer).setAuthorizedLpLocker(await locker.getAddress(), true)).to.be.revertedWith("not admin");
    await expect(treasury.connect(deployer).setPrimaryLpLocker(await locker.getAddress())).to.be.revertedWith("not admin");
    expect(await factory.campaignsCount()).to.equal(0n);

    await creatorRegistry.connect(safe).setLaunchRecorder(await factory.getAddress(), true);
    expect(await creatorRegistry.launchRecorder(await factory.getAddress())).to.equal(true);
    await expect(treasury.connect(safe).setAuthorizedLpLocker(await locker.getAddress(), true)).to.be.revertedWith("use propose");
    await treasury.connect(safe).proposeAuthorizedLpLocker(await locker.getAddress());
    await ethers.provider.send("evm_increaseTime", [3600]);
    await ethers.provider.send("evm_mine", []);
    await treasury.connect(safe).acceptAuthorizedLpLocker();
    await treasury.connect(safe).setPrimaryLpLocker(await locker.getAddress());
    expect(await treasury.authorizedLpLocker(await oldLocker.getAddress())).to.equal(true);
    expect(await treasury.authorizedLpLocker(await locker.getAddress())).to.equal(true);
    expect(await treasury.permanentLpLocker()).to.equal(await locker.getAddress());
    expect(await factory.campaignsCount()).to.equal(0n);

    await factory.connect(safe).enableLive();
    expect(await factory.live()).to.equal(true);
    expect(await factory.createPaused()).to.equal(true);
    expect(await factory.requireRouteAuthorization()).to.equal(true);
    expect(await factory.requireAuthorizedTrading()).to.equal(true);
    expect(await factory.securityDefaultsLocked()).to.equal(true);
    expect(await factory.campaignsCount()).to.equal(0n);

    await expect(factory.connect(creator).createCampaign(campaignReq)).to.be.revertedWithCustomError(
      factory,
      "RouteAuthorizationRequired",
    );

    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 600n;
    const signature = await signCreateRoute(factory, await creator.getAddress(), routeAuthority, deadline);
    await expect(
      factory.connect(creator).createCampaignAuthorized(campaignReq, {
        tradeRouteProfile: 1,
        finalizeRouteProfile: 1,
        deadline,
        signature,
      }),
    ).to.be.revertedWithCustomError(factory, "CreatePaused");

    expect(await factory.campaignsCount()).to.equal(0n);
  });
});
