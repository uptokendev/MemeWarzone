#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CENSUS_KIND = "bnb-current-generation-census";
export const SCHEMA_VERSION = 1;
export const BNB_MAINNET_CHAIN_ID = 56;
export const BNB_TESTNET_CHAIN_ID = 97;
export const ROBINHOOD_TESTNET_CHAIN_ID = 46630;
export const LIVE_FACTORY_GENERATION = 3;
export const LIVE_CAMPAIGN_GENERATION = 2;
export const SOURCE_FACTORY_GENERATION = 4;
export const SOURCE_CAMPAIGN_GENERATION = 3;
export const LIVE_LIQUIDITY_KIND = 1;
export const LIVE_TREASURY_GENERATION = "v2";
export const REQUIRED_POOL_FEE_BPS = 30;
export const SOURCE_HEAD_NOT_LIVE_BNB =
  "source factory generation 4 / campaign 3 != accepted live BNB generation 3 / campaign 2";

export const MAINNET_CREATION_FACTORY = "0xc378221E57898106079aE4B818a92978e4cd9559";
export const MAINNET_SUPPORT_FACTORY = "0x3068eAE6F8431bFc3c5Faae9c3bBB95F007be59a";
export const MAINNET_LOCKER = "0xFcE77642e22ef04B8398fB6dfEE99614CAb32f69";
export const MAINNET_TREASURY_V2 = "0xe157a6FDf19CAB61f2ECa048966f137A3240a921";
export const TESTNET_CREATION_FACTORY = "0x77Af7634837643d4f93d1086b492571268b30B5F";
export const TESTNET_LOCKER = "0xb083929D2bbabdE7fc580090D5B18bbD918Fda9a";
export const TESTNET_TREASURY_V2 = "0x0b0b3412bebaf92ABf1b3c977ee1664344e2d35d";
export const ROBINHOOD_TESTNET_FACTORY = "0xF170a2C97953754c2C1105E2AcC522Bc8e764D75";

const BNB_FACTORY_BROADCAST_SCRIPTS = [
  "scripts/deploy-clean-slate-factory.ts",
  "scripts/deploy-dual-test-factory.ts",
  "scripts/deploy-creator-arm-cooldown-factory.ts",
  "scripts/deploy-bnb-factory-replacement-phase-a.ts",
  "scripts/deploy-factory-only.ts",
];

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function censusPath(chainId) {
  const file = Number(chainId) === BNB_MAINNET_CHAIN_ID ? "mainnet.current.json" : "testnet.current.json";
  return path.join(repoRoot(), "deployments/bnb", file);
}

function isAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || ""));
}

function sameAddress(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot(), relativePath), "utf8");
}

function requireIncludes(haystack, needle, label) {
  if (!haystack.includes(needle)) throw new Error(`${label} is missing required proof text: ${needle}`);
}

function parseSourceGeneration(source, name, expected) {
  const match = source.match(new RegExp(`uint32 public constant ${name} = (\\d+);`));
  if (!match) throw new Error(`LaunchFactory.sol is missing ${name}`);
  const value = Number(match[1]);
  if (value !== expected) {
    throw new Error(`LaunchFactory.sol ${name} is ${value}, expected source-head ${expected}`);
  }
  return value;
}

