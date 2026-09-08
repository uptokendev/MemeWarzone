#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ROBINHOOD_LOCAL_ENDPOINTS,
  assertPortAvailable,
  buildRobinhoodLocalEnv,
  configPathFromRepoRoot,
  loadSimpleEnvFile,
} from "./robinhood-local-env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(here, "..");
const repoRoot = path.resolve(frontendDir, "..");
const indexerDir = path.join(repoRoot, "realtime-indexer");
const configPath = configPathFromRepoRoot(repoRoot);
const examplePath = path.join(repoRoot, "config", "robinhood-local.env.example");
const defaultManifestPath = path.join(repoRoot, "deployments", "robinhood", "testnet.staged.json");
const manifestPath = path.resolve(
  repoRoot,
  String(process.env.ROBINHOOD_STAGE_DEPLOYMENT_FILE || "deployments/robinhood/testnet.staged.json"),
);

function requireAddress(label, value) {
  const raw = String(value || "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) {
    throw new Error(`${label} is missing or invalid in the Robinhood staged manifest.`);
  }
  return raw;
}

function stageManifestEnv(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const manifest = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (Number(manifest.targetChainId) !== 46630 || Number(manifest.chainId) !== 46630) {
    throw new Error(`Robinhood staged manifest must target chain 46630; got target=${manifest.targetChainId} chain=${manifest.chainId}.`);
  }
  if (manifest.stagingOnly?.productionCompatible !== false) {
    throw new Error("Robinhood localhost only accepts the staging-only testnet manifest.");
  }

  const c = manifest.contracts || {};
  const factory = requireAddress("LaunchFactory", c.launchFactory);
  const voteTreasury = requireAddress("UPVoteTreasury", c.upVoteTreasury);
  const treasuryRouter = requireAddress("TreasuryRouterV2", c.treasuryRouterV2);
  const communityVault = requireAddress("CommunityRewardsVault", c.communityRewardsVault);
  const recruiterVault = requireAddress("RecruiterRewardsVault", c.recruiterRewardsVault);
  const protocolVault = requireAddress("ProtocolRevenueVault", c.protocolRevenueVault);
  const creatorRegistry = requireAddress("CreatorRegistry", c.creatorRegistry);
  const riskRegistry = requireAddress("RiskRegistry", c.riskRegistry);
  const oracle = requireAddress("GraduationOracle", c.graduationOracle);
  const locker = requireAddress("PermanentV3PositionLocker", c.permanentV3PositionLocker);
  const campaignImplementation = requireAddress("LaunchCampaign implementation", c.launchCampaignImplementation);
  const adapter = requireAddress("Robinhood V3 graduation adapter", c.graduationAdapter);
  const v3Factory = requireAddress("Robinhood mock V3 factory", c.mockV3Factory);
  const positionManager = requireAddress("Robinhood mock V3 position manager", c.mockNonfungiblePositionManager);
  const swapRouter = requireAddress("Robinhood mock V3 swap router", c.mockSwapRouter02);
  const wrappedNative = requireAddress("Robinhood wrapped native", c.mockWeth9);
  const weeklyVault = requireAddress("TreasuryVaultV2", c.weeklyLeagueVault);
  const startBlock = Math.max(0, Number(manifest.deploymentBlock || 0));

  return {
    FACTORY_ADDRESS_46630: factory,
    FACTORY_START_BLOCK_46630: String(startBlock),
    SUPPORTED_FACTORY_ADDRESSES_46630: factory,
    SUPPORTED_FACTORY_START_BLOCKS_46630: String(startBlock),
    VOTE_TREASURY_ADDRESS_46630: voteTreasury,
    VOTE_TREASURY_START_BLOCK_46630: String(startBlock),
    TREASURY_ROUTER_ADDRESS_46630: treasuryRouter,
    TREASURY_VAULT_ADDRESS_46630: weeklyVault,
    COMMUNITY_REWARDS_VAULT_ADDRESS_46630: communityVault,
    RECRUITER_REWARDS_VAULT_ADDRESS_46630: recruiterVault,
    PROTOCOL_REVENUE_VAULT_ADDRESS_46630: protocolVault,
    CREATOR_REGISTRY_ADDRESS_46630: creatorRegistry,
    RISK_REGISTRY_ADDRESS_46630: riskRegistry,
    GRADUATION_ORACLE_ADDRESS_46630: oracle,
    PERMANENT_LP_LOCKER_ADDRESS_46630: locker,
    CAMPAIGN_IMPLEMENTATION_ADDRESS_46630: campaignImplementation,
    LAUNCH_ROUTER_ADDRESS_46630: adapter,
    ROBINHOOD_V3_FACTORY_ADDRESS_46630: v3Factory,
    ROBINHOOD_V3_POSITION_MANAGER_ADDRESS_46630: positionManager,
    ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_46630: swapRouter,
    WRAPPED_NATIVE_ADDRESS_46630: wrappedNative,

    VITE_FACTORY_ADDRESS_46630: factory,
    VITE_SUPPORTED_FACTORY_ADDRESSES_46630: factory,
    VITE_SUPPORTED_FACTORY_START_BLOCKS_46630: String(startBlock),
    VITE_VOTE_TREASURY_ADDRESS_46630: voteTreasury,
    VITE_TREASURY_ROUTER_ADDRESS_46630: treasuryRouter,
    VITE_TREASURY_VAULT_ADDRESS_46630: weeklyVault,
    VITE_COMMUNITY_REWARDS_VAULT_ADDRESS_46630: communityVault,
    VITE_RECRUITER_REWARDS_VAULT_ADDRESS_46630: recruiterVault,
    VITE_PROTOCOL_REVENUE_VAULT_ADDRESS_46630: protocolVault,
    VITE_CREATOR_REGISTRY_ADDRESS_46630: creatorRegistry,
    VITE_RISK_REGISTRY_ADDRESS_46630: riskRegistry,
    VITE_GRADUATION_ORACLE_ADDRESS_46630: oracle,
    VITE_PERMANENT_LP_LOCKER_ADDRESS_46630: locker,
    VITE_CAMPAIGN_IMPLEMENTATION_ADDRESS_46630: campaignImplementation,
    VITE_LAUNCH_ROUTER_ADDRESS_46630: adapter,
    VITE_ROBINHOOD_V3_FACTORY_ADDRESS_46630: v3Factory,
    VITE_ROBINHOOD_V3_POSITION_MANAGER_ADDRESS_46630: positionManager,
    VITE_ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_46630: swapRouter,
    VITE_WRAPPED_NATIVE_ADDRESS_46630: wrappedNative,
  };
}

