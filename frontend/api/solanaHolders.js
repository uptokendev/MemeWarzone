import { badMethod, getQuery, isSolanaAddress, json } from "../server/http.js";
import { countSolanaHolders } from "./lib/arenaImportMarketFeed.js";

/**
 * GET /api/solana/holders?mint=<mint>&campaign=<campaign PDA>
 *
 * Exact holder count for a Solana launchpad token: owners with a non-zero balance, excluding the
 * campaign PDA (it owns the bonding-curve vault). The token page used to derive holders from a trade
 * replay while bonding (misses transfers) and from getTokenLargestAccounts after graduation (capped
 * at 20 accounts), so neither matched the chain. Cached 60 s per mint; concurrent requests share one
 * RPC scan.
 */
const CACHE_MS = 60_000;
const cache = new Map();
const inflight = new Map();

function rpcUrl() {
  return String(process.env.SOLANA_RPC_URL || process.env.SOLANA_MAINNET_RPC_URL || process.env.SOLANA_RPC_HTTP || "").trim();
}

export default async function handler(req, res) {
  if (req.method !== "GET") return badMethod(res);
  const q = getQuery(req);
  const mint = String(q.mint || "").trim();
  const campaign = String(q.campaign || "").trim();
  if (!isSolanaAddress(mint)) return json(res, 400, { error: "Invalid mint" });
  if (campaign && !isSolanaAddress(campaign)) return json(res, 400, { error: "Invalid campaign" });

  const key = `${mint}:${campaign}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return json(res, 200, { ok: true, holders: hit.holders, at: hit.at, cached: true });

  try {
    let request = inflight.get(key);
    if (!request) {
      request = countSolanaHolders(rpcUrl(), mint, fetch, { excludeOwners: campaign ? [campaign] : [] }).finally(() => inflight.delete(key));
      inflight.set(key, request);
    }
    const holders = await request;
    if (holders == null) return json(res, 200, { ok: false, holders: null, error: "Holder count unavailable" });
    const entry = { holders, at: Date.now() };
    cache.set(key, entry);
    if (cache.size > 2_000) cache.delete(cache.keys().next().value);
    return json(res, 200, { ok: true, holders, at: entry.at, cached: false });
  } catch (error) {
    console.warn("[api/solana/holders]", mint, error?.message || error);
    return json(res, 200, { ok: false, holders: null, error: "Holder count unavailable" });
  }
}
