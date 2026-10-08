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
  return { since: new Date(startedAt).toISOString(), uptimeSec, total, byChain, estimatedPerDay: perDay };
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
    if (delta.total > 0) log(`[${label}]`, JSON.stringify({ windowMin: minutes, ...delta }));
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
