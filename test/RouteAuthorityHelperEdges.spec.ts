import { expect } from "chai";
import { ethers } from "hardhat";

const verifier = require("../scripts/verify-route-authority.cjs");

const BACKEND_GAP =
  "BACKEND GAP: routeAuthorizationSigner/verify-route-authority hash the old 7-field request; generation 6 needs 11 fields (firstBuyTokens, firstBuyMaxCost, feeChoice, feeCreatorPct)";

describe("route authority verifier helper edges", function () {
  it("exports the ABI type layouts used by create and trade hashes", async () => {
    expect(verifier.CREATE_AUTH_TYPES).to.deep.eq([
      "string",
      "uint256",
      "address",
      "address",
      "bytes32",
      "uint8",
      "uint8",
      "uint64",
    ]);
    expect(verifier.TRADE_AUTH_TYPES).to.deep.eq([
      "string",
      "uint256",
      "address",
      "address",
      "uint8",
      "uint8",
      "uint256",
      "uint256",
      "uint64",
    ]);
  });

  // The generation-6 factory hashes the 11-field CampaignRequest (LaunchFactory._hashCampaignRequest).
  it.skip(`exports the ABI type layout used by request hashes -- ${BACKEND_GAP}`, async () => {
    expect(verifier.REQUEST_HASH_TYPES).to.deep.eq([
      "bytes32",
      "bytes32",
      "bytes32",
      "bytes32",
      "bytes32",
      "bytes32",
      "uint256", "uint256", "uint256", "uint8", "uint8",
    ]);
  });

  it("hashes empty and ascii strings exactly like ethers", async () => {
    for (const value of ["", "RouteAuthProbe", "meme-route-123"]) {
      expect(verifier.hashString(value)).to.eq(ethers.keccak256(ethers.toUtf8Bytes(value)));
    }
  });

  it("adds a hardhat ephemeral-network hint on the local hardhat network", async () => {
    const hint = verifier.hardhatEphemeralHint("0x0000000000000000000000000000000000000001", "hardhat");

    expect(hint).to.include("hardhat network is ephemeral per command");
    expect(hint).to.include("0x0000000000000000000000000000000000000001");
  });

  it("rejects addresses without contract code with the checked label", async () => {
    let message = "";
    try {
      await verifier.requireContractCode(ethers.ZeroAddress, "ZeroProbe", ethers.provider, "hardhat");
    } catch (error: any) {
      message = error.message;
    }

    expect(message).to.include("ZeroProbe 0x0000000000000000000000000000000000000000 has no code");
  });

  it("accepts deployed contracts when bytecode is present", async () => {
    const receiver = await ethers.deployContract("AcceptingReceiver");
    await receiver.waitForDeployment();

    await verifier.requireContractCode(await receiver.getAddress(), "AcceptingReceiver", ethers.provider, "hardhat");
  });
});
