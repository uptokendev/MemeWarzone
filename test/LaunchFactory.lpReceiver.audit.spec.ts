import { expect } from "chai";
import { ethers } from "hardhat";
import { deployCoreFixture } from "./fixtures/core";

const baseReq = (overrides: Record<string, unknown> = {}) => ({
  name: "PermanentLockerToken",
  symbol: "PLT",
  logoURI: "ipfs://permanent-locker",
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
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
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

async function signCreateRoute(factory: any, creator: string, signer: any, req: ReturnType<typeof baseReq>, deadline: bigint) {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const digest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256", "address", "address", "bytes32", "uint8", "uint8", "uint64"],
      ["MWZ_CREATE_ROUTE_AUTH", chainId, await factory.getAddress(), creator, hashCreateRouteRequest(req), 1, 1, deadline]
    )
  );
  return signer.signMessage(ethers.getBytes(digest));
}

describe("LaunchFactory permanent LP receiver", function () {
  it("does not expose an LP receiver in the creator-facing request and always injects the permanent locker", async () => {
    const { factory, creator } = await deployCoreFixture();

    await expect(factory.connect(creator).createCampaign(baseReq() as any)).to.emit(factory, "CampaignCreated");

    const info = await factory.getCampaign(0n);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
    expect(await campaign.lpReceiver()).to.eq(await factory.permanentLpLocker());
  });

  it("binds authorized creation to the complete public campaign request", async () => {
    const { factory, creator, owner } = await deployCoreFixture();
    await factory.connect(owner).setRouteAuthority(await owner.getAddress());

    const signedReq = baseReq({ name: "AuthorizedCampaign", symbol: "AUTH" });
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 600);
    const signature = await signCreateRoute(factory, await creator.getAddress(), owner, signedReq, deadline);

    await expect(
      factory.connect(creator).createCampaignAuthorized(signedReq as any, {
        tradeRouteProfile: 1,
        finalizeRouteProfile: 1,
        deadline,
        signature,
      })
    ).to.emit(factory, "CampaignCreated");
  });
});
