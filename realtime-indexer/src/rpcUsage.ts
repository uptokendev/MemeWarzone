/**
 * Per-process JSON-RPC request counter, by chain and method.
 *
 * The paid BNB / Robinhood RPC quota ran out on 2026-10-08 with no record of
 * which process sent what. This counts every request of every ethers
 * JsonRpcProvider in the process (one patch of the prototype's _send, which
 * all JSON-RPC traffic of a provider goes through) and the raw probe calls of
 * rpcProvider.ts, keyed by chain and method only. URLs are never stored: they
 * carry the provider key.
 *
 * Solana JSON-RPC goes over plain fetch (solanaIndexer, meteora, dbc, the
 * keepers) and over @solana/web3.js, which captures globalThis.fetch when it is
 * first imported. hookSolanaFetchCounter wraps globalThis.fetch and counts the
 * Solana methods of JSON-RPC bodies (batches per entry) under chain "solana".
 * It must run before @solana/web3.js is imported: main.ts imports
 * rpcUsagePreload.ts first for that.
 *
 * Exposed on GET /health (rpcUsage) and logged every RPC_USAGE_LOG_MINUTES
 * minutes (default 15; 0 = off):
 *   [rpc-usage] {"windowMin":15,"total":123,"byChain":{"56":{"total":100,"methods":{...}}}}
 * Short-lived cron jobs log their totals once at exit (logRpcUsageOnExit).
 */
import { ethers } from "ethers";

const counts = new Map<string, Map<string, number>>();
const startedAt = Date.now();
let lastLogged: Map<string, Map<string, number>> | null = null;

function bump(chain: unknown, method: unknown, n = 1) {
  const key = String(chain ?? "unknown");
  const name = String(method || "unknown").slice(0, 64);
  let byMethod = counts.get(key);
  if (!byMethod) {
    byMethod = new Map();
    counts.set(key, byMethod);
  }
  byMethod.set(name, (byMethod.get(name) || 0) + n);
}

// Which of our functions sent each request, as "file:function" (first stack frame in this package
// outside the RPC plumbing). Lets /health show the cost per loop instead of only per method.
const bySource = new Map<string, number>();
const PACKAGE_DIR = (() => {
  try {
    // Package root, not dist/: with --enable-source-maps frames point at src/*.ts.
    return new URL("..", import.meta.url).pathname;
  } catch {
    return "";
  }
})();
const PLUMBING_FILE = /\/(?:rpcUsage|rpcUsagePreload|rpcProvider)\.[cm]?[jt]s(?::|$)/;
const STACK_FRAME = /^\s*at (?:async )?(?:(.+?) \()?(?:file:\/\/)?([^()\s]+?):\d+:\d+\)?$/;

/** "solanaFeeEscrowWorker.js:processFlushes" for the first frame of ours below the plumbing. */
export function rpcCallSource(stack: string | undefined, packageDir = PACKAGE_DIR): string {
  for (const line of String(stack || "").split("\n").slice(1)) {
    const match = STACK_FRAME.exec(line);
    if (!match) continue;
    const file = match[2];
    if (!packageDir || !file.includes(packageDir) || file.includes("/node_modules/") || PLUMBING_FILE.test(file)) continue;
    const name = file.slice(file.lastIndexOf("/") + 1);
    const fn = String(match[1] || "").replace(/^(?:Object|Timeout|process)\./, "").replace(/^async /, "") || "<top>";
    return `${name}:${fn}`.slice(0, 120);
  }
  return "unattributed";
}

function attributeRpcCall(chain: unknown, n = 1) {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 60;
  let stack: string | undefined;
  try {
    stack = new Error().stack;
  } finally {
    Error.stackTraceLimit = limit;
  }
  const key = `${String(chain ?? "unknown")} ${rpcCallSource(stack)}`;
  bySource.set(key, (bySource.get(key) || 0) + n);
}

/** Attribute one request to its caller (rawRpcCall; the ethers and fetch hooks attribute their own). */
export function attributeRpcRequest(chain: unknown, payload: unknown) {
  try {
    attributeRpcCall(chain, Array.isArray(payload) ? payload.length : 1);
  } catch {
    // attribution must never break a request
  }
}

/** Count one JSON-RPC request (or each entry of a batch). */
export function countRpcRequest(chain: unknown, payload: unknown) {
  for (const item of Array.isArray(payload) ? payload : [payload]) {
    if (!item) continue;
    bump(chain, typeof item === "string" ? item : (item as any).method);
  }
}

type Plain = { total: number; byChain: Record<string, { total: number; methods: Record<string, number> }> };

function plain(source: Map<string, Map<string, number>> = counts): Plain {
  const byChain: Plain["byChain"] = {};
  let total = 0;
  for (const [chain, byMethod] of source) {
    const methods: Record<string, number> = {};
    let chainTotal = 0;
    for (const [method, n] of [...byMethod].sort((a, b) => b[1] - a[1])) {
      methods[method] = n;
      chainTotal += n;
    }
    byChain[chain] = { total: chainTotal, methods };
    total += chainTotal;
  }
  return { total, byChain };
}

