import { expect } from "chai";
import { artifacts, ethers } from "hardhat";
import { deployCoreFixture } from "./fixtures/core";
import { deployFactoryWithLocker } from "../scripts/lib/deployFactoryWithLocker";
import { wireEvmGenTestDoubles } from "./helpers/deployFactory";

const MAX_BPS = 10_000n;
const MAX_BASE_PRICE = ethers.parseEther("1000");
// Launch generation: 1e22 (was 1e36) so the factory's supply-bound check stays in checked arithmetic.
const MAX_PRICE_SLOPE = 10n ** 22n;
const MAX_GRADUATION_TARGET = ethers.parseEther("1000000");

const baseReq = (overrides: Record<string, unknown> = {}) => ({
  name: "MyToken",
  symbol: "MYT",
  logoURI: "ipfs://logo",
  xAccount: "",
  website: "",
  extraLink: "",
  graduationTarget: 0n,
  firstBuyTokens: 0n,
  firstBuyMaxCost: 0n,
  feeChoice: 1,
  feeCreatorPct: 0,
  ...overrides,
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
  deadline: bigint,
  chainIdOverride?: bigint
) {
  const chainId = chainIdOverride ?? (await ethers.provider.getNetwork()).chainId;
  const digest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256", "address", "address", "bytes32", "uint8", "uint8", "uint64"],
      ["MWZ_CREATE_ROUTE_AUTH", chainId, await factory.getAddress(), creator, hashCreateRouteRequest(req), tradeProfile, finalizeProfile, deadline]
    )
  );
  return signer.signMessage(ethers.getBytes(digest));
}

async function signScheduledCreateRoute(
  factory: any,
  creator: string,
  signer: any,
  req: any,
  tradeProfile: number,
  finalizeProfile: number,
  deadline: bigint,
) {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const factoryGeneration = await factory.FACTORY_GENERATION();
  const campaignGeneration = await factory.CAMPAIGN_GENERATION();
  const digest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256", "address", "address", "bytes32", "uint64", "bytes32", "bytes32", "bytes32", "uint64", "uint256", "uint32", "uint32", "uint8", "uint8", "uint64"],
      [
        "MWZ_CREATE_SCHEDULED_V2_AUTH",
        chainId,
        await factory.getAddress(),
        creator,
        hashCreateRouteRequest(req.campaign),
        req.launchAt,
        req.draftReferenceHash,
        req.normalizedTickerHash,
        req.metadataHash,
        req.reservationVersion,
        req.authorizationNonce,
        factoryGeneration,
        campaignGeneration,
        tradeProfile,
        finalizeProfile,
        deadline,
      ],
    ),
  );
  return signer.signMessage(ethers.getBytes(digest));
}

async function latestTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp);
}

function scheduledRequest(name: string, symbol: string, launchAt: bigint, nonce: bigint) {
  return {
    campaign: baseReq({ name, symbol }),
    launchAt,
    draftReferenceHash: ethers.keccak256(ethers.toUtf8Bytes(`draft:${symbol}`)),
    normalizedTickerHash: ethers.keccak256(ethers.toUtf8Bytes(symbol)),
    metadataHash: ethers.keccak256(ethers.toUtf8Bytes(`metadata:${symbol}`)),
    reservationVersion: 1n,
    authorizationNonce: nonce,
  };
}

async function scheduledAuth(factory: any, creator: any, authority: any, request: any) {
  const deadline = (await latestTimestamp()) + 600n;
  const signature = await signScheduledCreateRoute(
    factory,
    await creator.getAddress(),
    authority,
    request,
    1,
    1,
    deadline,
  );
  return { tradeRouteProfile: 1, finalizeRouteProfile: 1, deadline, signature };
}

async function deployFactoryPrereqs() {
  const [deployer] = await ethers.getSigners();

  const TopazFactory = await ethers.getContractFactory("MockTopazFactory");
  const topazFactory = await TopazFactory.deploy();
  await topazFactory.waitForDeployment();

  const Router = await ethers.getContractFactory("MockRouter");
  const router = await Router.deploy(await topazFactory.getAddress(), await deployer.getAddress());
  await router.waitForDeployment();

  const PriceFeed = await ethers.getContractFactory("MockUsdPriceFeed");
  const priceFeed = await PriceFeed.deploy(8);
  await priceFeed.waitForDeployment();
  const now = await latestTimestamp();
  await priceFeed.setRoundData(1n, ethers.parseUnits("1", 8), now, now, 1n);

  const GraduationOracle = await ethers.getContractFactory("GraduationOracle");
  const graduationOracle = await GraduationOracle.deploy(await priceFeed.getAddress(), 3600n);
  await graduationOracle.waitForDeployment();

  // Launch generation: create registers the coin's fee choice on the treasury router's creator vault
  // (ICreatorRewardsVaultV2.setCampaignChoice), so the prereqs use the generation's router/vault doubles.
  const treasuryRouter = await (await ethers.getContractFactory("MockTreasuryRouterEvmGen")).deploy();
  await treasuryRouter.waitForDeployment();
  const creatorVault = await (await ethers.getContractFactory("MockCreatorRewardsVaultEvmGen")).deploy();
  await creatorVault.waitForDeployment();
  await treasuryRouter.setCreatorRewardsVault(await creatorVault.getAddress());

  const Campaign = await ethers.getContractFactory("LaunchCampaign");
  const implementation = await Campaign.deploy();
  await implementation.waitForDeployment();

  const tokenDeployer = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
  await tokenDeployer.waitForDeployment();

  return { deployer, router, priceFeed, graduationOracle, treasuryRouter, creatorVault, implementation, tokenDeployer };
}

