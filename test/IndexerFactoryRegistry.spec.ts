import { expect } from "chai";
import { ethers } from "hardhat";

const { buildIndexerManifest, eventTopic } = require("../scripts/lib/indexerManifest.cjs");
const { buildInterfaces, contractFilters, decodeLog, getCursorScope, supportedFactories } = require("../scripts/indexer-runtime.cjs");

function addr(id: number) {
  return `0x${id.toString(16).padStart(40, "0")}`;
}

function baseDeployment() {
  return {
    network: "bscTestnet",
    chainId: 97,
    deploymentBlock: 100,
    router: addr(30),
    topazRouterAdapter: addr(13),
    productionTopazRouter: addr(14),
    contracts: {
      LaunchFactory: addr(1),
      LaunchCampaignImplementation: addr(2),
      TreasuryRouter: addr(3),
      TreasuryVaultV2: addr(4),
      RecruiterRewardsVault: addr(5),
      CommunityRewardsVault: addr(6),
      ProtocolRevenueVault: addr(7),
      CreatorRegistry: addr(8),
      RiskRegistry: addr(9),
      GraduationOracle: addr(10),
      PermanentLpLocker: addr(11),
      UPVoteTreasury: addr(12),
    },
    routing: {
      factoryRouteAuthority: addr(20),
    },
  };
}

