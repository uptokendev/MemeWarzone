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

export async function readAccounts(addresses, { urls = solanaProgressRpcUrls(), fetchImpl = fetch } = {}) {
  if (!urls.length || !addresses.length) return new Map();
  const out = new Map();
  for (let i = 0; i < addresses.length; i += 100) {
    const batch = addresses.slice(i, i + 100);
    const values = await readBatch(urls, batch, fetchImpl);
    batch.forEach((address, index) => {
      const data = values[index]?.data?.[0];
      out.set(address, data ? decodeSolanaCampaignCurve(Buffer.from(data, "base64")) : null);
    });
  }
  return out;
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
