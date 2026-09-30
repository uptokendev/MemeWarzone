#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");
const { buildIndexerManifest, eventFragmentFor } = require("./lib/indexerManifest.cjs");

const DEFAULT_CONFIRMATIONS = 6;
const DEFAULT_BATCH_BLOCKS = 2_000;

const ARTIFACT_CANDIDATES = {
  LaunchFactory: ["contracts/LaunchFactory.sol/LaunchFactory.json"],
  LaunchCampaign: ["contracts/LaunchCampaign.sol/LaunchCampaign.json"],
  LaunchCampaignImplementation: ["contracts/LaunchCampaign.sol/LaunchCampaign.json"],
  TreasuryRouter: ["contracts/TreasuryRouter.sol/TreasuryRouter.json"],
  TreasuryVaultV2: ["contracts/TreasuryVaultV2.sol/TreasuryVaultV2.json", "contracts/treasury/TreasuryVaultV2.sol/TreasuryVaultV2.json"],
  MonthlyLeagueTreasury: ["contracts/MonthlyLeagueTreasury.sol/MonthlyLeagueTreasury.json"],
  CharityTreasury: ["contracts/CharityTreasury.sol/CharityTreasury.json"],
  RecruiterRewardsVault: ["contracts/RecruiterRewardsVault.sol/RecruiterRewardsVault.json"],
  CommunityRewardsVault: ["contracts/CommunityRewardsVault.sol/CommunityRewardsVault.json"],
  ProtocolRevenueVault: ["contracts/ProtocolRevenueVault.sol/ProtocolRevenueVault.json"],
  CreatorRegistry: ["contracts/CreatorRegistry.sol/CreatorRegistry.json"],
  RiskRegistry: ["contracts/RiskRegistry.sol/RiskRegistry.json"],
  GraduationOracle: ["contracts/GraduationOracle.sol/GraduationOracle.json"],
  PermanentLpLocker: ["contracts/PermanentLpLocker.sol/PermanentLpLocker.json"],
  PermanentV3PositionLocker: ["contracts/PermanentV3PositionLocker.sol/PermanentV3PositionLocker.json"],
  TreasuryRouterV4: ["contracts/TreasuryRouterV4.sol/TreasuryRouterV4.json"],
  CreatorRewardsVaultV2: ["contracts/CreatorRewardsVaultV2.sol/CreatorRewardsVaultV2.json"],
  UPVoteTreasury: ["contracts/UPVoteTreasury.sol/UPVoteTreasury.json"],
};

