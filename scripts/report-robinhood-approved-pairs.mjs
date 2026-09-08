#!/usr/bin/env node
import fs from "node:fs";
import { listRobinhoodManifestPairCandidates, summarizeRobinhoodManifestPairCandidates } from "../frontend/api/lib/robinhoodFullApprovedPairCatalog.js";

const DEFAULT_MANIFEST = "deployments/robinhood/mainnet.json";

export function buildRobinhoodApprovedPairReport({ productionManifest } = {}) {
  const manifest = productionManifest || JSON.parse(fs.readFileSync(DEFAULT_MANIFEST, "utf8"));
  const candidates = listRobinhoodManifestPairCandidates();
  const runtimeReady = manifest?.supportEnabled === true && manifest?.creationEnabled === true && Boolean(manifest?.contracts?.launchFactory);
  const blocker = runtimeReady
    ? "runtime certification required per candidate before ACTIVE"
    : "Robinhood production manifest is dark/incomplete: supportEnabled + creationEnabled + contracts.launchFactory are required";

  return {
    chainId: 4663,
    generatedAt: new Date().toISOString(),
    productionRuntimeReady: runtimeReady,
    summary: summarizeRobinhoodManifestPairCandidates(),
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

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const manifestPath = process.argv[2] || process.env.ROBINHOOD_PRODUCTION_MANIFEST || DEFAULT_MANIFEST;
  const productionManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const report = buildRobinhoodApprovedPairReport({ productionManifest });
  if (process.argv.includes("--markdown")) console.log(toMarkdownTable(report));
  else console.log(JSON.stringify(report, null, 2));
}
