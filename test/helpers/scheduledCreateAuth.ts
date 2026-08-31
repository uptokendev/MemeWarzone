import { ethers } from "hardhat";
import { deployCoreFixture } from "../fixtures/core";

function hashCampaignRequest(req: {
  name: string;
  symbol: string;
  logoURI: string;
  xAccount: string;
  website: string;
  extraLink: string;
  graduationTarget: bigint;
}) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "uint256"],
      [
        ethers.keccak256(ethers.toUtf8Bytes(String(req.name))),
        ethers.keccak256(ethers.toUtf8Bytes(String(req.symbol))),
        ethers.keccak256(ethers.toUtf8Bytes(String(req.logoURI))),
        ethers.keccak256(ethers.toUtf8Bytes(String(req.xAccount))),
        ethers.keccak256(ethers.toUtf8Bytes(String(req.website))),
        ethers.keccak256(ethers.toUtf8Bytes(String(req.extraLink))),
        req.graduationTarget,
      ],
    ),
  );
}

/**
 * Deploy a factory whose treasury implements V3 routeTrade/routeFinalize.
 * The shared core fixture still uses TreasuryRouter V1, but LaunchFactory always
 * strict-routes fees through the V3 interface. Do not weaken the factory verifier.
 */
export async function deployScheduledCreateFixture() {
  const core = await deployCoreFixture();
  const MockRouter = await ethers.getContractFactory("MockPhase1TreasuryRouter");
  const feeRouter = await MockRouter.deploy();
  await feeRouter.waitForDeployment();

  const Factory = await ethers.getContractFactory("LaunchFactory");
  const factory = await Factory.deploy(
    await core.router.getAddress(),
    await feeRouter.getAddress(),
    await core.campaignImplementation.getAddress(),
    await core.graduationOracle.getAddress(),
  );
  await factory.waitForDeployment();

  const { owner } = core;
  const current = await core.factory.config();
  await factory.connect(owner).setRequireRouteAuthorization(false);
  await factory.connect(owner).setRequireAuthorizedTrading(false);
  await factory.connect(owner).setConfig({
    totalSupply: current.totalSupply,
    curveBps: current.curveBps,
    liquidityTokenBps: current.liquidityTokenBps,
    basePrice: current.basePrice,
    priceSlope: current.priceSlope,
    graduationTarget: current.graduationTarget,
    liquidityBps: current.liquidityBps,
  });
  await factory.connect(owner).enableLive();

  return { ...core, factory, feeRouter };
}

/** Sign the current factory digest. Do not hardcode generations; the contract is the authority. */
export async function signScheduledCreateAuthorization(
  factory: any,
  creator: string,
  signer: any,
  request: any,
  tradeRouteProfile: number,
  finalizeRouteProfile: number,
  deadline: bigint,
) {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const factoryGeneration = await factory.FACTORY_GENERATION();
  const campaignGeneration = await factory.CAMPAIGN_GENERATION();
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
        creator,
        hashCampaignRequest(request.campaign),
        request.launchAt,
        request.draftReferenceHash,
        request.normalizedTickerHash,
        request.metadataHash,
        request.reservationVersion,
        request.authorizationNonce,
        factoryGeneration,
        campaignGeneration,
        tradeRouteProfile,
        finalizeRouteProfile,
        deadline,
      ],
    ),
  );
  return signer.signMessage(ethers.getBytes(digest));
}
