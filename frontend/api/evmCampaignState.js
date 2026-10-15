import { ethers } from "ethers";
import { badMethod, getQuery, json } from "../server/http.js";
import { getRpcUrls, getServerReadProvider } from "./lib/getServerReadProvider.js";
import { parseGen5QuoteParams, readGen5CampaignState } from "./lib/evmGen5CampaignState.js";
import { gen8V4ConfigFor } from "./lib/evmGen8Config.js";
import { gen8IndexedCampaignState, readGen8CampaignState, readGen8IndexedPool, readGen8Pool } from "./lib/evmGen8CampaignState.js";

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
 * A generation 8 answer is cached for 60 s. A newer row in evm_gen8_swaps bypasses that cache so a
 * trade-triggered refetch reads the lens again. The 10 s cache is unchanged for every other generation.
 */

const EVM_CHAIN_IDS = new Set([56, 97, 4663, 46630, 31337, 6281971]);
const GEN8_CAMPAIGN_STATE_CACHE_MS = 60_000;
const cache = new Map();
const MAX_CACHE_ENTRIES = 2000;

function cacheMs() {
  const n = Number(process.env.EVM_CAMPAIGN_STATE_CACHE_MS);
  return Number.isFinite(n) && n >= 0 ? n : 10_000;
}

/** True when the indexer has a gen-8 swap newer than this cache entry. A DB error keeps the cache. */
async function gen8IndexedSwapNewer(deps, chainId, token, storedAt) {
  let db = null;
  try {
    db = await gen8Db(deps);
  } catch {
    return false;
  }
  if (!db || typeof db.query !== "function") return false;
  try {
    const found = await db.query(
      `select 1 as hit from public.evm_gen8_swaps
        where chain_id = $1 and lower(token_address) = lower($2) and block_time > $3
        limit 1`,
      [chainId, token, new Date(storedAt)],
    );
    return Array.isArray(found?.rows) && found.rows.length > 0;
  } catch {
    return false;
  }
}

async function gen8Db(deps) {
  if (deps.db !== undefined) return deps.db;
  try {
    return (await import("../server/db.js")).pool;
  } catch {
    return null;
  }
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
  if (!EVM_CHAIN_IDS.has(chainId)) return json(res, 400, { error: "chainId must be an EVM launch chain (56, 97, 4663, 46630, 6281971)." });
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
  if (hit && hit.expiresAt > Date.now()) {
    const newerGen8Swap = hit.gen8 && await gen8IndexedSwapNewer(deps, chainId, campaign, hit.storedAt);
    if (!newerGen8Swap) return json(res, 200, { ...hit.value, cached: true });
  }

  try {
    const provider = await getProvider(chainId);
    if (!provider) return json(res, 503, { error: `No RPC is configured for chain ${chainId}.`, code: "EVM_RPC_NOT_CONFIGURED" });
    // Generation 8 on the V4 venue (only where EVM_GEN8_LAUNCHER_<id> / EVM_GEN8_HOOK_<id> are set): the address is
    // the coin's token and its state lives in the hook's pool, not in a campaign contract. One hook read decides;
    // anything else falls through to the generation 5/6/7 reader unchanged. A Barkswap chain (DogeOS) has no V4 config
    // here, so it falls through too until its lens branch exists (plan t21).
    const gen8Cfg = (deps.gen8Config || gen8V4ConfigFor)(chainId);
    let state = null;
    let gen8Served = false;
    if (gen8Cfg) {
      const findPool = deps.readGen8Pool || readGen8Pool;
      let hookReadFailed = false;
      const gen8Pool = await findPool({ provider, cfg: gen8Cfg, token: campaign }).catch((error) => {
        console.warn("[api/evm/campaign-state] gen-8 pool read failed; trying the indexer, then the campaign reader", error?.shortMessage || error?.message || error);
        hookReadFailed = true;
        return null;
      });
      // The indexer's open_at / last_phase stand in for what the chain read cannot answer (fix round 2026-10-12).
      const loadIndexed = deps.loadGen8Indexed || (async () => readGen8IndexedPool(await gen8Db(deps), chainId, campaign));
      if (gen8Pool) {
        const indexed = await loadIndexed().catch(() => null);
        state = await (deps.readGen8State || readGen8CampaignState)({ provider, cfg: gen8Cfg, token: campaign, wallet: wallet || null, pool: gen8Pool, indexed });
        gen8Served = Boolean(state);
      } else if (hookReadFailed) {
        const indexed = await loadIndexed().catch(() => null);
        if (indexed) {
          state = gen8IndexedCampaignState({ cfg: gen8Cfg, indexed });
          gen8Served = true;
        }
      }
    }
    if (!state) state = await read({ provider, campaignAddress: campaign, wallet: wallet || null, quoteParams });
    const value = { chainId, ...state };
    const gen8 = gen8Served || Number(state?.generation?.factoryGeneration) === 8;
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(key, { value, expiresAt: Date.now() + (gen8 ? GEN8_CAMPAIGN_STATE_CACHE_MS : cacheMs()), gen8, storedAt: Date.now() });
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
