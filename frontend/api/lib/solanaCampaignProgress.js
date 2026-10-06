import { decodeSolanaCampaignCurve, solanaBondingProgressPct, solanaCurveCloseLamports } from "../../shared/solanaCampaignCurve.mjs";

/**
 * Solana bonding progress for the campaign list, exactly as Token Details computes it: each campaign's
 * own on-chain account (its chosen $15k / $30k / $50k graduation target and its curve), one batched
 * getMultipleAccounts per page, cached briefly. Replaces a single USD default for every campaign,
 * which put a $15k campaign at half its real progress.
 */
const CACHE_MS = 15_000;
const cache = new Map(); // address -> { at, curve }

// Same mainnet RPC list as /api/solana/campaign-account, tried in order. Reading only the first
// configured URL with no fallback left every Solana card at 0% whenever that one endpoint refused
// (2026-10-01: KAIJU88 read 0% on the front page while its coin page, which falls back, read 21%).
export function solanaProgressRpcUrls(env = process.env) {
  return [
    ...String(env.SOLANA_RPC_URL || "").split(","),
    ...String(env.SOLANA_RPC_HTTP || "").split(","),
    env.SOLANA_MAINNET_RPC,
    env.VITE_SOLANA_MAINNET_RPC,
    env.VITE_SOLANA_RPC,
  ]
    .map((value) => String(value || "").trim())
    .filter((value, index, all) => /^https?:\/\//i.test(value) && all.indexOf(value) === index);
}

async function readBatch(urls, batch, fetchImpl) {
  let lastError = null;
  for (const url of urls) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [batch, { encoding: "base64", commitment: "confirmed" }] }),
      });
      const body = await response.json().catch(() => null);
      if (response.ok && Array.isArray(body?.result?.value)) return body.result.value;
      lastError = new Error(body?.error?.message || `HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("no Solana RPC configured");
}

const DBC_PROGRAM_ID = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
const dbcThresholds = new Map(); // config address -> migration quote threshold (a config never changes)
let dbcCoderPromise = null;

/** The DBC SDK's account coder (decodes bytes only; the connection is never used). */
async function dbcAccountCoder() {
  dbcCoderPromise ||= (async () => {
    const { Connection } = await import("@solana/web3.js");
    const { DynamicBondingCurveClient } = await import("@meteora-ag/dynamic-bonding-curve-sdk");
    return new DynamicBondingCurveClient(new Connection("http://127.0.0.1:8899"), "confirmed").state.program.coder.accounts;
  })();
  return dbcCoderPromise;
}

/** A DBC pool's quote reserve, config and migration flag from its account bytes. */
export async function decodeDbcPool(bytes) {
  const decoded = (await dbcAccountCoder()).decode("virtualPool", bytes);
  const pool = decoded?.poolState ?? decoded;
  return {
    launchType: "dbc",
    quoteReserve: BigInt(String(pool.quoteReserve)),
    config: String(pool.config),
    isMigrated: Number(pool.isMigrated) !== 0,
  };
}

/** A DBC config's migration quote threshold (quote raw units) from its account bytes. */
export async function decodeDbcConfigThreshold(bytes) {
  return BigInt(String((await dbcAccountCoder()).decode("poolConfig", bytes).migrationQuoteThreshold));
}

async function decodeAccount(value) {
  const data = value?.data?.[0];
  if (!data) return null;
  const bytes = Buffer.from(data, "base64");
  try {
    // A Meteora DBC coin's campaign address is its pool, not a launchpad Campaign account.
    if (String(value.owner || "") === DBC_PROGRAM_ID) return await decodeDbcPool(bytes);
    return decodeSolanaCampaignCurve(bytes);
  } catch {
    return null;
  }
}

async function readRaw(addresses, { urls, fetchImpl }) {
  const out = [];
  for (let i = 0; i < addresses.length; i += 100) out.push(...(await readBatch(urls, addresses.slice(i, i + 100), fetchImpl)));
  return out;
}

export async function readAccounts(addresses, { urls = solanaProgressRpcUrls(), fetchImpl = fetch } = {}) {
  if (!urls.length || !addresses.length) return new Map();
  const values = await readRaw(addresses, { urls, fetchImpl });
  const out = new Map();
  for (let index = 0; index < addresses.length; index += 1) out.set(addresses[index], await decodeAccount(values[index]));
  // DBC progress is the pool's quote reserve against its config's migration threshold.
  const configs = [...new Set([...out.values()].filter((v) => v?.launchType === "dbc" && !dbcThresholds.has(v.config)).map((v) => v.config))];
  if (configs.length) {
    // A failed config read leaves only the DBC coins without progress, never the launchpad ones.
    const raw = await readRaw(configs, { urls, fetchImpl }).catch(() => []);
    for (let index = 0; index < configs.length; index += 1) {
      const data = raw[index]?.data?.[0];
      if (!data) continue;
      try {
        dbcThresholds.set(configs[index], await decodeDbcConfigThreshold(Buffer.from(data, "base64")));
      } catch {
        // unknown threshold leaves that coin's progress null
      }
    }
  }
  for (const value of out.values()) {
    if (value?.launchType === "dbc") value.threshold = dbcThresholds.get(value.config) ?? 0n;
  }
  return out;
}

/** DBC progress in percent (4 decimals), as the coin page shows it; null when the threshold is unknown. */
export function dbcProgressPct(pool) {
  if (pool.isMigrated) return 100;
  if (!(pool.threshold > 0n)) return null;
  return Math.max(0, Math.min(100, Number((pool.quoteReserve * 1_000_000n) / pool.threshold) / 10_000));
}

/** Adds progressPct + graduationCloseSol to Solana items (never throws; unknown stays null). */
export async function withSolanaBondingProgress(items, solUsd) {
  try {
    const now = Date.now();
    const solana = items.filter((item) => item.chainId === 101 || item.chainId === 102);
    const stale = solana.map((item) => item.campaignAddress).filter((address) => !(cache.get(address)?.at > now - CACHE_MS));
    if (stale.length) {
      const read = await readAccounts(stale);
      for (const [address, curve] of read) cache.set(address, { at: now, curve });
    }
    for (const item of solana) {
      const curve = cache.get(item.campaignAddress)?.curve;
      if (!curve) continue;
      if (item.isDexTrading) {
        item.progressPct = 100;
        continue;
      }
      if (curve.launchType === "dbc") {
        item.progressPct = dbcProgressPct(curve);
        continue;
      }
      const closes = solanaCurveCloseLamports(curve, solUsd);
      item.progressPct = solanaBondingProgressPct(curve, solUsd);
      item.graduationCloseSol = closes > 0n ? String(Number(closes) / 1e9) : null;
      item.graduationTargetUsd = Number(curve.graduationTargetUsdMicros) / 1e6;
    }
  } catch (error) {
    console.warn("[campaigns] Solana bonding progress unavailable", error?.message || error);
  }
  return items;
}
