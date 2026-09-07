#!/usr/bin/env node
import fs from "node:fs";
import { APPROVED_QUOTE_CATALOG } from "../frontend/api/lib/approvedQuoteCatalog.js";
import {
  certifyRobinhoodStockRuntime,
  normalizeRuntimeAddress,
  ROBINHOOD_MAINNET_CHAIN_ID,
  ROBINHOOD_STOCK_PROVIDER,
} from "../frontend/api/lib/robinhoodStockRuntimeCertification.js";
import { createRobinhoodRuntimeProvider } from "../frontend/api/lib/robinhoodStockRuntimeProvider.js";

const DEFAULT_MANIFEST = "deployments/robinhood/mainnet.json";
const CANONICAL_URL = "https://api.robinhood.com/rhj/assets";

function normalizeAddress(value) {
  return normalizeRuntimeAddress(value);
}

function deriveTradingHalted(asset) {
  const capabilities = asset?.tradingCapabilities;
  if (!capabilities || typeof capabilities !== "object") return null;
  const statuses = [];
  for (const session of Object.values(capabilities)) {
    if (!session || typeof session !== "object") continue;
    for (const value of Object.values(session)) {
      if (typeof value === "string") statuses.push(value.toUpperCase());
    }
  }
  if (!statuses.length) return null;
  if (statuses.some((status) => status.includes("HALT"))) return true;
  return !statuses.some((status) => status === "TRADING_STATUS_TRADABLE");
}

function canonicalRows(payload) {
  const assets = Array.isArray(payload) ? payload : Array.isArray(payload?.assets) ? payload.assets : [];
  const rows = [];
  for (const asset of assets) {
    for (const deployment of Array.isArray(asset?.deployments) ? asset.deployments : []) {
      if (Number(deployment?.chainId) !== ROBINHOOD_MAINNET_CHAIN_ID) continue;
      const address = normalizeAddress(deployment?.contractAddress);
      if (!address) continue;
      rows.push({
        providerAssetUid: String(asset?.id || asset?.uid || "").trim() || null,
        symbol: String(asset?.tokenSymbol || asset?.symbol || "").trim().toUpperCase(),
        address,
        decimals: Number(asset?.tokenDecimals ?? asset?.decimals ?? 18),
        status: String(asset?.status || "UNKNOWN"),
        tradingHalted: deriveTradingHalted(asset),
      });
    }
  }
  return rows;
}

function exactKey(address) {
  return normalizeAddress(address).toLowerCase();
}