function validInitParams(addresses: {
  creator: string;
  factory: string;
  graduationAdapter: string;
  graduationOracle: string;
  treasuryRouter: string;
  tokenDeployer: string;
}) {
  // LaunchCampaign.InitParams of the launch generation (factory 6 / campaign 5).
  return {
    name: "Init Token",
    symbol: "INIT",
    logoURI: "ipfs://logo",
    totalSupply: ethers.parseEther("1000"),
    curveBps: 5000n,
    liquidityTokenBps: 4000n,
    basePrice: 1n,
    priceSlope: 1n,
    graduationTarget: 1n,
    graduationOracle: addresses.graduationOracle,
    protocolFeeBps: 200n,
    graduationAdapter: addresses.graduationAdapter,
    feeRecipient: addresses.treasuryRouter,
    creator: addresses.creator,
    factory: addresses.factory,
    riskRegistry: ethers.ZeroAddress,
    tokenDeployer: addresses.tokenDeployer,
    creatorBuyCapWei: 0n,
    requireAuthorizedTrading: false,
    tradeRouteProfile: 1,
    finalizeRouteProfile: 1,
  };
}

describe("LaunchFactory", function () {
  it("constructor requires contract router, treasury router, campaign implementation, and graduation oracle", async () => {
    const Factory = await ethers.getContractFactory("LaunchFactory");
    const { deployer, router, treasuryRouter, implementation, graduationOracle } = await deployFactoryPrereqs();
    // The factory binds a pre-deployed locker; for the argument checks any locker with code will do.
    const anyLocker = await (await ethers.getContractFactory("PermanentLpLocker")).deploy(await deployer.getAddress());
    const lockerAddress = await anyLocker.getAddress();

    await expect(
      Factory.deploy(ethers.ZeroAddress, await treasuryRouter.getAddress(), await implementation.getAddress(), await graduationOracle.getAddress(), lockerAddress)
    ).to.be.revertedWithCustomError(Factory, "RouterZero");

    await expect(
      Factory.deploy(await router.getAddress(), ethers.ZeroAddress, await implementation.getAddress(), await graduationOracle.getAddress(), lockerAddress)
    ).to.be.revertedWithCustomError(Factory, "RecipientZero");

    await expect(
      Factory.deploy(await router.getAddress(), await treasuryRouter.getAddress(), ethers.ZeroAddress, await graduationOracle.getAddress(), lockerAddress)
    ).to.be.revertedWithCustomError(Factory, "ImplementationZero");

    await expect(
      Factory.deploy(await router.getAddress(), await treasuryRouter.getAddress(), await implementation.getAddress(), ethers.ZeroAddress, lockerAddress)
    ).to.be.revertedWithCustomError(Factory, "GraduationOracleZero");

    await expect(
      Factory.deploy(await deployer.getAddress(), await treasuryRouter.getAddress(), await implementation.getAddress(), await graduationOracle.getAddress(), lockerAddress)
    ).to.be.revertedWithCustomError(Factory, "ContractCodeMissing");

    await expect(
      Factory.deploy(await router.getAddress(), await deployer.getAddress(), await implementation.getAddress(), await graduationOracle.getAddress(), lockerAddress)
    ).to.be.revertedWithCustomError(Factory, "ContractCodeMissing");

    await expect(
      Factory.deploy(await router.getAddress(), await treasuryRouter.getAddress(), await deployer.getAddress(), await graduationOracle.getAddress(), lockerAddress)
    ).to.be.revertedWithCustomError(Factory, "ContractCodeMissing");

    await expect(
      Factory.deploy(await router.getAddress(), await treasuryRouter.getAddress(), await implementation.getAddress(), await deployer.getAddress(), lockerAddress)
    ).to.be.revertedWithCustomError(Factory, "ContractCodeMissing");

    const factory = await (await deployFactoryWithLocker({ factoryName: "LaunchFactory", args: [await router.getAddress(),
      await treasuryRouter.getAddress(),
      await implementation.getAddress(),
      await graduationOracle.getAddress()] })).factory;
    expect(await factory.router()).to.eq(await router.getAddress());
    expect(await factory.graduationOracle()).to.eq(await graduationOracle.getAddress());
    expect(await factory.leagueReceiver()).to.eq(await treasuryRouter.getAddress());
    expect(await factory.feeRecipient()).to.eq(await treasuryRouter.getAddress());
    expect(await factory.campaignImplementation()).to.eq(await implementation.getAddress());
    expect((await factory.config()).totalSupply).to.be.gt(0n);
    expect((await factory.config()).graduationTarget).to.eq(ethers.parseEther("30000"));
    expect(await factory.protocolFeeBps()).to.eq(200n);
    expect(await factory.requireAuthorizedTrading()).to.eq(true);
    expect(await factory.requireRouteAuthorization()).to.eq(true);
    expect(await factory.FACTORY_GENERATION()).to.eq(6n);
    expect(await factory.CAMPAIGN_GENERATION()).to.eq(5n);
    expect(await factory.live()).to.eq(false);
  });

  it("keeps LaunchFactory runtime bytecode below the internal size target", async () => {
    const artifact = await artifacts.readArtifact("LaunchFactory");
    const runtimeBytes = (artifact.deployedBytecode.length - 2) / 2;
    expect(runtimeBytes).to.be.lessThan(23_000);
  });

  it("standalone implementation is locked and cannot be initialized directly", async () => {
    const { deployer, router, treasuryRouter, implementation, graduationOracle, tokenDeployer } = await deployFactoryPrereqs();

    const params = validInitParams({
      creator: await deployer.getAddress(),
      factory: await deployer.getAddress(),
      graduationAdapter: await router.getAddress(),
      graduationOracle: await graduationOracle.getAddress(),
      treasuryRouter: await treasuryRouter.getAddress(),
      tokenDeployer: await tokenDeployer.getAddress(),
    });
    await expect(implementation.initialize(params)).to.be.revertedWithCustomError(implementation, "AlreadyInitialized");
    await expect(implementation.initializeScheduled(params, 0n)).to.be.revertedWithCustomError(implementation, "AlreadyInitialized");
  });

  it("live latch: createCampaign blocked until enabled; onlyOwner; enableLive is one-way", async () => {
    const [owner, creator] = await ethers.getSigners();
    const { router, treasuryRouter, implementation, graduationOracle } = await deployFactoryPrereqs();
    const Factory = await ethers.getContractFactory("LaunchFactory");
    const factory = await (await deployFactoryWithLocker({ factoryName: "LaunchFactory", args: [await router.getAddress(),
      await treasuryRouter.getAddress(),
      await implementation.getAddress(),
      await graduationOracle.getAddress()] })).factory;

    await expect(factory.connect(creator).createCampaign(baseReq() as any)).to.be.revertedWithCustomError(factory, "RouteAuthorizationRequired");
    await factory.connect(owner).setRequireRouteAuthorization(false);
    await expect(factory.connect(creator).createCampaign(baseReq() as any)).to.be.revertedWithCustomError(factory, "NotLive");
    await expect(factory.connect(creator).enableLive()).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
    await expect(factory.connect(owner).enableLive()).to.emit(factory, "LiveEnabled");
    expect(await factory.live()).to.eq(true);
    await expect(factory.connect(owner).enableLive()).to.be.revertedWithCustomError(factory, "AlreadyLive");
    // Launch generation: a live factory still refuses create until the native graduation adapter and the
    // token deployer are wired; the $30k default target needs a curve that raises it at the $1 test oracle.
    await expect(factory.connect(creator).createCampaign(baseReq() as any)).to.be.revertedWithCustomError(
      factory,
      "NativeGraduationAdapterUnavailable"
    );
    await wireEvmGenTestDoubles(factory, await router.getAddress(), await treasuryRouter.getAddress());
    await factory.connect(owner).setConfig({
      totalSupply: ethers.parseEther("1000"),
      curveBps: 5000n,
      liquidityTokenBps: 4000n,
      basePrice: 10n ** 12n,
      priceSlope: 10n ** 13n,
      graduationTarget: ethers.parseEther("1"),
    });
    await expect(factory.connect(creator).createCampaign(baseReq() as any)).to.emit(factory, "CampaignCreated");
  });

  it("factory clone initializes exactly once and stores creator, token, factory, and oracle", async () => {
    const { factory, creator, treasuryRouter, graduationOracle, tokenDeployer } = (await deployCoreFixture()) as any;

    await factory.connect(creator).createCampaign(baseReq({ name: "Clone", symbol: "CLN" }) as any);
    const info = await factory.getCampaign(0n);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);

    expect(await campaign.owner()).to.eq(await creator.getAddress());
    expect(await campaign.factory()).to.eq(await factory.getAddress());
    expect(await campaign.graduationOracle()).to.eq(await graduationOracle.getAddress());
    expect(await campaign.token()).to.eq(info.token);
    expect(info.token).to.not.eq(ethers.ZeroAddress);
    // Launch generation: no lpReceiver; the LP always reaches the factory's permanent locker through the
    // native graduation adapter the factory injects.
    expect(await campaign.graduationAdapter()).to.eq(await factory.nativeGraduationAdapter());
    expect(await campaign.feeRecipient()).to.eq(await treasuryRouter.getAddress());

    const params = validInitParams({
      creator: await creator.getAddress(),
      factory: await factory.getAddress(),
      graduationAdapter: await factory.nativeGraduationAdapter(),
      graduationOracle: await graduationOracle.getAddress(),
      treasuryRouter: await treasuryRouter.getAddress(),
      tokenDeployer: await tokenDeployer.getAddress(),
    });
    await expect(campaign.initialize(params)).to.be.revertedWithCustomError(campaign, "AlreadyInitialized");
    await expect(campaign.initializeScheduled(params, 0n)).to.be.revertedWithCustomError(campaign, "AlreadyInitialized");
  });

  it("rejects graduation notifications from unknown campaigns", async () => {
    const { factory, creator } = await deployCoreFixture();

    await expect(
      factory.connect(creator).notifyCampaignGraduated(await creator.getAddress(), ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(factory, "UnknownCampaign");
  });

  it("createCampaign has no creator initial buy path", async () => {
    const { factory, creator } = await deployCoreFixture();

    const tx = await factory.connect(creator).createCampaign(baseReq() as any);
    await expect(tx).to.emit(factory, "CampaignCreated");

    const info = await factory.getCampaign(0n);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
    const token = await ethers.getContractAt("LaunchToken", await campaign.token());

    expect(await campaign.sold()).to.eq(0n);
    expect(await token.balanceOf(await creator.getAddress())).to.eq(0n);
  });

  it("createCampaign: validates inputs, emits, persists CampaignInfo", async () => {
    const { factory, creator } = await deployCoreFixture();

    await expect(factory.connect(creator).createCampaign(baseReq({ name: "" }) as any)).to.be.revertedWithCustomError(
      factory,
      "NameEmpty"
    );
    await expect(factory.connect(creator).createCampaign(baseReq({ symbol: "" }) as any)).to.be.revertedWithCustomError(
      factory,
      "SymbolEmpty"
    );
    await expect(factory.connect(creator).createCampaign(baseReq({ logoURI: "" }) as any)).to.be.revertedWithCustomError(
      factory,
      "LogoEmpty"
    );

    const tx = await factory.connect(creator).createCampaign(baseReq() as any);
    await expect(tx).to.emit(factory, "CampaignCreated");

    expect(await factory.campaignsCount()).to.eq(1n);
    const info = await factory.getCampaign(0n);
    expect(info.creator).to.eq(await creator.getAddress());
    expect(info.name).to.eq("MyToken");
    expect(info.symbol).to.eq("MYT");
    expect(info.logoURI).to.eq("ipfs://logo");

    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
    expect(await campaign.graduationAdapter()).to.eq(await factory.nativeGraduationAdapter());

    const page = await factory.getCampaignPage(0n, 10n);
    expect(page.length).to.eq(1);
    expect(page[0].campaign).to.eq(info.campaign);

    await expect(factory.getCampaign(1n)).to.be.revertedWithCustomError(factory, "OutOfBounds");
    await expect(factory.getCampaignPage(2n, 1n)).to.be.revertedWithCustomError(factory, "Offset");
  });

  it("createCampaignAuthorized applies signer-approved recruiter route profiles", async () => {
    const { factory, creator, owner } = await deployCoreFixture();
    await factory.connect(owner).setRequireRouteAuthorization(true);
    await factory.connect(owner).setRouteAuthority(await owner.getAddress());

    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 600);
    const req = baseReq({ name: "RecruiterToken", symbol: "RCRT" });
    const signature = await signCreateRoute(factory, await creator.getAddress(), owner, req, 2, 2, deadline);

    await factory.connect(creator).createCampaignAuthorized(req as any, {
      tradeRouteProfile: 2,
      finalizeRouteProfile: 2,
      deadline,
      signature,
    });

    const info = await factory.getCampaign(0n);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
    expect(await campaign.tradeRouteProfile()).to.eq(2n);
    expect(await campaign.finalizeRouteProfile()).to.eq(2n);
  });

  it("scheduled deployment uses current-time cooldown and records a normal creator launch", async () => {
    const { factory, owner, creator } = await deployCoreFixture();
    const CreatorRegistry = await ethers.getContractFactory("CreatorRegistry");
    const registry = await CreatorRegistry.deploy();
    await registry.waitForDeployment();
    await registry.connect(owner).setLaunchRecorder(await factory.getAddress(), true);
    await factory.connect(owner).setRegistries(await registry.getAddress(), ethers.ZeroAddress);
    await factory.connect(owner).setRouteAuthority(await owner.getAddress());

    const launchAt = (await latestTimestamp()) + 7n * 24n * 60n * 60n;
    const request = scheduledRequest("Scheduled", "SCH", launchAt, 101n);
    const auth = await scheduledAuth(factory, creator, owner, request);
    const before = await latestTimestamp();

    await expect(factory.connect(creator).createScheduledCampaignAuthorized(request as any, auth))
      .to.emit(factory, "ScheduledCampaignCreated");

    const profile = await registry.getCreatorProfile(await creator.getAddress());
    expect(profile.liveBondingCount).to.eq(1n);
    expect(BigInt(profile.lastLaunchTimestamp)).to.be.gte(before);
    expect(BigInt(profile.lastLaunchTimestamp)).to.be.lt(launchAt);

    const info = await factory.getCampaign(0n);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
    const rules = await registry.getCreatorRules(await creator.getAddress());
    expect(await campaign.launchAt()).to.eq(launchAt);
    // C4: the tier buy lock is replaced by escrow of the creator's own buys; the tier buy cap is still injected.
    expect(await campaign.creatorBuyCapWei()).to.eq(BigInt(rules.creatorBuyCapWei));

    const eligibility = await factory.creatorLaunchEligibility(await creator.getAddress());
    expect(eligibility.allowed).to.eq(false);
    expect(eligibility.currentLiveCount).to.eq(1n);
    expect(eligibility.cooldownEndsAt).to.eq(BigInt(profile.lastLaunchTimestamp) + BigInt(rules.cooldownSeconds));
  });

  it("a future launchAt cannot bypass an active creator deployment cooldown", async () => {
    const { factory, owner, creator } = await deployCoreFixture();
    const CreatorRegistry = await ethers.getContractFactory("CreatorRegistry");
    const registry = await CreatorRegistry.deploy();
    await registry.waitForDeployment();
    await registry.connect(owner).setLaunchRecorder(await factory.getAddress(), true);
    await factory.connect(owner).setRegistries(await registry.getAddress(), ethers.ZeroAddress);
    await factory.connect(owner).setRouteAuthority(await owner.getAddress());

    await factory.connect(creator).createCampaign(baseReq({ name: "First", symbol: "FST" }) as any);
    const request = scheduledRequest(
      "Cannot Bypass",
      "NOBYPASS",
      (await latestTimestamp()) + 20n * 24n * 60n * 60n,
      102n,
    );
    const auth = await scheduledAuth(factory, creator, owner, request);

    await expect(factory.connect(creator).createScheduledCampaignAuthorized(request as any, auth))
      .to.be.revertedWithCustomError(factory, "CreatorNotEligible");
  });

  it("different creators can arm campaigns with the exact same launchAt", async () => {
    const { factory, owner, creator, alice } = await deployCoreFixture();
    const CreatorRegistry = await ethers.getContractFactory("CreatorRegistry");
    const registry = await CreatorRegistry.deploy();
    await registry.waitForDeployment();
    await registry.connect(owner).setLaunchRecorder(await factory.getAddress(), true);
    await factory.connect(owner).setRegistries(await registry.getAddress(), ethers.ZeroAddress);
    await factory.connect(owner).setRouteAuthority(await owner.getAddress());

    const launchAt = (await latestTimestamp()) + 7n * 24n * 60n * 60n;
    const requestA = scheduledRequest("Campaign A", "SAMEA", launchAt, 201n);
    const requestB = scheduledRequest("Campaign B", "SAMEB", launchAt, 202n);

    await factory.connect(creator).createScheduledCampaignAuthorized(
      requestA as any,
      await scheduledAuth(factory, creator, owner, requestA),
    );
    await factory.connect(alice).createScheduledCampaignAuthorized(
      requestB as any,
      await scheduledAuth(factory, alice, owner, requestB),
    );

    const campaignA = await ethers.getContractAt("LaunchCampaign", (await factory.getCampaign(0n)).campaign);
    const campaignB = await ethers.getContractAt("LaunchCampaign", (await factory.getCampaign(1n)).campaign);
    expect(await campaignA.launchAt()).to.eq(launchAt);
    expect(await campaignB.launchAt()).to.eq(launchAt);
    expect((await registry.getCreatorProfile(await creator.getAddress())).liveBondingCount).to.eq(1n);
    expect((await registry.getCreatorProfile(await alice.getAddress())).liveBondingCount).to.eq(1n);
  });

  it("the same creator can arm two campaigns for one future launchAt on separate eligible days", async () => {
    const { factory, owner, creator } = await deployCoreFixture();
    const CreatorRegistry = await ethers.getContractFactory("CreatorRegistry");
    const registry = await CreatorRegistry.deploy();
    await registry.waitForDeployment();
    await registry.connect(owner).setLaunchRecorder(await factory.getAddress(), true);
    await factory.connect(owner).setRegistries(await registry.getAddress(), ethers.ZeroAddress);
    await factory.connect(owner).setRouteAuthority(await owner.getAddress());

    const launchAt = (await latestTimestamp()) + 10n * 24n * 60n * 60n;
    const requestA = scheduledRequest("Creator A1", "AONE", launchAt, 301n);
    await factory.connect(creator).createScheduledCampaignAuthorized(
      requestA as any,
      await scheduledAuth(factory, creator, owner, requestA),
    );

    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);

    const requestB = scheduledRequest("Creator A2", "ATWO", launchAt, 302n);
    await factory.connect(creator).createScheduledCampaignAuthorized(
      requestB as any,
      await scheduledAuth(factory, creator, owner, requestB),
    );

    const campaignA = await ethers.getContractAt("LaunchCampaign", (await factory.getCampaign(0n)).campaign);
    const campaignB = await ethers.getContractAt("LaunchCampaign", (await factory.getCampaign(1n)).campaign);
    expect(await campaignA.launchAt()).to.eq(launchAt);
    expect(await campaignB.launchAt()).to.eq(launchAt);
    expect((await registry.getCreatorProfile(await creator.getAddress())).liveBondingCount).to.eq(2n);
  });

  it("rejects schedules below five minutes and beyond thirty days", async () => {
    const { factory, owner, creator } = await deployCoreFixture();
    await factory.connect(owner).setRouteAuthority(await owner.getAddress());

    const now = await latestTimestamp();
    const tooSoon = scheduledRequest("Too Soon", "SOON", now + 299n, 401n);
    await expect(
      factory.connect(creator).createScheduledCampaignAuthorized(
        tooSoon as any,
        await scheduledAuth(factory, creator, owner, tooSoon),
      ),
    ).to.be.revertedWithCustomError(factory, "InvalidLaunchAt");

    const tooFar = scheduledRequest("Too Far", "FAR", now + 30n * 24n * 60n * 60n + 10n, 402n);
    await expect(
      factory.connect(creator).createScheduledCampaignAuthorized(
        tooFar as any,
        await scheduledAuth(factory, creator, owner, tooFar),
      ),
    ).to.be.revertedWithCustomError(factory, "LaunchAtTooFar");
  });

  it("createCampaignAuthorized rejects missing authority, expired signatures, invalid profiles, bad signers, wrong chain, and replay", async () => {
    const { factory, creator, owner, alice } = await deployCoreFixture();
    await factory.connect(owner).setRequireRouteAuthorization(true);
    const req = baseReq({ name: "RouteGuard", symbol: "RGD" });
    const deadline = (await latestTimestamp()) + 600n;
    const expiredDeadline = (await latestTimestamp()) - 1n;

    await expect(
      factory.connect(creator).createCampaignAuthorized(req as any, {
        tradeRouteProfile: 1,
        finalizeRouteProfile: 1,
        deadline,
        signature: "0x",
      })
    ).to.be.revertedWithCustomError(factory, "RouteAuthorityZero");

    await factory.connect(owner).setRouteAuthority(await owner.getAddress());
    const expiredSignature = await signCreateRoute(factory, await creator.getAddress(), owner, req, 1, 1, expiredDeadline);
    await expect(
      factory.connect(creator).createCampaignAuthorized(req as any, {
        tradeRouteProfile: 1,
        finalizeRouteProfile: 1,
        deadline: expiredDeadline,
        signature: expiredSignature,
      })
    ).to.be.revertedWithCustomError(factory, "RouteAuthorizationExpired");

    const invalidProfileSignature = await signCreateRoute(factory, await creator.getAddress(), owner, req, 99, 1, deadline);
    await expect(
      factory.connect(creator).createCampaignAuthorized(req as any, {
        tradeRouteProfile: 99,
        finalizeRouteProfile: 1,
        deadline,
        signature: invalidProfileSignature,
      })
    ).to.be.revertedWithCustomError(factory, "InvalidRouteProfile");

    const badSignerSignature = await signCreateRoute(factory, await creator.getAddress(), alice, req, 1, 1, deadline);
    await expect(
      factory.connect(creator).createCampaignAuthorized(req as any, {
        tradeRouteProfile: 1,
        finalizeRouteProfile: 1,
        deadline,
        signature: badSignerSignature,
      })
    ).to.be.revertedWithCustomError(factory, "InvalidRouteAuthorization");

    const { chainId } = await ethers.provider.getNetwork();
    const wrongChainSignature = await signCreateRoute(factory, await creator.getAddress(), owner, req, 1, 1, deadline, chainId + 1n);
    await expect(
      factory.connect(creator).createCampaignAuthorized(req as any, {
        tradeRouteProfile: 1,
        finalizeRouteProfile: 1,
        deadline,
        signature: wrongChainSignature,
      })
    ).to.be.revertedWithCustomError(factory, "InvalidRouteAuthorization");

    const validSignature = await signCreateRoute(factory, await creator.getAddress(), owner, req, 1, 1, deadline);
    const routeAuth = { tradeRouteProfile: 1, finalizeRouteProfile: 1, deadline, signature: validSignature };
    await expect(factory.connect(creator).createCampaignAuthorized(req as any, routeAuth)).to.emit(factory, "CampaignCreated");
    await expect(factory.connect(creator).createCampaignAuthorized(req as any, routeAuth)).to.be.revertedWithCustomError(
      factory,
      "RouteAuthorizationReplayed"
    );
  });

  it("owner-only setters with validation + events", async () => {
    const { factory, owner, alice, treasuryRouter, v2factory, router, graduationAdapter, tokenDeployer } = (await deployCoreFixture()) as any;

    // Launch generation: the DEX router, feeRecipient and leagueReceiver are fixed at construction (a new
    // treasury router means a new factory generation), so there is no setCoreRouting to call at all.
    expect(factory.interface.getFunction("setCoreRouting")).to.eq(null);
    for (const [name, args] of [
      ["setGraduationOracle", [await alice.getAddress()]],
      ["setProtocolFee", [123n]],
      ["setRouteProfiles", [1, 1]],
      ["setRouteAuthority", [await alice.getAddress()]],
      ["setRegistries", [ethers.ZeroAddress, ethers.ZeroAddress]],
      ["setNativeGraduationAdapter", [await graduationAdapter.getAddress()]],
      ["setLaunchTokenDeployer", [await tokenDeployer.getAddress()]],
      ["setGlobalPaused", [true]],
      ["setCreatePaused", [true]],
      ["setRequireRouteAuthorization", [true]],
      ["setRequireAuthorizedTrading", [true]],
      ["enableLive", []],
      ["lockSecurityDefaults", []],
    ] as [string, unknown[]][]) {
      await expect((factory.connect(alice) as any)[name](...args), name).to.be.revertedWithCustomError(
        factory,
        "OwnableUnauthorizedAccount"
      );
    }
    await expect(factory.connect(owner).setGraduationOracle(ethers.ZeroAddress)).to.be.revertedWithCustomError(factory, "GraduationOracleZero");
    await expect(factory.connect(owner).setGraduationOracle(await alice.getAddress())).to.be.revertedWithCustomError(factory, "ContractCodeMissing");
    await expect(factory.connect(owner).setNativeGraduationAdapter(ethers.ZeroAddress)).to.be.revertedWithCustomError(factory, "ContractCodeMissing");
    await expect(factory.connect(owner).setNativeGraduationAdapter(await alice.getAddress())).to.be.revertedWithCustomError(factory, "ContractCodeMissing");
    await expect(factory.connect(owner).setLaunchTokenDeployer(await alice.getAddress())).to.be.revertedWithCustomError(factory, "ContractCodeMissing");
    await expect(factory.connect(owner).setRouteProfiles(3, 1)).to.be.revertedWithCustomError(factory, "InvalidRouteProfile");
    await expect(factory.connect(owner).setProtocolFee(1001n)).to.be.revertedWithCustomError(factory, "FeeTooHigh");
    await expect(factory.connect(owner).setProtocolFee(24n)).to.be.revertedWithCustomError(factory, "FeeTooLowForLeague");
    await expect(factory.connect(owner).setRegistries(await alice.getAddress(), ethers.ZeroAddress)).to.be.revertedWithCustomError(
      factory,
      "ContractCodeMissing"
    );
    await expect(factory.connect(owner).setRegistries(ethers.ZeroAddress, await alice.getAddress())).to.be.revertedWithCustomError(
      factory,
      "ContractCodeMissing"
    );

    await expect(factory.connect(owner).setProtocolFee(123n)).to.emit(factory, "ProtocolFeeUpdated").withArgs(123n);
    expect(await factory.protocolFeeBps()).to.eq(123n);
    await expect(factory.connect(owner).setRequireRouteAuthorization(true))
      .to.emit(factory, "RequireRouteAuthorizationUpdated")
      .withArgs(true);
    expect(await factory.requireRouteAuthorization()).to.eq(true);

    // Construction-time routing, and the locker the constructor configured with it.
    expect(await factory.router()).to.eq(await router.getAddress());
    expect(await factory.feeRecipient()).to.eq(await treasuryRouter.getAddress());
    expect(await factory.leagueReceiver()).to.eq(await treasuryRouter.getAddress());
    const locker = await ethers.getContractAt("PermanentLpLocker", await factory.permanentLpLocker());
    expect(await locker.treasuryRouter()).to.eq(await treasuryRouter.getAddress());
    expect(await locker.topazFactory()).to.eq(await v2factory.getAddress());

    const { graduationOracle: newOracle } = await deployFactoryPrereqs();
    await expect(factory.connect(owner).setGraduationOracle(await newOracle.getAddress()))
      .to.emit(factory, "GraduationOracleUpdated")
      .withArgs(await newOracle.getAddress());

    await expect(
      factory.connect(owner).setConfig({
        totalSupply: 0n,
        curveBps: 5000n,
        liquidityTokenBps: 4000n,
        basePrice: 1n,
        priceSlope: 1n,
        graduationTarget: 1n,
      })
    ).to.be.revertedWithCustomError(factory, "SupplyZero");

    await expect(
      factory.connect(owner).setConfig({
        totalSupply: 1n,
        curveBps: 0n,
        liquidityTokenBps: 0n,
        basePrice: 1n,
        priceSlope: 1n,
        graduationTarget: 1n,
      })
    ).to.be.revertedWithCustomError(factory, "InvalidCurveBps");
  });

  it("setConfig rejects every bounded economic misconfiguration", async () => {
    const { factory, owner } = await deployCoreFixture();
    const validConfig = {
      totalSupply: ethers.parseEther("1000"),
      curveBps: 6000n,
      liquidityTokenBps: 3000n,
      basePrice: 1n,
      priceSlope: 1n,
      graduationTarget: 1n,
    };

    await expect(factory.connect(owner).setConfig({ ...validConfig, curveBps: MAX_BPS, liquidityTokenBps: 1n })).to.be.revertedWithCustomError(
      factory,
      "InvalidCurveBps"
    );
    await expect(factory.connect(owner).setConfig({ ...validConfig, basePrice: 0n })).to.be.revertedWithCustomError(factory, "PriceZero");
    await expect(factory.connect(owner).setConfig({ ...validConfig, basePrice: MAX_BASE_PRICE + 1n })).to.be.revertedWithCustomError(
      factory,
      "ParamTooHigh"
    );
    await expect(factory.connect(owner).setConfig({ ...validConfig, priceSlope: 0n })).to.be.revertedWithCustomError(factory, "SlopeZero");
    await expect(factory.connect(owner).setConfig({ ...validConfig, priceSlope: MAX_PRICE_SLOPE + 1n })).to.be.revertedWithCustomError(
      factory,
      "ParamTooHigh"
    );
    await expect(factory.connect(owner).setConfig({ ...validConfig, graduationTarget: 0n })).to.be.revertedWithCustomError(
      factory,
      "TargetZero"
    );
    await expect(factory.connect(owner).setConfig({ ...validConfig, graduationTarget: MAX_GRADUATION_TARGET + 1n })).to.be.revertedWithCustomError(
      factory,
      "ParamTooHigh"
    );
    await expect(factory.connect(owner).setConfig({ ...validConfig, totalSupply: ethers.parseEther("1000000000") + 1n })).to.be.revertedWithCustomError(
      factory,
      "ParamTooHigh"
    );
    // Launch generation (C5 §2 rule 1): liquidityBps is gone; a curve whose sold-out graduation would not fit
    // the liquidity allocation is refused instead -- no allocation at all, and the old 84/14 production split.
    await expect(factory.connect(owner).setConfig({ ...validConfig, liquidityTokenBps: 0n })).to.be.revertedWithCustomError(
      factory,
      "SupplyBoundBroken"
    );
    await expect(
      factory.connect(owner).setConfig({
        totalSupply: ethers.parseEther("1000000000"),
        curveBps: 8400n,
        liquidityTokenBps: 1400n,
        basePrice: 1_000_000_000n,
        priceSlope: 1080n,
        graduationTarget: ethers.parseEther("30000"),
      })
    ).to.be.revertedWithCustomError(factory, "SupplyBoundBroken");
    // The generation's own defaults pass the same bound.
    await expect(
      factory.connect(owner).setConfig({
        totalSupply: ethers.parseEther("1000000000"),
        curveBps: 7000n,
        liquidityTokenBps: 2800n,
        basePrice: 1_000_000_000n,
        priceSlope: 1080n,
        graduationTarget: ethers.parseEther("30000"),
      })
    ).to.emit(factory, "ConfigUpdated");
  });

  it("setConfig accepts documented upper bounds and campaigns inherit the frozen economic snapshot", async () => {
    const { factory, owner, creator } = await deployCoreFixture();
    const boundedConfig = {
      totalSupply: ethers.parseEther("1000"),
      curveBps: 6000n,
      liquidityTokenBps: 3000n,
      basePrice: MAX_BASE_PRICE,
      priceSlope: MAX_PRICE_SLOPE,
      graduationTarget: MAX_GRADUATION_TARGET,
    };

    await expect(factory.connect(owner).setConfig(boundedConfig)).to.emit(factory, "ConfigUpdated");
    await factory.connect(creator).createCampaign(baseReq({ name: "Bounded", symbol: "BND" }) as any);

    const info = await factory.getCampaign(0n);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
    expect(await campaign.totalSupply()).to.eq(boundedConfig.totalSupply);
    expect(await campaign.curveSupply()).to.eq((boundedConfig.totalSupply * boundedConfig.curveBps) / MAX_BPS);
    expect(await campaign.liquiditySupply()).to.eq((boundedConfig.totalSupply * boundedConfig.liquidityTokenBps) / MAX_BPS);
    expect(await campaign.creatorReserve()).to.eq(ethers.parseEther("100"));
    expect(await campaign.basePrice()).to.eq(MAX_BASE_PRICE);
    expect(await campaign.priceSlope()).to.eq(MAX_PRICE_SLOPE);
    expect(await campaign.graduationTarget()).to.eq(MAX_GRADUATION_TARGET);
    const stored = await factory.config();
    expect(stored.priceSlope).to.eq(MAX_PRICE_SLOPE);
    expect(stored.basePrice).to.eq(MAX_BASE_PRICE);
  });

  it("always applies factory-configured economics to new campaigns", async () => {
    const { factory, creator } = await deployCoreFixture();
    const configured = await factory.config();

    await factory.connect(creator).createCampaign(baseReq({ name: "FixedEconomics", symbol: "FIX" }) as any);

    const info = await factory.getCampaign(0n);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
    expect(await campaign.basePrice()).to.eq(configured.basePrice);
    expect(await campaign.priceSlope()).to.eq(configured.priceSlope);
    expect(await campaign.graduationTarget()).to.eq(configured.graduationTarget);
  });

  it("allows each campaign request to override the graduation target", async () => {
    const { factory, creator, owner, priceFeed } = await deployCoreFixture();
    // Launch generation: create refuses a target above 95% of what the full curve raises at the oracle
    // price, so this uses the generation's production curve and a $600 native price (the fixture's tiny
    // curve raises ~1.25 native, far below $15k at $1).
    await factory.connect(owner).setConfig({
      totalSupply: ethers.parseEther("1000000000"),
      curveBps: 7000n,
      liquidityTokenBps: 2800n,
      basePrice: 1_000_000_000n,
      priceSlope: 1080n,
      graduationTarget: ethers.parseEther("30000"),
    });
    const now = await latestTimestamp();
    await priceFeed.setRoundData(2n, ethers.parseUnits("600", 8), now, now, 2n);
    const configured = await factory.config();
    const fastTarget = ethers.parseEther("15000");

    await factory.connect(creator).createCampaign(baseReq({ name: "FastGrad", symbol: "FAST", graduationTarget: fastTarget }) as any);

    const info = await factory.getCampaign(0n);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
    expect(await campaign.basePrice()).to.eq(configured.basePrice);
    expect(await campaign.priceSlope()).to.eq(configured.priceSlope);
    expect(await campaign.graduationTarget()).to.eq(fastTarget);
  });

  it("locks economic and routing setters after the first campaign exists", async () => {
    const { factory, owner, creator, alice, graduationOracle, graduationAdapter, tokenDeployer } = (await deployCoreFixture()) as any;

    await factory.connect(creator).createCampaign(baseReq({ name: "Locked", symbol: "LCK" }) as any);

    // setCoreRouting and setLaunchProtectionConfig no longer exist (routing fixed at construction; block
    // protection replaced by the C2 anti-sniper fee). The generation's adapter/deployer setters lock too.
    expect(factory.interface.getFunction("setCoreRouting")).to.eq(null);
    expect(factory.interface.getFunction("setLaunchProtectionConfig")).to.eq(null);
    await expect(factory.connect(owner).setNativeGraduationAdapter(await graduationAdapter.getAddress())).to.be.revertedWithCustomError(factory, "FactoryLocked");
    await expect(factory.connect(owner).setLaunchTokenDeployer(await tokenDeployer.getAddress())).to.be.revertedWithCustomError(factory, "FactoryLocked");
    await expect(factory.connect(owner).setStockGraduationAdapter(ethers.ZeroAddress)).to.be.revertedWithCustomError(factory, "FactoryLocked");
    await expect(factory.connect(owner).setStockCampaignImplementation(ethers.ZeroAddress)).to.be.revertedWithCustomError(factory, "FactoryLocked");
    await expect(factory.connect(alice).setProtocolFee(123n)).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
    await expect(factory.connect(owner).setGraduationOracle(await graduationOracle.getAddress())).to.be.revertedWithCustomError(factory, "FactoryLocked");
    await expect(factory.connect(owner).setProtocolFee(123n)).to.be.revertedWithCustomError(factory, "FactoryLocked");
    await expect(factory.connect(owner).setRouteProfiles(1, 1)).to.be.revertedWithCustomError(factory, "FactoryLocked");
    await expect(
      factory.connect(owner).setConfig({
        totalSupply: 1n,
        curveBps: 5000n,
        liquidityTokenBps: 4000n,
        basePrice: 1n,
        priceSlope: 1n,
        graduationTarget: 1n,
      })
    ).to.be.revertedWithCustomError(factory, "FactoryLocked");
  });
});
