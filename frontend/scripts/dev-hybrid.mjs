import { spawn } from "node:child_process";
import net from "node:net";

const isWindows = process.platform === "win32";

const requestedApiPort = Number(process.env.PORT || process.env.API_PORT || process.env.VITE_DEV_API_PORT || 3001);
const vitePort = process.env.VITE_PORT || "5173";
const reuseExistingApi = ["1", "true", "yes", "on"].includes(String(process.env.DEV_HYBRID_REUSE_API || "").trim().toLowerCase());

const children = [];
let shuttingDown = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function apiBaseForPort(port) {
  return `http://127.0.0.1:${port}`;
}

function healthUrlForPort(port) {
  return `${apiBaseForPort(port)}/healthz`;
}

async function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function findFreePort(startPort) {
  for (let port = startPort; port < startPort + 20; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free API port found from ${startPort} to ${startPort + 19}`);
}

async function isApiHealthy(port) {
  try {
    const res = await fetch(healthUrlForPort(port), { cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForApi(port, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isApiHealthy(port)) return true;
    await sleep(500);
  }
  return false;
}

function start(name, script, env) {
  const command = isWindows ? "cmd.exe" : "npm";
  const args = isWindows ? ["/d", "/s", "/c", `npm run ${script}`] : ["run", script];

  const child = spawn(command, args, {
    stdio: "inherit",
    shell: false,
    windowsHide: false,
    env: {
      ...process.env,
      ...env,
    },
  });

  children.push(child);

  child.on("error", (error) => {
    if (shuttingDown) return;
    console.error(`[dev-hybrid] failed to start ${name}:`, error);
    shutdown(1);
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    if (code === 0 || signal) return;
    console.error(`[dev-hybrid] ${name} exited with code ${code ?? "signal " + signal}`);
    shutdown(code || 1);
  });

  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      if (isWindows && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      // ignore
    }
  }
  setTimeout(() => process.exit(code), 250);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const requestedApiBase = apiBaseForPort(requestedApiPort);
console.log(`[dev-hybrid] API: ${requestedApiBase}`);
console.log(`[dev-hybrid] Web: http://127.0.0.1:${vitePort}`);

let apiPort = requestedApiPort;
let apiBase = requestedApiBase;
const requestedApiAlreadyRunning = await isApiHealthy(requestedApiPort);

if (requestedApiAlreadyRunning && reuseExistingApi) {
  console.log(`[dev-hybrid] API already healthy, reusing existing server: ${healthUrlForPort(requestedApiPort)}`);
} else {
  if (requestedApiAlreadyRunning) {
    apiPort = await findFreePort(requestedApiPort + 1);
    apiBase = apiBaseForPort(apiPort);
    console.log(`[dev-hybrid] API already running on ${requestedApiBase}; starting a fresh gateway on ${apiBase}`);
    console.log("[dev-hybrid] set DEV_HYBRID_REUSE_API=true to intentionally reuse an existing API server");
  } else if (!(await isPortFree(requestedApiPort))) {
    apiPort = await findFreePort(requestedApiPort + 1);
    apiBase = apiBaseForPort(apiPort);
    console.log(`[dev-hybrid] API port ${requestedApiPort} is occupied; starting a fresh gateway on ${apiBase}`);
  }

  // Use stable API mode by default. The node --watch API script can restart from
  // unrelated file activity and cause browser refreshes across every route.
  // Hybrid local development must never make an upstream Railway 404/405 final:
  // the local API owns many routes that Railway may not have yet. Keep proxying
  // successful upstream routes, but always fall back to the local handler when
  // the upstream does not recognize a route.
  start("api", "api:start", {
    PORT: String(apiPort),
    API_PORT: String(apiPort),
    API_RAILWAY_PROXY_STRICT: "false",
    RAILWAY_API_PROXY_STRICT: "false",
  });

  console.log(`[dev-hybrid] waiting for API health: ${healthUrlForPort(apiPort)}`);
  const apiReady = await waitForApi(apiPort);

  if (!apiReady) {
    console.error(`[dev-hybrid] API did not become healthy at ${healthUrlForPort(apiPort)}`);
    shutdown(1);
  } else {
    console.log(`[dev-hybrid] API is healthy`);
  }
}

start("vite", "dev:vite", {
  VITE_DEV_API_PORT: String(apiPort),
  VITE_DEV_API_PROXY_TARGET: apiBase,
  VITE_PORT: vitePort,
});