async function loadCanonicalPayload() {
  const fixture = String(process.env.ROBINHOOD_CANONICAL_ASSETS_FIXTURE || "").trim();
  if (fixture) return JSON.parse(fs.readFileSync(fixture, "utf8"));
  const response = await fetch(CANONICAL_URL, { headers: { accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(`Robinhood canonical asset request failed (${response.status})`);
  return response.json();
}

function candidateInventory() {
  return APPROVED_QUOTE_CATALOG.assets
    .filter((asset) => String(asset.chainId) === String(ROBINHOOD_MAINNET_CHAIN_ID) && asset.provider === ROBINHOOD_STOCK_PROVIDER)
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function emptyRecord(asset) {
  return {
    symbol: asset.symbol,
    exactTokenAddress: asset.address,
    provider: ROBINHOOD_STOCK_PROVIDER,
    identityStatus: "PENDING",
    acquisitionPool: null,
    routeStatus: "PENDING",
    liquidityResult: "PENDING",
    oracleFeed: null,
    oracleFreshness: "PENDING",
    referencePriceResult: "PENDING",
    priceImpactResult: "PENDING",
    oracleDeviationResult: "PENDING",
    slippageResult: "PENDING",
    finalMemeQuoteCompatibility: "PENDING",
    lockerCompatibility: "PENDING",
    technicalEligibility: false,
    providerRestrictionStatus: "PROVIDER_JURISDICTION_POLICY_REQUIRED",
    finalDisposition: "PENDING",
    reason: null,
  };
}

export async function certifyRobinhoodApprovedQuotes({
  productionManifest,
  canonicalPayload,
  rpcUrl,
  now = Date.now(),
  probeNativeWei,
} = {}) {
  const manifest = productionManifest || JSON.parse(fs.readFileSync(DEFAULT_MANIFEST, "utf8"));
  const candidates = candidateInventory();
  if (candidates.length !== 33) throw new Error(`Expected exactly 33 merged Robinhood stock-token candidates, found ${candidates.length}`);

  const report = {
    chainId: ROBINHOOD_MAINNET_CHAIN_ID,
    provider: ROBINHOOD_STOCK_PROVIDER,
    generatedAt: new Date(now).toISOString(),
    productionSupportEnabled: manifest?.supportEnabled === true,
    productionCreationEnabled: manifest?.creationEnabled === true,
    candidatesAudited: candidates.length,
    records: candidates.map(emptyRecord),
  };

  const launchFactory = normalizeAddress(manifest?.contracts?.launchFactory);
  if (!report.productionSupportEnabled || !report.productionCreationEnabled || !launchFactory) {
    const blocker = "Robinhood mainnet deployment manifest is dark/incomplete: supportEnabled and creationEnabled must be true and contracts.launchFactory must be deployed before runtime certification";
    for (const record of report.records) {
      record.identityStatus = "PASS_MANIFEST_EXACT_IDENTITY";
      record.reason = blocker;
    }
    return summarize(report);
  }

  if (!rpcUrl) throw new Error("ROBINHOOD_MAINNET_RPC_URL is required once the production manifest is enabled");
  const provider = createRobinhoodRuntimeProvider(rpcUrl, ROBINHOOD_MAINNET_CHAIN_ID);
  try {
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== ROBINHOOD_MAINNET_CHAIN_ID) throw new Error(`RPC chain mismatch: ${network.chainId}`);
    const payload = canonicalPayload || await loadCanonicalPayload();
    const canonical = new Map(canonicalRows(payload).map((row) => [exactKey(row.address), row]));

    for (let index = 0; index < candidates.length; index += 1) {
      const asset = candidates[index];
      const record = report.records[index];
      const providerRow = canonical.get(exactKey(asset.address));
      if (!providerRow) {
        record.finalDisposition = "REJECTED";
        record.reason = "exact contract is missing from current Robinhood chain-4663 provider authority";
        continue;
      }
      if (providerRow.symbol !== String(asset.symbol).toUpperCase()) {
        record.finalDisposition = "REJECTED";
        record.reason = `provider symbol mismatch for exact contract: expected ${asset.symbol}, got ${providerRow.symbol}`;
        continue;
      }
      if (Number(providerRow.decimals) !== Number(asset.decimals)) {
        record.finalDisposition = "REJECTED";
        record.reason = `provider decimals mismatch for exact contract: expected ${asset.decimals}, got ${providerRow.decimals}`;
        continue;
      }
      record.identityStatus = "PASS";
      if (String(providerRow.status).toUpperCase() !== "ASSET_STATUS_ACTIVE") {
        record.reason = `provider asset is not active (${providerRow.status})`;
        continue;
      }
      if (providerRow.tradingHalted === true) {
        record.reason = "provider trading capability is currently halted/untradable";
        continue;
      }

      try {
        const evidence = await certifyRobinhoodStockRuntime({
          row: {
            chain_id: ROBINHOOD_MAINNET_CHAIN_ID,
            contract_address: asset.address,
            symbol: asset.symbol,
          },
          provider,
          factoryAddress: launchFactory,
          now,
          probeNativeWei,
        });
        record.acquisitionPool = evidence.acquisitionPool;
        record.routeStatus = "PASS";
        record.liquidityResult = `PASS:${evidence.poolStockUsdWad}`;
        record.oracleFeed = evidence.oracleFeed;
        record.oracleFreshness = `PASS:${evidence.oracleAgeSeconds}s`;
        record.referencePriceResult = evidence.referencePriceResult;
        record.priceImpactResult = `PASS:${evidence.priceImpactBps}bps`;
        record.oracleDeviationResult = `PASS:${evidence.oracleDeviationBps}bps`;
        record.slippageResult = `PASS:max=${evidence.maxSwapSlippageBps}bps,minOut=${evidence.minimumOutAtPolicy}`;
        record.finalMemeQuoteCompatibility = evidence.finalMemeQuoteCompatibility ? "PASS" : "PENDING";
        record.lockerCompatibility = evidence.lockerCompatibility ? "PASS" : "PENDING";
        record.technicalEligibility = evidence.technicalEligibility === true;
        record.providerRestrictionStatus = evidence.providerRestrictionStatus;
        record.finalDisposition = record.technicalEligibility ? "ACTIVE_SAFE" : "PENDING";
        record.reason = record.technicalEligibility ? "all technical runtime certification gates passed" : "runtime certification incomplete";
      } catch (error) {
        record.reason = String(error?.shortMessage || error?.message || error);
      }
    }
    return summarize(report);
  } finally {
    provider.destroy();
  }
}

function summarize(report) {
  const counts = {
    identityPass: 0,
    acquisitionPass: 0,
    pricePass: 0,
    finalLpPass: 0,
    activeSafe: 0,
    pending: 0,
    rejected: 0,
  };
  for (const record of report.records) {
    if (record.identityStatus.startsWith("PASS")) counts.identityPass += 1;
    if (record.routeStatus === "PASS" && record.liquidityResult.startsWith("PASS")) counts.acquisitionPass += 1;
    if (
      record.oracleFreshness.startsWith("PASS") &&
      record.referencePriceResult === "PASS" &&
      record.priceImpactResult.startsWith("PASS") &&
      record.oracleDeviationResult.startsWith("PASS") &&
      record.slippageResult.startsWith("PASS")
    ) counts.pricePass += 1;
    if (record.finalMemeQuoteCompatibility === "PASS" && record.lockerCompatibility === "PASS") counts.finalLpPass += 1;
    if (record.finalDisposition === "ACTIVE_SAFE") counts.activeSafe += 1;
    else if (record.finalDisposition === "REJECTED") counts.rejected += 1;
    else counts.pending += 1;
  }
  return { ...report, counts };
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const manifestPath = process.argv[2] || process.env.ROBINHOOD_PRODUCTION_MANIFEST || DEFAULT_MANIFEST;
  const productionManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const canonicalFixture = String(process.env.ROBINHOOD_CANONICAL_ASSETS_FIXTURE || "").trim();
  const canonicalPayload = canonicalFixture ? JSON.parse(fs.readFileSync(canonicalFixture, "utf8")) : undefined;
  const rpcUrl = process.env.ROBINHOOD_MAINNET_RPC_URL || process.env.ROBINHOOD_RPC_HTTP_4663;
  const probeRaw = String(process.env.ROBINHOOD_STOCK_CERT_PROBE_NATIVE_WEI || "").trim();
  const probeNativeWei = /^\d+$/.test(probeRaw) && BigInt(probeRaw) > 0n ? BigInt(probeRaw) : undefined;
  const result = await certifyRobinhoodApprovedQuotes({ productionManifest, canonicalPayload, rpcUrl, probeNativeWei });
  console.log(JSON.stringify(result, null, 2));
  if (result.counts.rejected > 0) process.exitCode = 2;
  if (result.productionCreationEnabled && result.counts.activeSafe !== result.candidatesAudited) process.exitCode = 3;
}