describe("Indexer factory registry support", function () {
  it("adds a default active factory registry for single-factory deployments", async () => {
    const manifest = buildIndexerManifest(baseDeployment(), "single factory deployment");

    expect(manifest.factoryRegistry.activeFactory).to.eq(ethers.getAddress(addr(1)));
    expect(manifest.factoryRegistry.activeGeneration).to.eq("current");
    expect(manifest.factoryRegistry.factories).to.have.length(1);
    expect(manifest.factoryRegistry.factories[0]).to.include({
      generation: "current",
      address: ethers.getAddress(addr(1)),
      creationEnabled: true,
      tradingEnabled: true,
      supportEnabled: true,
    });
    expect(manifest.factoryRegistry.factories[0].treasuryRouter).to.eq(ethers.getAddress(addr(3)));
    expect(manifest.factoryRegistry.factories[0].permanentLpLocker).to.eq(ethers.getAddress(addr(11)));
  });

  it("keeps supported previous factories while enforcing exactly one creation-enabled active factory", async () => {
    const deployment = {
      ...baseDeployment(),
      factoryRegistry: {
        activeFactory: addr(1),
        factories: [
          {
            generation: "previous-testnet",
            address: addr(21),
            deploymentBlock: 50,
            creationEnabled: false,
            tradingEnabled: true,
            supportEnabled: true,
            routeAuthority: addr(22),
            treasuryRouter: addr(23),
            permanentLpLocker: addr(24),
          },
          {
            generation: "final-testnet",
            address: addr(1),
            deploymentBlock: 100,
            creationEnabled: true,
            tradingEnabled: true,
            supportEnabled: true,
          },
        ],
      },
    };

    const manifest = buildIndexerManifest(deployment, "multi factory deployment");

    expect(manifest.factoryRegistry.activeFactory).to.eq(ethers.getAddress(addr(1)));
    expect(manifest.factoryRegistry.activeGeneration).to.eq("final-testnet");
    expect(manifest.factoryRegistry.factories.map((factory: any) => factory.generation)).to.deep.eq([
      "previous-testnet",
      "final-testnet",
    ]);
    expect(supportedFactories(manifest).map((factory: any) => factory.address)).to.deep.eq([
      ethers.getAddress(addr(21)),
      ethers.getAddress(addr(1)),
    ]);
  });

  it("rejects ambiguous creation-enabled factory registries", async () => {
    const deployment = {
      ...baseDeployment(),
      factoryRegistry: {
        activeFactory: addr(1),
        factories: [
          { generation: "a", address: addr(1), creationEnabled: true },
          { generation: "b", address: addr(21), creationEnabled: true },
        ],
      },
    };

    expect(() => buildIndexerManifest(deployment, "bad registry")).to.throw(
      "expected exactly one creationEnabled factory"
    );
  });

  it("builds one LaunchFactory filter and cursor scope per supported factory", async () => {
    const manifest = buildIndexerManifest(
      {
        ...baseDeployment(),
        factoryRegistry: {
          activeFactory: addr(1),
          factories: [
            { generation: "previous", address: addr(21), deploymentBlock: 50, creationEnabled: false, supportEnabled: true },
            { generation: "current", address: addr(1), deploymentBlock: 100, creationEnabled: true, supportEnabled: true },
            { generation: "archived", address: addr(31), deploymentBlock: 20, creationEnabled: false, supportEnabled: false },
          ],
        },
      },
      "filter deployment"
    );

    const factoryFilters = contractFilters(manifest).filter((filter: any) => filter.contractName === "LaunchFactory");
    expect(factoryFilters.map((filter: any) => filter.factoryGeneration)).to.deep.eq(["previous", "current"]);
    expect(factoryFilters.map((filter: any) => filter.address)).to.deep.eq([ethers.getAddress(addr(21)), ethers.getAddress(addr(1))]);

    const cursor = { schemaVersion: 2, chainId: 97, scopes: {} as Record<string, any> };
    const previousScope = getCursorScope(cursor, manifest, factoryFilters[0]);
    const currentScope = getCursorScope(cursor, manifest, factoryFilters[1]);
    expect(previousScope.scope.lastFinalizedBlock).to.eq(49);
    expect(currentScope.scope.lastFinalizedBlock).to.eq(99);
    expect(previousScope.key).to.not.eq(currentScope.key);
  });

  // Was skipped as a CONTRACT FINDING until 2026-09-30: the manifest listed bare signatures only and the
  // runtime decoded with a fallback ABI that marks nothing indexed. The manifest now carries full fragments.
  it("preserves factory address and generation on decoded LaunchFactory events", async () => {
    const deployment = baseDeployment();
    const manifest = buildIndexerManifest(deployment, "decode deployment");
    const topicMap = buildInterfaces(manifest);
    const iface = new ethers.Interface([
      "event CampaignCreated(uint256 indexed id, address indexed campaign, address indexed creator, address token, string name, string symbol, string logoURI, string xAccount)",
    ]);
    const encoded = iface.encodeEventLog(iface.getEvent("CampaignCreated")!, [
      7n,
      addr(40),
      addr(41),
      addr(42),
      "Generation Token",
      "GEN",
      "ipfs://gen",
      "@gen",
    ]);

    const decoded = decodeLog(
      {
        chainId: 97,
        contractName: "LaunchFactory",
        address: ethers.getAddress(addr(21)),
        factoryAddress: ethers.getAddress(addr(21)),
        factoryGeneration: "previous",
        topics: encoded.topics,
        data: encoded.data,
        blockNumber: 123,
        blockHash: `0x${"1".repeat(64)}`,
        transactionHash: `0x${"2".repeat(64)}`,
        transactionIndex: 0,
        logIndex: 3,
      },
      topicMap
    );

    expect(decoded.eventSignature).to.eq("CampaignCreated(uint256,address,address,address,string,string,string,string)");
    expect(decoded.factoryAddress).to.eq(ethers.getAddress(addr(21)));
    expect(decoded.factoryGeneration).to.eq("previous");
    expect(decoded.args["0"]).to.eq("7");
    expect(decoded.args["1"]).to.eq(ethers.getAddress(addr(40)));
  });

  it("decodes launch-generation campaign and factory events with their indexed topics, and keeps the old ones", async () => {
    const manifest = buildIndexerManifest(baseDeployment(), "gen5 deployment");
    const topicMap = buildInterfaces(manifest);
    const campaignIface = new ethers.Interface([
      "event Graduated(address indexed pool, uint256 raise, uint256 protocolShare, uint256 creatorShare, uint256 poolNative, uint256 memeUsed, uint256 memeBurned, uint256 curvePrice, uint256 startPrice, bool repaired)",
      "event CampaignFinalized(address indexed caller, address indexed pair, uint256 graduationBalance, uint256 graduationOvershoot, uint256 liquidityTokens, uint256 liquidityBnb, uint256 liquidityLp, uint256 protocolFee, uint256 creatorPayout, uint256 burnedUnsoldTokens, uint256 burnedUnusedLpTokens, uint256 finalCurvePrice, uint256 initialDexPrice, uint256 postBurnTotalSupply)",
    ]);
    const factoryIface = new ethers.Interface([
      "event CampaignFeeChoiceSet(address indexed campaign, address indexed creator, address indexed vault, uint8 choice, uint8 creatorPct)",
    ]);
    const base = { chainId: 97, blockNumber: 1, blockHash: `0x${"1".repeat(64)}`, transactionHash: `0x${"2".repeat(64)}`, transactionIndex: 0, logIndex: 0 };
    const graduated = campaignIface.encodeEventLog(campaignIface.getEvent("Graduated")!, [addr(50), 100n, 2n, 19n, 78n, 5n, 6n, 7n, 8n, true]);
    const decodedGrad = decodeLog({ ...base, contractName: "LaunchCampaign", address: addr(60), topics: graduated.topics, data: graduated.data }, topicMap);
    expect(decodedGrad.eventName).to.eq("Graduated");
    expect(decodedGrad.args["0"]).to.eq(ethers.getAddress(addr(50)));
    expect(decodedGrad.args["9"]).to.eq(true);
    const finalized = campaignIface.encodeEventLog(campaignIface.getEvent("CampaignFinalized")!, [addr(51), addr(52), 1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n, 11n, 12n]);
    const decodedFin = decodeLog({ ...base, contractName: "LaunchCampaign", address: addr(61), topics: finalized.topics, data: finalized.data }, topicMap);
    expect(decodedFin.eventName).to.eq("CampaignFinalized");
    expect(decodedFin.args["1"]).to.eq(ethers.getAddress(addr(52)));
    const choice = factoryIface.encodeEventLog(factoryIface.getEvent("CampaignFeeChoiceSet")!, [addr(53), addr(54), addr(55), 3, 40]);
    const decodedChoice = decodeLog({ ...base, contractName: "LaunchFactory", address: addr(1), topics: choice.topics, data: choice.data }, topicMap);
    expect(decodedChoice.eventName).to.eq("CampaignFeeChoiceSet");
    expect(decodedChoice.args["3"]).to.eq("3");
    expect(decodedChoice.args["4"]).to.eq("40");
  });
});