if (!fs.existsSync(configPath) && !String(process.env.DATABASE_URL || "").trim()) {
  console.error("[robinhood-local] local config is missing.");
  console.error(`Copy ${path.relative(repoRoot, examplePath)} to config/robinhood.local and set your LOCAL PostgreSQL DATABASE_URL.`);
  process.exit(1);
}

const fileEnv = loadSimpleEnvFile(configPath);
let manifestEnv = null;
try {
  manifestEnv = stageManifestEnv(manifestPath);
} catch (error) {
  console.error(`[robinhood-local] staged manifest rejected: ${error?.message || error}`);
  process.exit(1);
}

if (!manifestEnv) {
  console.warn(`[robinhood-local] no staged Robinhood manifest found at ${path.relative(repoRoot, manifestPath)}.`);
  console.warn("[robinhood-local] The stack can boot for UI/read-only work, but create/trade/graduation acceptance needs the real 46630 staged deployment first.");
}

let env;
try {
  env = buildRobinhoodLocalEnv(process.env, { ...fileEnv, ...(manifestEnv || {}) });
} catch (error) {
  console.error(`[robinhood-local] isolation preflight failed: ${error?.message || error}`);
  process.exit(1);
}

if (manifestEnv && !String(env.ROUTE_AUTHORITY_PRIVATE_KEY || "").trim()) {
  console.warn("[robinhood-local] ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY is not configured; signed create/buy/sell acceptance will fail until it is supplied.");
}

for (const port of [3002, 3001, 5173]) {
  try {
    await assertPortAvailable(port);
  } catch (error) {
    console.error(`[robinhood-local] ${error?.message || error}`);
    console.error("Stop the old local service first. This profile never reuses an unknown process.");
    process.exit(1);
  }
}

const children = [];
let shuttingDown = false;

