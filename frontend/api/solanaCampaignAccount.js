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

export default async function handler(req, res) {
  if (req.method !== "GET") return badMethod(res);
  const q = getQuery(req);
  const address = String(q.address || "").trim();
  if (!isSolanaAddress(address)) return json(res, 400, { error: "Invalid Solana address" });
  const cluster = String(q.cluster || "").trim().toLowerCase() === "devnet" ? "devnet" : "mainnet-beta";
  const urls = rpcUrls(cluster);
  if (!urls.length) return json(res, 200, { ok: true, found: false });

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
      if (!data) return json(res, 200, { ok: true, found: false });
      return json(res, 200, {
        ok: true,
        found: true,
        dataBase64: data,
        owner: value?.owner || null,
        lamports: value?.lamports ?? null,
      });
    } catch (error) {
      lastError = error;
    }
  }
  console.error("[api/solana/campaign-account]", lastError);
  return json(res, 200, { ok: true, found: false });
}
