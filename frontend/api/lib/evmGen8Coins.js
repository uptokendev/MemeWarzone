/**
 * "Is this address a generation 8 coin?" for API paths that must treat gen-8 coins differently (trade authorization:
 * never signed, D3; import swaps: never the import route, D9). Only asked where gen-8 is configured for the chain.
 *
 * Order: the campaigns row (factory_generation 8, written by the gen-8 indexer; campaign address = token address),
 * then, only when the database has no row for the address or cannot be read, the hook on chain (pools(id).creator,
 * id from the token and the hook). A gen-6/7 coin with a campaigns row is answered from the database alone.
 */
import { ethers } from "ethers";
import { EVM_GEN8_FACTORY_GENERATION, GEN8_TRADE_PATH, gen8PoolId, gen8PoolKey } from "../../shared/evmGen8.mjs";
import { gen8ConfigFor } from "./evmGen8Config.js";

const HOOK_POOLS_ABI = ["function pools(bytes32) view returns (address creator, uint40 launchTime, bool graduated, int24 tickGrad, int24 tickStart, uint128 liqA, uint128 liqB, uint160 sqrtGrad, tuple(uint16,uint16,uint16,uint16,uint16) fees)"];

/**
 * Returns { token, poolId, poolKey, graduated|null, source } for a gen-8 coin, or null. Never throws.
 * deps: { db, getProvider(chainId), env }
 */
export async function findGen8Coin({ chainId, address, db = null, getProvider = null, env = process.env }) {
  const cfg = gen8ConfigFor(chainId, env);
  if (!cfg || !ethers.isAddress(String(address || ""))) return null;
  const token = ethers.getAddress(address);
  const answer = (source, graduated = null) => ({
    token,
    poolId: gen8PoolId(token, cfg.hook),
    poolKey: gen8PoolKey(token, cfg.hook),
    graduated,
    source,
    tradePath: GEN8_TRADE_PATH,
  });

  let dbAnswered = false;
  if (db) {
    try {
      const { rows } = await db.query(
        `select factory_generation, graduated_at_chain
           from public.campaigns
          where chain_id = $1 and (campaign_address = $2 or token_address = $2)
          limit 1`,
        [Number(chainId), token.toLowerCase()],
      );
      if (rows.length) {
        dbAnswered = true;
        if (Number(rows[0].factory_generation) === EVM_GEN8_FACTORY_GENERATION) return answer("campaigns", rows[0].graduated_at_chain != null);
        return null;
      }
    } catch (error) {
      console.warn("[gen8] campaign generation lookup failed; asking the hook", error?.message || error);
    }
  }
  if (dbAnswered || !getProvider) return null;
  try {
    const provider = await getProvider(Number(chainId));
    if (!provider) return null;
    const hook = new ethers.Contract(cfg.hook, HOOK_POOLS_ABI, provider);
    const p = await hook.pools(gen8PoolId(token, cfg.hook));
    const creator = p.creator ?? p[0];
    if (!creator || creator === ethers.ZeroAddress) return null;
    return answer("hook", Boolean(p.graduated ?? p[2]));
  } catch (error) {
    console.warn("[gen8] hook lookup failed", error?.shortMessage || error?.message || error);
    return null;
  }
}

/** The 409 body for a trade authorization request on a gen-8 coin (trading is never signed, D3). */
export function gen8TradeAuthorizationRefusal(coin, chainId) {
  return {
    error: "Generation 8 coins trade without an authorization: swap in the coin's Uniswap V4 pool.",
    code: "GEN8_TRADES_NOT_SIGNED",
    chainId: Number(chainId),
    tradePath: GEN8_TRADE_PATH,
    token: coin.token,
    poolId: coin.poolId,
    poolKey: coin.poolKey,
  };
}
