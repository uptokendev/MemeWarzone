import "../api/load-local-env.mjs";
import { spawn } from "node:child_process";

const isWindows = process.platform === "win32";
const apiPort = process.env.VITE_DEV_API_PORT || process.env.API_PORT || process.env.PORT || "3001";
const apiBase = process.env.VITE_DEV_API_PROXY_TARGET || `http://127.0.0.1:${apiPort}`;
const healthUrl = `${apiBase.replace(/\/$/, "")}/healthz`;

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function truthy(value) {
  return TRUE_VALUES.has(String(value || "").trim().toLowerCase());
}

function normalizeUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return withProtocol.replace(/\/+$/, "");
}

function viteRealtimeApiBase() {
  const localGateway = normalizeUrl(apiBase);
  const railwayProxyEnabled = truthy(process.env.API_RAILWAY_PROXY || process.env.RAILWAY_API_PROXY || process.env.VITE_API_RAILWAY_PROXY);
  const forceDirect = truthy(process.env.VITE_REALTIME_API_DIRECT || process.env.VITE_FORCE_DIRECT_REALTIME_API);

  // In hybrid localhost mode, the browser should call the local API gateway.
  // The gateway then proxies /api/token/* to Railway. This avoids localhost CORS
  // drift while preserving the same Railway data source underneath.
  if (railwayProxyEnabled && !forceDirect && localGateway) {
    console.log("[dev:vite] using local API gateway as VITE_REALTIME_API_BASE for hybrid parity");
    return localGateway;
  }

  const explicit = normalizeUrl(process.env.VITE_REALTIME_API_BASE);
  if (explicit) return explicit;

  const railway = normalizeUrl(process.env.RAILWAY_API_BASE_URL || process.env.RAILWAY_INDEXER_URL);
  if (railway) {
    console.log("[dev:vite] using Railway URL as VITE_REALTIME_API_BASE for local parity");
    return railway;
  }

  return "";
}

async function checkApi() {
  try {
    const res = await fetch(healthUrl, { cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

const ok = await checkApi();
if (!ok) {
  console.error("\n[dev:vite] Local API gateway is not reachable.");
  console.error(`[dev:vite] Tried: ${healthUrl}`);
  console.error("\nStart the hybrid stack instead:");
  console.error("  npm run dev:hybrid");
  console.error("\nOr start the API in another terminal first:");
  console.error("  npm run api:dev");
  console.error("\nThen run:");
  console.error("  npm run dev:vite\n");
  process.exit(1);
}

console.log(`[dev:vite] API OK: ${healthUrl}`);

const realtimeApiBase = viteRealtimeApiBase();
if (!realtimeApiBase) {
  console.warn(
    "[dev:vite] VITE_REALTIME_API_BASE is missing. TokenDetails chart/realtime data expects the Railway realtime-indexer URL or the local hybrid gateway."
  );
}

// Local development must always expose the current three-chain product surface.
// Merge these required dev chains into any older local VITE_ALLOWED_CHAIN_IDS so a
// stale .env containing only BNB/Solana cannot silently hide Robinhood. Production
// never executes this launcher and therefore keeps its explicit fail-closed config.
const configuredAllowedChainIds = String(process.env.VITE_ALLOWED_CHAIN_IDS || "")
  .split(",")
  .map((value) => Number(String(value).trim()))
  .filter((value) => Number.isInteger(value) && value > 0);
const allowedChainIds = Array.from(new Set([...configuredAllowedChainIds, 56, 101, 46630])).join(",");
console.log(`[dev:vite] browser chains: ${allowedChainIds}`);

const command = isWindows ? "cmd.exe" : "vite";
const args = isWindows ? ["/d", "/s", "/c", "vite"] : [];
const child = spawn(command, args, {
  stdio: "inherit",
  shell: false,
  env: {
    ...process.env,
    VITE_ALLOWED_CHAIN_IDS: allowedChainIds,
    VITE_DEV_API_PORT: apiPort,
    VITE_DEV_API_PROXY_TARGET: apiBase,
    ...(realtimeApiBase ? { VITE_REALTIME_API_BASE: realtimeApiBase } : {}),
  },
});

child.on("exit", (code, signal) => {
  if (signal) process.exit(0);
  process.exit(code || 0);
});

child.on("error", (error) => {
  console.error("[dev:vite] failed to start Vite:", error);
  process.exit(1);
});