function spawnService(name, command, args, cwd, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd,
    env: { ...env, ...extraEnv },
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  children.push({ name, child });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`[robinhood-local] ${name} exited unexpectedly (${signal || code}). Shutting down the local stack.`);
    shutdown(code || 1);
  });
  child.on("error", (error) => {
    if (shuttingDown) return;
    console.error(`[robinhood-local] ${name} failed to start: ${error?.message || error}`);
    shutdown(1);
  });
  return child;
}

async function waitForHttp(name, url, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok || response.status < 500) {
        console.log(`[robinhood-local] ${name} ready: ${url}`);
        return;
      }
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = String(error?.message || error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${name} did not become ready at ${url}${last ? ` (${last})` : ""}`);
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children.slice().reverse()) {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
  setTimeout(() => process.exit(code), 250).unref();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(0));
}

console.log("[robinhood-local] isolated topology");
console.log(`  frontend     ${ROBINHOOD_LOCAL_ENDPOINTS.frontend}`);
console.log(`  frontend API ${ROBINHOOD_LOCAL_ENDPOINTS.frontendApi}`);
console.log(`  indexer API  ${ROBINHOOD_LOCAL_ENDPOINTS.indexer}`);
console.log("  scanner      dedicated Robinhood Testnet bonding scanner");
console.log(`  V3 indexer   ${env.ENABLE_ROBINHOOD_V3_POOL_INDEXER === "1" ? "enabled" : "disabled"}`);
console.log("  database     LOCAL PostgreSQL only");
console.log("  chain        Robinhood Testnet 46630");
console.log("  Ably         disabled");
console.log("  Supabase     disabled (logo uploads use local data URLs)");
console.log("  telemetry    disabled");
if (manifestEnv) {
  console.log(`  manifest     ${path.relative(repoRoot, manifestPath)}`);
  console.log(`  factory      ${env.FACTORY_ADDRESS_46630}`);
}
console.log("[robinhood-local] Shared production EVM/Solana scanner configuration remains disabled in this profile.");
console.log("[robinhood-local] The dedicated scanner hard-requires local runtime + chain 46630 + a loopback Robinhood database.");

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

try {
  // Start the local realtime-indexer API first. BNB/Solana RPCs are force-cleared,
  // so the shared production loops have no chain transport to operate on. WTR preload
  // starts the Robinhood V3 pool indexer when the staged manifest supplied its router.
  spawnService("realtime-indexer", npm, ["run", "dev"], indexerDir, { PORT: "3002" });
  await waitForHttp("realtime-indexer", `${ROBINHOOD_LOCAL_ENDPOINTS.indexer}/healthz`);

  // Run Robinhood bonding/factory event ingestion as a separate process. This is
  // intentionally not implemented by repointing the shared BNB scanner.
  spawnService("robinhood-scanner", npm, ["exec", "--", "tsx", "src/robinhoodLocalScanner.ts"], indexerDir);

  // Then the frontend API. The historical Railway proxy name is retained in code,
  // but every upstream URL is force-pinned to 127.0.0.1:3002 in this profile.
  spawnService("frontend-api", npm, ["run", "api:start"], frontendDir, { PORT: "3001" });
  await waitForHttp("frontend-api", `${ROBINHOOD_LOCAL_ENDPOINTS.frontendApi}/healthz`);

  // Vite last, so the browser never boots before both local backends are available.
  spawnService("vite", npm, ["run", "dev:vite", "--", "--host", "127.0.0.1", "--port", "5173"], frontendDir, {
    VITE_DEV_API_PORT: "3001",
    VITE_DEV_API_PROXY_TARGET: ROBINHOOD_LOCAL_ENDPOINTS.frontendApi,
  });
  await waitForHttp("vite", ROBINHOOD_LOCAL_ENDPOINTS.frontend);

  console.log("\n[robinhood-local] local stack + dedicated 46630 scanner + Robinhood V3 indexer are up. No Coolify API/indexer endpoint is in the runtime route set.");
  console.log(`[robinhood-local] open ${ROBINHOOD_LOCAL_ENDPOINTS.frontend}`);
} catch (error) {
  console.error(`[robinhood-local] startup failed: ${error?.message || error}`);
  shutdown(1);
}