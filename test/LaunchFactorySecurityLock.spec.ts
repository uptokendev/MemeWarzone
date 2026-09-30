import { expect } from "chai";
import { ethers } from "hardhat";
import { deployCoreFixture } from "./fixtures/core";

type CampaignRequest = {
  name: string;
  symbol: string;
  logoURI: string;
  xAccount: string;
  website: string;
  extraLink: string;
  graduationTarget: bigint;
  firstBuyTokens?: bigint;
  firstBuyMaxCost?: bigint;
  feeChoice?: number;
  feeCreatorPct?: number;
};

const baseReq = (overrides: Partial<CampaignRequest> = {}): CampaignRequest => ({
  name: "LockedToken",
  symbol: "LCK",
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

async function signCreateRouteAuthorization(factory: any, routeAuthority: any, creator: any, req: CampaignRequest) {
  const latest = await ethers.provider.getBlock("latest");
  const deadline = BigInt(latest!.timestamp + 3600);
  const tradeRouteProfile = Number(await factory.ROUTE_PROFILE_STANDARD_UNLINKED());
  const finalizeRouteProfile = Number(await factory.ROUTE_PROFILE_STANDARD_UNLINKED());
  const abi = ethers.AbiCoder.defaultAbiCoder();

  const requestHash = ethers.keccak256(
    abi.encode(
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
  const { chainId } = await ethers.provider.getNetwork();
  const digest = ethers.keccak256(
    abi.encode(
      ["string", "uint256", "address", "address", "bytes32", "uint8", "uint8", "uint64"],
      [
        "MWZ_CREATE_ROUTE_AUTH",
        chainId,
        await factory.getAddress(),
        await creator.getAddress(),
        requestHash,
        tradeRouteProfile,
        finalizeRouteProfile,
        deadline,
      ]
    )
  );

  return {
    tradeRouteProfile,
    finalizeRouteProfile,
    deadline,
    signature: await routeAuthority.signMessage(ethers.getBytes(digest)),
  };
}

describe("LaunchFactory security defaults lock", function () {
  it("locks production security defaults against later bypass toggles", async () => {
    const { factory, owner, creator } = await deployCoreFixture();

    expect(await factory.securityDefaultsLocked()).to.eq(false);
    await expect(factory.connect(owner).lockSecurityDefaults()).to.be.revertedWithCustomError(factory, "SecurityDefaultsDisabled");

    await factory.connect(creator).createCampaign(baseReq() as any);
    const info = await factory.getCampaign(0n);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
    expect(await campaign.requireAuthorizedTrading()).to.eq(false);

    await factory.connect(owner).setRequireRouteAuthorization(true);
    await factory.connect(owner).setRequireAuthorizedTrading(true);

    await expect(factory.connect(owner).lockSecurityDefaults()).to.emit(factory, "SecurityDefaultsLockedEnabled");
    expect(await factory.securityDefaultsLocked()).to.eq(true);

    await expect(factory.connect(owner).lockSecurityDefaults()).to.be.revertedWithCustomError(factory, "SecurityDefaultsLocked");
    await expect(factory.connect(owner).setRequireRouteAuthorization(false)).to.be.revertedWithCustomError(factory, "SecurityDefaultsLocked");
    await expect(factory.connect(owner).setRequireAuthorizedTrading(false)).to.be.revertedWithCustomError(factory, "SecurityDefaultsLocked");

    await expect(factory.connect(owner).setCampaignRequireAuthorizedTrading(info.campaign, true))
      .to.emit(campaign, "RequireAuthorizedTradingUpdated")
      .withArgs(true);
    expect(await campaign.requireAuthorizedTrading()).to.eq(true);
    await expect(factory.connect(owner).setCampaignRequireAuthorizedTrading(info.campaign, false)).to.be.revertedWithCustomError(
      factory,
      "SecurityDefaultsLocked"
    );
  });

  it("allows a fresh production-style lock before authorized campaign creation", async () => {
    const { factory, owner, creator } = await deployCoreFixture();
    const req = baseReq({ name: "FreshLockedToken", symbol: "FLT" });

    await factory.connect(owner).setRequireRouteAuthorization(true);
    await factory.connect(owner).setRequireAuthorizedTrading(true);
    await factory.connect(owner).setRouteAuthority(await owner.getAddress());

    expect(await factory.campaignsCount()).to.eq(0n);
    await expect(factory.connect(owner).lockSecurityDefaults()).to.emit(factory, "SecurityDefaultsLockedEnabled");
    expect(await factory.securityDefaultsLocked()).to.eq(true);

    await expect(factory.connect(creator).createCampaign(req as any)).to.be.revertedWithCustomError(
      factory,
      "RouteAuthorizationRequired"
    );

    const routeAuth = await signCreateRouteAuthorization(factory, owner, creator, req);
    await expect(factory.connect(creator).createCampaignAuthorized(req as any, routeAuth)).to.emit(factory, "CampaignCreated");

    const info = await factory.getCampaign(0n);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
    expect(await campaign.requireAuthorizedTrading()).to.eq(true);
    expect(await factory.securityDefaultsLocked()).to.eq(true);
  });
});
