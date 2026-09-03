import { expect } from "chai";
import { ethers, network } from "hardhat";
import { deployCoreFixture } from "./fixtures/core";

const FACTORY_GENERATION = 4;
const CAMPAIGN_GENERATION = 2;

function campaignRequest(name: string, symbol: string) {
  return {
    name,
    symbol,
    logoURI: `ipfs://${symbol.toLowerCase()}`,
    xAccount: "",
    website: "",
    extraLink: "",
    graduationTarget: 0n,
  };
}

function hashCampaignRequest(req: ReturnType<typeof campaignRequest>) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
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

async function latestTimestamp() {
  return BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
}

function scheduledRequest(name: string, symbol: string, launchAt: bigint, nonce: bigint) {
  return {
    campaign: campaignRequest(name, symbol),
    launchAt,
    draftReferenceHash: ethers.id(`draft:${symbol}`),
    normalizedTickerHash: ethers.id(symbol),
    metadataHash: ethers.id(`metadata:${symbol}`),
    reservationVersion: 1n,
    authorizationNonce: nonce,
  };
}

async function signScheduled(factory: any, creator: any, authority: any, request: any) {
  const deadline = (await latestTimestamp()) + 600n;
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const digest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      [
        "string",
        "uint256",
        "address",
        "address",
        "bytes32",
        "uint64",
        "bytes32",
        "bytes32",
        "bytes32",
        "uint64",
        "uint256",
        "uint32",
        "uint32",
        "uint8",
        "uint8",
        "uint64",
      ],
      [
        "MWZ_CREATE_SCHEDULED_V2_AUTH",
        chainId,
        await factory.getAddress(),
        await creator.getAddress(),
        hashCampaignRequest(request.campaign),
        request.launchAt,
        request.draftReferenceHash,
        request.normalizedTickerHash,
        request.metadataHash,
        request.reservationVersion,
        request.authorizationNonce,
        FACTORY_GENERATION,
        CAMPAIGN_GENERATION,
        1,
        1,
        deadline,
      ],
    ),
  );
  return {
    tradeRouteProfile: 1,
    finalizeRouteProfile: 1,
    deadline,
    signature: await authority.signMessage(ethers.getBytes(digest)),
  };
}

async function configureRegistry(fixture: Awaited<ReturnType<typeof deployCoreFixture>>) {
  const { factory, owner } = fixture;
  const Registry = await ethers.getContractFactory("CreatorRegistry");
  const registry = await Registry.deploy();
  await registry.waitForDeployment();
  await registry.connect(owner).setLaunchRecorder(await factory.getAddress(), true);
  await factory.connect(owner).setRegistries(await registry.getAddress(), ethers.ZeroAddress);
  await factory.connect(owner).setRouteAuthority(await owner.getAddress());
  return registry;
}

async function notifyGraduatedFromCampaign(factory: any, campaignAddress: string, creatorAddress: string) {
  await network.provider.send("hardhat_setBalance", [campaignAddress, "0x56BC75E2D63100000"]);
  const campaignSigner = await ethers.getImpersonatedSigner(campaignAddress);
  return factory.connect(campaignSigner).notifyCampaignGraduated(creatorAddress, ethers.ZeroAddress);
}

describe("Creator arm cooldown correction", function () {
  it("uses one live-count ledger for immediate and scheduled campaigns and cannot decrement twice", async () => {
    const fixture = await deployCoreFixture();
    const { factory, owner, creator, alice } = fixture;
    const registry = await configureRegistry(fixture);

    await factory.connect(creator).createCampaign(campaignRequest("Immediate", "IMM"));
    const launchAt = (await latestTimestamp()) + 2n * 24n * 60n * 60n;
    const scheduled = scheduledRequest("Scheduled", "SCH", launchAt, 1n);
    await factory.connect(alice).createScheduledCampaignAuthorized(
      scheduled,
      await signScheduled(factory, alice, owner, scheduled),
    );

    expect((await registry.getCreatorProfile(await creator.getAddress())).liveBondingCount).to.equal(1n);
    expect((await registry.getCreatorProfile(await alice.getAddress())).liveBondingCount).to.equal(1n);

    const immediateInfo = await factory.getCampaign(0n);
    await notifyGraduatedFromCampaign(factory, immediateInfo.campaign, await creator.getAddress());
    expect((await registry.getCreatorProfile(await creator.getAddress())).liveBondingCount).to.equal(0n);
    await expect(
      notifyGraduatedFromCampaign(factory, immediateInfo.campaign, await creator.getAddress()),
    ).to.be.revertedWithCustomError(factory, "GraduationAlreadyRecorded");
    expect((await registry.getCreatorProfile(await creator.getAddress())).liveBondingCount).to.equal(0n);

    const scheduledInfo = await factory.getCampaign(1n);
    await notifyGraduatedFromCampaign(factory, scheduledInfo.campaign, await alice.getAddress());
    expect((await registry.getCreatorProfile(await alice.getAddress())).liveBondingCount).to.equal(0n);
    await expect(
      notifyGraduatedFromCampaign(factory, scheduledInfo.campaign, await alice.getAddress()),
    ).to.be.revertedWithCustomError(factory, "GraduationAlreadyRecorded");
    expect((await registry.getCreatorProfile(await alice.getAddress())).liveBondingCount).to.equal(0n);
  });

  it("opens several same-timestamp campaigns at the same block boundary", async () => {
    const fixture = await deployCoreFixture();
    const { factory, owner, creator, alice, bob } = fixture;
    await configureRegistry(fixture);

    const launchAt = (await latestTimestamp()) + 3600n;
    const first = scheduledRequest("Same Time A", "SMA", launchAt, 11n);
    const second = scheduledRequest("Same Time B", "SMB", launchAt, 12n);

    await factory.connect(creator).createScheduledCampaignAuthorized(
      first,
      await signScheduled(factory, creator, owner, first),
    );
    await factory.connect(alice).createScheduledCampaignAuthorized(
      second,
      await signScheduled(factory, alice, owner, second),
    );

    const campaignA = await ethers.getContractAt("LaunchCampaign", (await factory.getCampaign(0n)).campaign);
    const campaignB = await ethers.getContractAt("LaunchCampaign", (await factory.getCampaign(1n)).campaign);
    const amountOut = ethers.parseEther("1");
    const quoteA = await campaignA.quoteBuyExactTokens(amountOut);
    const quoteB = await campaignB.quoteBuyExactTokens(amountOut);

    await expect(campaignA.connect(bob).buyExactTokens(amountOut, quoteA, { value: quoteA }))
      .to.be.revertedWithCustomError(campaignA, "TradingNotOpen");
    await expect(campaignB.connect(bob).buyExactTokens(amountOut, quoteB, { value: quoteB }))
      .to.be.revertedWithCustomError(campaignB, "TradingNotOpen");

    await network.provider.send("evm_setNextBlockTimestamp", [Number(launchAt)]);
    await network.provider.send("evm_mine");

    await expect(campaignA.connect(bob).buyExactTokens(amountOut, quoteA, { value: quoteA }))
      .to.emit(campaignA, "TokensPurchased");
    await expect(campaignB.connect(bob).buyExactTokens(amountOut, quoteB, { value: quoteB }))
      .to.emit(campaignB, "TokensPurchased");
  });
});