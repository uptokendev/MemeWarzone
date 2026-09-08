#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRobinhoodLocalEnv,
  configPathFromRepoRoot,
  loadSimpleEnvFile,
} from "./robinhood-local-env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(here, "..");
const repoRoot = path.resolve(frontendDir, "..");
const configPath = configPathFromRepoRoot(repoRoot);
const manifestPath = path.resolve(
  repoRoot,
  String(process.env.ROBINHOOD_STAGE_DEPLOYMENT_FILE || "deployments/robinhood/testnet.staged.json"),
);

function fail(message) {
  console.error(`[robinhood-local-start] ${message}`);
  process.exit(1);
}

if (!fs.existsSync(manifestPath)) {
  fail(
    `real Robinhood testnet staged manifest is missing at ${path.relative(repoRoot, manifestPath)}. ` +
      "Deploy and verify chain 46630 before browser acceptance.",
  );
}

if (!fs.existsSync(configPath) && !String(process.env.DATABASE_URL || "").trim()) {
  fail(
    "config/robinhood.local is missing. Copy config/robinhood-local.env.example and set the local PostgreSQL DATABASE_URL.",
  );
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (Number(manifest.targetChainId) !== 46630 || Number(manifest.chainId) !== 46630) {
  fail(`staged manifest must be a real 46630 deployment; got target=${manifest.targetChainId} chain=${manifest.chainId}.`);
}
if (manifest.stagingOnly?.productionCompatible !== false) {
  fail("staged manifest is not marked testnet-only/non-production-compatible.");
}
if (!/^0x[a-fA-F0-9]{40}$/.test(String(manifest.contracts?.launchFactory || ""))) {
  fail("staged manifest is missing LaunchFactory.");
}
if (!/^0x[a-fA-F0-9]{40}$/.test(String(manifest.contracts?.upVoteTreasury || ""))) {
  fail("staged manifest is missing UPVoteTreasury. Run the Robinhood auxiliary deployment first.");
}

const fileEnv = loadSimpleEnvFile(configPath);
let env;
try {
  env = buildRobinhoodLocalEnv(process.env, fileEnv);
} catch (error) {
  fail(`local isolation preflight failed: ${error?.message || error}`);
}

if (!String(env.ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY || env.ROUTE_AUTHORITY_PRIVATE_KEY || "").trim()) {
  fail(
    "ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY is missing. Browser create/buy/sell acceptance requires the route-authority signer used by the staged factory.",
  );
}

function runNodeScript(label, scriptPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: repoRoot,
      env: { ...process.env, ...fileEnv },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed (${signal || code})`));
    });
  });
}

console.log("[robinhood-local-start] target: Robinhood Testnet 46630 via localhost UI");
console.log(`[robinhood-local-start] manifest: ${path.relative(repoRoot, manifestPath)}`);
console.log(`[robinhood-local-start] factory: ${manifest.contracts.launchFactory}`);
console.log("[robinhood-local-start] bootstrapping isolated local PostgreSQL schema...");

await runNodeScript("Robinhood local DB bootstrap", path.join(frontendDir, "scripts", "prepare-robinhood-local-db.mjs"));

console.log("[robinhood-local-start] database ready; starting local frontend/API/indexer/scanners...");
const child = spawn(process.execPath, [path.join(frontendDir, "scripts", "dev-robinhood-local.mjs")], {
  cwd: repoRoot,
  env: {
    ...process.env,
    ...fileEnv,
    ROBINHOOD_STAGE_DEPLOYMENT_FILE: manifestPath,
  },
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    try {
      child.kill(signal);
    } catch {}
  });
}

child.once("error", (error) => fail(`local stack failed to start: ${error?.message || error}`));
child.once("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
