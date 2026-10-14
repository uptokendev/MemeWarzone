import { badMethod, getQuery, isSolanaAddress, json } from "../server/http.js";

function rpcUrls(cluster) {
  const devnet = cluster === "devnet";
  const configured = (
    devnet
      ? [
          process.env.SOLANA_DEVNET_RPC_URL,
          process.env.SOLANA_DEVNET_RPC,
          process.env.SOLANA_DEVNET_RPC_HTTP,
          process.env.SOLANA_RPC_HTTP_102,
          process.env.VITE_SOLANA_DEVNET_RPC,
        ]
      : [
          process.env.SOLANA_RPC_URL,
          process.env.SOLANA_RPC_HTTP,
          process.env.SOLANA_MAINNET_RPC,
          process.env.VITE_SOLANA_MAINNET_RPC,
          process.env.VITE_SOLANA_RPC,
        ]
  )
    .map((value) => String(value || "").trim())
    .filter((value) => /^https?:\/\//i.test(value));
  const fallbacks = devnet ? ["https://api.devnet.solana.com"] : [];
  return [...new Set([...configured, ...fallbacks])];
}

// Every open Token Details / War Room tab polls this route. A short shared cache plus in-flight
// dedupe turns N tabs into one getAccountInfo per address per window; failures are never cached.
const CACHE_MS = Math.max(0, Number(process.env.SOLANA_CAMPAIGN_ACCOUNT_CACHE_MS || 2_000));
const CACHE_MAX_ENTRIES = 5_000;
const cache = new Map();
const inflight = new Map();

async function readAccount(urls, address) {
  let lastError = null;
  for (const rpc of urls) {
    try {
      const response = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getAccountInfo",
          params: [address, { encoding: "base64", commitment: "confirmed" }],
        }),
      });
      const payload = await response.json().catch(() => null);
      if (payload?.error) {
        lastError = payload.error;
        continue;
      }
      const value = payload?.result?.value;
      const data = Array.isArray(value?.data) ? value.data[0] : null;
      if (!data) return { cacheable: true, body: { ok: true, found: false } };
      return {
        cacheable: true,
        body: {
          ok: true,
          found: true,
          dataBase64: data,
          owner: value?.owner || null,
          lamports: value?.lamports ?? null,
        },
      };
    } catch (error) {
      lastError = error;
    }
  }
  console.error("[api/solana/campaign-account]", lastError);
  return { cacheable: false, body: { ok: true, found: false } };
}

async function readAccountCached(cluster, urls, address) {
  const key = `${cluster}:${address}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.body;
  const pending = inflight.get(key);
  if (pending) return pending;
  const request = readAccount(urls, address)
    .then(({ cacheable, body }) => {
      if (cacheable && CACHE_MS > 0) {
        cache.delete(key);
        cache.set(key, { at: Date.now(), body });
        if (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
      }
      return body;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, request);
  return request;
}

export default async function handler(req, res) {
  if (req.method !== "GET") return badMethod(res);
  const q = getQuery(req);
  const address = String(q.address || "").trim();
  if (!isSolanaAddress(address)) return json(res, 400, { error: "Invalid Solana address" });
  const cluster = String(q.cluster || "").trim().toLowerCase() === "devnet" ? "devnet" : "mainnet-beta";
  const urls = rpcUrls(cluster);
  if (!urls.length) return json(res, 200, { ok: true, found: false });

  return json(res, 200, await readAccountCached(cluster, urls, address));
}
