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

if (!fs.existsSync(configPath) && !String(process.env.DATABASE_URL || "").trim()) {
  console.error("[robinhood-local] local config is missing.");
  console.error(`Copy ${path.relative(repoRoot, examplePath)} to config/robinhood.local and set your LOCAL PostgreSQL DATABASE_URL.`);
  process.exit(1);
}

const fileEnv = loadSimpleEnvFile(configPath);
let env;
try {
  env = buildRobinhoodLocalEnv(process.env, fileEnv);
} catch (error) {
  console.error(`[robinhood-local] isolation preflight failed: ${error?.message || error}`);
  process.exit(1);
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
console.log("  database     LOCAL PostgreSQL only");
console.log("  chain        Robinhood Testnet 46630");
console.log("  Ably         disabled");
console.log("  Supabase     disabled (logo uploads use local data URLs)");
console.log("  telemetry    disabled");
console.log("[robinhood-local] IMPORTANT: the shared production indexer scanner is intentionally not repointed to 46630 by this runner.");
console.log("[robinhood-local] Until the RH local scanner lands, port 3002 runs the local indexer/API process with BNB/Solana RPCs disabled.");

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

try {
  // Start the local realtime-indexer process first. BNB/Solana RPCs are force-cleared.
  spawnService("realtime-indexer", npm, ["run", "dev"], indexerDir, { PORT: "3002" });
  await waitForHttp("realtime-indexer", `${ROBINHOOD_LOCAL_ENDPOINTS.indexer}/healthz`);

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

  console.log("\n[robinhood-local] local stack is up. No Coolify API/indexer endpoint is in the runtime route set.");
  console.log(`[robinhood-local] open ${ROBINHOOD_LOCAL_ENDPOINTS.frontend}`);
} catch (error) {
  console.error(`[robinhood-local] startup failed: ${error?.message || error}`);
  shutdown(1);
}
