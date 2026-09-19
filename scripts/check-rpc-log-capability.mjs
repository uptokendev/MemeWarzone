#!/usr/bin/env node
/**
 * Does every configured RPC actually serve eth_getLogs?
 *
 * Claim recovery, the indexer and post-graduation pool tracking are all log
 * scans. An endpoint that answers eth_blockNumber and eth_call happily but
 * refuses eth_getLogs passes every ordinary health check and then makes real,
 * paid entitlements look unrecoverable. bsc-testnet.bnbchain.org does exactly
 * this: it answers -32005 "limit exceeded" for a one-block span, so the message
 * reads like a range limit while meaning "not served at all".
 *
 * Run this against a deployment's environment before trusting its claims:
 *
 *   node scripts/check-rpc-log-capability.mjs
 *   node scripts/check-rpc-log-capability.mjs --url https://... --chain 97
 *
 * Exits non-zero if any configured endpoint cannot serve logs.
 */

// Every env name the codebase reads an EVM RPC from, per chain.
const CHAIN_ENV_NAMES = {
  56: ["BSC_RPC_HTTP_56", "BSC_MAINNET_RPC_URL", "BSC_MAINNET_RPC", "VITE_BSC_RPC_URL"],
  97: ["BSC_RPC_HTTP_97", "BSC_TESTNET_RPC"],
  4663: ["ROBINHOOD_RPC_HTTP_4663", "ROBINHOOD_MAINNET_RPC_URL"],
  46630: ["ROBINHOOD_RPC_HTTP_46630", "ROBINHOOD_TESTNET_RPC_URL", "VITE_ROBINHOOD_RPC_URL"],
};

// Transfer(address,address,uint256): present on every chain, so an empty result
// is a real answer rather than a sign the filter was wrong.
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const SPANS = [5000, 1000, 250, 100, 10, 1];

function redact(url) {
  try {
    const parsed = new URL(url);
    // API keys live in the path for BlockPI/Alchemy/Infura style endpoints.
    const path = parsed.pathname.replace(/\/[0-9a-fA-F]{16,}/g, "/<key>");
    return `${parsed.protocol}//${parsed.host}${path}${parsed.search ? "?<query>" : ""}`;
  } catch {
    return "<unparseable url>";
  }
}

async function rpc(url, method, params, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    return { httpStatus: response.status, error: body?.error ?? null, result: body?.result ?? null };
  } catch (error) {
    return { httpStatus: 0, error: { message: String(error?.message || error) }, result: null };
  } finally {
    clearTimeout(timer);
  }
}

async function inspect(url, expectedChainId) {
  const label = redact(url);
  const head = await rpc(url, "eth_blockNumber", []);
  if (head.error || head.result == null) {
    return { label, ok: false, reason: `cannot answer eth_blockNumber: ${head.error?.message || `HTTP ${head.httpStatus}`}` };
  }
  const latest = Number(head.result);

  const chain = await rpc(url, "eth_chainId", []);
  const reportedChainId = chain.result == null ? null : Number(chain.result);
  if (expectedChainId != null && reportedChainId != null && reportedChainId !== Number(expectedChainId)) {
    return { label, ok: false, latest, reportedChainId, reason: `serves chain ${reportedChainId}, expected ${expectedChainId}` };
  }

  let firstError = null;
  for (const span of SPANS) {
    const probe = await rpc(url, "eth_getLogs", [{
      fromBlock: "0x" + Math.max(0, latest - span + 1).toString(16),
      toBlock: "0x" + latest.toString(16),
      topics: [TRANSFER_TOPIC],
    }]);
    if (!probe.error && Array.isArray(probe.result)) {
      return { label, ok: true, latest, reportedChainId, largestServedSpan: span, logs: probe.result.length };
    }
    firstError = firstError || probe.error;
  }
  return { label, ok: false, latest, reportedChainId, reason: `refuses eth_getLogs at every span down to 1 block: ${firstError?.message || "unknown"}` };
}

function parseArgs(argv) {
  const args = { url: null, chain: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--url") args.url = argv[i + 1];
    if (argv[i] === "--chain") args.chain = Number(argv[i + 1]);
  }
  return args;
}

async function main() {
  const { url, chain } = parseArgs(process.argv.slice(2));

  const targets = [];
  if (url) {
    targets.push({ chainId: chain, envName: "--url", url });
  } else {
    for (const [chainId, names] of Object.entries(CHAIN_ENV_NAMES)) {
      for (const envName of names) {
        const value = process.env[envName];
        if (value && String(value).trim()) targets.push({ chainId: Number(chainId), envName, url: String(value).trim() });
      }
    }
  }

  if (!targets.length) {
    console.log("No EVM RPC environment variables are set, so there is nothing to check.");
    console.log(`Looked for: ${Object.values(CHAIN_ENV_NAMES).flat().join(", ")}`);
    process.exit(0);
  }

  // The same URL is often shared across env names; check each endpoint once.
  const seen = new Map();
  let failures = 0;
  for (const target of targets) {
    const key = `${target.chainId}|${target.url}`;
    const result = seen.get(key) || await inspect(target.url, target.chainId);
    seen.set(key, result);

    const status = result.ok ? "OK  " : "FAIL";
    const detail = result.ok
      ? `eth_getLogs up to ${result.largestServedSpan} blocks (${result.logs} logs), head ${result.latest}`
      : result.reason;
    console.log(`${status} chain ${target.chainId} ${target.envName}\n       ${result.label}\n       ${detail}`);
    if (!result.ok) failures += 1;
  }

  if (failures) {
    console.log(`\n${failures} endpoint reference(s) cannot serve eth_getLogs.`);
    console.log("Claim recovery, the indexer and post-graduation pool tracking all depend on it.");
    process.exit(1);
  }
  console.log("\nEvery configured endpoint serves eth_getLogs.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
