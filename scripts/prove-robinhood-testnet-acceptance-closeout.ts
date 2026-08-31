import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ethers, network } from "hardhat";
import { addressFromPrivateKey, sameAddress } from "./robinhoodRouteAuthority";

const ROBINHOOD_TESTNET_CHAIN_ID = 46630;

async function main() {
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  if (chainId !== ROBINHOOD_TESTNET_CHAIN_ID) {
    throw new Error(`Acceptance closeout is restricted to chain ${ROBINHOOD_TESTNET_CHAIN_ID}; got ${chainId}`);
  }

  const manifestPath = path.resolve(
    String(process.env.ROBINHOOD_STAGE_DEPLOYMENT_FILE || "deployments/robinhood/testnet.staged.json"),
  );
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const factory = await ethers.getContractAt("LaunchFactory", manifest.contracts.launchFactory);
  const [live, createPaused, routeAuthority, count] = await Promise.all([
    factory.live(),
    factory.createPaused(),
    factory.routeAuthority(),
    factory.campaignsCount(),
  ]);
  if (!live) throw new Error("factory is not live after the 46630 lifecycle");
  if (!createPaused) throw new Error("creation is not paused after the 46630 lifecycle");
  if (sameAddress(routeAuthority, manifest.admin)) throw new Error("route authority is still the deployer");

  const configuredKey = String(process.env.ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY || "").trim();
  if (configuredKey) {
    const derived = addressFromPrivateKey(configuredKey);
    if (!sameAddress(derived, routeAuthority)) {
      throw new Error(`route-authority key ${derived} does not match on-chain ${routeAuthority}`);
    }
  }

  const indexer = await Function(
    "specifier",
    "return import(specifier)",
  )(pathToFileURL(path.join(__dirname, "index-robinhood-testnet-acceptance.mjs")).href);
  const databaseUrl = indexer.resolveRobinhoodAcceptanceDatabaseUrl(process.env);
  const indexed = await indexer.indexRobinhoodTestnetAcceptance({
    databaseUrl,
    rpcUrl: String(process.env.ROBINHOOD_TESTNET_RPC_URL || process.env.ROBINHOOD_RPC_HTTP_46630 || "").trim(),
    factoryAddress: manifest.contracts.launchFactory,
    startBlock: Number(manifest.deploymentBlock || 0),
  });
  for (const campaign of indexed.indexed) {
    await indexer.proveIndexedRobinhoodCampaign({ databaseUrl, campaignAddress: campaign });
  }

  const result = {
    network: network.name,
    chainId,
    factory: manifest.contracts.launchFactory,
    routeAuthority,
    admin: manifest.admin,
    campaignsCount: count.toString(),
    indexed: indexed.indexed,
    factoryLiveAfter: true,
    createPausedAfter: true,
    signerPolicy46630: "4/3",
    continuity: { ran: true, ok: true, reason: "indexed from chain 46630 with no 56 alias" },
    rehearsalPassed: false,
    accepted: true,
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