export function parseBnbCurrentCensus(raw, expectedChainId) {
  if (raw == null || typeof raw !== "object") throw new Error("BNB census is missing or not an object");
  if (Number(raw.schemaVersion) !== SCHEMA_VERSION) throw new Error("BNB census schemaVersion must be 1");
  if (raw.kind !== CENSUS_KIND) throw new Error(`BNB census kind must be ${CENSUS_KIND}`);
  if (Number(raw.chainId) !== Number(expectedChainId)) {
    throw new Error(`BNB census chainId must be ${expectedChainId}`);
  }
  if (raw.live !== true) throw new Error("BNB census live must be true");
  if (Number(raw.factoryGeneration) !== LIVE_FACTORY_GENERATION || Number(raw.campaignGeneration) !== LIVE_CAMPAIGN_GENERATION) {
    throw new Error(`BNB census live generation must be factory ${LIVE_FACTORY_GENERATION} / campaign ${LIVE_CAMPAIGN_GENERATION}`);
  }
  if (Number(raw.liquidityKind) !== LIVE_LIQUIDITY_KIND) {
    throw new Error("BNB census liquidityKind must be 1 (Topaz V2 ERC20)");
  }
  if (raw.liquidityKindName !== "topaz-v2-erc20") throw new Error("BNB census liquidityKindName must be topaz-v2-erc20");
  if (raw.treasuryGeneration !== LIVE_TREASURY_GENERATION) throw new Error("BNB census treasuryGeneration must be v2");
  if (Number(raw.requiredPoolFeeBps) !== REQUIRED_POOL_FEE_BPS) throw new Error("BNB census requiredPoolFeeBps must be 30");
  if (Number(raw.lockerCreatorFeeBps) !== 8000 || Number(raw.lockerProtocolFeeBps) !== 2000) {
    throw new Error("BNB census locker harvest split must be 8000/2000");
  }
  if (raw.uniswapV3Rejected !== true) throw new Error("BNB census must reject Uniswap V3");
  if (raw.creationEnabled !== true) throw new Error("BNB census creationEnabled must be true for the current creation factory");
  if (typeof raw.createPaused !== "boolean") throw new Error("BNB census createPaused must be explicit");
  if (raw.supportEnabled !== true) throw new Error("BNB census supportEnabled must be true");
  if (!isAddress(raw.creationFactory)) throw new Error("BNB census creationFactory must be a valid address");
  if (!sameAddress(raw.contracts?.launchFactory, raw.creationFactory)) {
    throw new Error("BNB census contracts.launchFactory must match creationFactory");
  }
  if (!isAddress(raw.contracts?.permanentLpLocker) || !isAddress(raw.contracts?.treasuryRouterV2)) {
    throw new Error("BNB census locker and treasuryRouterV2 must be valid addresses");
  }
  if (raw.contracts?.permanentV3PositionLocker || raw.contracts?.treasuryRouterV3) {
    throw new Error("BNB current census must not claim V3 NFT locker or TreasuryRouterV3 as live");
  }
  const sourceHead = raw.sourceHead;
  if (!sourceHead || typeof sourceHead !== "object") throw new Error("BNB census sourceHead is required");
  if (Number(sourceHead.factoryGeneration) !== SOURCE_FACTORY_GENERATION || Number(sourceHead.campaignGeneration) !== SOURCE_CAMPAIGN_GENERATION) {
    throw new Error("BNB census sourceHead must pin factory 4 / campaign 3");
  }
  if (sourceHead.isCurrentLiveBnb !== false) {
    throw new Error("BNB census sourceHead.isCurrentLiveBnb must be false");
  }
  if (!String(sourceHead.reason || "").includes(SOURCE_HEAD_NOT_LIVE_BNB)) {
    throw new Error("BNB census sourceHead.reason must state that source 4/3 is not live BNB 3/2");
  }
  if (
    Number(sourceHead.factoryGeneration) === Number(raw.factoryGeneration) &&
    Number(sourceHead.campaignGeneration) === Number(raw.campaignGeneration)
  ) {
    throw new Error("BNB census must not treat source-head 4/3 as the current live generation");
  }
  return raw;
}

export function loadBnbCurrentCensus(chainId) {
  const file = censusPath(chainId);
  if (!fs.existsSync(file)) throw new Error(`BNB census missing: ${file}`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`BNB census exists but is not valid JSON: ${error.message}`);
  }
  return parseBnbCurrentCensus(parsed, chainId);
}

