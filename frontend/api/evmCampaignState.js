import { ethers } from "ethers";
import { badMethod, getQuery, json } from "../server/http.js";
import { getRpcUrls, getServerReadProvider } from "./lib/getServerReadProvider.js";
import { parseGen5QuoteParams, readGen5CampaignState } from "./lib/evmGen5CampaignState.js";

/**
 * GET /api/evm/campaign-state?chainId=56|4663&campaign=0x..[&wallet=0x..][&buyNativeWei=..|&buyTokens=..|&sellTokens=..]
 *
 * Generation 5 coin-page state read from chain (docs/evm-launch C2, C4, C5, C6, E12): the trade fee now
 * and when the anti-sniper window ends, the creator's escrow (released, locked, next release), the
 * graduation state (pending since, whether graduate() succeeds now, repair needed, native fallback
 * after 7 days for quote coins) and the creator's pull balances. A campaign of an older generation
 * answers `supported: false` and nothing else, so existing pages keep their current reads.
 *
 * Cached per campaign + quote parameters for EVM_CAMPAIGN_STATE_CACHE_MS (default 10 s): the fee
 * changes every second only during the first minute, and graduation state changes with trades.
 */

const EVM_CHAIN_IDS = new Set([56, 97, 4663, 46630, 31337]);
const cache = new Map();
const MAX_CACHE_ENTRIES = 2000;

function cacheMs() {
  const n = Number(process.env.EVM_CAMPAIGN_STATE_CACHE_MS);
  return Number.isFinite(n) && n >= 0 ? n : 10_000;
}

export function clearEvmCampaignStateCache() {
  cache.clear();
}

export async function evmCampaignStateHandler(req, res, deps = {}) {
  if (req.method !== "GET") return badMethod(res);
  const q = getQuery(req);
  const chainId = Number(q.chainId);
  const campaign = String(q.campaign || q.campaignAddress || "").trim();
  const wallet = String(q.wallet || "").trim();
  if (!EVM_CHAIN_IDS.has(chainId)) return json(res, 400, { error: "chainId must be an EVM launch chain (56, 97, 4663, 46630)." });
  if (!ethers.isAddress(campaign)) return json(res, 400, { error: "Invalid campaign address." });
  if (wallet && !ethers.isAddress(wallet)) return json(res, 400, { error: "Invalid wallet address." });

  let quoteParams;
  try {
    quoteParams = parseGen5QuoteParams(q);
  } catch (error) {
    return json(res, error.httpStatus || 400, { error: error.message });
  }

  const getProvider = deps.getProvider || (async (id) => {
    if (!getRpcUrls(id).length) return null;
    return getServerReadProvider(id);
  });
  const read = deps.readState || readGen5CampaignState;

  const key = [
    chainId,
    campaign.toLowerCase(),
    wallet.toLowerCase(),
    quoteParams.buyNativeWei ?? "",
    quoteParams.buyTokens ?? "",
    quoteParams.sellTokens ?? "",
  ].join(":");
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return json(res, 200, { ...hit.value, cached: true });

  try {
    const provider = await getProvider(chainId);
    if (!provider) return json(res, 503, { error: `No RPC is configured for chain ${chainId}.`, code: "EVM_RPC_NOT_CONFIGURED" });
    const state = await read({ provider, campaignAddress: campaign, wallet: wallet || null, quoteParams });
    const value = { chainId, ...state };
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(key, { value, expiresAt: Date.now() + cacheMs() });
    return json(res, 200, { ...value, cached: false });
  } catch (error) {
    console.error("[api/evm/campaign-state]", error);
    return json(res, 502, {
      error: "The campaign could not be read from chain.",
      code: "EVM_CAMPAIGN_STATE_UNREADABLE",
      detail: String(error?.shortMessage || error?.message || error),
    });
  }
}

export default function handler(req, res) {
  return evmCampaignStateHandler(req, res);
}