function requireEnv(name, fallback = "") {
  const value = (process.env[name] || fallback).trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function optionalInt(name, fallback) {
  const raw = (process.env[name] || "").trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name}: expected non-negative integer`);
  return value;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function defaultDeploymentFile(target) {
  return path.join(__dirname, "..", "deployments", `${target}.json`);
}

function defaultOutputDir(target) {
  return path.join(process.cwd(), "output", "indexer", target);
}

function loadManifest(targetOverride = process.argv[2]) {
  if (process.env.INDEXER_MANIFEST_FILE) return readJson(path.resolve(process.env.INDEXER_MANIFEST_FILE));
  const target = targetOverride || process.env.HARDHAT_NETWORK || process.env.INDEXER_NETWORK || "hardhat";
  const deploymentFile = process.env.DEPLOYMENT_FILE ? path.resolve(process.env.DEPLOYMENT_FILE) : defaultDeploymentFile(target);
  return buildIndexerManifest(readJson(deploymentFile), deploymentFile);
}

function defaultConfirmations(manifest) {
  if (manifest.chainId === 31337 || manifest.network === "localhost" || manifest.network === "hardhat") return 0;
  return DEFAULT_CONFIRMATIONS;
}

function artifactPath(contractName) {
  const candidates = ARTIFACT_CANDIDATES[contractName] || [];
  for (const candidate of candidates) {
    const file = path.join(process.cwd(), "artifacts", candidate);
    if (fs.existsSync(file)) return file;
  }
  return "";
}

function loadArtifactInterface(contractName) {
  const file = artifactPath(contractName);
  if (!file) return null;
  return new ethers.Interface(readJson(file).abi);
}

function artifactCoversSignatures(iface, signatures) {
  if (!iface) return false;
  return signatures.every((signature) => {
    try {
      return Boolean(iface.getEvent(signature));
    } catch {
      return false;
    }
  });
}

function signatureFromEvent(eventFragment) {
  return eventFragment.format("sighash");
}

/**
 * The full fragment (with `indexed` flags) for one signature: the manifest's own `eventFragments`, then the
 * built-in table (a manifest written before fragments existed), then the compiled artifact. Never a
 * fragment built from the bare signature: that one marks nothing indexed, so ethers reads indexed topics as
 * data and every CampaignCreated / TokensPurchased log throws. An unknown signature fails loudly here.
 */
function resolveEventFragment(manifest, contractName, signature, artifactIface) {
  const fromManifest = manifest.eventFragments?.[contractName]?.[signature];
  if (fromManifest) return fromManifest;
  const builtIn = eventFragmentFor(contractName, signature);
  if (builtIn) return builtIn;
  if (artifactIface) {
    try {
      const event = artifactIface.getEvent(signature);
      if (event && signatureFromEvent(event) === signature) return event.format("full");
    } catch {
      // not in the artifact
    }
  }
  throw new Error(`indexer: no fragment with indexed flags for ${contractName}.${signature}; add it to EVENT_FRAGMENTS`);
}

function buildInterfaces(manifest) {
  const byContractTopic = new Map();
  for (const [contractName, events] of Object.entries(manifest.events || {})) {
    const signatures = Object.keys(events);
    if (signatures.length === 0) continue;
    const artifactIface = loadArtifactInterface(contractName);
    for (const [signature, topic] of Object.entries(events)) {
      const fragment = resolveEventFragment(manifest, contractName, signature, artifactIface);
      const iface = new ethers.Interface([fragment]);
      if (iface.getEvent(signature).topicHash.toLowerCase() !== String(topic).toLowerCase()) {
        throw new Error(`indexer: topic mismatch for ${contractName}.${signature}`);
      }
      byContractTopic.set(`${contractName}:${String(topic).toLowerCase()}`, { contractName, signature, iface });
    }
  }
  return byContractTopic;
}

function supportedFactories(manifest) {
  const registryFactories = manifest.factoryRegistry?.factories;
  if (Array.isArray(registryFactories) && registryFactories.length > 0) {
    return registryFactories.filter((factory) => factory.supportEnabled !== false);
  }
  const address = manifest.contracts?.LaunchFactory;
  return address ? [{ generation: "current", address, deploymentBlock: manifest.deploymentBlock ?? null, creationEnabled: true, tradingEnabled: true, supportEnabled: true }] : [];
}

function contractFilters(manifest) {
  const filters = [];
  for (const [contractName, address] of Object.entries(manifest.contracts || {})) {
    if (contractName === "LaunchFactory") continue;
    const topics = Object.values(manifest.events?.[contractName] || {});
    if (address && topics.length > 0) filters.push({ contractName, address, topics, scope: `${contractName}:${address}` });
  }

  const factoryTopics = Object.values(manifest.events?.LaunchFactory || {});
  if (factoryTopics.length > 0) {
    for (const factory of supportedFactories(manifest)) {
      filters.push({
        contractName: "LaunchFactory",
        address: factory.address,
        topics: factoryTopics,
        factoryGeneration: factory.generation,
        factoryAddress: factory.address,
        deploymentBlock: factory.deploymentBlock ?? manifest.deploymentBlock ?? null,
        creationEnabled: Boolean(factory.creationEnabled),
        tradingEnabled: factory.tradingEnabled !== false,
        scope: `LaunchFactory:${factory.generation}:${factory.address}`,
      });
    }
  }

  return filters;
}

function serializeArg(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(serializeArg);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializeArg(item)]));
  }
  return value;
}

function decodeLog(log, topicMap) {
  const meta = topicMap.get(`${log.contractName}:${String(log.topics[0]).toLowerCase()}`);
  if (!meta) return null;
  const parsed = meta.iface.parseLog({ topics: log.topics, data: log.data });
  return {
    chainId: log.chainId,
    contractName: meta.contractName,
    contractAddress: log.address,
    factoryAddress: log.factoryAddress || (meta.contractName === "LaunchFactory" ? log.address : undefined),
    factoryGeneration: log.factoryGeneration,
    eventSignature: meta.signature,
    eventName: parsed.name,
    blockNumber: Number(log.blockNumber),
    blockHash: log.blockHash,
    txHash: log.transactionHash,
    txIndex: Number(log.transactionIndex),
    logIndex: Number(log.index ?? log.logIndex),
    removed: Boolean(log.removed),
    args: serializeArg(parsed.args),
  };
}

function eventKey(event) {
  return `${event.chainId}:${event.txHash}:${event.logIndex}`.toLowerCase();
}

function appendJsonl(file, rows) {
  if (rows.length === 0) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

function newScope(manifest, startOverride) {
  const start = startOverride ?? manifest.deploymentBlock ?? 0;
  return { lastFinalizedBlock: Math.max(0, Number(start) - 1), seen: {} };
}

function loadCursor(file, manifest) {
  if (!fs.existsSync(file)) {
    return { schemaVersion: 2, chainId: manifest.chainId, scopes: {} };
  }
  const cursor = readJson(file);
  if (cursor.scopes) return cursor;
  return {
    schemaVersion: 2,
    chainId: cursor.chainId || manifest.chainId,
    migratedFromSchemaVersion: cursor.schemaVersion || 1,
    scopes: {
      default: {
        lastFinalizedBlock: Number(cursor.lastFinalizedBlock || 0),
        seen: cursor.seen || {},
      },
    },
  };
}

function getCursorScope(cursor, manifest, filter) {
  const key = String(filter.scope || `${filter.contractName}:${filter.address}`).toLowerCase();
  if (!cursor.scopes[key]) cursor.scopes[key] = newScope(manifest, filter.deploymentBlock);
  return { key, scope: cursor.scopes[key] };
}

async function getLatestBlock(provider, rpcUrl) {
  try {
    return await provider.getBlockNumber();
  } catch (error) {
    const detail = error && error.message ? String(error.message).split("\n")[0] : String(error);
    throw new Error(
      `[indexer] RPC unavailable at ${rpcUrl}. Start a local node or set INDEXER_RPC_URL/RPC_URL/BSC_TESTNET_RPC. ${detail}`
    );
  }
}

async function indexOnce(options = {}) {
  const manifest = options.manifest || loadManifest(options.target);
  const rpcUrl = options.rpcUrl || requireEnv("INDEXER_RPC_URL", process.env.RPC_URL || process.env.BSC_TESTNET_RPC || "http://127.0.0.1:8545");
  // ethers v6: staticNetwork:true with network=undefined does NOT pin #network and
  // spam-logs "failed to detect network... retry in 1s". Always pass chainId/Network.
  const chainId = Number(manifest.chainId || 97);
  const network = ethers.Network.from(chainId);
  const provider = new ethers.JsonRpcProvider(rpcUrl, network, {
    staticNetwork: network,
    batchMaxCount: 1,
    batchStallTime: 0,
  });
  const confirmations = options.confirmations ?? optionalInt("INDEXER_CONFIRMATIONS", defaultConfirmations(manifest));
  const batchBlocks = options.batchBlocks ?? optionalInt("INDEXER_BATCH_BLOCKS", DEFAULT_BATCH_BLOCKS);
  const outDir = options.outDir || process.env.INDEXER_OUT_DIR || defaultOutputDir(manifest.network || String(manifest.chainId));
  const cursorFile = path.join(outDir, "cursor.json");
  const eventsFile = path.join(outDir, "events.jsonl");
  const topicMap = buildInterfaces(manifest);
  const filters = contractFilters(manifest);
  const cursor = loadCursor(cursorFile, manifest);
  const latest = await getLatestBlock(provider, rpcUrl);
  const finalizedTo = Math.max(0, latest - confirmations);
  let indexed = 0;

  if (latest === 0 && (manifest.chainId === 31337 || manifest.network === "localhost" || manifest.network === "hardhat")) {
    console.warn("[indexer] local node has no blocks yet. Run npm run deploy:verify:localhost against this same node, then rerun the indexer.");
  }

  for (const filter of filters) {
    const { key: scopeKey, scope } = getCursorScope(cursor, manifest, filter);
    let fromBlock = Number(scope.lastFinalizedBlock || 0) + 1;

    if (fromBlock > finalizedTo) {
      console.log(`[indexer] up to date scope=${scopeKey} latest=${latest} finalized=${finalizedTo}`);
      continue;
    }

    while (fromBlock <= finalizedTo) {
      const toBlock = Math.min(finalizedTo, fromBlock + batchBlocks - 1);
      const decoded = [];
      const logs = await provider.getLogs({ address: filter.address, fromBlock, toBlock, topics: [filter.topics] });

      for (const log of logs) {
        const event = decodeLog(
          {
            ...log,
            chainId: manifest.chainId,
            contractName: filter.contractName,
            factoryAddress: filter.factoryAddress,
            factoryGeneration: filter.factoryGeneration,
          },
          topicMap
        );
        if (!event) continue;
        const key = eventKey(event);
        if (scope.seen[key]) continue;
        scope.seen[key] = event.blockHash;
        decoded.push(event);
      }

      decoded.sort((a, b) => a.blockNumber - b.blockNumber || a.txIndex - b.txIndex || a.logIndex - b.logIndex);
      appendJsonl(eventsFile, decoded);
      indexed += decoded.length;
      scope.lastFinalizedBlock = toBlock;
      scope.updatedAt = Math.floor(Date.now() / 1000);
      cursor.updatedAt = scope.updatedAt;
      writeJsonAtomic(cursorFile, cursor);
      console.log(`[indexer] scanned scope=${scopeKey} ${fromBlock}-${toBlock} events=${decoded.length}`);
      fromBlock = toBlock + 1;
    }
  }

  return { indexed, toBlock: finalizedTo, outDir, scopes: Object.keys(cursor.scopes).length };
}

async function main() {
  const result = await indexOnce({ target: process.argv[2] });
  console.log(`[indexer] complete indexed=${result.indexed} scopes=${result.scopes} out=${result.outDir}`);
}

module.exports = {
  artifactCoversSignatures,
  buildInterfaces,
  contractFilters,
  decodeLog,
  defaultConfirmations,
  getCursorScope,
  indexOnce,
  loadCursor,
  loadManifest,
  supportedFactories,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