export function readSourceHeadGenerations() {
  const source = readRepoFile("contracts/LaunchFactory.sol");
  return {
    factoryGeneration: parseSourceGeneration(source, "FACTORY_GENERATION", SOURCE_FACTORY_GENERATION),
    campaignGeneration: parseSourceGeneration(source, "CAMPAIGN_GENERATION", SOURCE_CAMPAIGN_GENERATION),
    liquidityKindV2: /uint8 public constant LIQUIDITY_KIND_V2_ERC20 = 1;/.test(source),
    liquidityKindV3: /uint8 public constant LIQUIDITY_KIND_V3_NFT = 2;/.test(source),
  };
}

export function assertSourceHeadIsNotLiveBnb(census = loadBnbCurrentCensus(BNB_MAINNET_CHAIN_ID)) {
  const source = readSourceHeadGenerations();
  const liveFactory = Number(census.factoryGeneration);
  const liveCampaign = Number(census.campaignGeneration);
  if (source.factoryGeneration === liveFactory && source.campaignGeneration === liveCampaign) {
    throw new Error("source-head generation must not equal accepted live BNB generation");
  }
  if (source.factoryGeneration !== SOURCE_FACTORY_GENERATION || source.campaignGeneration !== SOURCE_CAMPAIGN_GENERATION) {
    throw new Error(`source-head must be ${SOURCE_FACTORY_GENERATION}/${SOURCE_CAMPAIGN_GENERATION}`);
  }
  if (liveFactory !== LIVE_FACTORY_GENERATION || liveCampaign !== LIVE_CAMPAIGN_GENERATION) {
    throw new Error(`accepted live BNB generation must be ${LIVE_FACTORY_GENERATION}/${LIVE_CAMPAIGN_GENERATION}`);
  }
  if (source.factoryGeneration === LIVE_FACTORY_GENERATION && source.campaignGeneration === LIVE_CAMPAIGN_GENERATION) {
    throw new Error("source-head must not be rewritten to look like live BNB 3/2");
  }
  return {
    assertion: SOURCE_HEAD_NOT_LIVE_BNB,
    sourceFactoryGeneration: source.factoryGeneration,
    sourceCampaignGeneration: source.campaignGeneration,
    liveFactoryGeneration: liveFactory,
    liveCampaignGeneration: liveCampaign,
    sourceIsNotLiveBnb: true,
  };
}

