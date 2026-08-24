#!/usr/bin/env node
/**
 * Resolve the currently accepted BSC Testnet certification factory from the
 * tracked deployment manifest. Never invent an address and never use previous
 * supported-factory fallbacks.
 *
 * Usage:
 *   node scripts/resolve-bsc-certification-factory.mjs
 *   node scripts/resolve-bsc-certification-factory.mjs --github-output
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(ROOT, "config/bsc-testnet-certification.json");
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function fail(message) {
  throw new Error(`[bsc-certification-factory] ${message}`);
}

function parseJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    const start = text.indexOf("{");
    if (start < 0) throw error;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === "\\") {
          escape = true;
          continue;
        }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{") depth += 1;
      if (ch === "}") {
        depth -= 1;
        if (depth === 0) return JSON.parse(text.slice(start, i + 1));
      }
    }
    throw error;
  }
}

function normalize(address) {
  const value = String(address || "").trim();
  if (!ADDRESS_RE.test(value)) return "";
  return value;
}

function extractFactory(manifest) {
  if (manifest?.newFactory?.creationEnabled && manifest.newFactory.address) {
    return {
      address: normalize(manifest.newFactory.address),
      locker: normalize(manifest.newFactory.locker),
      live: Boolean(manifest.newFactory.live),
      creationEnabled: true,
      sourceField: "newFactory",
    };
  }
  const supported = manifest?.supportedFactories;
  if (Array.isArray(supported)) {
    const enabled = supported.filter((entry) => entry?.creationEnabled && entry.address);
    if (enabled.length > 1) fail("expected exactly one creationEnabled factory in supportedFactories");
    if (enabled.length === 1) {
      return {
        address: normalize(enabled[0].address),
        locker: normalize(enabled[0].locker),
        live: enabled[0].live !== false,
        creationEnabled: true,
        sourceField: "supportedFactories",
      };
    }
  }
  const contractsAddress = normalize(manifest?.contracts?.LaunchFactory);
  if (contractsAddress && manifest?.creationEnabled !== false) {
    return {
      address: contractsAddress,
      locker: normalize(manifest.contracts?.PermanentLpLocker || manifest.newFactory?.locker),
      live: manifest?.newFactory?.live !== false,
      creationEnabled: Boolean(manifest?.newFactory?.creationEnabled || manifest?.creationEnabled),
      sourceField: "contracts.LaunchFactory",
    };
  }
  return null;
}

function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const sourceRel = config.sourceManifest;
  const sourcePath = path.join(ROOT, sourceRel);
  if (!fs.existsSync(sourcePath)) {
    fail(
      `source manifest missing: ${sourceRel}. ${config.deployIfMissing || "Deploy a dedicated low-threshold test factory."}`,
    );
  }
  const manifest = parseJsonObject(fs.readFileSync(sourcePath, "utf8"));
  if (Number(manifest.chainId || config.chainId) !== 97) {
    fail(`source manifest chainId must be 97, got ${manifest.chainId}`);
  }

  const factory = extractFactory(manifest);
  if (!factory?.address) {
    fail(
      `no creation-enabled factory in ${sourceRel}. Deploy a dedicated low-threshold test factory with: ${config.deployIfMissing}`,
    );
  }
  if (config.requireCreationEnabled && !factory.creationEnabled) {
    fail(`factory ${factory.address} is not creation-enabled`);
  }
  if (config.requireLive && factory.live === false) {
    fail(`factory ${factory.address} is not live`);
  }

  const rejected = new Set((config.rejectedFactories || []).map((item) => item.toLowerCase()));
  if (rejected.has(factory.address.toLowerCase())) {
    fail(
      `${factory.address} is a previous/obsolete factory fallback and is not the certification factory. ${config.deployIfMissing}`,
    );
  }

  const topazRel = config.topazManifest;
  const topazPath = path.join(ROOT, topazRel);
  if (!fs.existsSync(topazPath)) fail(`Topaz manifest missing: ${topazRel}`);

  const result = {
    chainId: 97,
    factory: factory.address,
    locker: factory.locker || "",
    creationEnabled: factory.creationEnabled,
    live: factory.live,
    sourceManifest: sourceRel,
    topazManifest: topazRel,
    deploymentFile: sourceRel,
    sourceField: factory.sourceField,
  };

  console.log(JSON.stringify(result, null, 2));
  console.log(`FACTORY_ADDRESS=${result.factory}`);
  console.log(`DEPLOYMENT_FILE=${result.deploymentFile}`);
  console.log(`TOPAZ_MANIFEST=${result.topazManifest}`);

  if (process.argv.includes("--github-output") && process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `factory=${result.factory}`,
        `deployment_file=${result.deploymentFile}`,
        `topaz_manifest=${result.topazManifest}`,
        `locker=${result.locker}`,
        "",
      ].join("\n"),
    );
  }
}

try {
  main();
} catch (error) {
  console.error(error?.stack || error);
  process.exitCode = 1;
}