/** Totals since the process started, with a per-day estimate per chain. */
export function rpcUsageSnapshot() {
  const uptimeSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  const { total, byChain } = plain();
  const estimatedPerDay: Record<string, number> = {};
  for (const [chain, value] of Object.entries(byChain)) estimatedPerDay[chain] = Math.round((value.total / uptimeSec) * 86_400);
  const bySourcePerDay: Record<string, number> = {};
  for (const [key, n] of [...bySource].sort((a, b) => b[1] - a[1]).slice(0, 60)) {
    bySourcePerDay[key] = Math.round((n / uptimeSec) * 86_400);
  }
  return { since: new Date(startedAt).toISOString(), uptimeSec, total, byChain, estimatedPerDay, bySourcePerDay };
}

function clone() {
  const copy = new Map<string, Map<string, number>>();
  for (const [chain, byMethod] of counts) copy.set(chain, new Map(byMethod));
  return copy;
}

/** Requests since the previous call (the whole process on the first call). */
export function rpcUsageDelta(): Plain {
  const now = clone();
  const delta = new Map<string, Map<string, number>>();
  for (const [chain, byMethod] of now) {
    const before = lastLogged?.get(chain);
    const out = new Map<string, number>();
    for (const [method, n] of byMethod) {
      const d = n - (before?.get(method) || 0);
      if (d > 0) out.set(method, d);
    }
    if (out.size) delta.set(chain, out);
  }
  lastLogged = now;
  return plain(delta);
}

export function resetRpcUsage() {
  counts.clear();
  bySource.clear();
  lastLogged = null;
}

let ethersHooked = false;

/** Patches JsonRpcProvider.prototype._send once so every provider's requests are counted on its pinned chain. */
export function hookEthersRpcCounter(JsonRpcProviderClass: any = ethers.JsonRpcProvider) {
  if (ethersHooked) return;
  const proto = JsonRpcProviderClass?.prototype;
  if (!proto || typeof proto._send !== "function") return;
  const original = proto._send;
  proto._send = function countedSend(this: any, payload: unknown) {
    let chain = "unknown";
    try {
      chain = String(this._network?.chainId ?? "unknown");
    } catch {
      // network not pinned yet
    }
    countRpcRequest(chain, payload);
    return original.call(this, payload);
  };
  const originalSend = proto.send;
  if (typeof originalSend === "function") {
    proto.send = function attributedSend(this: any, method: string, params: unknown) {
      let chain = "unknown";
      try {
        chain = String(this._network?.chainId ?? "unknown");
      } catch {
        // network not pinned yet
      }
      attributeRpcRequest(chain, method);
      return originalSend.call(this, method, params);
    };
  }
  ethersHooked = true;
}

const SOLANA_METHOD = /^(get[A-Z]|sendTransaction|simulateTransaction|requestAirdrop|isBlockhashValid|minimumLedgerSlot)/;

/**
 * Counts the Solana methods of a JSON-RPC body under chain "solana". Other
 * methods are ignored on purpose: EVM requests are already counted once by the
 * ethers hook (which does not use fetch) or by rawRpcCall, so counting them
 * here too would double them. Returns the number counted.
 */
export function countSolanaFetchBody(body: unknown): number {
  if (typeof body !== "string" || !body.includes('"jsonrpc"')) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return 0;
  }
  let n = 0;
  for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
    const method = (item as any)?.method;
    if (typeof method === "string" && SOLANA_METHOD.test(method)) {
      bump("solana", method);
      n += 1;
    }
  }
  if (n > 0) attributeRpcRequest("solana", new Array(n));
  return n;
}

/** Wraps a fetch so Solana JSON-RPC POST bodies are counted. URLs are never read or kept. */
export function countingSolanaFetch(fetchImpl: typeof fetch): typeof fetch {
  return function countedFetch(input: any, init?: any) {
    try {
      countSolanaFetchBody(init?.body);
    } catch {
      // never let counting break a request
    }
    return fetchImpl(input, init);
  } as typeof fetch;
}

let fetchHooked = false;

/** Counts Solana JSON-RPC sent through globalThis.fetch (also what @solana/web3.js uses). Once per process. */
export function hookSolanaFetchCounter() {
  if (fetchHooked || typeof globalThis.fetch !== "function") return;
  globalThis.fetch = countingSolanaFetch(globalThis.fetch.bind(globalThis));
  fetchHooked = true;
}

let timer: NodeJS.Timeout | null = null;

/** Logs the requests of the last window every RPC_USAGE_LOG_MINUTES minutes (default 15, 0 = off). */
export function startRpcUsageLog(env: NodeJS.ProcessEnv = process.env, log: (...args: unknown[]) => void = console.log) {
  if (timer) return;
  const minutes = Number(env.RPC_USAGE_LOG_MINUTES ?? 15);
  if (!Number.isFinite(minutes) || minutes <= 0) return;
  timer = setInterval(() => {
    const delta = rpcUsageDelta();
    if (delta.total > 0) log("[rpc-usage]", JSON.stringify({ windowMin: minutes, ...delta }));
  }, minutes * 60_000);
  timer.unref?.();
}

/** One summary line when a short-lived process (a cron job) exits. */
export function logRpcUsageOnExit(log: (...args: unknown[]) => void = console.log) {
  let done = false;
  const write = () => {
    if (done) return;
    done = true;
    const snap = plain();
    if (snap.total > 0) log("[rpc-usage]", JSON.stringify(snap));
  };
  process.once("beforeExit", write);
  process.once("exit", write);
}
