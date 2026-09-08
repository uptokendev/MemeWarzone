#!/usr/bin/env node
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const ROBINHOOD_TESTNET_CHAIN_ID = 46630;
export const EXPECTED_FACTORY_GENERATION = 4;
export const EXPECTED_CAMPAIGN_GENERATION = 3;
export const EXPECTED_LIQUIDITY_KIND = 2;

function sameAddress(a, b) {
  return Boolean(a && b) && String(a).toLowerCase() === String(b).toLowerCase();
}

export function proveRobinhoodStagedManifest(manifest) {
  if (!manifest || typeof manifest !== "object") throw new Error("staged manifest is missing");
  if (manifest.targetChainId !== ROBINHOOD_TESTNET_CHAIN_ID) {
    throw new Error(`wrong targetChainId: expected ${ROBINHOOD_TESTNET_CHAIN_ID}, got ${manifest.targetChainId}`);
  }
  if (String(manifest.environment || "").toLowerCase() === "production") {
    throw new Error("staged manifest must not claim production environment");
  }
  if (
    manifest.factoryGeneration !== EXPECTED_FACTORY_GENERATION ||
    manifest.campaignGeneration !== EXPECTED_CAMPAIGN_GENERATION ||
    manifest.liquidityKind !== EXPECTED_LIQUIDITY_KIND
  ) {
    throw new Error(
      `wrong generation/liquidity metadata: expected factory ${EXPECTED_FACTORY_GENERATION} / campaign ${EXPECTED_CAMPAIGN_GENERATION} / liquidity ${EXPECTED_LIQUIDITY_KIND}`,
    );
  }
  if (manifest.creationEnabled !== false || manifest.supportEnabled !== false || manifest.factoryLive !== false) {
    throw new Error("staged deployment unexpectedly enabled");
  }
  if (manifest.securityDefaultsLocked !== true) {
    throw new Error("staged factory must keep security defaults locked");
  }
  if (!Array.isArray(manifest.activationPrerequisites) || manifest.activationPrerequisites.length === 0) {
    throw new Error("activation prerequisites missing; staged stack must not be silently activatable");
  }
  if (manifest.stagingOnly?.productionCompatible !== false) throw new Error("staging-only marker missing");
  if (manifest.stagingOnly?.controlledV3Dex !== true) throw new Error("controlled V3 staging marker missing");
  if (!manifest.contracts?.upVoteTreasury) throw new Error("UPVoteTreasury missing from staged manifest");
  if (!manifest.contracts?.v3NativeSwapAdapter) throw new Error("Robinhood V3 native swap adapter missing from staged manifest");
  if (manifest.auxiliaryFeatures?.v3NativeSwapAdapter?.nativeAsset !== "ETH") {
    throw new Error("native V3 adapter ETH metadata missing");
  }

  const contracts = manifest.contracts || {};
  const multiHop = manifest.auxiliaryFeatures?.v3MultiHopSwapAdapter;
  if (!contracts.v3MultiHopSwapAdapter) throw new Error("Robinhood V3 Stock multi-hop swap adapter missing from staged manifest");
  if (!multiHop || multiHop.enabled !== true || multiHop.routeKind !== "STOCK_TWO_HOP") {
    throw new Error("Stock multi-hop adapter metadata missing");
  }
  if (multiHop.nativeAsset !== "ETH" || multiHop.testnetOnly !== true) {
    throw new Error("Stock multi-hop adapter testnet ETH metadata missing");
  }
  if (multiHop.routeConfigured !== false) {
    throw new Error("staged Stock multi-hop adapter must not preconfigure a market route");
  }

  const stagedFactory = contracts.v3Factory || contracts.mockV3Factory || contracts.MockUniswapV3Factory;
  const stagedRouter = contracts.v3SwapRouter || contracts.swapRouter || contracts.mockSwapRouter02 || contracts.MockUniswapV3SwapRouter;
  const stagedWrapped = contracts.weth9 || contracts.wrappedNative || contracts.mockWeth9 || contracts.MockWETH9;
  if (!sameAddress(multiHop.v3Factory, stagedFactory)) throw new Error("Stock multi-hop adapter V3 factory metadata mismatch");
  if (!sameAddress(multiHop.swapRouter, stagedRouter)) throw new Error("Stock multi-hop adapter router metadata mismatch");
  if (!sameAddress(multiHop.wrappedNative, stagedWrapped)) throw new Error("Stock multi-hop adapter wrapped-native metadata mismatch");

  return true;
}

function runningAsCli() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (runningAsCli()) {
  const file = process.argv[2] || process.env.ROBINHOOD_STAGE_DEPLOYMENT_FILE;
  if (!file) {
    console.error("usage: node scripts/prove-robinhood-staged-manifest.mjs <manifest.json>");
    process.exit(2);
  }
  proveRobinhoodStagedManifest(JSON.parse(fs.readFileSync(file, "utf8")));
  console.log("Robinhood staged manifest activation gate passed");
}
