#!/usr/bin/env node
import fs from "node:fs";
import {
  discoverRobinhoodCanonicalStockCandidates,
  listRobinhoodManifestPairCandidates,
  ROBINHOOD_CANONICAL_ASSETS_URL,
  summarizeRobinhoodPairCandidates,
} from "../frontend/api/lib/robinhoodFullApprovedPairCatalog.js";
import { ROBINHOOD_VERIFIED_NON_STOCK_DISCOVERY } from "../frontend/api/lib/robinhoodVerifiedNonStockDiscovery.js";

const DEFAULT_MANIFEST = "deployments/robinhood/mainnet.json";

function mergeCandidates(baseCandidates) {
  const byContract = new Map(baseCandidates.map((item) => [String(item.contract).toLowerCase(), item]));
  for (const candidate of ROBINHOOD_VERIFIED_NON_STOCK_DISCOVERY) {
    if (!byContract.has(String(candidate.contract).toLowerCase())) byContract.set(String(candidate.contract).toLowerCase(), candidate);
  }
  return [...byContract.values()].sort((a, b) => a.category.localeCompare(b.category) || a.asset.localeCompare(b.asset));
}

export function buildRobinhoodApprovedPairReport({ productionManifest, canonicalPayload, discoveryError = null } = {}) {
  const manifest = productionManifest || JSON.parse(fs.readFileSync(DEFAULT_MANIFEST, "utf8"));
  const baseCandidates = canonicalPayload ? discoverRobinhoodCanonicalStockCandidates(canonicalPayload) : listRobinhoodManifestPairCandidates();
  const candidates = mergeCandidates(baseCandidates);
  const runtimeReady = manifest?.supportEnabled === true && manifest?.creationEnabled === true && Boolean(manifest?.contracts?.launchFactory);
  const blocker = runtimeReady
    ? "runtime certification required per candidate before ACTIVE"
    : "Robinhood production manifest is dark/incomplete: supportEnabled + creationEnabled + contracts.launchFactory are required";

  return {
    chainId: 4663,
    generatedAt: new Date().toISOString(),
    canonicalDiscoverySource: canonicalPayload ? ROBINHOOD_CANONICAL_ASSETS_URL : "STATIC_MANIFEST_FALLBACK",
    canonicalDiscoveryError: discoveryError,
    productionRuntimeReady: runtimeReady,
    summary: summarizeRobinhoodPairCandidates(candidates),
    candidates: candidates.map((candidate) => ({
      ...candidate,
      health: runtimeReady ? candidate.health : "PENDING_PRODUCTION_RUNTIME",
      disposition: "PENDING",
      reason: blocker,
    })),
  };
}

export function toMarkdownTable(report) {
  const header = "| Asset | Category | Contract | Provider | Decimals | Price authority | ETH acquisition route | Graduation route | V3 venue | Liquidity | Capacity | Health | ACTIVE/PENDING |";
  const separator = "|---|---|---|---|---:|---|---|---|---|---|---|---|---|";
  const rows = report.candidates.map((item) => `| ${item.asset} | ${item.category} | ${item.contract} | ${item.provider} | ${item.decimals} | ${item.priceAuthority} | ${item.ethAcquisitionRoute} | ${item.graduationRoute} | ${item.v3Venue} | ${item.liquidity} | ${item.capacity} | ${item.health} | ${item.disposition} |`);
  return [header, separator, ...rows].join("\n");
}

async function loadCanonicalPayload() {
  const fixture = String(process.env.ROBINHOOD_CANONICAL_ASSETS_FIXTURE || "").trim();
  if (fixture) return JSON.parse(fs.readFileSync(fixture, "utf8"));
  const response = await fetch(ROBINHOOD_CANONICAL_ASSETS_URL, { headers: { accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(`Robinhood canonical assets request failed (${response.status})`);
  return response.json();
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const manifestPath = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : process.env.ROBINHOOD_PRODUCTION_MANIFEST || DEFAULT_MANIFEST;
  const productionManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  let canonicalPayload;
  let discoveryError = null;
  try {
    canonicalPayload = await loadCanonicalPayload();
  } catch (error) {
    discoveryError = String(error?.message || error);
  }
  const report = buildRobinhoodApprovedPairReport({ productionManifest, canonicalPayload, discoveryError });
  if (process.argv.includes("--markdown")) console.log(toMarkdownTable(report));
  else console.log(JSON.stringify(report, null, 2));
}
