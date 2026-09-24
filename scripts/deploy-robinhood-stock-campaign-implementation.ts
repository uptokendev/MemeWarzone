/**
 * Deploy RobinhoodStockLaunchCampaign -- the implementation every stock-bound
 * campaign is cloned from -- and write the Safe batch that binds it to the
 * factory with setStockCampaignImplementation.
 *
 * Found 2026-09-24 by running the stock registry sync in the API container:
 * every candidate stopped at "Stock campaign implementation is not configured".
 * On chain, the Robinhood mainnet factory 0x35E93D0b… answers
 * stockCampaignImplementation() == 0x0. The generation deploy script never
 * deployed this contract nor set it, so createStockCampaignAuthorized has
 * nothing to clone and no stock-bound campaign can exist on Robinhood.
 *
 * ORDER MATTERS. setStockCampaignImplementation is `whenMutable`: it reverts
 * FactoryLocked as soon as the factory holds ONE campaign of any kind. The
 * Safe batch this writes must execute BEFORE the step-H batch that unpauses
 * create on Robinhood. After the first campaign, only a new factory
 * generation can carry stock bindings.
 *
 *   npx hardhat run scripts/deploy-robinhood-stock-campaign-implementation.ts --network robinhoodMainnet
 *
 * Reads only, then deploys one contract from the deployer; the binding itself
 * is the Safe's (factory owner). Rehearsed by
 * test/RobinhoodStockCampaignImplementationDeploy.spec.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";

import { buildBatch } from "./make-safe-batch";

export const ROBINHOOD_MAINNET_CHAIN_ID = 4663n;
export const RECORD_PATH = path.resolve(__dirname, "..", "deployments", "robinhood", "mainnet.stock-campaign-implementation.json");
export const BATCH_PATH = path.resolve(__dirname, "..", "deployments", "robinhood", "mainnet.R5-stock-campaign-implementation.safe-batch.json");
const GENERATION_RECORD_PATH = path.resolve(__dirname, "..", "deployments", "robinhood", "mainnet.quote-generation.json");

const FACTORY_ABI = [
  "function liquidityKind() view returns (uint8)",
  "function LIQUIDITY_KIND_V3_NFT() view returns (uint8)",
  "function campaignsCount() view returns (uint256)",
  "function stockCampaignImplementation() view returns (address)",
  "function stockGraduationAdapter() view returns (address)",
  "function owner() view returns (address)",
];

export type FactoryReadiness = {
  factory: string;
  owner: string;
  liquidityKind: number;
  campaigns: bigint;
  stockAdapter: string;
  stockImplementation: string;
};

/** Every reason the Safe call would revert or be pointless, found before a wei is spent. */
export async function readFactoryReadiness(factoryAddress: string): Promise<FactoryReadiness> {
  const factory = ethers.getAddress(factoryAddress);
  if ((await ethers.provider.getCode(factory)) === "0x") throw new Error(`factory ${factory} has no code on this chain`);
  const reader = new ethers.Contract(factory, FACTORY_ABI, ethers.provider);
  const [liquidityKind, v3Kind, campaigns, stockImplementation, stockAdapter, owner] = await Promise.all([
    reader.liquidityKind(), reader.LIQUIDITY_KIND_V3_NFT(), reader.campaignsCount(), reader.stockCampaignImplementation(), reader.stockGraduationAdapter(), reader.owner(),
  ]);
  if (Number(liquidityKind) !== Number(v3Kind)) {
    throw new Error(`factory liquidityKind is ${liquidityKind}, not V3 (${v3Kind}); setStockCampaignImplementation would revert UnsupportedLiquidityKind`);
  }
  if (BigInt(campaigns) !== 0n) {
    throw new Error(`factory already holds ${campaigns} campaign(s): setStockCampaignImplementation is whenMutable and reverts FactoryLocked -- stock bindings need a new factory generation`);
  }
  if (ethers.getAddress(stockAdapter) === ethers.ZeroAddress) {
    throw new Error("factory has no stockGraduationAdapter; set it in the same Safe batch, before this call");
  }
  if (ethers.getAddress(stockImplementation) !== ethers.ZeroAddress) {
    throw new Error(`factory already has stockCampaignImplementation ${stockImplementation}; nothing to do`);
  }
  return {
    factory,
    owner: ethers.getAddress(owner),
    liquidityKind: Number(liquidityKind),
    campaigns: BigInt(campaigns),
    stockAdapter: ethers.getAddress(stockAdapter),
    stockImplementation: ethers.getAddress(stockImplementation),
  };
}

