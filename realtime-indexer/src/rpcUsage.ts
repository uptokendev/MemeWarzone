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
 * byCaller is the raw cumulative count per caller, per chain, every caller and
 * each method. bySourcePerDay stays the top 60 per-day rates. URLs are never stored.
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

// Which of our functions sent each request, as "chain file:function" -> method -> raw count.
// /health shows every caller. bySourcePerDay is still only the top 60 rates.
const bySource = new Map<string, Map<string, number>>();
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
  // The first frame of ours, plus the nearest different caller above it: shared helpers
  // (solanaIndexer's rpc, getLogsSafe) would otherwise lump every loop into one key.
  const frames: Array<{ name: string; fn: string }> = [];
  for (const line of String(stack || "").split("\n").slice(1)) {
    const match = STACK_FRAME.exec(line);
    if (!match) continue;
    const file = match[2];
    if (!packageDir || !file.includes(packageDir) || file.includes("/node_modules/") || PLUMBING_FILE.test(file)) continue;
    const name = file.slice(file.lastIndexOf("/") + 1);
    const fn = String(match[1] || "").replace(/^(?:Object|Timeout|process)\./, "").replace(/^async /, "") || "<top>";
    if (!frames.length) {
      frames.push({ name, fn });
      continue;
    }
    if (fn === frames[0].fn && name === frames[0].name) continue;
    frames.push({ name, fn });
    break;
  }
  if (!frames.length) return "unattributed";
  const [first, parent] = frames;
  const head = `${first.name}:${first.fn}`;
  if (!parent) return head.slice(0, 120);
  return `${head}<${parent.name === first.name ? parent.fn : `${parent.name}:${parent.fn}`}`.slice(0, 120);
}

function methodOf(item: unknown): string {
  if (typeof item === "string") return item.slice(0, 64) || "unknown";
  if (item && typeof item === "object" && typeof (item as { method?: unknown }).method === "string") {
    return String((item as { method: string }).method).slice(0, 64) || "unknown";
  }
  return "unknown";
}

/** Attribute each request to its caller, keeping the method. A string payload is one method name. */
export function attributeRpcRequest(chain: unknown, payload: unknown) {
  try {
    const items = Array.isArray(payload) ? payload : [payload];
    if (!items.length) return;
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 60;
    let stack: string | undefined;
    try {
      stack = new Error().stack;
    } finally {
      Error.stackTraceLimit = limit;
    }
    const key = `${String(chain ?? "unknown")} ${rpcCallSource(stack)}`;
    let methods = bySource.get(key);
    if (!methods) {
      methods = new Map();
      bySource.set(key, methods);
    }
    for (const item of items) {
      const name = methodOf(item);
      methods.set(name, (methods.get(name) || 0) + 1);
    }
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
  const ranked = [...bySource].map(([key, methods]) => {
    let callerTotal = 0;
    for (const n of methods.values()) callerTotal += n;
    return { key, callerTotal, methods };
  }).sort((a, b) => b.callerTotal - a.callerTotal);
  const bySourcePerDay: Record<string, number> = {};
  for (const row of ranked.slice(0, 60)) {
    bySourcePerDay[row.key] = Math.round((row.callerTotal / uptimeSec) * 86_400);
  }
  const grouped = new Map<string, Array<{ caller: string; total: number; methods: Record<string, number> }>>();
  for (const row of ranked) {
    const space = row.key.indexOf(" ");
    const chain = space < 0 ? "unknown" : row.key.slice(0, space);
    const caller = space < 0 ? row.key : row.key.slice(space + 1);
    const methods: Record<string, number> = {};
    for (const [method, n] of [...row.methods].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) methods[method] = n;
    const list = grouped.get(chain) ?? [];
    list.push({ caller, total: row.callerTotal, methods });
    grouped.set(chain, list);
  }
  const byCaller: Record<string, Record<string, { total: number; methods: Record<string, number> }>> = {};
  for (const chain of [...grouped.keys()].sort((a, b) => a.localeCompare(b, "en", { numeric: true }))) {
    const callers: Record<string, { total: number; methods: Record<string, number> }> = {};
    for (const row of grouped.get(chain) ?? []) callers[row.caller] = { total: row.total, methods: row.methods };
    byCaller[chain] = callers;
  }
  return { since: new Date(startedAt).toISOString(), uptimeSec, total, byChain, estimatedPerDay, bySourcePerDay, byCaller };
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
  const methods: string[] = [];
  for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
    const method = (item as any)?.method;
    if (typeof method === "string" && SOLANA_METHOD.test(method)) {
      bump("solana", method);
      methods.push(method);
    }
  }
  if (methods.length > 0) attributeRpcRequest("solana", methods);
  return methods.length;
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
