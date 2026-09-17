import { badMethod, getQuery, isSolanaAddress, json } from "../server/http.js";

function rpcUrl() {
  return String(process.env.SOLANA_RPC_URL || process.env.SOLANA_RPC_HTTP || process.env.SOLANA_MAINNET_RPC || "").trim();
}

export default async function handler(req, res) {
  if (req.method !== "GET") return badMethod(res);
  const address = String(getQuery(req).address || "").trim();
  if (!isSolanaAddress(address)) return json(res, 400, { error: "Invalid Solana address" });
  const rpc = rpcUrl();
  if (!rpc) return json(res, 503, { error: "SOLANA_RPC_URL is not configured on the API" });

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
    console.error("[api/solana/campaign-account]", error);
    return json(res, 502, { error: "Solana RPC read failed" });
  }
}
