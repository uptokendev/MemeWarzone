import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const LIVE_BACKEND_HOSTS = new Set([
  "api.memewar.zone",
  "indexer.memewar.zone",
  "memebattles-frontend-7dcf.up.railway.app",
  "memebattles-production-dca0.up.railway.app",
]);

export const ROBINHOOD_LOCAL_ENDPOINTS = Object.freeze({
  frontend: "http://127.0.0.1:5173",
  frontendApi: "http://127.0.0.1:3001",
  indexer: "http://127.0.0.1:3002",
});

function unquote(value) {
  const trimmed = String(value || "").trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function loadSimpleEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    out[match[1]] = unquote(match[2]);
  }
  return out;
}

export function isLoopbackHost(hostname) {
  return LOCAL_HOSTS.has(String(hostname || "").trim().toLowerCase());
}

export function assertLoopbackUrl(label, raw) {
  let parsed;
  try {
    parsed = new URL(String(raw || ""));
  } catch {
    throw new Error(`${label} must be a valid URL; got ${String(raw || "(empty)")}`);
  }
  if (!isLoopbackHost(parsed.hostname)) {
    throw new Error(`${label} must stay on loopback in Robinhood local mode; got ${parsed.hostname}`);
  }
  return parsed;
}

export function assertLocalDatabaseUrl(raw) {
  const parsed = assertLoopbackUrl("DATABASE_URL", raw);
  if (!/^postgres(?:ql)?:$/i.test(parsed.protocol)) {
    throw new Error(`DATABASE_URL must be PostgreSQL; got ${parsed.protocol}`);
  }
  const dbName = parsed.pathname.replace(/^\//, "");
  if (!dbName || !/robinhood|local/i.test(dbName)) {
    throw new Error(
      `DATABASE_URL must name a dedicated local Robinhood database (for example memewarzone_robinhood_local); got ${dbName || "(empty)"}`,
    );
  }
  return parsed;
}

function assertNotLiveBackend(label, raw) {
  const value = String(raw || "").trim();
  if (!value) return;
  let host = "";
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return;
  }
  if (LIVE_BACKEND_HOSTS.has(host) || host.endsWith(".railway.app")) {
    throw new Error(`${label} resolves to a live/retired remote backend (${host}) in Robinhood local mode.`);
  }
}

function forceLocalServiceRoutes(env) {
  const api = ROBINHOOD_LOCAL_ENDPOINTS.frontendApi;
  const indexer = ROBINHOOD_LOCAL_ENDPOINTS.indexer;
  Object.assign(env, {
    VITE_FRONTEND_API_BASE: api,
    VITE_RAILWAY_FRONTEND_API_BASE: api,
    RAILWAY_FRONTEND_API_BASE_URL: api,
    VITE_TOKEN_API_BASE: indexer,
    VITE_RAILWAY_TOKEN_API_BASE: indexer,
    RAILWAY_TOKEN_API_BASE_URL: indexer,
    VITE_REALTIME_API_BASE: indexer,
    VITE_API_BASE: indexer,
    VITE_API_BASE_URL: indexer,
    VITE_RAILWAY_API_BASE: indexer,
    LOCAL_INDEXER_API_BASE_URL: indexer,
    RAILWAY_API_BASE_URL: indexer,
    RAILWAY_INDEXER_URL: indexer,
    API_RAILWAY_PROXY: "1",
    API_RAILWAY_PROXY_STRICT: "1",
    VITE_DEV_API_PORT: "3001",
    VITE_DEV_API_PROXY_TARGET: api,
  });
}

export function buildRobinhoodLocalEnv(baseEnv = {}, fileEnv = {}) {
  const env = { ...baseEnv, ...fileEnv };
  env.RUNTIME_ENVIRONMENT = "local";
  env.VITE_RUNTIME_ENVIRONMENT = "local";
  env.ROBINHOOD_TESTNET_CHAIN_ID = "46630";
  env.DEFAULT_EVM_CHAIN_ID = "46630";
  env.EVM_INDEXER_CHAIN_IDS = "46630";
  env.VITE_DEFAULT_CHAIN_ID = "46630";
  env.VITE_ALLOWED_CHAIN_IDS = "46630";
  env.PG_DISABLE_SSL = "1";
  env.PG_SIMPLE_PROTOCOL = "0";
  env.PORT = "3002";
  env.INDEXER_PORT = "3002";
  env.FRONTEND_API_PORT = "3001";
  env.FRONTEND_PORT = "5173";

  // Robinhood-local must never wake BNB/Solana workers accidentally from inherited env.
  env.BSC_RPC_HTTP_56 = "";
  env.BSC_RPC_HTTP_97 = "";
  env.SOLANA_RPC_HTTP = "";
  env.SOLANA_LAUNCHPAD_PROGRAM_ID = "";
  env.ENABLE_TOPAZ_POOL_INDEXER = "0";
  env.ENABLE_GRADUATION_HANDOFF_RECONCILER = "0";
  env.ENABLE_UNIFIED_MARKET_API = "1";
  env.ENABLE_UNIFIED_MARKET_CHART = "1";

  // External production services are disabled in this profile.
  env.LOCAL_DISABLE_ABLY = "1";
  env.LOCAL_DISABLE_REMOTE_SUPABASE = "1";
  env.ENABLE_DATA_URL_UPLOADS = "1";
  env.TELEMETRY_INGEST_URL = "";
  env.TELEMETRY_TOKEN = "";
  delete env.ABLY_API_KEY;
  delete env.SUPABASE_URL;
  delete env.SUPABASE_SERVICE_ROLE_KEY;
  delete env.SUPABASE_SERVICE_KEY;
  delete env.SUPABASE_SECRET_KEY;

  forceLocalServiceRoutes(env);

  const rpc = String(env.ROBINHOOD_TESTNET_RPC_URL || env.ROBINHOOD_RPC_HTTP_46630 || "").trim();
  if (!rpc || !/^https?:\/\//i.test(rpc)) {
    throw new Error("Set ROBINHOOD_TESTNET_RPC_URL in config/robinhood.local.");
  }
  env.ROBINHOOD_TESTNET_RPC_URL = rpc;
  env.ROBINHOOD_RPC_HTTP_46630 = rpc;
  env.VITE_PUBLIC_RPC_46630 = String(env.VITE_PUBLIC_RPC_46630 || rpc);

  assertLocalDatabaseUrl(env.DATABASE_URL);

  const backendKeys = [
    "VITE_FRONTEND_API_BASE",
    "VITE_TOKEN_API_BASE",
    "VITE_REALTIME_API_BASE",
    "VITE_API_BASE",
    "VITE_API_BASE_URL",
    "VITE_RAILWAY_API_BASE",
    "RAILWAY_API_BASE_URL",
    "RAILWAY_INDEXER_URL",
    "LOCAL_INDEXER_API_BASE_URL",
  ];
  for (const key of backendKeys) {
    assertNotLiveBackend(key, env[key]);
    assertLoopbackUrl(key, env[key]);
  }

  return env;
}

export function configPathFromRepoRoot(repoRoot) {
  return path.join(repoRoot, "config", "robinhood.local");
}

export async function assertPortAvailable(port, host = "127.0.0.1") {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => reject(new Error(`Local port ${port} is already in use: ${error.message}`)));
    server.listen({ port, host }, () => server.close(resolve));
  });
}

export function truthy(value) {
  return TRUE_VALUES.has(String(value || "").trim().toLowerCase());
}