export function proveBnbCensusMatchesArtifacts() {
  const mainnet = loadBnbCurrentCensus(BNB_MAINNET_CHAIN_ID);
  const testnet = loadBnbCurrentCensus(BNB_TESTNET_CHAIN_ID);
  const mainnetArtifact = JSON.parse(readRepoFile("deployments/bscMainnet.factory-30bps-80-20.json"));
  const testnetArtifact = JSON.parse(readRepoFile("deployments/bscTestnet.clean-slate-factory.json"));

  for (const relativePath of [...(mainnet.sourceArtifacts || []), ...(testnet.sourceArtifacts || [])]) {
    if (!fs.existsSync(path.join(repoRoot(), relativePath))) {
      throw new Error(`BNB census source artifact is missing from git: ${relativePath}`);
    }
  }

  if (!sameAddress(mainnet.creationFactory, mainnetArtifact.activeFactory) || !sameAddress(mainnet.creationFactory, MAINNET_CREATION_FACTORY)) {
    throw new Error("BNB mainnet census creation factory drifted from factory-30bps-80-20 artifact");
  }
  if (!sameAddress(mainnet.contracts.permanentLpLocker, mainnetArtifact.activeLocker) || !sameAddress(mainnet.contracts.permanentLpLocker, MAINNET_LOCKER)) {
    throw new Error("BNB mainnet census locker drifted from factory-30bps-80-20 artifact");
  }
  if (!sameAddress(mainnet.contracts.treasuryRouterV2, mainnetArtifact.constructor?.treasury) || !sameAddress(mainnet.contracts.treasuryRouterV2, MAINNET_TREASURY_V2)) {
    throw new Error("BNB mainnet census treasury V2 drifted from committed factory-30bps constructor.treasury");
  }
  if (Number(mainnetArtifact.lockerEconomics?.REQUIRED_POOL_FEE_BPS) !== REQUIRED_POOL_FEE_BPS) {
    throw new Error("BNB mainnet locker economics must remain 30 bps");
  }
  const support = mainnet.supportFactories?.[0];
  if (!support || support.creationEnabled !== false || support.supportEnabled !== true) {
    throw new Error("BNB mainnet support factory must stay support-only");
  }
  if (!sameAddress(support.address, MAINNET_SUPPORT_FACTORY)) {
    throw new Error("BNB mainnet support factory address drifted");
  }

  if (!sameAddress(testnet.creationFactory, testnetArtifact.newFactory.address) || !sameAddress(testnet.creationFactory, TESTNET_CREATION_FACTORY)) {
    throw new Error("BNB testnet census creation factory drifted from clean-slate artifact");
  }
  if (Number(testnetArtifact.factoryGeneration) !== LIVE_FACTORY_GENERATION || Number(testnetArtifact.campaignGeneration) !== LIVE_CAMPAIGN_GENERATION) {
    throw new Error("BNB testnet clean-slate artifact must remain factory 3 / campaign 2");
  }
  if (
    !sameAddress(testnet.contracts.treasuryRouterV2, testnetArtifact.reused?.treasuryRouter) ||
    !sameAddress(testnet.contracts.treasuryRouterV2, testnetArtifact.contracts?.TreasuryRouter) ||
    !sameAddress(testnet.contracts.treasuryRouterV2, TESTNET_TREASURY_V2)
  ) {
    throw new Error("BNB testnet census treasury V2 drifted from committed clean-slate treasuryRouter");
  }
  if (testnet.createPaused !== false || testnet.creationEnabled !== true) {
    throw new Error("BNB testnet current creation factory must stay live and creation-enabled");
  }
  if (!sameAddress(testnet.contracts.permanentLpLocker, testnetArtifact.newFactory.locker) || !sameAddress(testnet.contracts.permanentLpLocker, TESTNET_LOCKER)) {
    throw new Error("BNB testnet census locker drifted from clean-slate artifact");
  }

  return { mainnet, testnet };
}

export function proveBnbSignerStaysOnCampaignGeneration2() {
  const signer = readRepoFile("frontend/api/dev-fix/routeAuthorizationSigner.js");
  requireIncludes(
    signer,
    "if (id === ROBINHOOD_TESTNET_CHAIN_ID || id === LOCAL_HARDHAT_CHAIN_ID) return 3;",
    "routeAuthorizationSigner",
  );
  requireIncludes(signer, "return 2;", "routeAuthorizationSigner");
  requireIncludes(signer, 'return "3-or-4/2";', "routeAuthorizationSigner");
  requireIncludes(signer, 'if (id === ROBINHOOD_TESTNET_CHAIN_ID || id === LOCAL_HARDHAT_CHAIN_ID) return "4/3";', "routeAuthorizationSigner");
  if (/expectedCampaignGeneration[\s\S]{0,400}56[\s\S]{0,80}return 3/.test(signer)) {
    throw new Error("BNB signer must not return campaign generation 3 for chain 56");
  }
  const client = readRepoFile("frontend/src/lib/scheduledLaunchClientV2.ts");
  requireIncludes(client, 'return "3-or-4/2";', "scheduledLaunchClientV2");
  requireIncludes(client, "return 2;", "scheduledLaunchClientV2");
  return {
    bnbCampaignGeneration: LIVE_CAMPAIGN_GENERATION,
    robinhoodCampaignGeneration: SOURCE_CAMPAIGN_GENERATION,
    rejectedBnbCampaignGeneration3: true,
  };
}