/** Deploys the implementation (no constructor args; it is only ever cloned) and proves the factory will accept it. */
export async function deployStockCampaignImplementation(): Promise<string> {
  const factory = await ethers.getContractFactory("RobinhoodStockLaunchCampaign");
  const implementation = await factory.deploy();
  await implementation.waitForDeployment();
  const address = await implementation.getAddress();
  if ((await ethers.provider.getCode(address)) === "0x") throw new Error("implementation has no code after deploy");
  if ((await implementation.isStockCampaignImplementation()) !== true) {
    throw new Error("isStockCampaignImplementation() is not true; the factory would revert StockCampaignImplementationUnavailable");
  }
  return address;
}

export function stockImplementationBatch(chainId: number, factoryAddress: string, implementation: string) {
  return buildBatch(
    chainId,
    "R5 Robinhood stock campaign implementation",
    `Bind RobinhoodStockLaunchCampaign ${implementation} to LaunchFactory ${factoryAddress}. Must execute BEFORE the step-H setCreatePaused(false): the setter is whenMutable and locks at the first campaign.`,
    [{ to: factoryAddress, contract: "LaunchFactory", fn: "setStockCampaignImplementation", args: [implementation] }],
  );
}

async function main() {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  if (chainId !== ROBINHOOD_MAINNET_CHAIN_ID) {
    throw new Error(`this script is for Robinhood mainnet (4663); ${network.name} reports chain ${chainId}`);
  }
  if (fs.existsSync(RECORD_PATH)) {
    throw new Error(`${RECORD_PATH} exists -- the implementation is already deployed; delete the record only if you mean to deploy a second one`);
  }
  const generation = JSON.parse(fs.readFileSync(GENERATION_RECORD_PATH, "utf8"));
  const factoryAddress = ethers.getAddress(String(generation.deployed?.LaunchFactory || ""));
  const safe = ethers.getAddress(String(generation.owner || ""));
  const readiness = await readFactoryReadiness(factoryAddress);
  if (readiness.owner !== safe) throw new Error(`factory owner is ${readiness.owner}, expected the Safe ${safe}`);

  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`[stock-impl] chain ${chainId}  deployer ${deployer.address}  ${ethers.formatEther(balance)} ETH`);
  console.log(`[stock-impl] factory ${readiness.factory}  owner (Safe) ${readiness.owner}  campaigns ${readiness.campaigns}  adapter ${readiness.stockAdapter}`);

  const implementation = await deployStockCampaignImplementation();
  const block = await ethers.provider.getBlockNumber();
  const batch = stockImplementationBatch(Number(chainId), readiness.factory, implementation);
  fs.writeFileSync(BATCH_PATH, `${JSON.stringify(batch, null, 2)}\n`);
  const record = {
    network: network.name,
    chainId: Number(chainId),
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    block,
    contracts: { RobinhoodStockLaunchCampaign: implementation },
    factory: readiness.factory,
    safe: readiness.owner,
    bound: false,
    safeBatch: path.basename(BATCH_PATH),
    verification: { name: "RobinhoodStockLaunchCampaign", address: implementation, contract: "contracts/RobinhoodStockLaunchCampaign.sol:RobinhoodStockLaunchCampaign", args: [] },
  };
  fs.writeFileSync(RECORD_PATH, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`[stock-impl] RobinhoodStockLaunchCampaign ${implementation}  (block ${block})`);
  console.log(`[stock-impl] wrote ${RECORD_PATH}`);
  console.log(`[stock-impl] wrote ${BATCH_PATH}  <- import in the Safe Transaction Builder, sign, execute`);
  console.log("[stock-impl] ORDER: execute this batch BEFORE mainnet.H-open.safe-batch.json. The first campaign locks the setter forever.");
  console.log("[stock-impl] then: node scripts/sync-robinhood-stock-registry.mjs --rescan-only   (in the API container)");
  console.log(`[stock-impl] verification manifest entry: ${JSON.stringify(record.verification)}`);
}

if (require.main === module) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
