// Per-process JSON-RPC request counter, by chain and method.
//
// Why: the paid BNB / Robinhood RPC quota ran out on 2026-10-08 and nothing in
// our own processes said how many requests each one sent. This counts every
// request a process sends (ethers JsonRpcProvider and plain fetch JSON-RPC),
// keyed by chain and method only. URLs are never stored or logged: they carry
// the provider key in the path.
//
// Exposed on the API's GET /health (rpcUsage) and logged every
// RPC_USAGE_LOG_MINUTES minutes (default 15; 0 = off) as one line:
//   [rpc-usage] {"windowMin":15,"total":123,"byChain":{"56":{"eth_call":100,...}}}
// byCaller is the raw cumulative count per caller, per chain, every caller and
// each method. bySourcePerDay stays the top 60 per-day rates. URLs are never stored.
// Cron scripts log their totals once at exit (logRpcUsageOnExit).

import { ethers } from "ethers";
import { getRpcUrls } from "./getServerReadProvider.js";

const counts = new Map(); // chain -> Map(method -> n)
const startedAt = Date.now();
let lastLogged = null; // snapshot of counts at the previous log line

function bump(chain, method, n = 1) {
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
const bySource = new Map();
const PACKAGE_DIR = (() => {
  try {
    return new URL("../..", import.meta.url).pathname; // frontend/
  } catch {
    return "";
  }
})();
const PLUMBING_FILE = /\/(?:rpcUsage|rpcUsageInstall)\.[cm]?js$/;
const STACK_FRAME = /^\s*at (?:async )?(?:(.+?) \()?(?:file:\/\/)?([^()\s]+?):\d+:\d+\)?$/;

/** "solanaImportTrades.js:rpc" for the first frame of ours below the counter. */
export function rpcCallSource(stack, packageDir = PACKAGE_DIR) {
  // The first frame of ours, plus the nearest different caller above it: shared helpers (an
  // rpc() wrapper) would otherwise lump every caller into one key.
  const frames = [];
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

function methodOf(item) {
  if (typeof item === "string") return item.slice(0, 64) || "unknown";
  if (item && typeof item === "object" && typeof item.method === "string") return item.method.slice(0, 64) || "unknown";
  return "unknown";
}

/** Attribute each request to its caller, keeping the method. A string payload is one method name. Never throws. */
export function attributeRpcRequest(chain, payload) {
  try {
    const items = Array.isArray(payload) ? payload : [payload];
    if (!items.length) return;
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 60;
    let stack;
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
export function countRpcRequest(chain, payload) {
  for (const item of Array.isArray(payload) ? payload : [payload]) {
    if (!item) continue;
    bump(chain, typeof item === "string" ? item : item.method);
  }
}

function plain(source = counts) {
  const byChain = {};
  let total = 0;
  for (const [chain, byMethod] of source) {
    const methods = {};
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

/** Totals since this process started. */
export function rpcUsageSnapshot() {
  const uptimeSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  const { total, byChain } = plain();
  const perDay = {};
  for (const [chain, value] of Object.entries(byChain)) perDay[chain] = Math.round((value.total / uptimeSec) * 86_400);
  const ranked = [...bySource].map(([key, methods]) => {
    let callerTotal = 0;
    for (const n of methods.values()) callerTotal += n;
    return { key, callerTotal, methods };
  }).sort((a, b) => b.callerTotal - a.callerTotal);
  const bySourcePerDay = {};
  for (const row of ranked.slice(0, 60)) {
    bySourcePerDay[row.key] = Math.round((row.callerTotal / uptimeSec) * 86_400);
  }
  const grouped = new Map();
  for (const row of ranked) {
    const space = row.key.indexOf(" ");
    const chain = space < 0 ? "unknown" : row.key.slice(0, space);
    const caller = space < 0 ? row.key : row.key.slice(space + 1);
    const methods = {};
    for (const [method, n] of [...row.methods].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) methods[method] = n;
    const list = grouped.get(chain) ?? [];
    list.push({ caller, total: row.callerTotal, methods });
    grouped.set(chain, list);
  }
  const byCaller = {};
  for (const chain of [...grouped.keys()].sort((a, b) => a.localeCompare(b, "en", { numeric: true }))) {
    const callers = {};
    for (const row of grouped.get(chain)) callers[row.caller] = { total: row.total, methods: row.methods };
    byCaller[chain] = callers;
  }
  return { since: new Date(startedAt).toISOString(), uptimeSec, total, byChain, estimatedPerDay: perDay, bySourcePerDay, byCaller };
}

function clone() {
  const copy = new Map();
  for (const [chain, byMethod] of counts) copy.set(chain, new Map(byMethod));
  return copy;
}

/** Requests since the previous call (the whole process on the first call). */
export function rpcUsageDelta() {
  const now = clone();
  const delta = new Map();
  for (const [chain, byMethod] of now) {
    const before = lastLogged?.get(chain);
    const out = new Map();
    for (const [method, n] of byMethod) {
      const d = n - (before?.get(method) || 0);
      if (d > 0) out.set(method, d);
    }
    if (out.size) delta.set(chain, out);
  }
  lastLogged = now;
  return plain(delta);
}

/** For tests. */
export function resetRpcUsage() {
  counts.clear();
  bySource.clear();
  lastLogged = null;
}

// ------------------------------------------------------------------ hooks

let ethersHooked = false;

/**
 * Counts every request of every ethers JsonRpcProvider in this process (one
 * patch of the prototype's _send, which all JSON-RPC traffic of a provider
 * goes through). The chain is the provider's pinned network.
 */
export function hookEthersRpcCounter(JsonRpcProviderClass = ethers.JsonRpcProvider) {
  if (ethersHooked) return;
  const proto = JsonRpcProviderClass?.prototype;
  if (!proto || typeof proto._send !== "function") return;
  const original = proto._send;
  proto._send = function countedSend(payload) {
    let chain = "unknown";
    try {
      chain = String(this._network?.chainId ?? "unknown");
    } catch {
      // network not pinned yet
    }
    countRpcRequest(chain, payload);
    return original.call(this, payload);
  };
  // Attribution happens in send: it runs in the caller's async chain, while ethers calls _send
  // from its batch drain timer, whose stack names no caller.
  const originalSend = proto.send;
  if (typeof originalSend === "function") {
    proto.send = function attributedSend(method, params) {
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
 * Wraps a fetch so JSON-RPC POST bodies are counted. The chain comes from
 * `chainOfUrl(url)` (matched against the configured RPC lists); a Solana
 * method name counts as "solana" when the URL is not known. The URL itself is
 * never kept.
 */
export function countingFetch(fetchImpl, chainOfUrl = () => null) {
  return async function countedFetch(input, init) {
    try {
      const body = init?.body;
      if (typeof body === "string" && body.includes("\"jsonrpc\"")) {
        const parsed = JSON.parse(body);
        const first = Array.isArray(parsed) ? parsed[0] : parsed;
        if (first?.method) {
          const url = typeof input === "string" ? input : input?.url || String(input || "");
          const chain = chainOfUrl(url) ?? (SOLANA_METHOD.test(first.method) ? "solana" : "unknown");
          countRpcRequest(chain, parsed);
          attributeRpcRequest(chain, parsed);
        }
      }
    } catch {
      // never let counting break a request
    }
    return fetchImpl(input, init);
  };
}

let fetchHooked = false;

/** Counts plain-fetch JSON-RPC in this process (globalThis.fetch). */
export function hookFetchRpcCounter(chainOfUrl) {
  if (fetchHooked || typeof globalThis.fetch !== "function") return;
  globalThis.fetch = countingFetch(globalThis.fetch.bind(globalThis), chainOfUrl);
  fetchHooked = true;
}

let timer = null;

/** Logs the requests of the last window every RPC_USAGE_LOG_MINUTES minutes (default 15, 0 = off). */
export function startRpcUsageLog({ env = process.env, log = console.log, label = "rpc-usage" } = {}) {
  if (timer) return;
  const minutes = Number(env.RPC_USAGE_LOG_MINUTES ?? 15);
  if (!Number.isFinite(minutes) || minutes <= 0) return;
  timer = setInterval(() => {
    const delta = rpcUsageDelta();
    if (delta.total > 0) {
      // Callers since start, per day; the worker has no /health, so its log line carries them.
      const topSourcesPerDay = Object.fromEntries(Object.entries(rpcUsageSnapshot().bySourcePerDay).slice(0, 15));
      log(`[${label}]`, JSON.stringify({ windowMin: minutes, ...delta, topSourcesPerDay }));
    }
  }, minutes * 60_000);
  timer.unref?.();
}

/** One summary line when a short-lived process (a cron script) exits. */
export function logRpcUsageOnExit({ log = console.log, label = "rpc-usage" } = {}) {
  let done = false;
  const write = () => {
    if (done) return;
    done = true;
    const snap = plain();
    if (snap.total > 0) log(`[${label}]`, JSON.stringify(snap));
  };
  process.once("beforeExit", write);
  process.once("exit", write);
}

const EVM_CHAINS = [56, 97, 4663, 46630];

/** Chain of a configured RPC URL (getRpcUrls lists, matched exactly, then by host), or null. */
export function chainOfRpcUrl(url, rpcUrlsFor = getRpcUrls) {
  const text = String(url || "");
  if (!text) return null;
  let host = "";
  try {
    host = new URL(text).host;
  } catch {
    return null;
  }
  let byHost = null;
  for (const chainId of EVM_CHAINS) {
    for (const candidate of rpcUrlsFor(chainId)) {
      if (candidate === text) return chainId;
      try {
        if (!byHost && new URL(candidate).host === host) byHost = chainId;
      } catch {
        // ignore
      }
    }
  }
  return byHost;
}

let installed = false;

/**
 * Turns on the counters for this process: every ethers JsonRpcProvider and
 * every plain-fetch JSON-RPC body, plus the periodic [rpc-usage] log line
 * (long-running) or one line at exit (cron scripts: `{ once: true }`).
 */
export function installRpcUsageCounters({ once = false, label = "rpc-usage" } = {}) {
  if (installed) return;
  installed = true;
  hookEthersRpcCounter();
  hookFetchRpcCounter((url) => chainOfRpcUrl(url));
  if (once) logRpcUsageOnExit({ label });
  else startRpcUsageLog({ label });
}