export function proveBnbBroadcastScriptsRefuseSourceHead() {
  const guard = readRepoFile("scripts/lib/bnbLiveGenerationGuard.ts");
  requireIncludes(guard, SOURCE_HEAD_NOT_LIVE_BNB, "bnbLiveGenerationGuard");
  requireIncludes(guard, "FACTORY_GENERATION = 3;", "bnbLiveGenerationGuard");
  requireIncludes(guard, "CAMPAIGN_GENERATION = 2;", "bnbLiveGenerationGuard");
  for (const file of BNB_FACTORY_BROADCAST_SCRIPTS) {
    const source = readRepoFile(file);
    requireIncludes(source, "refuseBnbFactoryBroadcastIfSourceHeadIsNotLive", file);
  }
  const locker = readRepoFile("contracts/PermanentLpLocker.sol");
  requireIncludes(locker, "uint16 public constant REQUIRED_POOL_FEE_BPS = 30;", "PermanentLpLocker");
  if (/\bfunction withdraw\(/.test(locker) || /\bfunction unlock\(/.test(locker) || /\bfunction migrate\(/.test(locker)) {
    throw new Error("PermanentLpLocker must not grow a principal withdraw/unlock/migrate path");
  }
  return { guarded: BNB_FACTORY_BROADCAST_SCRIPTS };
}

export function proveRobinhoodFreezeUntouched() {
  const freeze = JSON.parse(readRepoFile("deployments/robinhood/testnet.accepted.json"));
  if (Number(freeze.chainId) !== ROBINHOOD_TESTNET_CHAIN_ID) throw new Error("Robinhood freeze chainId drifted");
  if (Number(freeze.factoryGeneration) !== SOURCE_FACTORY_GENERATION || Number(freeze.campaignGeneration) !== SOURCE_CAMPAIGN_GENERATION) {
    throw new Error("Robinhood freeze must remain factory 4 / campaign 3");
  }
  if (!sameAddress(freeze.factory, ROBINHOOD_TESTNET_FACTORY)) {
    throw new Error("Robinhood freeze factory drifted");
  }
  if (Number(freeze.liquidityKind) !== 2) throw new Error("Robinhood freeze liquidityKind must remain 2");
  if (freeze.expectedCreatePaused !== true) throw new Error("Robinhood freeze createPaused drifted");
  return { factory: freeze.factory, factoryGeneration: freeze.factoryGeneration, campaignGeneration: freeze.campaignGeneration };
}

export function proveBnbCurrentGeneration() {
  const artifacts = proveBnbCensusMatchesArtifacts();
  const sourceHead = assertSourceHeadIsNotLiveBnb(artifacts.mainnet);
  const testnetHead = assertSourceHeadIsNotLiveBnb(artifacts.testnet);
  const signer = proveBnbSignerStaysOnCampaignGeneration2();
  const broadcast = proveBnbBroadcastScriptsRefuseSourceHead();
  const robinhood = proveRobinhoodFreezeUntouched();
  return {
    mainnet: {
      chainId: artifacts.mainnet.chainId,
      creationFactory: artifacts.mainnet.creationFactory,
      factoryGeneration: artifacts.mainnet.factoryGeneration,
      campaignGeneration: artifacts.mainnet.campaignGeneration,
      liquidityKind: artifacts.mainnet.liquidityKind,
      treasuryGeneration: artifacts.mainnet.treasuryGeneration,
    },
    testnet: {
      chainId: artifacts.testnet.chainId,
      creationFactory: artifacts.testnet.creationFactory,
      factoryGeneration: artifacts.testnet.factoryGeneration,
      campaignGeneration: artifacts.testnet.campaignGeneration,
      liquidityKind: artifacts.testnet.liquidityKind,
      treasuryGeneration: artifacts.testnet.treasuryGeneration,
    },
    sourceHead,
    testnetHead,
    signer,
    broadcast,
    robinhood,
  };
}

function runningAsCli() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (runningAsCli()) {
  proveBnbCurrentGeneration();
  console.log("BNB current-generation census source proof passed");
}
