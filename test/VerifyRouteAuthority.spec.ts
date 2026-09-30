import { expect } from "chai";
import { ethers } from "hardhat";

const {
  assertSignerRoundTrip,
  configuredRouteAuthority,
  createRouteAuthDigest,
  hardhatEphemeralHint,
  hashCampaignRequest,
  normalizeAddress,
  requireContractCode,
  tradeRouteAuthDigest,
} = require("../scripts/verify-route-authority.cjs");

async function expectRejects(promise: Promise<unknown>, message: string) {
  try {
    await promise;
  } catch (error: any) {
    expect(error.message).to.include(message);
    return;
  }
  throw new Error(`Expected rejection including: ${message}`);
}

describe("verify-route-authority script", function () {
  let originalAddress: string | undefined;
  let originalPrivateKey: string | undefined;

  beforeEach(() => {
    originalAddress = process.env.ROUTE_AUTHORITY_ADDRESS;
    originalPrivateKey = process.env.ROUTE_AUTHORITY_PRIVATE_KEY;
    delete process.env.ROUTE_AUTHORITY_ADDRESS;
    delete process.env.ROUTE_AUTHORITY_PRIVATE_KEY;
  });

  afterEach(() => {
    if (originalAddress === undefined) delete process.env.ROUTE_AUTHORITY_ADDRESS;
    else process.env.ROUTE_AUTHORITY_ADDRESS = originalAddress;
    if (originalPrivateKey === undefined) delete process.env.ROUTE_AUTHORITY_PRIVATE_KEY;
    else process.env.ROUTE_AUTHORITY_PRIVATE_KEY = originalPrivateKey;
  });

  it("normalizes configured route authority address or private key", async () => {
    const wallet = ethers.Wallet.createRandom();
    process.env.ROUTE_AUTHORITY_ADDRESS = wallet.address.toLowerCase();

    const byAddress = configuredRouteAuthority();
    expect(byAddress.address).to.eq(wallet.address);
    expect(byAddress.wallet).to.eq(null);

    delete process.env.ROUTE_AUTHORITY_ADDRESS;
    process.env.ROUTE_AUTHORITY_PRIVATE_KEY = wallet.privateKey.replace(/^0x/, "");

    const byKey = configuredRouteAuthority();
    expect(byKey.address).to.eq(wallet.address);
    expect(byKey.wallet.address).to.eq(wallet.address);
  });

  it("rejects missing or malformed authority configuration", async () => {
    expect(() => configuredRouteAuthority()).to.throw("Set ROUTE_AUTHORITY_ADDRESS or ROUTE_AUTHORITY_PRIVATE_KEY");
    expect(() => normalizeAddress("not-an-address", "BAD_ADDRESS")).to.throw("invalid address");
  });

  it("builds create and trade route authorization digests that recover from the configured signer", async () => {
    const wallet = ethers.Wallet.createRandom();
    const chainId = 31337n;
    const factory = "0x0000000000000000000000000000000000000001";
    const campaign = "0x0000000000000000000000000000000000000002";
    const requestHash = hashCampaignRequest({
      name: "Probe",
      symbol: "PRB",
      logoURI: "ipfs://probe",
      xAccount: "",
      website: "",
      extraLink: "",
      basePrice: 0n,
      priceSlope: 0n,
      graduationTarget: 0n,
      firstBuyTokens: 0n,
      firstBuyMaxCost: 0n,
      feeChoice: 1,
      feeCreatorPct: 0,
      lpReceiver: ethers.ZeroAddress,
    });
    const deadline = 1234567890n;

    const createDigest = createRouteAuthDigest({
      chainId,
      factory,
      creator: wallet.address,
      requestHash,
      tradeRouteProfile: 1,
      finalizeRouteProfile: 1,
      deadline,
    });
    const tradeDigest = tradeRouteAuthDigest({
      chainId,
      campaign,
      actor: wallet.address,
      routeProfile: 1,
      action: 0,
      amount: ethers.parseEther("1"),
      limit: ethers.parseEther("0.01"),
      deadline,
    });

    expect(createDigest).to.match(/^0x[a-fA-F0-9]{64}$/);
    expect(tradeDigest).to.match(/^0x[a-fA-F0-9]{64}$/);
    await assertSignerRoundTrip(wallet, wallet.address, createDigest, "create route auth");
    await assertSignerRoundTrip(wallet, wallet.address, tradeDigest, "trade route auth");
  });

  it("reports hardhat ephemeral-network hints for addresses without code", async () => {
    const [owner] = await ethers.getSigners();

    expect(hardhatEphemeralHint(await owner.getAddress(), "hardhat")).to.include("ephemeral per command");
    await expectRejects(
      requireContractCode(await owner.getAddress(), "LaunchFactory", ethers.provider, "hardhat"),
      "has no code on hardhat"
    );
  });
});
